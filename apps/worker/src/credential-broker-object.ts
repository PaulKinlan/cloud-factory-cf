import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import {
  DEFAULT_CAPABILITY_TTL_SECONDS,
  issueCapability,
  verifyCapability,
  type CapabilityClaims,
} from "./credentials/capability";
import { executeSignedRequest, type BrokerExecution } from "./credentials/broker";
import { credentialEnvFor, hasPermission, isApprovedCredentialBinding } from "./credentials/policy";

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

/** Sliding window for the per-agent quota; also the `Retry-After` horizon. */
export const QUOTA_WINDOW_MS = 60_000;

/** Calls per (agent, service, action) per window when BROKER_QUOTA_PER_MINUTE is unset. */
export const DEFAULT_QUOTA_PER_MINUTE = 60;

/**
 * Parses `BROKER_QUOTA_PER_MINUTE`. Only a plain non-negative integer is
 * honoured, and only an explicit `"0"` disables the throttle: an empty,
 * whitespace, negative, fractional or non-numeric value falls back to the safe
 * default rather than silently disabling the limit.
 */
export function parseQuotaLimit(raw: unknown): number {
  if (typeof raw !== "string") return DEFAULT_QUOTA_PER_MINUTE;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_QUOTA_PER_MINUTE;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_QUOTA_PER_MINUTE;
  return parsed;
}

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
      return Response.json({
        ok: true,
        service,
        action,
        permitted: this.isActionAllowed(service, action),
        narrowedByRepository: this.narrowedActions(service) !== null,
      });
    }
    if (url.pathname === "/provisioning") {
      return this.provisioning(request, url);
    }
    if (url.pathname === "/overrides") {
      return this.overrides(request);
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
    // One row per proxied call inside the window. Rows are pruned on every
    // check, so the table is bounded by the quota itself.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS credential_quota (
        at_ms INTEGER NOT NULL,
        agent TEXT NOT NULL,
        service TEXT NOT NULL,
        action TEXT NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS credential_quota_key_idx
        ON credential_quota (agent, service, action, at_ms);
    `);
    // Per-repository overrides: which env binding holds the credential for a
    // service, and an optional narrower action allowlist for the repository.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS repo_overrides (
        service TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (service, kind)
      );
    `);
    // Agents the control plane has allowed to receive capabilities. `action` may
    // be "*" to allow every action the policy table permits for that service.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_provisioning (
        agent TEXT NOT NULL,
        service TEXT NOT NULL,
        action TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (agent, service, action)
      );
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
    if (!this.isActionAllowed(service, action)) {
      const detail = hasPermission(service, action)
        ? "action not allowed in this repository"
        : "action not permitted";
      await this.record({ agent, service, action, outcome: "denied", detail });
      return Response.json({ ok: false, error: detail }, { status: 403 });
    }
    if (this.requiresProvisioning && !this.isProvisioned(agent, service, action)) {
      await this.record({
        agent,
        service,
        action,
        outcome: "denied",
        detail: "agent is not provisioned for this action",
      });
      return Response.json(
        { ok: false, error: "agent is not provisioned for this action" },
        { status: 403 },
      );
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
    if (!this.isActionAllowed(service, action)) {
      // A capability minted before the repository was narrowed is refused here,
      // not only at issuance.
      const detail = hasPermission(service, action)
        ? "action not allowed in this repository"
        : "action not permitted";
      await this.record({ agent: claims.sub, jti: claims.jti, service, action, outcome: "denied", detail });
      return Response.json({ ok: false, error: detail }, { status: 403 });
    }

    const quota = this.consumeQuota(claims.sub, service, action);
    if (!quota.allowed) {
      const auditId = await this.record({
        agent: claims.sub,
        jti: claims.jti,
        service,
        action,
        outcome: "quota_exceeded",
        status: 429,
        detail: `more than ${this.quotaLimit} calls in ${QUOTA_WINDOW_MS / 1000}s`,
      });
      return Response.json(
        {
          ok: false,
          error: "quota exceeded",
          retryAfter: quota.retryAfter,
          limit: this.quotaLimit,
          windowSeconds: QUOTA_WINDOW_MS / 1000,
          auditId,
        },
        { status: 429, headers: { "retry-after": String(quota.retryAfter) } },
      );
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
        credentialBindingFor: (service) => this.credentialBinding(service),
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

  // -------------------------------------------------------- provisioning

  /** Provisioning is enforced unless `BROKER_REQUIRE_PROVISIONING` is "0"/"false". */
  private get requiresProvisioning(): boolean {
    const raw = this.env.BROKER_REQUIRE_PROVISIONING;
    if (typeof raw !== "string") return true;
    const normalised = raw.trim().toLowerCase();
    return normalised !== "0" && normalised !== "false" && normalised !== "no";
  }

  /** Exact (agent, service, action) row, or an `action = "*"` row for the service. */
  private isProvisioned(agent: string, service: string, action: string): boolean {
    const row = this.sql
      .exec<{ present: number }>(
        `SELECT 1 AS present FROM agent_provisioning
         WHERE agent = ? AND service = ? AND (action = ? OR action = '*') LIMIT 1`,
        agent,
        service,
        action,
      )
      .toArray();
    return row.length > 0;
  }

  /**
   * Control-plane surface for provisioning records. Agents cannot provision
   * themselves: every method requires the same key that mints capabilities.
   */
  private async provisioning(request: Request, url: URL): Promise<Response> {
    const provisioningKey = this.env.BROKER_CONTROL_KEY;
    if (!provisioningKey) {
      return Response.json({ ok: false, error: "broker control key not configured" }, { status: 503 });
    }
    const authorised = await sameSecret(provisioningKey, request.headers.get("x-factory-control-key"));
    if (!authorised) {
      await this.record({
        agent: DEFAULT_CLIENT,
        service: "-",
        action: "-",
        outcome: "denied",
        detail: "bad control key on provisioning",
      });
      return Response.json({ ok: false, error: "not authorised to provision agents" }, { status: 401 });
    }

    if (request.method === "GET") {
      const rows = this.sql
        .exec<{ agent: string; service: string; action: string; created_at: string }>(
          `SELECT agent, service, action, created_at FROM agent_provisioning ORDER BY agent, service, action`,
        )
        .toArray();
      return Response.json({
        ok: true,
        repository: this.repository,
        enforced: this.requiresProvisioning,
        count: rows.length,
        entries: rows.map((row) => ({
          agent: row.agent,
          service: row.service,
          action: row.action,
          createdAt: row.created_at,
        })),
      });
    }

    const body =
      request.method === "POST" || request.method === "DELETE"
        ? ((await readJson(request)) as { agent?: unknown; service?: unknown; action?: unknown })
        : {};
    const agent = typeof body.agent === "string" ? body.agent.trim() : "";
    const service = typeof body.service === "string" ? body.service.trim() : "";
    const action = typeof body.action === "string" ? body.action.trim() : "";
    if (!agent || !service || !action) {
      return Response.json(
        { ok: false, error: "agent, service and action are required ('*' allows every action)" },
        { status: 400 },
      );
    }

    if (request.method === "POST") {
      if (!hasPermission(service, action) && action !== "*") {
        return Response.json({ ok: false, error: "action not permitted by policy" }, { status: 403 });
      }
      this.sql.exec(
        `INSERT OR IGNORE INTO agent_provisioning (agent, service, action, created_at) VALUES (?, ?, ?, ?)`,
        agent,
        service,
        action,
        new Date().toISOString(),
      );
      await this.record({ agent, service, action, outcome: "provisioned", detail: null });
      return Response.json({ ok: true, agent, service, action, repository: this.repository });
    }

    if (request.method === "DELETE") {
      const before = this.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM agent_provisioning WHERE agent = ? AND service = ? AND action = ?`,
          agent,
          service,
          action,
        )
        .one();
      this.sql.exec(
        `DELETE FROM agent_provisioning WHERE agent = ? AND service = ? AND action = ?`,
        agent,
        service,
        action,
      );
      if (before.count === 0) {
        return Response.json({ ok: false, error: "no such provisioning record" }, { status: 404 });
      }
      await this.record({ agent, service, action, outcome: "deprovisioned", detail: null });
      return Response.json({ ok: true, agent, service, action, revoked: before.count });
    }

    return new Response("method not allowed", { status: 405 });
  }

  // ------------------------------------------------------------ overrides

  private overrideValue(service: string, kind: OverrideKind): string | null {
    const rows = this.sql
      .exec<{ value: string }>(
        `SELECT value FROM repo_overrides WHERE service = ? AND kind = ?`,
        service,
        kind,
      )
      .toArray();
    return rows[0]?.value ?? null;
  }

  /** Env binding the repository uses for a service, or undefined for the policy default. */
  private credentialBinding(service: string): string | undefined {
    const value = this.overrideValue(service, "credential_binding");
    return value !== null && isApprovedCredentialBinding(service, value) ? value : undefined;
  }

  /** `null` means "not narrowed"; an array means only those actions are allowed. */
  private narrowedActions(service: string): string[] | null {
    const value = this.overrideValue(service, "allowed_actions");
    if (value === null) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is string => typeof entry === "string");
    } catch {
      // A corrupt row fails closed rather than opening the service back up.
      return [];
    }
  }

  /** Policy allowlist, then the repository's narrower allowlist when it has one. */
  private isActionAllowed(service: string, action: string): boolean {
    if (!hasPermission(service, action)) return false;
    const narrowed = this.narrowedActions(service);
    return narrowed === null || narrowed.includes(action);
  }

  /**
   * Control-plane surface for per-repository overrides:
   *   POST   { service, kind: "credential_binding", value: "GITHUB_TOKEN_X" }
   *   POST   { service, kind: "allowed_actions", value: ["repo.read", ...] }
   *   DELETE { service, kind }
   *   GET    (list)
   * Overrides can only narrow the policy: an action outside it is a 400.
   */
  private async overrides(request: Request): Promise<Response> {
    const provisioningKey = this.env.BROKER_CONTROL_KEY;
    if (!provisioningKey) {
      return Response.json({ ok: false, error: "broker control key not configured" }, { status: 503 });
    }
    const authorised = await sameSecret(provisioningKey, request.headers.get("x-factory-control-key"));
    if (!authorised) {
      await this.record({
        agent: DEFAULT_CLIENT,
        service: "-",
        action: "-",
        outcome: "denied",
        detail: "bad control key on overrides",
      });
      return Response.json({ ok: false, error: "not authorised to change overrides" }, { status: 401 });
    }

    if (request.method === "GET") {
      const rows = this.sql
        .exec<{ service: string; kind: string; value: string; updated_at: string }>(
          `SELECT service, kind, value, updated_at FROM repo_overrides ORDER BY service, kind`,
        )
        .toArray();
      return Response.json({
        ok: true,
        repository: this.repository,
        entries: rows.map((row) => ({
          service: row.service,
          kind: row.kind,
          value: row.kind === "allowed_actions" ? this.narrowedActions(row.service) : row.value,
          updatedAt: row.updated_at,
        })),
      });
    }

    const body = (await readJson(request)) as { service?: unknown; kind?: unknown; value?: unknown };
    const service = typeof body.service === "string" ? body.service.trim() : "";
    const kind = typeof body.kind === "string" ? body.kind.trim() : "";
    if (!service || !isOverrideKind(kind)) {
      return Response.json(
        { ok: false, error: 'service and kind ("credential_binding" | "allowed_actions") are required' },
        { status: 400 },
      );
    }

    if (request.method === "POST") {
      if (kind === "credential_binding") {
        // Only this service's own credential binding (or a sibling of it) may be
        // selected: a broker key or another service's token must never be
        // attachable to an upstream request.
        if (typeof body.value !== "string" || !isApprovedCredentialBinding(service, body.value)) {
          return Response.json(
            {
              ok: false,
              error: `value must be the ${service} credential binding or a sibling of it (e.g. ${credentialEnvFor(service) ?? "SERVICE_TOKEN"}_INSTALL_2)`,
            },
            { status: 400 },
          );
        }
        this.writeOverride(service, kind, body.value);
        await this.record({ agent: DEFAULT_CLIENT, service, action: kind, outcome: "override_set", detail: body.value });
        return Response.json({ ok: true, service, kind, value: body.value });
      }

      const requested = Array.isArray(body.value) ? body.value : [];
      const actions: string[] = [];
      for (const entry of requested) {
        if (typeof entry !== "string" || entry.trim().length === 0) {
          return Response.json({ ok: false, error: "value must be an array of action names" }, { status: 400 });
        }
        const action = entry.trim();
        if (!hasPermission(service, action)) {
          // Widening (or a typo) is a 400, never a silent extra allowance.
          return Response.json(
            { ok: false, error: `action ${action} is not permitted by policy for ${service}` },
            { status: 400 },
          );
        }
        if (!actions.includes(action)) actions.push(action);
      }
      this.writeOverride(service, kind, JSON.stringify(actions));
      await this.record({ agent: DEFAULT_CLIENT, service, action: kind, outcome: "override_set", detail: actions.join(",") });
      return Response.json({ ok: true, service, kind, value: actions });
    }

    if (request.method === "DELETE") {
      const before = this.overrideValue(service, kind);
      this.sql.exec(`DELETE FROM repo_overrides WHERE service = ? AND kind = ?`, service, kind);
      if (before === null) {
        return Response.json({ ok: false, error: "no such override" }, { status: 404 });
      }
      await this.record({ agent: DEFAULT_CLIENT, service, action: kind, outcome: "override_cleared", detail: null });
      return Response.json({ ok: true, service, kind });
    }

    return new Response("method not allowed", { status: 405 });
  }

  private writeOverride(service: string, kind: OverrideKind, value: string): void {
    this.sql.exec(
      `INSERT INTO repo_overrides (service, kind, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (service, kind) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      service,
      kind,
      value,
      new Date().toISOString(),
    );
  }

  // --------------------------------------------------------------- quota

  /** `BROKER_QUOTA_PER_MINUTE`; only an explicit "0" disables the quota. */
  private get quotaLimit(): number {
    return parseQuotaLimit(this.env.BROKER_QUOTA_PER_MINUTE);
  }

  /**
   * Sliding-window quota per (agent, service, action), counted after the
   * capability and policy checks so a denied request never spends a slot, and
   * before the upstream call so a replayed capability cannot flood a provider.
   * Every allowed call spends a slot, including ones whose upstream call fails.
   */
  private consumeQuota(
    agent: string,
    service: string,
    action: string,
  ): { allowed: boolean; retryAfter: number } {
    const limit = this.quotaLimit;
    if (limit === 0) return { allowed: true, retryAfter: 0 };

    const now = Date.now();
    const windowStart = now - QUOTA_WINDOW_MS;
    this.sql.exec(`DELETE FROM credential_quota WHERE at_ms <= ?`, windowStart);

    const row = this.sql
      .exec<{ count: number; oldest: number | null }>(
        `SELECT COUNT(*) AS count, MIN(at_ms) AS oldest
         FROM credential_quota WHERE agent = ? AND service = ? AND action = ?`,
        agent,
        service,
        action,
      )
      .one();

    if (row.count >= limit) {
      const oldest = row.oldest ?? now;
      const retryAfter = Math.max(1, Math.ceil((oldest + QUOTA_WINDOW_MS - now) / 1000));
      return { allowed: false, retryAfter };
    }

    this.sql.exec(
      `INSERT INTO credential_quota (at_ms, agent, service, action) VALUES (?, ?, ?, ?)`,
      now,
      agent,
      service,
      action,
    );
    return { allowed: true, retryAfter: 0 };
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

type OverrideKind = "credential_binding" | "allowed_actions";

function isOverrideKind(value: string): value is OverrideKind {
  return value === "credential_binding" || value === "allowed_actions";
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

/** Constant-time-ish comparison of a provisioning secret. */
async function sameSecret(expected: string, provided: string | null): Promise<boolean> {
  if (!provided || provided.length === 0) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) {
    difference |= (left[i] as number) ^ (right[i] as number);
  }
  return difference === 0;
}
