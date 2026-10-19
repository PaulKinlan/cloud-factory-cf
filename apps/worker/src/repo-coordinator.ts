import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { CanvasStore, migrateCanvasTable } from "./canvas-store";
import { MemoryHandler, migrateMemoryTable } from "./memory";
import {
  deliveryIdFor,
  eventNameFor,
  isProvider,
  MAX_WEBHOOK_BYTES,
  normaliseEvent,
  verifyGithubSignature,
  verifyGitlabToken,
  type NormalisedEvent,
  type Provider,
} from "./webhooks";

/** An event that keeps failing is dead-lettered instead of retried forever. */
export const MAX_ATTEMPTS = 5;
/** How long a runner may hold a claimed event before it is handed back. */
export const DEFAULT_VISIBILITY_MS = 60_000;
/** Exponential-ish backoff between attempts: attempt * this, capped below. */
const RETRY_BACKOFF_MS = 2_000;
const RETRY_BACKOFF_CAP_MS = 60_000;

/**
 * Per-repository Durable Object: the coordinator for one repo's event stream.
 *
 * Responsibilities (webhook ingestion + a durable queue):
 *   1. verify the provider signature/token over the raw body,
 *   2. dedupe on the provider delivery id (redeliveries are acknowledged but
 *      not queued twice),
 *   3. persist the event in SQLite and expose a claim/ack/fail queue, so a
 *      runner can process events at-least-once,
 *   4. hand unacknowledged leases back to the queue (alarm driven), and
 *      dead-letter events that exhaust `MAX_ATTEMPTS`.
 *
 * The runner (agent) that consumes the queue is layered on later; this object
 * owns only the durable contract, which is what every sink depends on.
 */
