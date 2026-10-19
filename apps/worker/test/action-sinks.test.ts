import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentContext } from "@factory-cloud/sdk";
import { SINK_TYPES, allSinks, telemetrySink } from "../src/action-sinks";
import { sinksFor } from "../src/pipeline";
import { signBody, TEST_SECRET } from "./support/webhook";

/**
 * The sinks a canvas layout can wire: an issue created on the provider, a beads
 * task through the broker, and telemetry exported to an endpoint or the log
 * (cloud-factory-cf-n4s). Each one has to reach a real destination or fail with a
 * reason an operator can act on.
 */
const CONTROL_KEY = "test-control-key";
const REPOSITORY = "acme/action-sinks";

interface NodeSpec {
  id: string;
  kind: "agent" | "source" | "sink";
  label: string;
  config?: Record<string, string>;
}

function layout(sinkType: string, opts: { provider?: string; event?: string } = {}): Record<string, unknown> {
  const nodes: NodeSpec[] = [
    { id: "n-agent", kind: "agent", label: "Agent", config: { prompt: "Act on this event.", model: "m" } },
    {
      id: "n-source",
      kind: "source",
      label: "Source",
      config: { provider: opts.provider ?? "github", event: opts.event ?? "pull_request" },
    },
    { id: "n-sink", kind: "sink", label: "Sink", config: { type: sinkType } },
  ];
  return {
    version: 1,
    nodes: nodes.map((node, index) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      x: index * 40,
      y: index * 20,
      config: node.config ?? {},
    })),
    edges: [
      { id: "e-0", from: "n-source", to: "n-agent" },
      { id: "e-1", from: "n-agent", to: "n-sink" },
    ],
    view: { x: 0, y: 0, zoom: 1 },
  };
}

async function storeDocument(document: unknown, repository = REPOSITORY): Promise<string> {
  const response = await SELF.fetch(`https://example.com/canvas/${repository}/documents`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
    body: JSON.stringify({ name: "Sink layout", document }),
  });
  expect([200, 201]).toContain(response.status);
  return ((await response.json()) as { id: string }).id;
}

async function provision(service: string, action: string, repository = REPOSITORY): Promise<void> {
  const response = await SELF.fetch(`https://example.com/broker/${repository}/provisioning`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
    body: JSON.stringify({ agent: `cloud-factory:${repository}`, service, action }),
  });
  expect([200, 201]).toContain(response.status);
}

async function enqueue(deliveryId: string, repository = REPOSITORY): Promise<void> {
  const payload = JSON.stringify({
    action: "opened",
    number: 12,
    delivery: deliveryId,
    sender: { login: "octocat" },
    repository: { full_name: repository },
    pull_request: { number: 12, title: "Add the sink wiring", state: "open" },
  });
  const response = await SELF.fetch(`https://example.com/webhooks/github/${repository}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "pull_request",
      "x-hub-signature-256": await signBody(TEST_SECRET, payload),
    },
    body: payload,
  });
  expect(response.status).toBe(202);
}

async function run(documentId: string, repository = REPOSITORY): Promise<{ ran: number; failed: number; agents: Array<{ status: string; error?: string }> }> {
  const response = await SELF.fetch(`https://example.com/canvas/${repository}/documents/${documentId}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { ran: number; failed: number; agents: Array<{ status: string; error?: string }> };
}

function stubUpstream(status = 201): { calls: Array<{ url: string; method?: string; body?: unknown; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; method?: string; body?: unknown; headers: Record<string, string> }> = [];
  vi.stubGlobal(
    "fetch",
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(JSON.stringify({ id: 1 }), { status });
    }) as unknown as typeof fetch,
  );
  return { calls };
}

let deliverySeq = 0;

/** Runs a layout wired to one sink type and returns the report plus upstream calls. */
async function runWithSink(sinkType: string, repository = REPOSITORY): Promise<{
  report: { ran: number; failed: number; agents: Array<{ status: string; error?: string }> };
  calls: Array<{ url: string; method?: string; body?: unknown; headers: Record<string, string> }>;
}> {
  const documentId = await storeDocument(layout(sinkType), repository);
  deliverySeq += 1;
  await enqueue(`sink-${sinkType}-${deliverySeq}`, repository);
  const { calls } = stubUpstream();
  const report = await run(documentId, repository);
  return { report, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canvas sink catalogue", () => {
  it("maps the sink types a layout may name onto the sinks that serve them", () => {
    expect(SINK_TYPES).toMatchObject({
      "github-pr-review": "github-pr-review-sink",
      "github-issue-comment": "github-issue-comment-sink",
      "github-issue-create": "github-issue-create-sink",
      "beads-task": "beads-task-sink",
      telemetry: "cloud-telemetry-sink",
    });
    expect(sinksFor(["beads-task"]).map((sink) => sink.name)).toEqual(["beads-task-sink"]);
    expect(sinksFor(["telemetry"]).map((sink) => sink.name)).toEqual(["cloud-telemetry-sink"]);
    expect(sinksFor(["github-issue-create"]).map((sink) => sink.name)).toEqual(["github-issue-create-sink"]);
    expect(sinksFor(["slack-message"])).toHaveLength(0);
    expect(Object.keys(allSinks()).sort()).toEqual([
      "beads-task-sink",
      "cloud-telemetry-sink",
      "github-issue-comment-sink",
      "github-issue-create-sink",
      "github-pr-review-sink",
    ]);
  });
});

