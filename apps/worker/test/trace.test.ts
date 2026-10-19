import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RunTraceStore, estimateTokens, normaliseInput, TRACE_CAP } from "../src/events/trace";
import { pushPayload } from "./support/webhook";

/**
 * Observability suite (cloud-factory-cf-2ng): the trace store, the usage
 * aggregates and the live socket. These run inside workerd against a real
 * Durable Object, so the SQL, the ring buffer and the WebSocket path are the
 * production code paths rather than a mock of them.
 */
const BASE = "https://repo-coordinator.internal";
const controlKey = "test-control-key";

function coordinator(repository: string) {
  return env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repository));
}

async function record(repository: string, input: Record<string, unknown>): Promise<Response> {
  return coordinator(repository).fetch(`${BASE}/trace`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

describe("trace store", () => {
  it("refuses a step with no delivery id instead of inventing one", () => {
    expect(normaliseInput({ step: "claimed" })).toBeNull();
    expect(normaliseInput({ deliveryId: "d1" })).toBeNull();
    expect(normaliseInput("nonsense")).toBeNull();
    expect(normaliseInput({ deliveryId: "d1", step: "claimed" })).toMatchObject({
      deliveryId: "d1",
      step: "claimed",
      status: "info",
    });
    expect(normaliseInput({ deliveryId: "d1", step: "x", status: "bogus" })?.status).toBe("info");
  });

  it("assigns a monotonic sequence per delivery and keeps steps in order", async () => {
    const stub = coordinator("trace/order");
    expect((await record("trace/order", { deliveryId: "d-1", step: "claimed", status: "info", detail: "start" })).status).toBe(201);
    await record("trace/order", { deliveryId: "d-1", step: "agent", status: "ok", detail: "ran", artifact: { tokensIn: 3 } });
    await record("trace/order", { deliveryId: "d-1", step: "settled", status: "ok", detail: "done" });
    await record("trace/order", { deliveryId: "d-2", step: "claimed", status: "info", detail: "other" });

    const listed = (await (await stub.fetch(`${BASE}/trace?deliveryId=d-1`)).json()) as {
      ok: boolean;
      count: number;
      steps: Array<{ sequence: number; step: string; artifact: unknown }>;
    };
    expect(listed.ok).toBe(true);
    expect(listed.steps.map((step) => step.step)).toEqual(["claimed", "agent", "settled"]);
    expect(listed.steps.map((step) => step.sequence)).toEqual([1, 2, 3]);
    expect(listed.steps[1]?.artifact).toEqual({ tokensIn: 3 });

    // newest first across deliveries, and the second delivery numbers from 1 again
    const recent = (await (await stub.fetch(`${BASE}/trace?limit=10`)).json()) as {
      steps: Array<{ deliveryId: string; sequence: number }>;
    };
    expect(recent.steps[0]?.deliveryId).toBe("d-2");
    expect(recent.steps[0]?.sequence).toBe(1);
  });

  it("aggregates the cost HUD numbers and labels tokens as estimates", async () => {
    const stub = coordinator("trace/usage");
    await record("trace/usage", { deliveryId: "u-1", step: "claimed", status: "info", detail: "start" });
    await record("trace/usage", {
      deliveryId: "u-1",
      step: "settled",
      status: "ok",
      detail: "succeeded",
      artifact: { status: "succeeded", actionTypes: ["issue.create", "pr.review"], tokensIn: 40, tokensOut: 12 },
    });
    await record("trace/usage", {
      deliveryId: "u-2",
      step: "settled",
      status: "error",
      detail: "failed",
      artifact: { status: "failed", actionTypes: [], tokensIn: 10, tokensOut: 0 },
    });
    await record("trace/usage", {
      deliveryId: "u-3",
      step: "settled",
      status: "warn",
      detail: "skipped",
      artifact: { status: "skipped", actionTypes: [], tokensIn: 0, tokensOut: 0 },
    });

    const body = (await (await stub.fetch(`${BASE}/trace/usage`)).json()) as {
      ok: boolean;
      usage: {
        runs: number;
        succeeded: number;
        failed: number;
        skipped: number;
        actions: number;
        tokensIn: number;
        tokensOut: number;
        estimated: boolean;
        byAction: Record<string, number>;
        latestAt: string | null;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.usage).toMatchObject({
      runs: 3,
      succeeded: 1,
      failed: 1,
      skipped: 1,
      actions: 2,
      tokensIn: 50,
      tokensOut: 12,
      estimated: true,
    });
    expect(body.usage.byAction).toEqual({ "issue.create": 1, "pr.review": 1 });
    expect(typeof body.usage.latestAt).toBe("string");
    expect(String(body.usage.latestAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("drops the oldest steps when the ring is full", async () => {
    const stub = coordinator("trace/ring");
    // One insert per row through the DO route would be slow at TRACE_CAP rows, so the
    // store is exercised directly against the same SQL the object owns.
    await record("trace/ring", { deliveryId: "first", step: "claimed", status: "info", detail: "oldest" });
    const store = await import("cloudflare:test").then(({ runInDurableObject }) =>
      runInDurableObject(stub, async (_instance, state) => {
        const trace = new RunTraceStore(state.storage.sql);
        for (let index = 0; index < TRACE_CAP + 20; index += 1) {
          trace.record({ deliveryId: `bulk-${index}`, step: "claimed", status: "info", detail: `step ${index}` });
        }
        const count = state.storage.sql.exec(`SELECT COUNT(*) AS n FROM run_trace`).toArray()[0]?.["n"];
        return { count: Number(count) };
      }),
    );
    expect(store.count).toBe(TRACE_CAP);
    const listed = (await (await stub.fetch(`${BASE}/trace?limit=200`)).json()) as {
      steps: Array<{ deliveryId: string }>;
    };
    expect(listed.steps.length).toBeLessThanOrEqual(TRACE_CAP);
    expect(listed.steps.some((step) => step.deliveryId === "first")).toBe(false);
  });

  it("streams recorded steps to an open socket", async () => {
    const stub = coordinator("trace/stream");
    const response = await stub.fetch(`${BASE}/trace/socket`, {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).toBeTruthy();
    socket!.accept();

    const messages: Array<Record<string, unknown>> = [];
    socket!.addEventListener("message", (event) => {
      messages.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await record("trace/stream", { deliveryId: "s-1", step: "claimed", status: "info", detail: "live" });
    // Give the broadcast a turn of the event loop; the send is synchronous inside
    // record(), so this is a scheduling wait, not a poll.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(messages[0]?.["type"]).toBe("hello");
    const step = messages.find((message) => message["type"] === "step");
    expect(step?.["step"]).toMatchObject({ deliveryId: "s-1", step: "claimed", detail: "live" });
    socket!.close();
  });

  it("sizes the hello frame by the viewer's limit", async () => {
    const stub = coordinator("trace/limit");
    for (let index = 0; index < 6; index += 1) {
      await record("trace/limit", { deliveryId: `l-${index}`, step: "claimed", status: "info", detail: `step ${index}` });
    }
    const response = await stub.fetch(`${BASE}/trace/socket?limit=3`, { headers: { upgrade: "websocket" } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const hello = await new Promise<{ type: string; steps: unknown[] }>((resolve) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String((event as MessageEvent).data))));
    });
    expect(hello.type).toBe("hello");
    expect(hello.steps).toHaveLength(3);
    socket.close();
  });

  it("rejects a socket handshake that is not an upgrade", async () => {
    const stub = coordinator("trace/noop");
    const response = await stub.fetch(`${BASE}/trace/socket`);
    expect(response.status).toBe(426);
  });
});

describe("trace route guards", () => {
  const worker = env.REPO_COORDINATOR;

  function app() {
    return import("../src/index").then((module) => module.default);
  }

  async function call(path: string, headers: Record<string, string> = {}, workerEnv = env): Promise<Response> {
    const handler = await app();
    return handler.fetch(new Request(`https://factory.example${path}`, { headers }), workerEnv as never);
  }

  it("serves the trace to the control plane only", async () => {
    // No key configured on this binding set: the route fails closed.
    const unconfigured = await call("/trace/acme/widget", {}, { ...env, BROKER_CONTROL_KEY: undefined } as never);
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({ ok: false, error: "control key not configured" });

    const guarded = await call("/trace/acme/widget", {}, { ...env, BROKER_CONTROL_KEY: controlKey } as never);
    expect(guarded.status).toBe(401);

    const allowed = await call(
      "/trace/acme/widget?limit=5",
      { "x-factory-control-key": controlKey },
      { ...env, BROKER_CONTROL_KEY: controlKey } as never,
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ ok: true });

    // A guess of the right length, and a guess sharing the real prefix, are both
    // refused: the compare is the constant-time sameSecret, not a byte scan (9t2).
    for (const guess of ["test-controlx", "test-contro"]) {
      const refused = await call(
        "/trace/acme/widget",
        { "x-factory-control-key": guess },
        { ...env, BROKER_CONTROL_KEY: controlKey } as never,
      );
      expect(refused.status).toBe(401);
    }
    const empty = await call("/trace/acme/widget", { "x-factory-control-key": "" }, { ...env, BROKER_CONTROL_KEY: controlKey } as never);
    expect(empty.status).toBe(401);

    // The socket takes the key as a query parameter (a browser cannot set a
    // handshake header), and a real upgrade gets the 101 from the object.
    const socket = await call(
      `/trace/acme/widget/socket?key=${controlKey}`,
      { upgrade: "websocket" },
      { ...env, BROKER_CONTROL_KEY: controlKey } as never,
    );
    expect(socket.status).toBe(101);
    socket.webSocket?.accept();
    socket.webSocket?.close();

    // The webhook path is untouched by the new route.
    expect(env.REPO_COORDINATOR).toBe(worker);
  });
});

describe("estimateTokens", () => {
  it("is the conventional four-characters-per-token estimate", () => {
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("pipeline trace", () => {
  it("records the ordered steps of a real run, including the prompt and the settlement", async () => {
    // A signed webhook queues one event; draining it runs the pipeline with the
    // trace sink wired exactly as the routes wire it.
    const repository = "trace/pipeline";
    const stub = coordinator(repository);
    const deliveryId = "trace-pipeline-1";
    const body = pushPayload(deliveryId, repository);
    const { signBody, TEST_SECRET } = await import("./support/webhook");
    const queued = await stub.fetch(`${BASE}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "pull_request",
        "x-hub-signature-256": await signBody(TEST_SECRET, body),
      },
      body,
    });
    expect(queued.status).toBe(202);

    const { drainRepository } = await import("../src/pipeline");
    const { traceSink } = await import("../src/events");
    await drainRepository({
      repository,
      controlKey,
      coordinator: stub,
      broker: env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(repository)),
      onStep: traceSink(stub),
    });

    const listed = (await (await stub.fetch(`${BASE}/trace?deliveryId=${deliveryId}`)).json()) as {
      steps: Array<{ step: string; artifact: unknown }>;
    };
    const names = listed.steps.map((step) => step.step);
    expect(names[0]).toBe("claimed");
    expect(names).toContain("facts");
    expect(names).toContain("agent");
    expect(names[names.length - 1]).toBe("settled");
    const settled = listed.steps.find((step) => step.step === "settled")?.artifact as Record<string, unknown>;
    expect(typeof settled["tokensIn"]).toBe("number");
    expect(Array.isArray(settled["actionTypes"])).toBe(true);
  });
});