export class RepoCoordinator extends DurableObject<Env> {
  private memoryHandler!: MemoryHandler;
  private canvasStore!: CanvasStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
    this.memoryHandler = new MemoryHandler(this.ctx.storage.sql);
    this.canvasStore = new CanvasStore(this.ctx.storage.sql, this.ctx.id.name ?? "");
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/events") {
      return this.ingest(request, url.searchParams.get("provider") ?? "github");
    }
    if (request.method === "GET" && url.pathname === "/events") {
      return this.listEvents(url);
    }
    if (request.method === "GET" && url.pathname.startsWith("/events/") && url.pathname.endsWith("/payload")) {
      const deliveryId = decodeURIComponent(url.pathname.slice("/events/".length, -"/payload".length));
      return this.eventPayload(deliveryId);
    }
    if (request.method === "POST" && url.pathname === "/claim") {
      return this.claim(await readJson(request));
    }
    if (request.method === "POST" && url.pathname === "/ack") {
      return this.ack(await readJson(request));
    }
    if (request.method === "POST" && url.pathname === "/fail") {
      return this.fail(await readJson(request));
    }
    if (request.method === "POST" && url.pathname === "/drain") {
      return this.drain();
    }
    if (request.method === "POST" && url.pathname === "/release") {
      return this.release(await readJson(request));
    }
    if (request.method === "POST" && url.pathname === "/deliveries/claim") {
      return this.claimDelivery(await readJson(request));
    }
    if (request.method === "POST" && url.pathname === "/deliveries/complete") {
      return this.completeDelivery(await readJson(request));
    }
    if (request.method === "GET" && url.pathname === "/deliveries") {
      return this.listDeliveries(url);
    }
    if (request.method === "POST" && url.pathname === "/runs/audit") {
      return this.recordRunAudit(await readJson(request));
    }
    if (request.method === "GET" && url.pathname === "/runs/audit") {
      return this.listRunAudit(url);
    }
    if (request.method === "POST" && url.pathname === "/requeue-expired") {
      const requeued = await this.requeueExpiredLeases();
      return Response.json({ ok: true, requeued });
    }
    if (url.pathname === "/canvas" || url.pathname.startsWith("/canvas/")) {
      // No id means "list" for GET and "create with a generated id" for PUT.
      const id = url.pathname === "/canvas" ? "" : decodeURIComponent(url.pathname.slice("/canvas/".length));
      if (request.method === "GET") return id ? this.canvasStore.get(id) : this.canvasStore.list(url);
      if (request.method === "PUT") return this.canvasStore.put(id, await readJson(request));
      if (request.method === "DELETE") return this.canvasStore.remove(id);
      return new Response("method not allowed", { status: 405 });
    }
    if (url.pathname.startsWith("/memory")) {
      const scope = url.searchParams.get("scope") ?? "repo";
      if (scope === "org") {
        return this.forwardToOrg(request);
      }
      return this.handleMemory(request, url);
    }
    if (request.method === "GET" && url.pathname === "/stats") {
      return this.stats();
    }

    return new Response("not found", { status: 404 });
  }

  /** Alarm entry point: hand expired leases back and re-arm for the next retry. */
  override async alarm(): Promise<void> {
    await this.requeueExpiredLeases();
    await this.armAlarm();
  }

  private migrate(): void {
    migrateMemoryTable(this.sql);
    migrateCanvasTable(this.sql);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        delivery_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        event TEXT NOT NULL,
        action TEXT,
        repository TEXT NOT NULL,
        actor TEXT,
        received_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        last_error TEXT,
        lease_id TEXT
      );
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS events_queue_idx ON events (status, available_at, received_at);
    `);
    try {
      this.sql.exec("ALTER TABLE events ADD COLUMN lease_id TEXT;");
    } catch {
      // Column already exists
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS run_audit (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        name TEXT NOT NULL,
        agents INTEGER NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS run_audit_document_idx ON run_audit (document_id, created_at);
    `);
    // One row per (event, agent): the ledger that makes a redelivered event skip
    // the agents that already delivered, so a fan-out retry cannot post twice.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS event_deliveries (
        delivery_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (delivery_id, agent_id)
      );
    `);
  }

  // ---------------------------------------------------------------- ingestion

  private async ingest(request: Request, providerParam: string): Promise<Response> {
    if (!isProvider(providerParam)) {
      return Response.json({ ok: false, error: "unsupported provider" }, { status: 400 });
    }
    const provider: Provider = providerParam;

    const body = await request.text();
    if (byteLength(body) > MAX_WEBHOOK_BYTES) {
      return Response.json({ ok: false, error: "payload too large" }, { status: 413 });
    }

    const authorised = await this.authorise(provider, request.headers, body);
    if (!authorised.ok) {
      return Response.json({ ok: false, error: authorised.error }, { status: authorised.status });
    }

    const deliveryId = deliveryIdFor(provider, request.headers);
    if (!deliveryId) {
      return Response.json({ ok: false, error: "missing delivery id" }, { status: 400 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return Response.json({ ok: false, error: "invalid json body" }, { status: 400 });
    }

    const normalised: NormalisedEvent = normaliseEvent(provider, payload);
    const routedRepository = request.headers.get("x-factory-repository");
    const repository = normalised.repository !== "unknown"
      ? normalised.repository
      : (routedRepository ?? "unknown");

    // A payload that names a different repository than the endpoint it arrived
    // on is either a misconfigured hook or a forgery attempt: refuse it.
    if (
      routedRepository !== null &&
      normalised.repository !== "unknown" &&
      !sameRepository(routedRepository, normalised.repository)
    ) {
      return Response.json(
        {
          ok: false,
          error: "repository mismatch",
          expected: routedRepository,
          received: normalised.repository,
        },
        { status: 400 },
      );
    }

    const existing = this.sql
      .exec<{ delivery_id: string }>(
        "SELECT delivery_id FROM events WHERE delivery_id = ?",
        deliveryId,
      )
      .toArray();
    if (existing.length > 0) {
      return Response.json({ ok: true, duplicate: true, deliveryId }, { status: 200 });
    }

    const now = new Date().toISOString();
    const headerEvent = eventNameFor(provider, request.headers);
    this.sql.exec(
      `INSERT INTO events (
         delivery_id, provider, event, action, repository, actor,
         received_at, payload, status, attempts, available_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      deliveryId,
      provider,
      headerEvent !== "unknown" ? headerEvent : (normalised.payloadEvent ?? "unknown"),
      normalised.action,
      repository,
      normalised.actor,
      now,
      body,
      now,
    );

    return Response.json({ ok: true, queued: true, deliveryId }, { status: 202 });
  }

  private async authorise(
    provider: Provider,
    headers: Headers,
    body: string,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    if (provider === "github") {
      const secret = this.env.WEBHOOK_SECRET;
      if (!secret) return { ok: false, status: 503, error: "webhook secret not configured" };
      const valid = await verifyGithubSignature(secret, body, headers.get("x-hub-signature-256"));
      return valid ? { ok: true } : { ok: false, status: 401, error: "invalid signature" };
    }

    const token = this.env.GITLAB_WEBHOOK_TOKEN;
    if (!token) return { ok: false, status: 503, error: "gitlab token not configured" };
    const valid = await verifyGitlabToken(token, headers.get("x-gitlab-token"));
    return valid ? { ok: true } : { ok: false, status: 401, error: "invalid token" };
  }

  // ---------------------------------------------------------------- queue API

  private async claim(payload: unknown): Promise<Response> {
    await this.requeueExpiredLeases();
    const body = asRecord(payload);
    const limit = clampInt(body?.["limit"], 1, 100, 10);
    const visibilityMs = clampInt(body?.["visibilityMs"], 0, 3_600_000, DEFAULT_VISIBILITY_MS);
    const now = new Date().toISOString();

    const due = this.sql
      .exec<{ delivery_id: string }>(
        `SELECT delivery_id FROM events
         WHERE status = 'pending' AND available_at <= ?
         ORDER BY received_at, delivery_id LIMIT ?`,
        now,
        limit,
      )
      .toArray();

    if (due.length === 0) return Response.json({ ok: true, claimed: [] });

    const leaseUntil = new Date(Date.now() + visibilityMs).toISOString();
    for (const row of due) {
      const leaseId = crypto.randomUUID();
      this.sql.exec(
        `UPDATE events
         SET status = 'processing', attempts = attempts + 1, available_at = ?, lease_id = ?
         WHERE delivery_id = ?`,
        leaseUntil,
        leaseId,
        row.delivery_id,
      );
    }

    const placeholders = due.map(() => "?").join(", ");
    const claimed = this.sql
      .exec<EventRow>(
        `SELECT ${EVENT_COLUMNS} FROM events WHERE delivery_id IN (${placeholders})
         ORDER BY received_at, delivery_id`,
        ...due.map((row) => row.delivery_id),
      )
      .toArray()
      .map(toWireEvent);

    await this.armAlarm();

    return Response.json({ ok: true, claimed, leaseUntil });
  }

  /** Full provider payload for one event; the runner fetches it after claiming. */
  private eventPayload(deliveryId: string): Response {
    if (deliveryId.length === 0) {
      return Response.json({ ok: false, error: "missing deliveryId" }, { status: 400 });
    }
    const rows = this.sql
      .exec<{ delivery_id: string; provider: string; event: string; action: string | null; repository: string; payload: string }>(
        `SELECT delivery_id, provider, event, action, repository, payload FROM events WHERE delivery_id = ?`,
        deliveryId,
      )
      .toArray();
    const row = rows[0];
    if (!row) return Response.json({ ok: false, error: "not found", deliveryId }, { status: 404 });
    return Response.json({
      ok: true,
      deliveryId: row.delivery_id,
      provider: row.provider,
      event: row.event,
      action: row.action,
      repository: row.repository,
      payload: safeParseJson(row.payload),
    });
  }

  /**
   * Returns claimed events to the queue without counting an attempt: used when a
   * run planned for one agent claims events that belong to another agent.
   */
  private async release(payload: unknown): Promise<Response> {
    const claims = claimsFrom(payload);
    if (claims.length === 0) {
      return Response.json({ ok: false, error: "no deliveryIds" }, { status: 400 });
    }
    const now = new Date().toISOString();
    let released = 0;
    for (const claim of claims) {
      if (!claim.leaseId) {
        return Response.json({ ok: false, error: "missing leaseId", deliveryId: claim.deliveryId }, { status: 400 });
      }
      const changed = this.sql.exec(
        `UPDATE events
         SET status = 'pending', lease_id = NULL, available_at = ?, attempts = MAX(attempts - 1, 0)
         WHERE delivery_id = ? AND lease_id = ? AND status = 'processing'`,
        now,
        claim.deliveryId,
        claim.leaseId,
      );
      // `rowsWritten` counts more than the row we just changed, so re-read the
      // row to report exactly what was released.
      const after = this.sql
        .exec<{ status: string; lease_id: string | null }>("SELECT status, lease_id FROM events WHERE delivery_id = ?", claim.deliveryId)
        .toArray()[0];
      if (changed && after?.status === "pending" && after.lease_id === null) released += 1;
    }
    return Response.json({ ok: true, released });
  }

  /**
   * Asks whether an agent still has to deliver this event.
   * - no row, or a `failed` row: run it (and mark it started);
   * - a `delivered` row: the side effect already happened, so skip it.
   * A `started` row means an earlier attempt died mid-flight; at-least-once is
   * the honest choice there, so it runs again.
   */
  private claimDelivery(payload: unknown): Response {
    const body = asRecord(payload);
    const deliveryId = typeof body?.["deliveryId"] === "string" ? (body["deliveryId"] as string) : "";
    const agentId = typeof body?.["agentId"] === "string" ? (body["agentId"] as string) : "";
    if (deliveryId.length === 0 || agentId.length === 0) {
      return Response.json({ ok: false, error: "deliveryId and agentId are required" }, { status: 400 });
    }
    const existing = this.sql
      .exec<{ status: string; updated_at: string }>(
        "SELECT status, updated_at FROM event_deliveries WHERE delivery_id = ? AND agent_id = ?",
        deliveryId,
        agentId,
      )
      .toArray()[0];

    // A runner with no agent identity of its own (the legacy queue drain) stands
    // for "the repository's agent": if any agent of this event has already
    // delivered, running again would repeat a provider call
    // (cloud-factory-cf-7wj).
    if (body?.["skipIfAnyDelivered"] === true && existing?.status !== "delivered") {
      const delivered = this.sql
        .exec<{ agent_id: string }>(
          "SELECT agent_id FROM event_deliveries WHERE delivery_id = ? AND status = 'delivered' LIMIT 1",
          deliveryId,
        )
        .toArray()[0];
      if (delivered !== undefined) {
        return Response.json({ ok: true, run: false, status: "delivered", deliveredBy: delivered.agent_id });
      }
    }

    const now = new Date().toISOString();
    if (existing?.status === "delivered") {
      return Response.json({ ok: true, run: false, status: existing.status, deliveredAt: existing.updated_at });
    }
    this.sql.exec(
      `INSERT INTO event_deliveries (delivery_id, agent_id, status, attempts, updated_at)
       VALUES (?, ?, 'started', 1, ?)
       ON CONFLICT (delivery_id, agent_id) DO UPDATE
         SET status = 'started', attempts = event_deliveries.attempts + 1, updated_at = excluded.updated_at`,
      deliveryId,
      agentId,
      now,
    );
    return Response.json({ ok: true, run: true, status: "started", previous: existing?.status ?? null });
  }

  /** Marks what actually happened for one (event, agent) pair. */
  private completeDelivery(payload: unknown): Response {
    const body = asRecord(payload);
    const deliveryId = typeof body?.["deliveryId"] === "string" ? (body["deliveryId"] as string) : "";
    const agentId = typeof body?.["agentId"] === "string" ? (body["agentId"] as string) : "";
    const status = typeof body?.["status"] === "string" ? (body["status"] as string) : "";
    if (deliveryId.length === 0 || agentId.length === 0 || !["delivered", "failed", "skipped"].includes(status)) {
      return Response.json(
        { ok: false, error: "deliveryId, agentId and status (delivered|failed|skipped) are required" },
        { status: 400 },
      );
    }
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO event_deliveries (delivery_id, agent_id, status, attempts, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (delivery_id, agent_id) DO UPDATE
         SET status = excluded.status, updated_at = excluded.updated_at`,
      deliveryId,
      agentId,
      status,
      now,
    );
    return Response.json({ ok: true, deliveryId, agentId, status });
  }

  private listDeliveries(url: URL): Response {
    const deliveryId = url.searchParams.get("deliveryId");
    if (deliveryId === null) {
      return Response.json({ ok: false, error: "deliveryId is required" }, { status: 400 });
    }
    const rows = this.sql
      .exec<{ agent_id: string; status: string; attempts: number; updated_at: string }>(
        "SELECT agent_id, status, attempts, updated_at FROM event_deliveries WHERE delivery_id = ? ORDER BY agent_id",
        deliveryId,
      )
      .toArray()
      .map((row) => ({
        agentId: row.agent_id,
        status: row.status,
        attempts: row.attempts,
        updatedAt: row.updated_at,
      }));
    return Response.json({ ok: true, deliveryId, deliveries: rows });
  }

  /** Records that a stored canvas document was turned into runs. */
  private recordRunAudit(payload: unknown): Response {
    const body = asRecord(payload);
    if (!body) return Response.json({ ok: false, error: "invalid body" }, { status: 400 });
    const documentId = typeof body["documentId"] === "string" ? body["documentId"] : "";
    if (documentId.length === 0) {
      return Response.json({ ok: false, error: "documentId is required" }, { status: 400 });
    }
    const name = typeof body["name"] === "string" ? body["name"].slice(0, 120) : "";
    const agents = Array.isArray(body["agents"]) ? body["agents"].length : 0;
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO run_audit (id, document_id, name, agents, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      documentId,
      name,
      agents,
      JSON.stringify(body["agents"] ?? []).slice(0, 8192),
      createdAt,
    );
    return Response.json({ ok: true, id, createdAt }, { status: 201 });
  }

  private listRunAudit(url: URL): Response {
    const limit = clampInt(url.searchParams.get("limit"), 1, 100, 20);
    const documentId = url.searchParams.get("documentId");
    const rows = (
      documentId === null
        ? this.sql.exec(
            `SELECT id, document_id, name, agents, detail, created_at FROM run_audit ORDER BY created_at DESC, id LIMIT ?`,
            limit,
          )
        : this.sql.exec(
            `SELECT id, document_id, name, agents, detail, created_at FROM run_audit WHERE document_id = ? ORDER BY created_at DESC, id LIMIT ?`,
            documentId,
            limit,
          )
    )
      .toArray()
      .map((row) => ({
        id: String(row["id"] ?? ""),
        documentId: String(row["document_id"] ?? ""),
        name: String(row["name"] ?? ""),
        agents: Number(row["agents"] ?? 0),
        detail: safeParseJson(String(row["detail"] ?? "[]")),
        createdAt: String(row["created_at"] ?? ""),
      }));
    return Response.json({ ok: true, count: rows.length, runs: rows });
  }

  private async ack(payload: unknown): Promise<Response> {
    const claims = claimsFrom(payload);
    if (claims.length === 0) {
      return Response.json({ ok: false, error: "no deliveryIds" }, { status: 400 });
    }

    const now = new Date().toISOString();
    // Pass 1: validate every claim in the batch before mutating any rows (fixes cloud-factory-cf-010)
    const toAcknowledge: string[] = [];
    for (const claim of claims) {
      if (!claim.leaseId) {
        return Response.json(
          { ok: false, error: "missing leaseId", deliveryId: claim.deliveryId },
          { status: 400 },
        );
      }

      const row = this.sql
        .exec<{ status: string; lease_id: string | null; available_at: string }>(
          "SELECT status, lease_id, available_at FROM events WHERE delivery_id = ?",
          claim.deliveryId,
        )
        .toArray()[0];

      if (!row) {
        return Response.json(
          { ok: false, error: "not found", deliveryId: claim.deliveryId },
          { status: 404 },
        );
      }

      // If already processed, allow idempotent retry only if lease matches (fixes cloud-factory-cf-wa8)
      if (row.status === "processed") {
        if (row.lease_id === claim.leaseId) {
          continue;
        }
        return Response.json(
          { ok: false, error: "lease conflict", deliveryId: claim.deliveryId },
          { status: 409 },
        );
      }

      // Conflict: status changed, lease mismatch, or lease expired (fixes cloud-factory-cf-xh7)
      if (row.status !== "processing" || row.lease_id !== claim.leaseId || row.available_at <= now) {
        return Response.json(
          { ok: false, error: "lease conflict", deliveryId: claim.deliveryId },
          { status: 409 },
        );
      }

      toAcknowledge.push(claim.deliveryId);
    }

    // Pass 2: mutate state only after the whole batch passed validation
    for (const deliveryId of toAcknowledge) {
      this.sql.exec(
        `UPDATE events SET status = 'processed', last_error = NULL
         WHERE delivery_id = ?`,
        deliveryId,
      );
    }

    return Response.json({ ok: true, acknowledged: claims.length });
  }

  private async fail(payload: unknown): Promise<Response> {
    const body = asRecord(payload);
    const claims = claimsFrom(payload);
    if (claims.length === 0) {
      return Response.json({ ok: false, error: "no deliveryIds" }, { status: 400 });
    }
    const reason = typeof body?.["error"] === "string" ? (body["error"] as string) : "unknown error";

    const now = new Date().toISOString();
    // Pass 1: validate every claim in the batch before mutating any rows (fixes cloud-factory-cf-010)
    interface ValidatedFail {
      deliveryId: string;
      attempts: number;
    }
    const toFail: ValidatedFail[] = [];

    for (const claim of claims) {
      if (!claim.leaseId) {
        return Response.json(
          { ok: false, error: "missing leaseId", deliveryId: claim.deliveryId },
          { status: 400 },
        );
      }

      const row = this.sql
        .exec<{ attempts: number; status: string; lease_id: string | null; available_at: string }>(
          "SELECT attempts, status, lease_id, available_at FROM events WHERE delivery_id = ?",
          claim.deliveryId,
        )
        .toArray()[0];

      if (!row) {
        return Response.json(
          { ok: false, error: "not found", deliveryId: claim.deliveryId },
          { status: 404 },
        );
      }

      // Conflict: status changed, lease mismatch, or lease expired (fixes cloud-factory-cf-xh7)
      if (row.status !== "processing" || row.lease_id !== claim.leaseId || row.available_at <= now) {
        return Response.json(
          { ok: false, error: "lease conflict", deliveryId: claim.deliveryId },
          { status: 409 },
        );
      }

      toFail.push({ deliveryId: claim.deliveryId, attempts: row.attempts });
    }

    // Pass 2: execute state changes only after whole batch is validated
    let retried = 0;
    let deadLettered = 0;
    for (const { deliveryId, attempts } of toFail) {
      if (attempts >= MAX_ATTEMPTS) {
        this.sql.exec(
          "UPDATE events SET status = 'failed', last_error = ?, lease_id = NULL WHERE delivery_id = ?",
          reason,
          deliveryId,
        );
        deadLettered += 1;
        continue;
      }

      const backoff = Math.min(RETRY_BACKOFF_MS * Math.max(attempts, 1), RETRY_BACKOFF_CAP_MS);
      this.sql.exec(
        `UPDATE events SET status = 'pending', last_error = ?, available_at = ?, lease_id = NULL
         WHERE delivery_id = ?`,
        reason,
        new Date(Date.now() + backoff).toISOString(),
        deliveryId,
      );
      retried += 1;
    }

    await this.armAlarm();

    return Response.json({ ok: true, retried, deadLettered });
  }

  /** Convenience path for tests/tools: process everything that is due right now. */
  private async drain(): Promise<Response> {
    const now = new Date().toISOString();
    const due = this.sql
      .exec<{ delivery_id: string }>(
        "SELECT delivery_id FROM events WHERE status = 'pending' AND available_at <= ?",
        now,
      )
      .toArray();

    if (due.length > 0) {
      this.sql.exec(
        "UPDATE events SET status = 'processed', lease_id = NULL WHERE status = 'pending' AND available_at <= ?",
        now,
      );
    }

    return Response.json({ ok: true, drained: due.length });
  }

  private listEvents(url: URL): Response {
    const limit = clampInt(url.searchParams.get("limit"), 1, 200, 50);
    const status = url.searchParams.get("status");
    const rows = status
      ? this.sql
          .exec<EventRow>(
            `SELECT ${EVENT_COLUMNS} FROM events WHERE status = ?
             ORDER BY received_at DESC LIMIT ?`,
            status,
            limit,
          )
          .toArray()
      : this.sql
          .exec<EventRow>(
            `SELECT ${EVENT_COLUMNS} FROM events ORDER BY received_at DESC LIMIT ?`,
            limit,
          )
          .toArray();

    return Response.json({
      ok: true,
      count: rows.length,
      events: rows.map(toWireEvent),
    });
  }

  private stats(): Response {
    const counts = this.sql
      .exec<{ status: string; total: number }>(
        "SELECT status, count(*) AS total FROM events GROUP BY status",
      )
      .toArray();

    return Response.json({
      ok: true,
      repository: this.ctx.id.name ?? "unknown",
      counts: Object.fromEntries(counts.map((row) => [row.status, row.total])),
      memoryKeys: this.memoryHandler.total(),
    });
  }

  // ------------------------------------------------------------------ memory

  private async forwardToOrg(request: Request): Promise<Response> {
    const repoName = this.ctx.id.name;
    const owner = repoName ? repoName.split("/")[0] : null;
    if (!owner || !this.env.ORG_COORDINATOR) {
      return Response.json({ ok: false, error: "org coordinator not available" }, { status: 503 });
    }
    const stub = this.env.ORG_COORDINATOR.get(this.env.ORG_COORDINATOR.idFromName(owner));
    const targetUrl = new URL(request.url);
    targetUrl.hostname = "org-coordinator.internal";
    targetUrl.searchParams.delete("scope");
    return stub.fetch(new Request(targetUrl.toString(), request));
  }

  private async handleMemory(request: Request, url: URL): Promise<Response> {
    if (request.method === "GET" && url.pathname.startsWith("/memory/")) {
      const key = safeDecode(url.pathname.slice("/memory/".length));
      if (key === null) return Response.json({ ok: false, error: "malformed key" }, { status: 400 });
      return this.memoryHandler.get(key);
    }
    if (request.method === "GET" && url.pathname === "/memory") {
      const key = url.searchParams.get("key");
      if (key) return this.memoryHandler.get(key);
      const prefix = url.searchParams.get("prefix") ?? "";
      return this.memoryHandler.list(prefix);
    }
    if ((request.method === "POST" || request.method === "PUT") && url.pathname.startsWith("/memory/")) {
      const key = safeDecode(url.pathname.slice("/memory/".length));
      if (key === null) return Response.json({ ok: false, error: "malformed key" }, { status: 400 });
      const body = await readJson(request);
      return this.memoryHandler.set(key, body as Record<string, unknown> | null);
    }
    if (request.method === "POST" && url.pathname === "/memory") {
      const body = (await readJson(request)) as Record<string, unknown> | null;
      const key = typeof body?.["key"] === "string" ? body["key"] : undefined;
      if (!key) return Response.json({ ok: false, error: "missing key" }, { status: 400 });
      return this.memoryHandler.set(key, body);
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/memory/")) {
      const key = safeDecode(url.pathname.slice("/memory/".length));
      if (key === null) return Response.json({ ok: false, error: "malformed key" }, { status: 400 });
      return this.memoryHandler.delete(key);
    }
    if (request.method === "DELETE" && url.pathname === "/memory") {
      const key = url.searchParams.get("key");
      if (!key) return Response.json({ ok: false, error: "missing key" }, { status: 400 });
      return this.memoryHandler.delete(key);
    }
    return new Response("not found", { status: 404 });
  }

  // ------------------------------------------------------------------ leases

  private async requeueExpiredLeases(): Promise<number> {
    const now = new Date().toISOString();
    const expired = this.sql
      .exec<{ total: number }>(
        "SELECT count(*) AS total FROM events WHERE status = 'processing' AND available_at <= ?",
        now,
      )
      .one().total;

    if (expired > 0) {
      this.sql.exec(
        "UPDATE events SET status = 'pending', lease_id = NULL WHERE status = 'processing' AND available_at <= ?",
        now,
      );
    }
    return expired;
  }

  /**
   * Schedule a wake-up for the next lease expiry or retry backoff. Rows that are
   * already due are left to the runner: arming an alarm for "now" would spin.
   */
  private async armAlarm(): Promise<void> {
    const now = new Date().toISOString();
    const next = this.sql
      .exec<{ next: string | null }>(
        `SELECT MIN(available_at) AS next FROM events
         WHERE status IN ('pending', 'processing') AND available_at > ?`,
        now,
      )
      .one().next;

    if (next) {
      await this.ctx.storage.setAlarm(Date.parse(next) + 1_000);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }
}

const EVENT_COLUMNS =
  "delivery_id, provider, event, action, repository, actor, received_at, status, attempts, available_at, last_error, lease_id";

interface EventRow extends Record<string, SqlStorageValue> {
  delivery_id: string;
  provider: string;
  event: string;
  action: string | null;
  repository: string;
  actor: string | null;
  received_at: string;
  status: string;
  attempts: number;
  available_at: string;
  last_error: string | null;
  lease_id: string | null;
}

function toWireEvent(row: EventRow) {
  return {
    deliveryId: row.delivery_id,
    provider: row.provider,
    event: row.event,
    action: row.action,
    repository: row.repository,
    actor: row.actor,
    receivedAt: row.received_at,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    lastError: row.last_error,
    leaseId: row.lease_id,
  };
}

interface ClaimToken {
  deliveryId: string;
  leaseId?: string;
}

function claimsFrom(payload: unknown): ClaimToken[] {
  const body = asRecord(payload);
  if (!body) return [];

  if (Array.isArray(body["claims"])) {
    return body["claims"]
      .map((item) => asRecord(item))
      .filter((rec): rec is Record<string, unknown> => rec !== null)
      .map((rec) => ({
        deliveryId: String(rec["deliveryId"] ?? rec["delivery_id"] ?? ""),
        leaseId:
          typeof (rec["leaseId"] ?? rec["lease_id"]) === "string"
            ? String(rec["leaseId"] ?? rec["lease_id"])
            : undefined,
      }))
      .filter((c) => c.deliveryId.length > 0);
  }

  const defaultLease =
    typeof (body["leaseId"] ?? body["lease_id"]) === "string"
      ? String(body["leaseId"] ?? body["lease_id"])
      : undefined;

  const raw = body["deliveryIds"] ?? body["deliveryId"] ?? body["delivery_id"];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return list
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map((id) => ({ deliveryId: id, leaseId: defaultLease }));
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function sameRepository(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
