import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { verifyHmacSha256 } from "./hmac";

/**
 * Per-repository Durable Object.
 *
 * The scaffold proves out the three things every later station depends on:
 *   1. a SQLite-backed Durable Object class (see `migrations` in wrangler.jsonc),
 *   2. signed webhook ingestion with delivery-id deduplication,
 *   3. a durable queue that survives isolate restarts and can be drained.
 *
 * Agent runs, hierarchical memory and the action sinks are layered on top of
 * this object (see the epic `cloud-factory-cf-rta`); the queue contract here is
 * deliberately small so it stays cheap to extend.
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
    const provider = url.searchParams.get("provider") ?? "github";

    if (request.method === "POST" && url.pathname === "/events") {
      return this.ingest(request, provider);
    }
    if (request.method === "GET" && url.pathname === "/events") {
      return this.listEvents();
    }
    if (request.method === "POST" && url.pathname === "/drain") {
      return this.drain();
    }

    return new Response("not found", { status: 404 });
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        delivery_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        event TEXT NOT NULL,
        repository TEXT NOT NULL,
        received_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS events_status_idx ON events (status, received_at);
    `);
  }

  private async ingest(request: Request, provider: string): Promise<Response> {
    const secret = this.env.WEBHOOK_SECRET;
    if (!secret) {
      return Response.json(
        { ok: false, error: "webhook secret not configured" },
        { status: 503 },
      );
    }

    const body = await request.text();
    const valid = await verifyHmacSha256(
      secret,
      body,
      request.headers.get("x-hub-signature-256"),
    );
    if (!valid) {
      return Response.json({ ok: false, error: "invalid signature" }, { status: 401 });
    }

    const deliveryId = request.headers.get("x-github-delivery");
    if (!deliveryId) {
      return Response.json({ ok: false, error: "missing delivery id" }, { status: 400 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return Response.json({ ok: false, error: "invalid json body" }, { status: 400 });
    }

    const repository =
      request.headers.get("x-factory-repository") ?? repositoryFromPayload(payload);
    const event = request.headers.get("x-github-event") ?? "unknown";

    const existing = this.sql
      .exec<{ delivery_id: string }>(
        "SELECT delivery_id FROM events WHERE delivery_id = ?",
        deliveryId,
      )
      .toArray();
    if (existing.length > 0) {
      return Response.json({ ok: true, duplicate: true, deliveryId }, { status: 200 });
    }

    this.sql.exec(
      `INSERT INTO events (delivery_id, provider, event, repository, received_at, payload, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      deliveryId,
      provider,
      event,
      repository,
      new Date().toISOString(),
      body,
    );

    return Response.json({ ok: true, queued: true, deliveryId }, { status: 202 });
  }

  private listEvents(): Response {
    const rows = this.sql
      .exec<EventRow>(
        `SELECT delivery_id, provider, event, repository, received_at, payload, status
         FROM events ORDER BY received_at DESC LIMIT 50`,
      )
      .toArray();

    return Response.json({
      ok: true,
      count: rows.length,
      events: rows.map((row) => ({
        deliveryId: row.delivery_id,
        provider: row.provider,
        event: row.event,
        repository: row.repository,
        receivedAt: row.received_at,
        status: row.status,
      })),
    });
  }

  private drain(): Response {
    const pending = this.sql
      .exec<{ total: number }>(
        "SELECT count(*) AS total FROM events WHERE status = 'pending'",
      )
      .one().total;

    if (pending > 0) {
      this.sql.exec("UPDATE events SET status = 'processed' WHERE status = 'pending'");
    }

    return Response.json({ ok: true, drained: pending });
  }
}

interface EventRow extends Record<string, SqlStorageValue> {
  delivery_id: string;
  provider: string;
  event: string;
  repository: string;
  received_at: string;
  payload: string;
  status: string;
}

function repositoryFromPayload(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "unknown";
  const repository = (payload as { repository?: { full_name?: unknown } }).repository;
  const fullName = repository?.full_name;
  return typeof fullName === "string" ? fullName : "unknown";
}
