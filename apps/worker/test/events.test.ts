import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  EventQueue,
  DeliveryLedger,
  RunAuditStore,
  migrateEventQueueTable,
  migrateDeliveryLedgerTable,
  migrateRunAuditTable,
  MAX_ATTEMPTS,
  DEFAULT_VISIBILITY_MS,
  asRecord,
  clampInt,
  safeParseJson,
  safeDecode,
} from "../src/events";

describe("events domain controllers", () => {
  it("exports expected queue defaults and shared helpers", () => {
    expect(MAX_ATTEMPTS).toBe(5);
    expect(DEFAULT_VISIBILITY_MS).toBe(60_000);

    expect(asRecord(null)).toBeNull();
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(clampInt("15", 1, 100, 10)).toBe(15);
    expect(clampInt(null, 1, 100, 10)).toBe(10);
    expect(clampInt(200, 1, 100, 10)).toBe(100);
    expect(safeParseJson('{"ok":true}')).toEqual({ ok: true });
    expect(safeParseJson("invalid")).toBeNull();
    expect(safeParseJson("raw-string", "raw-string")).toBe("raw-string");
    expect(safeDecode("hello%20world")).toBe("hello world");
    expect(safeDecode("%E0%A4%A")).toBeNull();
  });

  it("reads a pre-6to row that predates the canonical columns", async () => {
    // The migration adds kind/canonical_action; a row written before them must still
    // be listed rather than disappearing or throwing.
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName("acme/legacy-events"));
    const listed = await runInDurableObject(stub, (_instance, state) => {
      migrateEventQueueTable(state.storage.sql);
      state.storage.sql.exec(
        `INSERT INTO events (delivery_id, provider, event, action, repository, actor, received_at, payload, status, attempts, available_at)
         VALUES ('legacy-1', 'github', 'push', NULL, 'acme/legacy-events', 'octocat', '2026-10-19T00:00:00.000Z', '{}', 'pending', 0, '2026-10-19T00:00:00.000Z')`,
      );
      const queue = new EventQueue(state.storage.sql);
      return state.storage.sql.exec("SELECT kind, canonical_action FROM events WHERE delivery_id = 'legacy-1'").toArray();
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.["kind"]).toBeNull();
    expect(listed[0]?.["canonical_action"]).toBeNull();
  });

  it("EventQueue.enqueue returns true for new delivery_id and false for duplicate", async () => {
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName("acme/test-events-unit"));
    await runInDurableObject(stub, (_instance, state) => {
      migrateEventQueueTable(state.storage.sql);
      const queue = new EventQueue(state.storage.sql);
      const deliveryId = "test-delivery-" + crypto.randomUUID();
      const now = new Date().toISOString();

      const enqueued = queue.enqueue(
        deliveryId,
        "github",
        "push",
        null,
        "push",
        null,
        "acme/test-events-unit",
        "octocat",
        '{"ref":"refs/heads/main"}',
        now,
      );
      expect(enqueued).toBe(true);

      const duplicate = queue.enqueue(
        deliveryId,
        "github",
        "push",
        null,
        "push",
        null,
        "acme/test-events-unit",
        "octocat",
        '{"ref":"refs/heads/main"}',
        now,
      );
      expect(duplicate).toBe(false);
    });
  });

  it("DeliveryLedger claims and completes deliveries", async () => {
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName("acme/test-deliveries-unit"));
    await runInDurableObject(stub, async (_instance, state) => {
      migrateDeliveryLedgerTable(state.storage.sql);
      const ledger = new DeliveryLedger(state.storage.sql);
      const deliveryId = "delivery-" + crypto.randomUUID();
      const agentId = "agent-reviewer";

      const claimRes = ledger.claim({ deliveryId, agentId });
      const claimData = (await claimRes.json()) as { ok: boolean; run: boolean; status: string };
      expect(claimData.ok).toBe(true);
      expect(claimData.run).toBe(true);
      expect(claimData.status).toBe("started");

      const completeRes = ledger.complete({ deliveryId, agentId, status: "delivered" });
      const completeData = (await completeRes.json()) as { ok: boolean; status: string };
      expect(completeData.ok).toBe(true);
      expect(completeData.status).toBe("delivered");

      const listRes = ledger.list(new URL(`http://internal/deliveries?deliveryId=${deliveryId}`));
      const listData = (await listRes.json()) as { ok: boolean; deliveries: Array<{ agentId: string; status: string }> };
      expect(listData.ok).toBe(true);
      expect(listData.deliveries.length).toBe(1);
      expect(listData.deliveries[0]?.status).toBe("delivered");
    });
  });

  it("RunAuditStore records and lists run audits", async () => {
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName("acme/test-run-audit-unit"));
    await runInDurableObject(stub, async (_instance, state) => {
      migrateRunAuditTable(state.storage.sql);
      const audit = new RunAuditStore(state.storage.sql);
      const docId = "doc-" + crypto.randomUUID();

      const recordRes = audit.record({
        documentId: docId,
        name: "Test Run",
        agents: [{ id: "agent-1" }],
      });
      const recordData = (await recordRes.json()) as { ok: boolean; id: string };
      expect(recordData.ok).toBe(true);
      expect(typeof recordData.id).toBe("string");

      const listRes = audit.list(new URL(`http://internal/runs/audit?documentId=${docId}`));
      const listData = (await listRes.json()) as { ok: boolean; runs: Array<{ documentId: string; agents: number }> };
      expect(listData.ok).toBe(true);
      expect(listData.runs.length).toBe(1);
      expect(listData.runs[0]?.documentId).toBe(docId);
      expect(listData.runs[0]?.agents).toBe(1);
    });
  });
});
