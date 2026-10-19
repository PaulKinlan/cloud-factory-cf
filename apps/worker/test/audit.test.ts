import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AUDIT_PATH } from "../src/routes/audit";
import { githubRequest } from "./support/webhook";
import type { DeliveryLedger } from "../src/events/delivery-ledger";
import type { EventQueue, WireEvent } from "../src/events/event-queue";
import * as _eventsModule from "../src/events/index";
import * as _routesModule from "../src/routes/index";

const BASE = "https://repo-coordinator.internal";
const controlKey = "test-control-key";

function coordinator(repository: string) {
  return env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repository));
}

async function callAudit(
  path: string,
  headers: Record<string, string> = {},
  workerEnv = { ...env, BROKER_CONTROL_KEY: controlKey },
): Promise<Response> {
  const handler = await import("../src/index").then((m) => m.default);
  return handler.fetch(
    new Request(`https://factory.example${path}`, { headers }),
    workerEnv as never,
  );
}

describe("audit route patterns", () => {
  it("matches expected audit paths", () => {
    expect(AUDIT_PATH.test("/audit/events/acme/widgets")).toBe(true);
    expect(AUDIT_PATH.test("/audit/events/acme/widgets/stats")).toBe(true);
    expect(AUDIT_PATH.test("/audit/events/acme/widgets/deliv-123")).toBe(true);
    expect(AUDIT_PATH.test("/audit/runs/acme/widgets")).toBe(true);
    expect(AUDIT_PATH.test("/audit/other/acme/widgets")).toBe(false);
    expect(AUDIT_PATH.test("/audit/events/acme")).toBe(false);
  });
});

