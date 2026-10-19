import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import {
  DEFAULT_CAPABILITY_TTL_SECONDS,
  issueCapability,
  verifyCapability,
  type CapabilityClaims,
} from "./credentials/capability";
import { executeSignedRequest, type BrokerExecution } from "./credentials/broker";
import { hasPermission } from "./credentials/policy";
import { sameSecret } from "./secrets";

/**
 * Per-repository credential broker.
 *
 * Agents hold short-lived, signed capabilities; this object holds the real
 * credentials (Worker secrets) and is the only component that attaches them to
 * an outbound request. Every use - allowed or denied - is audited in SQLite
 * without the credential, the request body or the capability token.
 *
 * Routes:
 *   POST /capabilities   { agent, service, action, ttlSeconds? }  (control-plane key)
 *   GET  /permissions    ?service=&action=
 *   POST /proxy          { capability, params? }
 *   GET  /audit          ?limit=
 */

export const DEFAULT_CLIENT = "unknown";

export class CredentialBroker extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private get repository(): string {
    return this.ctx.id.name ?? DEFAULT_CLIENT;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/capabilities") {
      return this.issue(request);
    }
    if (request.method === "GET" && url.pathname === "/permissions") {
      const service = url.searchParams.get("service") ?? "";
      const action = url.searchParams.get("action") ?? "";
      return Response.json({ ok: true, service, action, permitted: hasPermission(service, action) });
    }
    if (request.method === "POST" && url.pathname === "/proxy") {
      return this.proxy(request);
    }
    if (request.method === "GET" && url.pathname === "/audit") {
      // Audit metadata names agents and actions, so it stays on the control
      // plane: same key that can mint a capability.
      const provisioningKey = this.env.BROKER_CONTROL_KEY;
      const authorised =
        provisioningKey !== undefined &&
        (await sameSecret(provisioningKey, request.headers.get("x-factory-control-key")));
      if (!authorised) {
        return Response.json({ ok: false, error: "not authorised to read the audit log" }, { status: 401 });
      }
      return this.audit(url);
    }

    return new Response("not found", { status: 404 });
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS credential_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        agent TEXT NOT NULL,
        jti TEXT,
        service TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        status INTEGER,
        duration_ms INTEGER,
        detail TEXT
      );
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS credential_audit_at_idx ON credential_audit (at);
    `);
  }

  // ------------------------------------------------------------- issuance

  private async issue(request: Request): Promise<Response> {
    const provisioningKey = this.env.BROKER_CONTROL_KEY;
    if (!provisioningKey) {
      return Response.json({ ok: false, error: "broker control key not configured" }, { status: 503 });
    }
    const presented = request.headers.get("x-factory-control-key");
    const authorised = await sameSecret(provisioningKey, presented);
    if (!authorised) {
      await this.record({ agent: DEFAULT_CLIENT, service: "-", action: "-", outcome: "denied", detail: "bad control key" });
      return Response.json({ ok: false, error: "not authorised to issue capabilities" }, { status: 401 });
    }

    const signingKey = this.env.BROKER_SIGNING_KEY;
    if (!signingKey) {
      return Response.json({ ok: false, error: "broker signing key not configured" }, { status: 503 });
    }

    const body = (await readJson(request)) as {
      agent?: unknown;
      service?: unknown;
      action?: unknown;
      ttlSeconds?: unknown;
    };

    const agent = typeof body.agent === "string" ? body.agent.trim() : "";
    const service = typeof body.service === "string" ? body.service.trim() : "";
    const action = typeof body.action === "string" ? body.action.trim() : "";

    if (!agent || !service || !action) {
      return Response.json(
        { ok: false, error: "agent, service and action are required" },
        { status: 400 },
      );
    }
    if (!hasPermission(service, action)) {
      await this.record({ agent, service, action, outcome: "denied", detail: "action not permitted" });
      return Response.json({ ok: false, error: "action not permitted" }, { status: 403 });
    }

    const ttlSeconds =
      typeof body.ttlSeconds === "number" ? body.ttlSeconds : DEFAULT_CAPABILITY_TTL_SECONDS;
    const capability = await issueCapability(signingKey, {
      sub: agent,
      repo: this.repository,
      service,
      action,
    }, { ttlSeconds });

    const verified = await verifyCapability(signingKey, capability);
    const expiresAt = verified.ok ? verified.claims.exp : Math.floor(Date.now() / 1000) + ttlSeconds;

    await this.record({ agent, service, action, outcome: "issued", detail: null });

    return Response.json({
      ok: true,
      capability,
      service,
      action,
      agent,
      expiresAt,
      repository: this.repository,
    });
  }

  // --------------------------------------------------------------- proxy

  private async proxy(request: Request): Promise<Response> {
    const signingKey = this.env.BROKER_SIGNING_KEY;
    if (!signingKey) {
      return Response.json({ ok: false, error: "broker signing key not configured" }, { status: 503 });
    }

    const body = (await readJson(request)) as {
      capability?: unknown;
      params?: unknown;
      service?: unknown;
      action?: unknown;
    };

    const token = typeof body.capability === "string" ? body.capability : "";
    const verified = await verifyCapability(signingKey, token);
    if (!verified.ok) {
      await this.record({ agent: DEFAULT_CLIENT, service: "-", action: "-", outcome: "denied", detail: `capability ${verified.reason}` });
      return Response.json({ ok: false, error: `capability ${verified.reason}` }, { status: 401 });
    }
    const claims: CapabilityClaims = verified.claims;

    if (claims.repo !== this.repository) {
      await this.record({ agent: claims.sub, jti: claims.jti, service: claims.service, action: claims.action, outcome: "denied", detail: "capability is for another repository" });
      return Response.json({ ok: false, error: "capability is for another repository" }, { status: 403 });
    }

    // The capability names its own service/action; a request may only restate
    // them, never widen them.
    const service = typeof body.service === "string" ? body.service : claims.service;
    const action = typeof body.action === "string" ? body.action : claims.action;
    if (service !== claims.service || action !== claims.action) {
      await this.record({ agent: claims.sub, jti: claims.jti, service, action, outcome: "denied", detail: "capability is for a different action" });
      return Response.json({ ok: false, error: "capability is for a different action" }, { status: 403 });
    }
    if (!hasPermission(service, action)) {
      await this.record({ agent: claims.sub, jti: claims.jti, service, action, outcome: "denied", detail: "action not permitted" });
      return Response.json({ ok: false, error: "action not permitted" }, { status: 403 });
    }

    const params =
      typeof body.params === "object" && body.params !== null
        ? (body.params as Record<string, unknown>)
        : undefined;

    const outcome = await executeSignedRequest(
      { service, action, repository: this.repository, params },
      {
        fetchImpl: fetch,
        readCredential: (envName) => {
          const value = (this.env as unknown as Record<string, unknown>)[envName];
          return typeof value === "string" ? value : undefined;
        },
      },
    );

    if (!outcome.ok) {
      const auditId = await this.record({
        agent: claims.sub,
        jti: claims.jti,
        service,
        action,
        outcome: outcome.status === 503 ? "unavailable" : "denied",
        status: outcome.status,
        detail: outcome.reason,
      });
      return Response.json({ ok: false, error: outcome.reason, auditId }, { status: outcome.status });
    }

    const execution: BrokerExecution = outcome.execution;
    const auditId = await this.record({
      agent: claims.sub,
      jti: claims.jti,
      service,
      action,
      outcome: "executed",
      status: execution.status,
      durationMs: execution.durationMs,
      detail: null,
    });

    return Response.json({
      ok: true,
      status: execution.status,
      body: execution.body,
      truncated: execution.truncated,
      redactions: execution.redactions,
      durationMs: execution.durationMs,
      service,
      action,
      auditId,
      // Deliberately no upstream headers: they can carry cookies or auth echoes.
    }, { status: 200 });
  }

  // --------------------------------------------------------------- audit

  private audit(url: URL): Response {
    const requested = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 200) : 50;

    const rows = this.sql
      .exec<AuditRow>(
        `SELECT id, at, agent, jti, service, action, outcome, status, duration_ms, detail
         FROM credential_audit ORDER BY id DESC LIMIT ?`,
        limit,
      )
      .toArray();

    return Response.json({
      ok: true,
      repository: this.repository,
      count: rows.length,
      entries: rows.map((row) => ({
        id: row.id,
        at: row.at,
        agent: row.agent,
        jti: row.jti,
        service: row.service,
        action: row.action,
        outcome: row.outcome,
        status: row.status,
        durationMs: row.duration_ms,
        detail: row.detail,
      })),
    });
  }

  private async record(entry: {
    agent: string;
    jti?: string;
    service: string;
    action: string;
    outcome: string;
    status?: number;
    durationMs?: number;
    detail: string | null;
  }): Promise<number> {
    const cursor = this.sql.exec<{ id: number }>(
      `INSERT INTO credential_audit (at, agent, jti, service, action, outcome, status, duration_ms, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
      new Date().toISOString(),
      entry.agent,
      entry.jti ?? null,
      entry.service,
      entry.action,
      entry.outcome,
      entry.status ?? null,
      entry.durationMs ?? null,
      entry.detail,
    );
    return cursor.one().id;
  }
}

interface AuditRow extends Record<string, SqlStorageValue> {
  id: number;
  at: string;
  agent: string;
  jti: string | null;
  service: string;
  action: string;
  outcome: string;
  status: number | null;
  duration_ms: number | null;
  detail: string | null;
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

