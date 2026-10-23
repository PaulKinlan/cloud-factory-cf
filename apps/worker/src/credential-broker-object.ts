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
import { sameSecret } from "./secrets";
import { verifyDelegation } from "./auth/delegation";

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
    if (url.pathname === "/settings") {
      return this.handleSettings(request);
    }
    if (request.method === "GET" && url.pathname === "/internal-setting") {
      const key = url.searchParams.get("key");
      return Response.json({ ok: true, value: key ? this.getSetting(key) : null });
    }
    if (request.method === "GET" && url.pathname === "/passkeys") {
      const id = url.searchParams.get("id");
      const subject = url.searchParams.get("subject");
      let query = "SELECT credential_id, subject, role, public_key_spki, algorithm, label, created_at, last_used_at FROM passkey_credentials";
      const params: string[] = [];
      if (id) {
        query += " WHERE credential_id = ?";
        params.push(id);
      } else if (subject) {
        query += " WHERE subject = ?";
        params.push(subject);
      }
      query += " ORDER BY created_at DESC";
      const rows = this.sql.exec<any>(query, ...params).toArray();
      return Response.json({
        ok: true,
        count: rows.length,
        passkeys: rows.map((r) => ({
          credentialId: r.credential_id,
          subject: r.subject,
          role: r.role,
          publicKeySpki: r.public_key_spki,
          algorithm: Number(r.algorithm),
          label: r.label,
          createdAt: r.created_at,
          lastUsedAt: r.last_used_at,
        })),
      });
    }
    if (request.method === "POST" && url.pathname === "/passkeys") {
      const body = (await readJson(request)) as Record<string, any>;
      const { credentialId, subject, role, publicKeySpki, algorithm, label } = body;
      if (!credentialId || !subject || !publicKeySpki) {
        return Response.json({ ok: false, error: "missing required passkey fields" }, { status: 400 });
      }
      const now = new Date().toISOString();
      this.sql.exec(
        `INSERT INTO passkey_credentials (credential_id, subject, role, public_key_spki, algorithm, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (credential_id) DO UPDATE SET
           subject = excluded.subject,
           role = excluded.role,
           public_key_spki = excluded.public_key_spki,
           algorithm = excluded.algorithm,
           label = excluded.label`,
        String(credentialId),
        String(subject),
        String(role ?? "user"),
        String(publicKeySpki),
        Number(algorithm ?? -7),
        String(label ?? "Passkey"),
        now,
      );
      return Response.json({ ok: true, credentialId });
    }
    if (request.method === "POST" && url.pathname === "/passkeys/touch") {
      const body = (await readJson(request)) as Record<string, any>;
      const id = String(body?.credentialId ?? "");
      if (id) {
        this.sql.exec(`UPDATE passkey_credentials SET last_used_at = ? WHERE credential_id = ?`, new Date().toISOString(), id);
      }
      return Response.json({ ok: true });
    }
    if (request.method === "DELETE" && url.pathname === "/passkeys") {
      const id = url.searchParams.get("id");
      const subject = url.searchParams.get("subject");
      if (id) {
        if (subject) {
          this.sql.exec(`DELETE FROM passkey_credentials WHERE credential_id = ? AND subject = ?`, id, subject);
        } else {
          this.sql.exec(`DELETE FROM passkey_credentials WHERE credential_id = ?`, id);
        }
        return Response.json({ ok: true, deleted: id });
      }
      return Response.json({ ok: false, error: "missing id" }, { status: 400 });
    }
    if (url.pathname === "/effective-webhook-secret") {
      const effective = (await this.resolveEffectiveSetting("webhook.secret")) ?? this.env.WEBHOOK_SECRET ?? null;
      if (!effective) {
        return Response.json({ ok: false, error: "no webhook secret configured" }, { status: 503 });
      }
      return Response.json({ ok: true, secret: effective });
    }
    if (url.pathname === "/effective-github-app") {
      const appId = (await this.resolveEffectiveSetting("github.app_id")) || this.env.GITHUB_APP_ID || null;
      const appSlug = (await this.resolveEffectiveSetting("github.app_slug")) || this.env.GITHUB_APP_SLUG || null;
      const clientId = (await this.resolveEffectiveSetting("github.client_id")) || this.env.GITHUB_CLIENT_ID || null;
      const clientSecret = (await this.resolveEffectiveSetting("github.client_secret")) || this.env.GITHUB_CLIENT_SECRET || null;
      const privateKey = (await this.resolveEffectiveSetting("github.private_key")) || this.env.GITHUB_PRIVATE_KEY || null;
      const webhookSecret = (await this.resolveEffectiveSetting("webhook.secret")) || this.env.WEBHOOK_SECRET || null;
      return Response.json({
        ok: true,
        appId,
        appSlug,
        clientId,
        clientSecret,
        privateKey,
        webhookSecret,
      });
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
    // Repository-level configuration & admin settings (GitHub App, BYOK AI keys, Webhooks).
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS repo_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // WebAuthn Passkeys registered for Root Admin and Users
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS passkey_credentials (
        credential_id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        role TEXT NOT NULL,
        public_key_spki TEXT NOT NULL,
        algorithm INTEGER NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS passkey_subject_idx ON passkey_credentials (subject);
    `);
  }

  // ------------------------------------------------------------- issuance

  /** The delegation on this request, verified against this object's own repository. */
  private async verifyDelegationHeader(
    request: Request,
  ): Promise<{ ok: true; claims: { login: string; repo: string; exp: number; jti: string } } | { ok: false }> {
    const signingKey = this.env.BROKER_SIGNING_KEY ?? this.env.BROKER_CONTROL_KEY;
    const token = request.headers.get("x-factory-delegation");
    if (!signingKey || !token) return { ok: false };
    const result = await verifyDelegation(signingKey, token, { repository: this.repository });
    return result.ok ? { ok: true, claims: result.claims } : { ok: false };
  }

  private async issue(request: Request): Promise<Response> {
    const provisioningKey = this.env.BROKER_CONTROL_KEY;
    const signingKeyConfigured = this.env.BROKER_SIGNING_KEY !== undefined;
    if (!provisioningKey && !signingKeyConfigured) {
      return Response.json({ ok: false, error: "broker control key not configured" }, { status: 503 });
    }
    const presented = request.headers.get("x-factory-control-key");
    const delegated = await this.verifyDelegationHeader(request);
    const authorised =
      delegated.ok || (provisioningKey !== undefined && (await sameSecret(provisioningKey, presented)));
    if (!authorised) {
      await this.record({ agent: DEFAULT_CLIENT, service: "-", action: "-", outcome: "denied", detail: "bad control key" });
      return Response.json({ ok: false, error: "not authorised to issue capabilities" }, { status: 401 });
    }
    const delegatedLogin = delegated.ok ? delegated.claims.login : undefined;

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
      ...(delegatedLogin === undefined ? {} : { login: delegatedLogin }),
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

    // Pre-resolve credentials for the target service before executing signed request (repo -> user -> default -> env)
    const envForService = credentialEnvFor(service);
    let resolvedCredentialValue: string | undefined = undefined;
    if (envForService) {
      const settingKey = this.settingKeyForEnv(envForService);
      if (settingKey) {
        const val = await this.resolveEffectiveSetting(settingKey);
        if (val) resolvedCredentialValue = val;
      }
    }

    const outcome = await executeSignedRequest(
      { service, action, repository: this.repository, params },
      {
        fetchImpl: fetch,
        readCredential: (envName) => {
          if (envForService && envName === envForService && resolvedCredentialValue) {
            return resolvedCredentialValue;
          }
          const settingKey = this.settingKeyForEnv(envName);
          if (settingKey) {
            const stored = this.getSetting(settingKey);
            if (stored) return stored;
          }
          const value = (this.env as unknown as Record<string, unknown>)[envName];
          return typeof value === "string" ? value : undefined;
        },
        credentialBindingFor: (service) => this.credentialBinding(service),
        readEnv: (name) => {
          const value = (this.env as unknown as Record<string, unknown>)[name];
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

  // ------------------------------------------------------------- admin settings

  private async handleSettings(request: Request): Promise<Response> {
    const provisioningKey = this.env.BROKER_CONTROL_KEY;
    const signingKeyConfigured = this.env.BROKER_SIGNING_KEY !== undefined;
    if (!provisioningKey && !signingKeyConfigured) {
      return Response.json({ ok: false, error: "broker control key not configured" }, { status: 503 });
    }
    const presented = request.headers.get("x-factory-control-key");
    const delegated = await this.verifyDelegationHeader(request);
    const authorised =
      delegated.ok || (provisioningKey !== undefined && (await sameSecret(provisioningKey, presented)));
    if (!authorised) {
      return Response.json({ ok: false, error: "not authorised to manage settings" }, { status: 401 });
    }

    if (request.method === "GET") {
      const rows = this.sql
        .exec<{ key: string; value: string; updated_at: string }>(
          `SELECT key, value, updated_at FROM repo_settings`
        )
        .toArray();
      const settingsMap = new Map<string, string>();
      for (const row of rows) {
        settingsMap.set(row.key, row.value);
      }

      const appId = settingsMap.get("github.app_id") ?? "";
      const clientId = settingsMap.get("github.client_id") ?? "";
      const clientSecret = settingsMap.get("github.client_secret") ?? "";
      const privateKey = settingsMap.get("github.private_key") ?? "";

      const anthropicKey = settingsMap.get("ai.anthropic_key") ?? "";
      const openaiKey = settingsMap.get("ai.openai_key") ?? "";
      const deepseekKey = settingsMap.get("ai.deepseek_key") ?? "";
      const geminiKey = settingsMap.get("ai.gemini_key") ?? "";

      const storedWebhookSecret = settingsMap.get("webhook.secret");
      const hasEnvWebhookSecret = Boolean(this.env.WEBHOOK_SECRET);
      const isWebhookConfigured = Boolean(storedWebhookSecret || hasEnvWebhookSecret);
      const webhookSecretMasked = storedWebhookSecret
        ? maskSecret(storedWebhookSecret)
        : hasEnvWebhookSecret
          ? "•••••••• (environment default)"
          : "";

      return Response.json({
        ok: true,
        repository: this.repository,
        githubApp: {
          appId,
          appSlug: settingsMap.get("github.app_slug") || this.env.GITHUB_APP_SLUG || "",
          clientId,
          hasClientSecret: clientSecret.length > 0,
          clientSecretMasked: maskSecret(clientSecret),
          hasPrivateKey: privateKey.length > 0,
          privateKeyFingerprint: privateKey ? await computePemFingerprint(privateKey) : null,
        },
        customers: {
          allowAllGithubUsers: settingsMap.get("customers.allow_all") === "true",
          allowedUsers: (settingsMap.get("customers.allowed_users") || "")
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
          platformOwners: (settingsMap.get("platform.owners") || this.env.PLATFORM_OWNERS || "")
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
        },
        aiProviders: {
          anthropic: {
            configured: anthropicKey.length > 0,
            maskedKey: maskSecret(anthropicKey),
            model: settingsMap.get("ai.anthropic_model") || "claude-sonnet-5-5",
          },
          openai: {
            configured: openaiKey.length > 0,
            maskedKey: maskSecret(openaiKey),
            model: settingsMap.get("ai.openai_model") || "gpt-6-astra",
          },
          deepseek: {
            configured: deepseekKey.length > 0,
            maskedKey: maskSecret(deepseekKey),
            model: settingsMap.get("ai.deepseek_model") || "deepseek-chat",
          },
          gemini: {
            configured: geminiKey.length > 0,
            maskedKey: maskSecret(geminiKey),
            model: settingsMap.get("ai.gemini_model") || "gemini-3.8-flash",
          },
        },
        webhook: {
          configured: isWebhookConfigured,
          isRepoOverride: Boolean(storedWebhookSecret),
          secretMasked: webhookSecretMasked,
          url: `/webhooks/github/${this.repository}`,
        },
      });
    }

    if (request.method === "POST") {
      const body = (await readJson(request)) as Record<string, any>;
      const now = new Date().toISOString();
      const updatedKeys: string[] = [];

      if (body.githubApp && typeof body.githubApp === "object") {
        const { appId, appSlug, clientId, clientSecret, privateKey } = body.githubApp;
        if (typeof appId === "string") {
          this.setSetting("github.app_id", appId.trim(), now);
          updatedKeys.push("github.app_id");
        }
        if (typeof appSlug === "string") {
          this.setSetting("github.app_slug", appSlug.trim(), now);
          updatedKeys.push("github.app_slug");
        }
        if (typeof clientId === "string") {
          this.setSetting("github.client_id", clientId.trim(), now);
          updatedKeys.push("github.client_id");
        }
        if (typeof clientSecret === "string" && clientSecret.trim().length > 0) {
          if (clientSecret.includes("••••")) {
            return Response.json({ ok: false, error: "Masked values cannot be stored as secrets" }, { status: 400 });
          }
          this.setSetting("github.client_secret", clientSecret.trim(), now);
          updatedKeys.push("github.client_secret");
        }
        if (typeof privateKey === "string" && privateKey.trim().length > 0) {
          if (privateKey.includes("••••")) {
            return Response.json({ ok: false, error: "Masked values cannot be stored as secrets" }, { status: 400 });
          }
          if (!isValidPem(privateKey)) {
            return Response.json(
              {
                ok: false,
                error: "Invalid PEM private key format: must start with -----BEGIN ... PRIVATE KEY----- and end with -----END ... PRIVATE KEY-----",
              },
              { status: 400 },
            );
          }
          this.setSetting("github.private_key", privateKey.trim(), now);
          updatedKeys.push("github.private_key");
        }
      }

      if (body.aiProviders && typeof body.aiProviders === "object") {
        const { anthropic, openai, deepseek, gemini } = body.aiProviders;
        if (typeof anthropic?.key === "string" && anthropic.key.trim().length > 0) {
          if (anthropic.key.includes("••••")) {
            return Response.json({ ok: false, error: "Masked values cannot be stored as keys" }, { status: 400 });
          }
          if (!anthropic.key.startsWith("sk-ant-") || anthropic.key.length < 20) {
            return Response.json({ ok: false, error: "Anthropic API key must start with sk-ant- and be at least 20 chars" }, { status: 400 });
          }
          this.setSetting("ai.anthropic_key", anthropic.key.trim(), now);
          updatedKeys.push("ai.anthropic_key");
        }
        if (typeof anthropic?.model === "string" && anthropic.model.trim().length > 0) {
          this.setSetting("ai.anthropic_model", anthropic.model.trim(), now);
          updatedKeys.push("ai.anthropic_model");
        }
        if (typeof openai?.key === "string" && openai.key.trim().length > 0) {
          if (openai.key.includes("••••")) {
            return Response.json({ ok: false, error: "Masked values cannot be stored as keys" }, { status: 400 });
          }
          if (!openai.key.startsWith("sk-") || openai.key.length < 20) {
            return Response.json({ ok: false, error: "OpenAI API key must start with sk- and be at least 20 chars" }, { status: 400 });
          }
          this.setSetting("ai.openai_key", openai.key.trim(), now);
          updatedKeys.push("ai.openai_key");
        }
        if (typeof openai?.model === "string" && openai.model.trim().length > 0) {
          this.setSetting("ai.openai_model", openai.model.trim(), now);
          updatedKeys.push("ai.openai_model");
        }
        if (typeof deepseek?.key === "string" && deepseek.key.trim().length > 0) {
          if (deepseek.key.includes("••••")) {
            return Response.json({ ok: false, error: "Masked values cannot be stored as keys" }, { status: 400 });
          }
          if (!deepseek.key.startsWith("sk-") || deepseek.key.length < 20) {
            return Response.json({ ok: false, error: "DeepSeek API key must start with sk- and be at least 20 chars" }, { status: 400 });
          }
          this.setSetting("ai.deepseek_key", deepseek.key.trim(), now);
          updatedKeys.push("ai.deepseek_key");
        }
        if (typeof deepseek?.model === "string" && deepseek.model.trim().length > 0) {
          this.setSetting("ai.deepseek_model", deepseek.model.trim(), now);
          updatedKeys.push("ai.deepseek_model");
        }
        if (typeof gemini?.key === "string" && gemini.key.trim().length > 0) {
          if (gemini.key.includes("••••")) {
            return Response.json({ ok: false, error: "Masked values cannot be stored as keys" }, { status: 400 });
          }
          if (!gemini.key.startsWith("AIza") || gemini.key.length < 20) {
            return Response.json({ ok: false, error: "Gemini API key must start with AIza and be at least 20 chars" }, { status: 400 });
          }
          this.setSetting("ai.gemini_key", gemini.key.trim(), now);
          updatedKeys.push("ai.gemini_key");
        }
        if (typeof gemini?.model === "string" && gemini.model.trim().length > 0) {
          this.setSetting("ai.gemini_model", gemini.model.trim(), now);
          updatedKeys.push("ai.gemini_model");
        }
      }

      if (typeof body.webhookSecret === "string" && body.webhookSecret.trim().length > 0) {
        if (body.webhookSecret.includes("••••")) {
          return Response.json({ ok: false, error: "Masked values cannot be stored as secrets" }, { status: 400 });
        }
        this.setSetting("webhook.secret", body.webhookSecret.trim(), now);
        updatedKeys.push("webhook.secret");
      }

      if (body.customers && typeof body.customers === "object") {
        if (typeof body.customers.allowAllGithubUsers === "boolean") {
          this.setSetting("customers.allow_all", String(body.customers.allowAllGithubUsers), now);
          updatedKeys.push("customers.allow_all");
        }
        if (Array.isArray(body.customers.allowedUsers)) {
          const list = body.customers.allowedUsers.map((u: unknown) => String(u).trim()).filter(Boolean);
          this.setSetting("customers.allowed_users", list.join(","), now);
          updatedKeys.push("customers.allowed_users");
        }
        if (Array.isArray(body.customers.platformOwners)) {
          const owners = body.customers.platformOwners.map((o: unknown) => String(o).trim()).filter(Boolean);
          this.setSetting("platform.owners", owners.join(","), now);
          updatedKeys.push("platform.owners");
        }
      }

      return Response.json({ ok: true, updated: updatedKeys });
    }

    if (request.method === "DELETE") {
      const url = new URL(request.url);
      const key = url.searchParams.get("key");
      if (key) {
        this.sql.exec(`DELETE FROM repo_settings WHERE key = ?`, key);
      } else {
        this.sql.exec(`DELETE FROM repo_settings`);
      }
      return Response.json({ ok: true, deleted: key ?? "all" });
    }

    return new Response("method not allowed", { status: 405 });
  }

  private setSetting(key: string, value: string, now: string): void {
    this.sql.exec(
      `INSERT INTO repo_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      now,
    );
  }

  private settingKeyForEnv(envName: string): string | null {
    switch (envName) {
      case "ANTHROPIC_API_KEY":
        return "ai.anthropic_key";
      case "OPENAI_API_KEY":
        return "ai.openai_key";
      case "DEEPSEEK_API_KEY":
        return "ai.deepseek_key";
      case "GEMINI_API_KEY":
        return "ai.gemini_key";
      case "GITHUB_TOKEN":
        return "github.token";
      default:
        return null;
    }
  }

  private getSetting(key: string): string | null {
    const rows = this.sql
      .exec<{ value: string }>(`SELECT value FROM repo_settings WHERE key = ?`, key)
      .toArray();
    return rows.length > 0 && rows[0] ? rows[0].value : null;
  }

  private async resolveEffectiveSetting(key: string): Promise<string | null> {
    const direct = this.getSetting(key);
    if (direct !== null && direct.length > 0) return direct;

    const repoStr = this.repository;
    const cleanRepo = repoStr.includes(":") ? repoStr.split(":")[1]! : repoStr;
    if (cleanRepo && cleanRepo.includes("/")) {
      const owner = cleanRepo.split("/")[0]!;
      if (owner && this.env.CREDENTIAL_BROKER) {
        try {
          const ownerStub = this.env.CREDENTIAL_BROKER.get(this.env.CREDENTIAL_BROKER.idFromName(owner.toLowerCase()));
          const res = await ownerStub.fetch(`https://credential-broker.internal/internal-setting?key=${encodeURIComponent(key)}`);
          if (res.ok) {
            const data = (await res.json().catch(() => null)) as { ok?: boolean; value?: string | null } | null;
            if (data?.ok && typeof data.value === "string" && data.value.length > 0) {
              return data.value;
            }
          }
        } catch {
          // ignore lookup failure
        }
      }
    }

    if (repoStr !== "default" && this.env.CREDENTIAL_BROKER) {
      try {
        const defaultStub = this.env.CREDENTIAL_BROKER.get(this.env.CREDENTIAL_BROKER.idFromName("default"));
        const res = await defaultStub.fetch(`https://credential-broker.internal/internal-setting?key=${encodeURIComponent(key)}`);
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as { ok?: boolean; value?: string | null } | null;
          if (data?.ok && typeof data.value === "string" && data.value.length > 0) {
            return data.value;
          }
        }
      } catch {
        // ignore lookup failure
      }
    }

    return null;
  }
}

export function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "••••••••";
  const start = secret.slice(0, 4);
  const end = secret.slice(-4);
  return `${start}••••••••${end}`;
}

export async function computePemFingerprint(pem: string): Promise<string> {
  const clean = pem.replace(/-----[A-Z ]*-----/g, "").replace(/\s+/g, "");
  if (!clean) return "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clean));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex.slice(0, 16)}`;
}

export function isValidPem(pem: string): boolean {
  const trimmed = pem.trim();
  return /^-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END (?:[A-Z ]+ )?PRIVATE KEY-----$/.test(trimmed);
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