describe("audit route authentication", () => {
  it("fails closed with 503 when control key is not configured", async () => {
    const res = await callAudit(
      "/audit/events/acme/widgets",
      { "x-factory-control-key": controlKey },
      { ...env, BROKER_CONTROL_KEY: undefined } as never,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("control key not configured");
  });

  it("returns 401 when control key is missing or invalid", async () => {
    const missing = await callAudit("/audit/events/acme/widgets");
    expect(missing.status).toBe(401);

    const wrong = await callAudit("/audit/events/acme/widgets", {
      "x-factory-control-key": "wrong-key",
    });
    expect(wrong.status).toBe(401);
  });

  it("returns 405 for non-GET methods", async () => {
    const handler = await import("../src/index").then((m) => m.default);
    const res = await handler.fetch(
      new Request("https://factory.example/audit/events/acme/widgets", {
        method: "POST",
        headers: { "x-factory-control-key": controlKey },
      }),
      { ...env, BROKER_CONTROL_KEY: controlKey } as never,
    );
    expect(res.status).toBe(405);
  });
});

describe("DO event audit log API", () => {
  const authHeaders = { "x-factory-control-key": controlKey };

  it("returns empty event list with zero counts when no events exist", async () => {
    const repository = "audit/empty-test";
    const res = await callAudit(`/audit/events/${repository}`, authHeaders);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      repository: string;
      count: number;
      stats: Record<string, number>;
      events: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.repository).toBe(repository);
    expect(body.count).toBe(0);
    expect(body.events).toEqual([]);
    expect(body.stats).toEqual({});
  });

  it("lists ingested events with status breakdown and filters", async () => {
    const repository = "audit/list-test";
    // Ingest two webhook events
    const req1 = await githubRequest("deliv-list-1", repository);
    const res1 = await SELF.fetch(req1);
    expect(res1.status).toBe(202);

    const req2 = await githubRequest("deliv-list-2", repository);
    const res2 = await SELF.fetch(req2);
    expect(res2.status).toBe(202);

    // List all events
    const listRes = await callAudit(`/audit/events/${repository}`, authHeaders);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      ok: boolean;
      count: number;
      stats: Record<string, number>;
      events: Array<{ deliveryId: string; status: string; event: string }>;
    };
    expect(listBody.ok).toBe(true);
    expect(listBody.count).toBe(2);
    expect(listBody.stats["pending"]).toBe(2);
    expect(listBody.events.map((e) => e.deliveryId)).toEqual(["deliv-list-2", "deliv-list-1"]);

    // Filter by limit
    const limitRes = await callAudit(`/audit/events/${repository}?limit=1`, authHeaders);
    const limitBody = (await limitRes.json()) as { count: number; events: unknown[] };
    expect(limitBody.count).toBe(1);
    expect(limitBody.events).toHaveLength(1);

    // Filter by deliveryId
    const delivRes = await callAudit(`/audit/events/${repository}?deliveryId=deliv-list-1`, authHeaders);
    const delivBody = (await delivRes.json()) as { count: number; events: Array<{ deliveryId: string }> };
    expect(delivBody.count).toBe(1);
    expect(delivBody.events[0]?.deliveryId).toBe("deliv-list-1");

    // Filter by status (none processed yet)
    const procRes = await callAudit(`/audit/events/${repository}?status=processed`, authHeaders);
    const procBody = (await procRes.json()) as { count: number; events: unknown[] };
    expect(procBody.count).toBe(0);
  });

  it("provides detailed audit for a single event including payload and agent deliveries", async () => {
    const repository = "audit/detail-test";
    const deliveryId = "deliv-detail-1";
    const req = await githubRequest(deliveryId, repository);
    const queued = await SELF.fetch(req);
    expect(queued.status).toBe(202);

    const stub = coordinator(repository);

    // Claim and complete a delivery record for deliv-detail-1 to simulate agent delivery
    await stub.fetch(`${BASE}/deliveries/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId, agentId: "reviewer" }),
    });
    await stub.fetch(`${BASE}/deliveries/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId, agentId: "reviewer", status: "delivered" }),
    });

    const res = await callAudit(`/audit/events/${repository}/${deliveryId}`, authHeaders);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      repository: string;
      event: {
        deliveryId: string;
        provider: string;
        event: string;
        action: string | null;
        payload: unknown;
        status: string;
      };
      deliveries: Array<{ agentId: string; status: string; attempts: number }>;
    };
    expect(body.ok).toBe(true);
    expect(body.repository).toBe(repository);
    expect(body.event.deliveryId).toBe(deliveryId);
    expect(body.event.provider).toBe("github");
    expect(body.event.payload).toBeDefined();
    expect(body.deliveries).toHaveLength(1);
    expect(body.deliveries[0]).toMatchObject({
      agentId: "reviewer",
      status: "delivered",
      attempts: 1,
    });
  });

  it("returns 404 for a non-existent event deliveryId", async () => {
    const repository = "audit/notfound-test";
    const res = await callAudit(`/audit/events/${repository}/non-existent`, authHeaders);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("not found");
  });

  it("returns status counts via the /stats subroute", async () => {
    const repository = "audit/stats-test";
    const req = await githubRequest("deliv-stats-1", repository);
    const queued = await SELF.fetch(req);
    expect(queued.status).toBe(202);

    const res = await callAudit(`/audit/events/${repository}/stats`, authHeaders);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      repository: string;
      stats: Record<string, number>;
    };
    expect(body.ok).toBe(true);
    expect(body.repository).toBe(repository);
    expect(typeof body.stats).toBe("object");
    expect(body.stats["pending"]).toBe(1);
  });

  it("retrieves an event whose delivery ID is stats (cloud-factory-cf-sood)", async () => {
    const repository = "audit/deliv-named-stats";
    const req = await githubRequest("stats", repository);
    const queued = await SELF.fetch(req);
    expect(queued.status).toBe(202);

    // Detail route /audit/events/:owner/:repo/stats returns the event detail view
    const detailRes = await callAudit(`/audit/events/${repository}/stats`, authHeaders);
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as any;
    expect(detailBody.ok).toBe(true);
    expect(detailBody.event).toBeDefined();
    expect(detailBody.event.deliveryId).toBe("stats");
    expect(detailBody.deliveries).toBeDefined();

    // Query param /audit/events/:owner/:repo?deliveryId=stats also returns the event list with the event
    const listRes = await callAudit(`/audit/events/${repository}?deliveryId=stats`, authHeaders);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as any;
    expect(listBody.ok).toBe(true);
    expect(listBody.count).toBe(1);
    expect(listBody.events[0].deliveryId).toBe("stats");
  });

  it("lists canvas run audits via /audit/runs", async () => {
    const repository = "audit/runs-test";
    const stub = coordinator(repository);
    await stub.fetch(`${BASE}/runs/audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documentId: "doc-canvas-1",
        name: "Security review canvas",
        agents: [{ id: "sec-agent" }],
      }),
    });

    const res = await callAudit(`/audit/runs/${repository}`, authHeaders);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      repository: string;
      count: number;
      runs: Array<{ documentId: string; name: string; agents: number }>;
    };
    expect(body.ok).toBe(true);
    expect(body.repository).toBe(repository);
    expect(body.count).toBe(1);
    const run = body.runs.find((r) => r.documentId === "doc-canvas-1");
    expect(run).toBeDefined();
    expect(run?.name).toBe("Security review canvas");
    expect(run?.agents).toBe(1);
  });

  it("returns 404 for /audit/runs with subpath id", async () => {
    const repository = "audit/runs-test";
    const res = await callAudit(`/audit/runs/${repository}/extra-id`, authHeaders);
    expect(res.status).toBe(404);
  });
});
