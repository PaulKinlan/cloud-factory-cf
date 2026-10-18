import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
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
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
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
    if (request.method === "POST" && url.pathname === "/requeue-expired") {
      const requeued = await this.requeueExpiredLeases();
      return Response.json({ ok: true, requeued });
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
    });
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
