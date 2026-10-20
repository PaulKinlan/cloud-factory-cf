import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("RepoCoordinator legacy read-through migration (Slice 3)", () => {
  const CONTROL_KEY = "test-control-key";

  it("requires control key authentication for /legacy/export and /legacy/ack-migrated", async () => {
    const legacyStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName("auth-org/auth-repo"));

    const unauthExport = await legacyStub.fetch("https://repo-coordinator.internal/legacy/export");
    expect(unauthExport.status).toBe(401);

    const badAuthExport = await legacyStub.fetch("https://repo-coordinator.internal/legacy/export", {
      headers: { "x-factory-control-key": "wrong-key" },
    });
    expect(badAuthExport.status).toBe(401);

    const unauthAck = await legacyStub.fetch("https://repo-coordinator.internal/legacy/ack-migrated", {
      method: "POST",
    });
    expect(unauthAck.status).toBe(401);

    const goodAuthExport = await legacyStub.fetch("https://repo-coordinator.internal/legacy/export", {
      headers: { "x-factory-control-key": CONTROL_KEY },
    });
    expect(goodAuthExport.status).toBe(200);
    const body = (await goodAuthExport.json()) as { ok: boolean; empty: boolean };
    expect(body.ok).toBe(true);
    expect(body.empty).toBe(true);
  });

  it("migrates existing rows from unprefixed DO to github: prefixed DO on first access", async () => {
    const legacyRepo = "legacy-org/legacy-repo";
    const prefixedRepo = `github:${legacyRepo}`;

    const legacyStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(legacyRepo));

    // Populate legacy DO with test data across all tables and set an alarm
    await runInDurableObject(legacyStub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);

      // 1. memory
      state.storage.sql.exec(
        "INSERT INTO memory (key, value, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        "test-key",
        "test-value",
        "{}",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      );

      // 2. canvas_documents
      state.storage.sql.exec(
        "INSERT INTO canvas_documents (id, name, document, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        "doc-1",
        "Test Doc",
        '{"nodes":[],"edges":[]}',
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      );

      // 3. webhook_connect
      state.storage.sql.exec(
        "INSERT INTO webhook_connect (id, last_ping_at, last_event_at, last_event, pings, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        "default",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        "ping",
        1,
        "2026-01-01T00:00:00Z",
      );

      // 4. events
      state.storage.sql.exec(
        `INSERT INTO events (
          delivery_id, provider, event, action, repository, actor, received_at, payload,
          status, attempts, available_at, last_error, lease_id, kind, canonical_action
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "mig-deliv-1",
        "github",
        "pull_request",
        "opened",
        legacyRepo,
        "octocat",
        "2026-01-01T00:00:00Z",
        '{"action":"opened"}',
        "pending",
        0,
        "2026-01-01T00:00:00Z",
        null,
        null,
        "merge_request",
        "opened",
      );

      // 5. event_deliveries
      state.storage.sql.exec(
        "INSERT INTO event_deliveries (delivery_id, agent_id, status, attempts, updated_at) VALUES (?, ?, ?, ?, ?)",
        "mig-deliv-1",
        "agent-mig",
        "delivered",
        1,
        "2026-01-01T00:00:00Z",
      );

      // 6. run_audit
      state.storage.sql.exec(
        "INSERT INTO run_audit (id, document_id, name, agents, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        "audit-1",
        "doc-1",
        "Run Audit",
        1,
        '{"status":"ok"}',
        "2026-01-01T00:00:00Z",
      );

      // 7. run_trace
      state.storage.sql.exec(
        "INSERT INTO run_trace (id, delivery_id, sequence, step, status, detail, artifact, created_at, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        "trace-1",
        "mig-deliv-1",
        1,
        "claimed",
        "info",
        "Step detail",
        "null",
        "2026-01-01T00:00:00Z",
        50,
      );
    });

    // Now access the prefixed DO for the first time
    const prefixedStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(prefixedRepo));
    const statsRes = await prefixedStub.fetch("https://repo-coordinator.internal/stats");
    expect(statsRes.status).toBe(200);

    // Verify all rows exist in the prefixed DO SQLite storage
    await runInDurableObject(prefixedStub, (_instance, state) => {
      const memoryRows = state.storage.sql.exec<{ key: string; value: string }>("SELECT key, value FROM memory").toArray();
      expect(memoryRows).toEqual([{ key: "test-key", value: "test-value" }]);

      const canvasRows = state.storage.sql.exec<{ id: string; name: string }>("SELECT id, name FROM canvas_documents").toArray();
      expect(canvasRows).toEqual([{ id: "doc-1", name: "Test Doc" }]);

      const connectRows = state.storage.sql.exec<{ pings: number }>("SELECT pings FROM webhook_connect").toArray();
      expect(connectRows).toEqual([{ pings: 1 }]);

      const eventRows = state.storage.sql.exec<{ delivery_id: string; status: string }>("SELECT delivery_id, status FROM events").toArray();
      expect(eventRows).toEqual([{ delivery_id: "mig-deliv-1", status: "pending" }]);

      const deliveryRows = state.storage.sql.exec<{ agent_id: string; status: string }>("SELECT agent_id, status FROM event_deliveries").toArray();
      expect(deliveryRows).toEqual([{ agent_id: "agent-mig", status: "delivered" }]);

      const auditRows = state.storage.sql.exec<{ id: string; name: string }>("SELECT id, name FROM run_audit").toArray();
      expect(auditRows).toEqual([{ id: "audit-1", name: "Run Audit" }]);

      const traceRows = state.storage.sql.exec<{ id: string; step: string }>("SELECT id, step FROM run_trace").toArray();
      expect(traceRows).toEqual([{ id: "trace-1", step: "claimed" }]);

      const migrationRecord = state.storage.sql.exec<{ name: string }>(
        "SELECT name FROM _schema_migrations WHERE name = 'legacy_read_through'",
      ).toArray();
      expect(migrationRecord).toHaveLength(1);
    });

    // Verify that the legacy DO's alarm was cancelled and it was marked as migrated
    await runInDurableObject(legacyStub, async (_instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBeNull();
      const legacyMigration = state.storage.sql.exec<{ name: string }>(
        "SELECT name FROM _schema_migrations WHERE name = 'migrated_to_prefixed'",
      ).toArray();
      expect(legacyMigration).toHaveLength(1);
    });

    // Second access is idempotent and doesn't re-run or duplicate
    const secondRes = await prefixedStub.fetch("https://repo-coordinator.internal/stats");
    expect(secondRes.status).toBe(200);
    const body = (await secondRes.json()) as { counts: Record<string, number> };
    expect(body.counts["pending"]).toBe(1);

    // Legacy un-prefixed DO now proxies non-export requests to the prefixed DO
    const proxiedRes = await legacyStub.fetch("https://repo-coordinator.internal/stats");
    expect(proxiedRes.status).toBe(200);
    const proxiedBody = (await proxiedRes.json()) as { repository: string; counts: Record<string, number> };
    expect(proxiedBody.repository).toBe(legacyRepo);
    expect(proxiedBody.counts["pending"]).toBe(1);
  });

  it("fails closed without writing migration marker if export throws", async () => {
    const faultRepo = "fault-org/fault-repo";
    const prefixedRepo = `github:${faultRepo}`;

    const legacyStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(faultRepo));
    await runInDurableObject(legacyStub, (_instance, state) => {
      // Cause an error by dropping a required table before export runs
      state.storage.sql.exec("DROP TABLE run_trace");
    });

    const prefixedStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(prefixedRepo));
    await prefixedStub.fetch("https://repo-coordinator.internal/stats");

    // The migration marker must NOT have been written
    await runInDurableObject(prefixedStub, (_instance, state) => {
      const migrationRecord = state.storage.sql.exec<{ name: string }>(
        "SELECT name FROM _schema_migrations WHERE name = 'legacy_read_through'",
      ).toArray();
      expect(migrationRecord).toHaveLength(0);
    });
  });

  it("cancels legacy DO alarm and marks migrated even on empty export path (cloud-factory-cf-4l5k)", async () => {
    const emptyRepo = "empty-org/empty-repo";
    const prefixedRepo = `github:${emptyRepo}`;

    const legacyStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(emptyRepo));
    await runInDurableObject(legacyStub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const prefixedStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(prefixedRepo));
    const res = await prefixedStub.fetch("https://repo-coordinator.internal/stats");
    expect(res.status).toBe(200);

    await runInDurableObject(legacyStub, async (_instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBeNull();
      const legacyMigration = state.storage.sql.exec<{ name: string }>(
        "SELECT name FROM _schema_migrations WHERE name = 'migrated_to_prefixed'",
      ).toArray();
      expect(legacyMigration).toHaveLength(1);
    });
  });

  it("migrates rows when legacy DO only has event_deliveries (cloud-factory-cf-yubh)", async () => {
    const delivRepo = "deliv-org/deliv-repo";
    const prefixedRepo = `github:${delivRepo}`;

    const legacyStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(delivRepo));
    await runInDurableObject(legacyStub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO event_deliveries (delivery_id, agent_id, status, attempts, updated_at) VALUES (?, ?, ?, ?, ?)",
        "sole-deliv-1",
        "agent-sole",
        "delivered",
        1,
        "2026-01-01T00:00:00Z",
      );
    });

    const prefixedStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(prefixedRepo));
    const res = await prefixedStub.fetch("https://repo-coordinator.internal/stats");
    expect(res.status).toBe(200);

    await runInDurableObject(prefixedStub, (_instance, state) => {
      const rows = state.storage.sql.exec<{ delivery_id: string }>(
        "SELECT delivery_id FROM event_deliveries",
      ).toArray();
      expect(rows).toEqual([{ delivery_id: "sole-deliv-1" }]);
    });
  });

  it("fails closed with 503 when BROKER_CONTROL_KEY is unconfigured (cloud-factory-cf-1xs3)", async () => {
    const unconfRepo = "unconf-org/unconf-repo";
    const prefixedRepo = `github:${unconfRepo}`;

    const prefixedStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(prefixedRepo));
    // Clear BROKER_CONTROL_KEY inside the DO instance
    await runInDurableObject(prefixedStub, (instance) => {
      (instance as unknown as { env: { BROKER_CONTROL_KEY?: string } }).env.BROKER_CONTROL_KEY = undefined;
    });

    const res = await prefixedStub.fetch("https://repo-coordinator.internal/stats");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("BROKER_CONTROL_KEY is unconfigured");
  });
});
