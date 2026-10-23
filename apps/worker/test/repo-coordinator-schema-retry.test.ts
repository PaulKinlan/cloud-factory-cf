import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getRepoCoordinator } from "../src/repo-coordinator-addressing";

/**
 * Lazy schema retry (cloud-factory-cf-u55u, coord's Proposal 1).
 *
 * The Durable Object applies its DDL once, in `blockConcurrencyWhile`, but a request
 * or alarm can still reach a query before the schema is visible to it — the
 * load-dependent `no such table: run_trace` that rip4 worked around by serialising the
 * vitest files. The fix is to fail soft on the *schema* rather than on the request:
 * a missing-table error re-applies the (idempotent, all-`IF NOT EXISTS`) migrations and
 * retries the handler exactly once. These tests drop a table inside the real object and
 * then drive the real HTTP surface.
 */

const BASE = "https://repo-coordinator.internal";

function coordinator(repository: string) {
  return getRepoCoordinator(env, repository);
}

function dropTable(repository: string, table: string): Promise<void> {
  return runInDurableObject(coordinator(repository), (_instance, state) => {
    state.storage.sql.exec(`DROP TABLE ${table}`);
  });
}

function tableExists(repository: string, table: string): Promise<boolean> {
  return runInDurableObject(coordinator(repository), (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table)
      .toArray();
    return rows.length === 1;
  });
}

describe("RepoCoordinator schema retry", () => {
  it("re-creates a dropped run_trace table and serves the request instead of failing", async () => {
    const repository = "acme/schema-retry-trace";
    const stub = coordinator(repository);

    // Warm the object so its normal migrations have run, then take the table away —
    // exactly the state a request can observe when it lands mid-migration under load.
    const warm = await stub.fetch(`${BASE}/trace`);
    expect(warm.status).toBe(200);
    await dropTable(repository, "run_trace");
    expect(await tableExists(repository, "run_trace")).toBe(false);

    const response = await stub.fetch(`${BASE}/trace`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    // The retry re-applied the DDL rather than returning an empty list from a missing table.
    expect(await tableExists(repository, "run_trace")).toBe(true);
  });

  it("re-covers every table the object writes, not just run_trace", async () => {
    const repository = "acme/schema-retry-queue";
    const stub = coordinator(repository);
    await stub.fetch(`${BASE}/trace`);

    // `events` is the queue table (migrateEventQueueTable); `/events` reads it, so the
    // first read fails on the dropped table and the retry re-applies the DDL before the
    // handler runs again.
    await dropTable(repository, "events");
    const response = await stub.fetch(`${BASE}/events`);
    expect(response.status).toBe(200);
    expect(await tableExists(repository, "events")).toBe(true);
  });

  it("retries a POST with its body intact, not with an empty one (cloud-factory-cf-1k1y)", async () => {
    const repository = "acme/schema-retry-body";
    const stub = coordinator(repository);
    await stub.fetch(`${BASE}/trace`);
    await dropTable(repository, "run_trace");

    // A retry that re-sent the consumed stream would reach the handler with no body and
    // answer 400; the clone is taken before the first attempt so the retry still has it.
    const response = await stub.fetch(`${BASE}/trace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deliveryId: "delivery-body",
        step: "gate",
        status: "ok",
        detail: "body survived the retry",
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: boolean; step: { step: string } | null };
    expect(body.ok).toBe(true);
    expect(body.step?.step).toBe("gate");
    // And the row is really there afterwards.
    const list = await stub.fetch(`${BASE}/trace`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).toContain("body survived the retry");
  });

  it("heals a missing canvas schema during an alarm instead of backing off forever (cloud-factory-cf-chcm)", async () => {
    const repository = "acme/schema-retry-alarm";
    const stub = coordinator(repository);
    await stub.fetch(`${BASE}/trace`);

    // Something for the drain to work on, so `autoDrain()` reaches `canvasHandles()`, the
    // query that reads canvas_documents.
    await runInDurableObject(coordinator(repository), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO events (delivery_id, provider, event, action, repository, received_at, payload, status, attempts, available_at)
         VALUES ('alarm-schema-1', 'github', 'pull_request', 'opened', ?, ?, '{}', 'pending', 0, ?)`,
        repository.split("/")[1],
        new Date().toISOString(),
        new Date(Date.now() - 1000).toISOString(),
      );
    });
    await dropTable(repository, "canvas_documents");

    await runInDurableObject(coordinator(repository), (instance) =>
      (instance as unknown as { alarm(): Promise<void> }).alarm(),
    );

    // Before the fix the alarm's own catch swallowed the missing table, re-armed a backoff
    // and left the table absent; now the retry re-creates it.
    expect(await tableExists(repository, "canvas_documents")).toBe(true);
  });

  it("does not swallow an error that is not a missing table", async () => {
    const repository = "acme/schema-retry-other";
    const stub = coordinator(repository);
    await stub.fetch(`${BASE}/trace`);

    // A malformed trace step is a 400 from the handler, not a schema problem: the
    // retry must not turn a validation failure into a success.
    const response = await stub.fetch(`${BASE}/trace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ not: "a step" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
  });
});