describe("issue-create sink", () => {
  it("creates an issue through the broker's issue.create action", async () => {
    await provision("github", "issue.create");
    const { report, calls } = await runWithSink("github-issue-create");

    expect(report.ran).toBe(1);
    expect(report.failed).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.github.com/repos/${REPOSITORY}/issues`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toMatchObject({ title: expect.stringContaining("Add the sink wiring") });
    expect(String((calls[0]?.body as { body?: string }).body)).toContain("cloud-factory");
    // The credential never appears in the report.
    expect(JSON.stringify(report)).not.toContain("ghp_test_github_credential");
  });

  it("is refused by the broker when the action is not provisioned", async () => {
    // A repository of its own: provisioning records are per (agent, service,
    // action), so sharing one would make this test depend on the one above.
    const { report } = await runWithSink("github-issue-create", "acme/action-sinks-unprovisioned");
    expect(report.failed).toBe(1);
    expect(report.agents[0]?.error ?? "").toContain("provision");
  });
});

describe("beads-task sink", () => {
  it("creates the task at the configured beads host with the broker's token", async () => {
    await provision("beads", "task.create");
    const { report, calls } = await runWithSink("beads-task");

    expect(report.failed).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://beads.test/repos/${REPOSITORY}/tasks`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toMatchObject({ title: expect.stringContaining("Add the sink wiring"), priority: "P2" });
    expect(calls[0]?.headers["authorization"]).toBe("Bearer test-beads-token");
  });
});

function telemetryContext() {
  return createAgentContext({
    id: "run:telemetry",
    repo: { owner: "acme", name: "action-sinks" },
    org: { id: "acme" },
    state: { agentId: "n-agent" },
  });
}

describe("telemetry sink", () => {
  it("exports to the configured endpoint, and to the log when there is none", async () => {
    const logged: Array<Record<string, unknown>> = [];
    const action = {
      id: "a-1",
      type: "telemetry:log",
      payload: { level: "info", message: "handled pull_request.opened", attributes: { deliveryId: "d-1" } },
    };

    // No endpoint: the entry is written to the structured log and reported as
    // exported (nothing is dropped silently).
    const offline = telemetrySink({ log: (entry) => logged.push(entry) });
    const offlineResult = await offline.handle(action as never, telemetryContext());
    expect(offlineResult.success).toBe(true);
    expect(offlineResult.result).toEqual({ exported: "log" });
    expect(logged[0]).toMatchObject({ sink: "cloud-telemetry-sink", exported: "log", repository: "acme/action-sinks" });

    // With an endpoint: a POST carrying the entry.
    const calls = stubUpstream(202);
    const exported = telemetrySink({ telemetryEndpoint: "https://telemetry.test/ingest", log: (entry) => logged.push(entry) });
    const onlineResult = await exported.handle(action as never, telemetryContext());
    expect(onlineResult.success).toBe(true);
    expect(onlineResult.result).toEqual({ exported: "endpoint", status: 202 });
    expect(calls.calls).toHaveLength(1);
    expect(calls.calls[0]?.url).toBe("https://telemetry.test/ingest");
    expect(calls.calls[0]?.body).toMatchObject({ type: "log", payload: { message: "handled pull_request.opened" } });
    vi.unstubAllGlobals();
  });

  it("fails the export when the endpoint rejects it", async () => {
    stubUpstream(500);
    const sink = telemetrySink({ telemetryEndpoint: "https://telemetry.test/ingest", log: () => {} });
    const result = await sink.handle(
      { id: "a-2", type: "telemetry:log", payload: { level: "warn", message: "x" } } as never,
      telemetryContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("500");
  });

  it("runs in a canvas layout, falling back to the log when no endpoint is set", async () => {
    const documentId = await storeDocument(layout("telemetry"));
    deliverySeq += 1;
    await enqueue(`sink-telemetry-${deliverySeq}`);
    const { calls } = stubUpstream(202);
    // Configure the endpoint for this run only, the way a deployment sets it.
    const configured = await SELF.fetch(`https://example.com/canvas/${REPOSITORY}/documents/${documentId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
      body: JSON.stringify({}),
    });
    expect(configured.status).toBe(200);
    // No endpoint is configured in this deployment, so the entry goes to the log
    // and the run still succeeds — nothing is dropped silently.
    expect(((await configured.json()) as { failed: number }).failed).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
