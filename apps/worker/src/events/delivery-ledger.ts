import { asRecord } from "./helpers";

export function migrateDeliveryLedgerTable(sql: SqlStorage): void {
  sql.exec(`
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

/**
 * Manages idempotent event delivery per (event, agent) pair.
 * Ensures fan-out retries do not re-execute agents that already delivered side effects.
 */
export class DeliveryLedger {
  constructor(private sql: SqlStorage) {}

  /**
   * Asks whether an agent still has to deliver this event.
   * - no row, or a `failed` row: run it (and mark it started);
   * - a `delivered` row: the side effect already happened, so skip it.
   * A `started` row means an earlier attempt died mid-flight; at-least-once is
   * the honest choice there, so it runs again.
   */
  claim(payload: unknown): Response {
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
  complete(payload: unknown): Response {
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

  list(url: URL): Response {
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
}
