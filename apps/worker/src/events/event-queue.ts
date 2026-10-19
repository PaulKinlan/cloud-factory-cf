import type { SdlcAction, SdlcKind } from "@factory-cloud/sdk";
import type { Provider } from "../webhooks";
import { asRecord, clampInt, safeParseJson } from "./helpers";

/** An event that keeps failing is dead-lettered instead of retried forever. */
export const MAX_ATTEMPTS = 5;
/** How long a runner may hold a claimed event before it is handed back. */
export const DEFAULT_VISIBILITY_MS = 60_000;
/** Exponential-ish backoff between attempts: attempt * this, capped below. */
const RETRY_BACKOFF_MS = 2_000;
const RETRY_BACKOFF_CAP_MS = 60_000;
/** How long a due event waits, so a burst of deliveries becomes one drain pass. */
export const DRAIN_COALESCE_MS = 1_000;

export interface AlarmScheduler {
  setAlarm(timestamp: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export function migrateEventQueueTable(sql: SqlStorage): void {
  sql.exec(`
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
  sql.exec(`
    CREATE INDEX IF NOT EXISTS events_queue_idx ON events (status, available_at, received_at);
  `);
  for (const column of [
    "ALTER TABLE events ADD COLUMN lease_id TEXT;",
    // ADR 003 / cloud-factory-cf-06p: the canonical event is carried in the row.
    // It cannot be derived later from the stored payload, because the adapters read
    // the delivery id and event name from the request headers, which are not stored.
    "ALTER TABLE events ADD COLUMN kind TEXT;",
    "ALTER TABLE events ADD COLUMN canonical_action TEXT;",
  ]) {
    try {
      sql.exec(column);
    } catch {
      // Column already exists on an older object.
    }
  }
}

/**
 * Manages the durable event queue state machine (enqueue, claim, ack, fail, release,
 * dead-lettering, and lease pruning).
 */
export class EventQueue {
  constructor(
    private sql: SqlStorage,
    private alarmScheduler?: AlarmScheduler,
  ) {}

  /**
   * Enqueues an ingested event. Returns false if delivery_id was already present (duplicate).
   */
  enqueue(
    deliveryId: string,
    provider: Provider,
    event: string,
    action: string | null,
    kind: SdlcKind | null,
    canonicalAction: SdlcAction,
    repository: string,
    actor: string | null,
    body: string,
    now: string,
  ): boolean {
    const existing = this.sql
      .exec<{ delivery_id: string }>(
        "SELECT delivery_id FROM events WHERE delivery_id = ?",
        deliveryId,
      )
      .toArray();
    if (existing.length > 0) {
      return false;
    }

    this.sql.exec(
      `INSERT INTO events (
         delivery_id, provider, event, action, kind, canonical_action, repository, actor,
         received_at, payload, status, attempts, available_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      deliveryId,
      provider,
      event,
      action,
      kind,
      canonicalAction,
      repository,
      actor,
      now,
      body,
      now,
    );
    return true;
  }

  async claim(payload: unknown): Promise<Response> {
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
  eventPayload(deliveryId: string): Response {
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
  async release(payload: unknown): Promise<Response> {
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

  async ack(payload: unknown): Promise<Response> {
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

  async fail(payload: unknown): Promise<Response> {
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
  async drain(): Promise<Response> {
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

  listEvents(url: URL): Response {
    const limit = clampInt(url.searchParams.get("limit"), 1, 200, 50);
    const status = url.searchParams.get("status");
    const deliveryId = url.searchParams.get("deliveryId");
    const event = url.searchParams.get("event");

    const clauses: string[] = [];
    const params: SqlStorageValue[] = [];

    if (deliveryId) {
      clauses.push("delivery_id = ?");
      params.push(deliveryId);
    }
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    if (event) {
      clauses.push("event = ?");
      params.push(event);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const query = `SELECT ${EVENT_COLUMNS} FROM events${where} ORDER BY received_at DESC, delivery_id DESC LIMIT ?`;
    params.push(limit);

    const rows = this.sql.exec<EventRow>(query, ...params).toArray();

    return Response.json({
      ok: true,
      count: rows.length,
      events: rows.map(toWireEvent),
    });
  }

  findEvent(deliveryId: string): (WireEvent & { payload: unknown }) | null {
    if (deliveryId.length === 0) return null;
    const rows = this.sql
      .exec<EventRow & { payload: string }>(
        `SELECT ${EVENT_COLUMNS}, payload FROM events WHERE delivery_id = ?`,
        deliveryId,
      )
      .toArray();
    const row = rows[0];
    if (!row) return null;
    return {
      ...toWireEvent(row),
      payload: safeParseJson(row.payload),
    };
  }

  statusCounts(): Record<string, number> {
    const counts = this.sql
      .exec<{ status: string; total: number }>(
        "SELECT status, count(*) AS total FROM events GROUP BY status",
      )
      .toArray();
    return Object.fromEntries(counts.map((row) => [row.status, row.total]));
  }

  async requeueExpiredLeases(): Promise<number> {
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
  /** True when an event is due now, which is what tells the alarm to drain. */
  hasDue(now: string = new Date().toISOString()): boolean {
    const rows = this.sql
      .exec<{ due: number }>(
        "SELECT COUNT(*) AS due FROM events WHERE status = 'pending' AND available_at <= ?",
        now,
      )
      .toArray();
    return (rows[0]?.due ?? 0) > 0;
  }

  /**
   * Arms the alarm for the next thing that needs work, **including work that is due
   * now**. The old query only looked at `available_at > now`, so a fresh delivery
   * (due immediately) armed nothing and nothing ever woke to drain it — which is why
   * a webhook alone produced no review (cloud-factory-cf-7or.1).
   */
  async armAlarm(): Promise<void> {
    if (!this.alarmScheduler) return;

    const next = this.sql
      .exec<{ next: string | null }>(
        "SELECT MIN(available_at) AS next FROM events WHERE status IN ('pending', 'processing')",
      )
      .one().next;

    if (next === null) {
      await this.alarmScheduler.deleteAlarm();
      return;
    }
    // A due event is drained after a short delay, so a burst of deliveries coalesces
    // into one pass instead of one wake-up per webhook.
    await this.alarmScheduler.setAlarm(Math.max(Date.now() + DRAIN_COALESCE_MS, Date.parse(next) + 1_000));
  }
}

const EVENT_COLUMNS =
  "delivery_id, provider, event, action, kind, canonical_action, repository, actor, received_at, status, attempts, available_at, last_error, lease_id";

interface EventRow extends Record<string, SqlStorageValue> {
  delivery_id: string;
  provider: string;
  event: string;
  action: string | null;
  kind: string | null;
  canonical_action: string | null;
  repository: string;
  actor: string | null;
  received_at: string;
  status: string;
  attempts: number;
  available_at: string;
  last_error: string | null;
  lease_id: string | null;
}

export interface WireEvent {
  deliveryId: string;
  provider: string;
  event: string;
  action: string | null;
  /** Canonical SDLC kind from the platform adapter (ADR 003); null on pre-6to rows. */
  kind: string | null;
  /** The provider action folded onto opened/updated/merged/closed, or null. */
  canonicalAction: string | null;
  repository: string;
  actor: string | null;
  receivedAt: string;
  status: string;
  attempts: number;
  availableAt: string;
  lastError: string | null;
  leaseId: string | null;
}

export function toWireEvent(row: EventRow): WireEvent {
  return {
    deliveryId: row.delivery_id,
    provider: row.provider,
    event: row.event,
    action: row.action,
    kind: row.kind,
    canonicalAction: row.canonical_action,
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
