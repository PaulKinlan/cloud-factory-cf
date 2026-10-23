import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseSettlement, planAgents, sourceMatches, uniqueClaims } from "../src/canvas-runs";
import { sinksFor } from "../src/pipeline";
import { signBody, TEST_SECRET } from "./support/webhook";
import { getRepoCoordinator } from "../src/repo-coordinator-addressing";

function coordinator(repository: string) {
  return getRepoCoordinator(env, repository, "github");
}

/** Simulates a lease/backoff elapsing without sleeping in the test. */
async function makeDue(repository: string, deliveryId: string): Promise<void> {
  await runInDurableObject(coordinator(repository), (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE events SET available_at = ? WHERE delivery_id = ?",
      new Date(Date.now() - 1_000).toISOString(),
      deliveryId,
    );
  });
}

/**
 * A stored canvas document is the agent configuration, so this exercises the
 * whole path: PUT a layout, queue matching events, POST the run route, and check
 * what the agent produced through the credential broker, plus the audit trail.
 */
const CONTROL_KEY = "test-control-key";
const GITHUB_CREDENTIAL = "ghp_test_github_credential";
const REPOSITORY = "acme/canvas-runs";

interface NodeSpec {
  id: string;
  kind: "agent" | "source" | "memory" | "sink";
  label: string;
  config?: Record<string, string>;
}

function layout(nodes: NodeSpec[], edges: Array<[string, string]>): Record<string, unknown> {
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
    edges: edges.map(([from, to], index) => ({ id: `e-${index}`, from, to })),
    view: { x: 0, y: 0, zoom: 1 },
  };
}

/** agent <- source, agent -> sink (+ optional memory hub). */
function wiredLayout(options: { prompt?: string; provider?: string; event?: string; sink?: string; withMemory?: boolean } = {}): Record<string, unknown> {
  const sink = options.sink ?? "github-pr-review";
  const nodes: NodeSpec[] = [
    {
      id: "n-agent",
      kind: "agent",
      label: "Reviewer",
      config: { prompt: options.prompt ?? "Review this change and comment.", model: "deepseek/deepseek-flash" },
    },
    {
      id: "n-source",
      kind: "source",
      label: "Pull requests",
      config: { provider: options.provider ?? "github", event: options.event ?? "pull_request" },
    },
    { id: "n-sink", kind: "sink", label: "Review", config: { type: sink } },
  ];
  const edges: Array<[string, string]> = [
    ["n-source", "n-agent"],
    ["n-agent", "n-sink"],
  ];
  if (options.withMemory) {
    nodes.push({ id: "n-memory", kind: "memory", label: "Repo memory", config: { scope: "repo" } });
    edges.push(["n-agent", "n-memory"]);
  }
  return layout(nodes, edges);
}

/** The per-(event, agent) delivery ledger a repository's coordinator keeps. */
async function ledger(repository: string, deliveryId: string): Promise<Array<{ agentId: string; status: string; attempts: number }>> {
  const coord = coordinator(repository);
  const response = await coord.fetch(`https://repo-coordinator.internal/deliveries?deliveryId=${encodeURIComponent(deliveryId)}`);
  const payload = (await response.json()) as { deliveries?: Array<{ agentId: string; status: string; attempts: number }> };
  return payload.deliveries ?? [];
}

async function storeDocument(repository: string, document: unknown, name = "Layout"): Promise<string> {
  const response = await SELF.fetch(`https://example.com/canvas/${repository}/documents`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
    body: JSON.stringify({ name, document }),
  });
  expect([200, 201]).toContain(response.status);
  return ((await response.json()) as { id: string }).id;
}

async function provision(repository: string, action: string): Promise<void> {
  const response = await SELF.fetch(`https://example.com/broker/${repository}/provisioning`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
    body: JSON.stringify({ agent: `cloud-factory:${repository}`, service: "github", action }),
  });
  expect([200, 201]).toContain(response.status);
}

async function enqueue(repository: string, deliveryId: string, body: unknown, event = "pull_request"): Promise<void> {
  const payload = JSON.stringify(body);
  const response = await SELF.fetch(`https://example.com/webhooks/github/${repository}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": event,
      "x-hub-signature-256": await signBody(TEST_SECRET, payload),
    },
    body: payload,
  });
  expect(response.status).toBe(202);
}

function pullRequest(repository: string, number: number): unknown {
  return {
    action: "opened",
    number,
    delivery: `d-${number}`,
    sender: { login: "octocat" },
    repository: { full_name: repository },
    pull_request: { number, title: `PR ${number}`, state: "open" },
  };
}

async function runDocument(
  repository: string,
  documentId: string,
  init: { controlKey?: string | null; method?: string; limit?: number } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.controlKey !== null) headers["x-factory-control-key"] = init.controlKey ?? CONTROL_KEY;
  const method = init.method ?? "POST";
  return SELF.fetch(`https://example.com/canvas/${repository}/documents/${documentId}/run`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(init.limit === undefined ? {} : { limit: init.limit }) : undefined,
  });
}

function stubUpstream(): { calls: Array<{ url: string; body?: unknown }> } {
  const calls: Array<{ url: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }) as unknown as typeof fetch,
  );
  return { calls };
}

async function audit(repository: string): Promise<Array<{ documentId: string; agents: number; detail: unknown }>> {
  const coord = coordinator(repository);
  const response = await coord.fetch("https://repo-coordinator.internal/runs/audit?limit=10");
  const payload = (await response.json()) as { runs?: Array<{ documentId: string; agents: number; detail: unknown }> };
  return payload.runs ?? [];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canvas run planning", () => {
  it("derives one plan per agent from the layout wiring", () => {
    const planned = planAgents(wiredLayout({ withMemory: true }));
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan).toHaveLength(1);
    expect(planned.plan[0]).toMatchObject({
      id: "n-agent",
      name: "Reviewer",
      prompt: "Review this change and comment.",
      model: "deepseek/deepseek-flash",
      sources: [{ provider: "github", event: "pull_request" }],
      memoryScope: "repo",
      sinks: ["github-pr-review"],
    });
  });

  it("refuses a layout it cannot run, with a reason naming the agent", () => {
    const noPrompt = wiredLayout({ prompt: "   " });
    expect(planAgents(noPrompt)).toEqual({
      ok: false,
      error: "agent “Reviewer” has no prompt, so it cannot run",
    });

    // An agent with no source wired in cannot be triggered by anything.
    const noSource = layout(
      [
        { id: "n-agent", kind: "agent", label: "Lonely", config: { prompt: "hi", model: "m" } },
        { id: "n-sink", kind: "sink", label: "Sink", config: { type: "github-pr-review" } },
      ],
      [["n-agent", "n-sink"]],
    );
    expect(planAgents(noSource)).toEqual({
      ok: false,
      error: "agent “Lonely” has no event source wired to it",
    });

    expect(planAgents({ version: 99 })).toEqual({
      ok: false,
      error: "the stored document is not a canvas this version can read",
    });
    expect(planAgents(layout([], []))).toEqual({
      ok: false,
      error: "the layout has no agent nodes, so there is nothing to run",
    });
  });

  it("releases a lease at most once, keeping order (qwo)", () => {
    const claim = (deliveryId: string, leaseId: string) => ({
      deliveryId,
      provider: "github",
      event: "pull_request",
      action: "opened",
      repository: REPOSITORY,
      actor: "octocat",
      attempts: 1,
      leaseId,
    });
    const events = [claim("a", "l-a"), claim("b", "l-b"), claim("a", "l-a")];
    expect(uniqueClaims(events).map((event) => event.deliveryId)).toEqual(["a", "b"]);
    expect(uniqueClaims([])).toEqual([]);
  });

  it("matches sources by provider and event, with * as a wildcard", () => {
    const githubPr = { provider: "github", event: "pull_request" };
    expect(sourceMatches({ provider: "github", event: "pull_request" }, githubPr)).toBe(true);
    expect(sourceMatches({ provider: "github", event: "issues" }, githubPr)).toBe(false);
    expect(sourceMatches({ provider: "gitlab", event: "pull_request" }, githubPr)).toBe(false);
    expect(sourceMatches({ provider: "github", event: "*" }, githubPr)).toBe(true);
  });
});

describe("canvas run route", () => {
  it("runs the stored layout's agent against the matching queued event and audits it", async () => {
    const repository = "acme/canvas-run-happy";
    await provision(repository, "pr.review");
    const documentId = await storeDocument(repository, wiredLayout(), "Reviewer layout");
    await enqueue(repository, "run-1", pullRequest(repository, 21));
    const { calls } = stubUpstream();

    const response = await runDocument(repository, documentId);
    expect(response.status).toBe(200);
    const report = (await response.json()) as {
      ok: boolean;
      documentId: string;
      name: string;
      ran: number;
      failed: number;
      agents: Array<{ agentId: string; status: string; runs: Array<{ deliveryId: string; status: string; settled: boolean }> }>;
    };
    expect(report).toMatchObject({ ok: true, documentId, name: "Reviewer layout", ran: 1, failed: 0 });
    expect(report.agents[0]).toMatchObject({ agentId: "n-agent", status: "ran" });
    expect(report.agents[0]?.runs[0]).toMatchObject({ deliveryId: "run-1", status: "succeeded", settled: true });

    // The layout's agent really acted: a review with the broker-held credential.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.github.com/repos/${repository}/pulls/21/reviews`);
    expect(String((calls[0]?.body as { body?: string }).body)).toContain("Automated review of #21");

    // Creation is audited with the events each agent consumed.
    const runs = await audit(repository);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ documentId, agents: 1 });
    expect(JSON.stringify(runs[0]?.detail)).toContain("run-1");
  });

  it("only claims events an agent's sources name, and leaves the rest queued", async () => {
    const repository = "acme/canvas-run-filter";
    await provision(repository, "pr.review");
    const documentId = await storeDocument(
      repository,
      wiredLayout({ provider: "gitlab", event: "merge_request" }),
      "Gitlab only",
    );
    await enqueue(repository, "filter-gh", pullRequest(repository, 22));
    const { calls } = stubUpstream();

    const report = (await (await runDocument(repository, documentId)).json()) as {
      ran: number;
      agents: Array<{ status: string; runs: unknown[] }>;
    };
    expect(report.ran).toBe(0);
    expect(report.agents[0]?.status).toBe("no-events");
    expect(calls).toHaveLength(0);

    // The unrelated event is back on the queue for whoever does want it.
    const coord = coordinator(repository);
    const stats = await coord.fetch("https://repo-coordinator.internal/stats");
    const counts = ((await stats.json()) as { counts?: Record<string, number> }).counts ?? {};
    expect(counts["pending"]).toBe(1);
    expect(counts["processing"] ?? 0).toBe(0);
  });

  it("reports a layout it cannot run and claims nothing", async () => {
    const repository = "acme/canvas-run-invalid";
    const documentId = await storeDocument(repository, wiredLayout({ prompt: "" }), "No prompt");
    await enqueue(repository, "invalid-1", pullRequest(repository, 23));

    const response = await runDocument(repository, documentId);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("has no prompt");
    expect(await audit(repository)).toHaveLength(0);
  });

  it("needs the control key, POST, and an existing document", async () => {
    const repository = "acme/canvas-run-auth";
    const documentId = await storeDocument(repository, wiredLayout());
    expect((await runDocument(repository, documentId, { controlKey: null })).status).toBe(401);
    expect((await runDocument(repository, documentId, { controlKey: "wrong" })).status).toBe(401);
    expect((await runDocument(repository, documentId, { method: "GET" })).status).toBe(405);
    const missing = await runDocument(repository, "does-not-exist");
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain("no such document");
  });

  it("fails the agent's run when it is not provisioned", async () => {
    const repository = "acme/canvas-run-unprovisioned";
    const documentId = await storeDocument(repository, wiredLayout());
    await enqueue(repository, "unprov-1", pullRequest(repository, 24));
    const { calls } = stubUpstream();

    const report = (await (await runDocument(repository, documentId)).json()) as {
      failed: number;
      agents: Array<{ status: string; error?: string }>;
    };
    expect(report.failed).toBe(1);
    expect(report.agents[0]?.error ?? "").toContain("not provisioned");
    expect(calls).toHaveLength(0);
  });
});

describe("canvas findings (xkg, mj7, olu)", () => {
  it("an agent wired to no supported sink gets no sink, and the run fails loudly", async () => {
    const repository = "acme/canvas-no-sink";
    await provision(repository, "pr.review");
    // Wiring names a sink type the worker does not implement.
    const documentId = await storeDocument(repository, wiredLayout({ sink: "slack-message" }), "Unsupported sink");
    await enqueue(repository, "nosink-1", pullRequest(repository, 31));
    const { calls } = stubUpstream();

    const report = (await (await runDocument(repository, documentId)).json()) as {
      failed: number;
      agents: Array<{ status: string; error?: string; runs: Array<{ error?: string }> }>;
    };
    expect(report.failed).toBe(1);
    // Loud and specific: the layout named a sink type this worker cannot serve.
    expect(report.agents[0]?.error ?? "").toContain("no sink in the wiring is one this worker can serve: slack-message");
    // Nothing reached the provider: the layout never wired a provider sink.
    expect(calls).toHaveLength(0);
    expect(sinksFor([])).toHaveLength(0);
    expect(sinksFor(["slack-message"])).toHaveLength(0);
    expect(sinksFor(undefined).map((sink) => sink.name)).toEqual(["github-pr-review-sink", "github-issue-comment-sink"]);
    // Types the worker does serve are selected by name.
    expect(sinksFor(["beads-task"]).map((sink) => sink.name)).toEqual(["beads-task-sink"]);
    expect(sinksFor(["telemetry"]).map((sink) => sink.name)).toEqual(["cloud-telemetry-sink"]);
    expect(sinksFor(["github-issue-create"]).map((sink) => sink.name)).toEqual(["github-issue-create-sink"]);
  });

  it("claims only what the run will process, so nothing sits on a lease", async () => {
    const repository = "acme/canvas-limit";
    await provision(repository, "pr.review");
    const documentId = await storeDocument(repository, wiredLayout(), "Limited");
    await enqueue(repository, "limit-1", pullRequest(repository, 32));
    await enqueue(repository, "limit-2", pullRequest(repository, 33));
    const { calls } = stubUpstream();

    const report = (await (await runDocument(repository, documentId, { limit: 1 })).json()) as {
      ran: number;
      agents: Array<{ runs: Array<{ deliveryId: string; settled: boolean }> }>;
    };
    expect(report.ran).toBe(1);
    expect(report.agents[0]?.runs[0]?.settled).toBe(true);
    expect(calls).toHaveLength(1);

    // The second delivery was never claimed: a run claims `limit` events for the
    // whole document, so there is nothing left on a lease and no attempt spent.
    const coord = coordinator(repository);
    const stats = await coord.fetch("https://repo-coordinator.internal/stats");
    const counts = ((await stats.json()) as { counts?: Record<string, number> }).counts ?? {};
    expect(counts["processing"] ?? 0).toBe(0);
    expect(counts["pending"]).toBe(1);
    const events = await coord.fetch("https://repo-coordinator.internal/events?limit=10");
    const listed = ((await events.json()) as { events?: Array<{ deliveryId: string; status: string; attempts: number }> }).events ?? [];
    const deferred = listed.find((event) => event.deliveryId === "limit-2");
    expect(deferred?.status).toBe("pending");
    expect(deferred?.attempts).toBe(0);
  });

  it("writes the review counter in the memory scope the layout wires", async () => {
    const repository = "acme/canvas-org-memory";
    await provision(repository, "pr.review");
    const documentId = await storeDocument(
      repository,
      wiredLayout({ withMemory: true }),
      "Org memory",
    );
    // wiredLayout wires a repo-scoped hub; switch it to org.
    const stored = await SELF.fetch(`https://example.com/canvas/${repository}/documents/${documentId}`, {
      headers: { "x-factory-control-key": CONTROL_KEY },
    });
    const body = (await stored.json()) as { document: { nodes: Array<{ id: string; config: Record<string, string> }> } };
    const memoryNode = body.document.nodes.find((node) => node.id === "n-memory");
    if (memoryNode) memoryNode.config = { scope: "org" };
    const put = await SELF.fetch(`https://example.com/canvas/${repository}/documents/${documentId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
      body: JSON.stringify({ name: "Org memory", document: body.document }),
    });
    expect(put.status).toBe(200);

    await enqueue(repository, "org-1", pullRequest(repository, 34));
    stubUpstream();
    expect((await runDocument(repository, documentId)).status).toBe(200);
    vi.unstubAllGlobals();
    await enqueue(repository, "org-2", pullRequest(repository, 35));
    const second = stubUpstream();
    expect((await runDocument(repository, documentId)).status).toBe(200);
    // The second run counts in org memory, which is what the wiring says.
    expect(String((second.calls[0]?.body as { body?: string }).body)).toContain("review #2");

    const coord = coordinator(repository);
    const repoMemory = await coord.fetch("https://repo-coordinator.internal/memory?scope=repo");
    expect(((await repoMemory.json()) as { total?: number }).total ?? 0).toBe(0);
  });
});

describe("fan-out: one event, several agents (cloud-factory-cf-sdq)", () => {
  function twoAgentLayout(): Record<string, unknown> {
    return layout(
      [
        {
          id: "n-source",
          kind: "source",
          label: "Pull requests",
          config: { provider: "github", event: "pull_request" },
        },
        { id: "n-reviewer", kind: "agent", label: "Reviewer", config: { prompt: "Review the change.", model: "m" } },
        { id: "n-docs", kind: "agent", label: "Docs checker", config: { prompt: "Check the docs.", model: "m" } },
        { id: "n-sink-a", kind: "sink", label: "Review", config: { type: "github-pr-review" } },
      ],
      [
        ["n-source", "n-reviewer"],
        ["n-source", "n-docs"],
        ["n-reviewer", "n-sink-a"],
        ["n-docs", "n-sink-a"],
      ],
    );
  }

  it("runs every agent the event is wired to, and settles the event once", async () => {
    const repository = "acme/canvas-fanout";
    await provision(repository, "pr.review");
    const documentId = await storeDocument(repository, twoAgentLayout(), "Two agents");
    await enqueue(repository, "fan-1", pullRequest(repository, 41));
    const { calls } = stubUpstream();

    const report = (await (await runDocument(repository, documentId)).json()) as {
      ran: number;
      events: number;
      failed: number;
      agents: Array<{ agentId: string; status: string; runs: Array<{ deliveryId: string; settled: boolean }> }>;
    };
    expect(report).toMatchObject({ ran: 2, events: 1, failed: 0 });
    expect(report.agents.map((agent) => agent.agentId)).toEqual(["n-reviewer", "n-docs"]);
    for (const agent of report.agents) {
      expect(agent.status).toBe("ran");
      expect(agent.runs).toHaveLength(1);
      expect(agent.runs[0]).toMatchObject({ deliveryId: "fan-1", settled: true });
    }
    // Both agents acted on the same event.
    expect(calls).toHaveLength(2);
    // The event was settled once: it is processed, not pending or processing.
    const coord = coordinator(repository);
    const stats = await coord.fetch("https://repo-coordinator.internal/stats");
    const counts = ((await stats.json()) as { counts?: Record<string, number> }).counts ?? {};
    expect(counts["processed"]).toBe(1);
    expect(counts["processing"] ?? 0).toBe(0);
  });

  it("leaves the event queued when the layout has no agent for it", async () => {
    const repository = "acme/canvas-fanout-none";
    const documentId = await storeDocument(
      repository,
      wiredLayout({ provider: "gitlab", event: "merge_request" }),
      "Gitlab only",
    );
    await enqueue(repository, "fan-2", pullRequest(repository, 42));
    stubUpstream();

    const report = (await (await runDocument(repository, documentId)).json()) as { ran: number; events: number };
    expect(report).toMatchObject({ ran: 0, events: 0 });
    const coord = coordinator(repository);
    const stats = await coord.fetch("https://repo-coordinator.internal/stats");
    const counts = ((await stats.json()) as { counts?: Record<string, number> }).counts ?? {};
    expect(counts["pending"]).toBe(1);
  });
});

describe("idempotent delivery across fan-out retries (cloud-factory-cf-eu3)", () => {
  function mixedLayout(): Record<string, unknown> {
    // Reviewer delivers; the "docs" agent is wired to a sink type this worker
    // does not implement, so it always fails. That makes the event fail after the
    // reviewer already delivered — the exact partial-failure case.
    return layout(
      [
        { id: "n-source", kind: "source", label: "Pull requests", config: { provider: "github", event: "pull_request" } },
        { id: "n-reviewer", kind: "agent", label: "Reviewer", config: { prompt: "Review.", model: "m" } },
        { id: "n-docs", kind: "agent", label: "Docs", config: { prompt: "Check docs.", model: "m" } },
        { id: "n-review-sink", kind: "sink", label: "Review", config: { type: "github-pr-review" } },
        { id: "n-unknown-sink", kind: "sink", label: "Beads", config: { type: "beads-task" } },
      ],
      [
        ["n-source", "n-reviewer"],
        ["n-source", "n-docs"],
        ["n-reviewer", "n-review-sink"],
        ["n-docs", "n-unknown-sink"],
      ],
    );
  }



  it("claim/complete decides whether a pair still has work", async () => {
    const repository = "acme/idempotency-ledger";
    const coord = coordinator(repository);
    const post = async (path: string, body: unknown) =>
      (await (
        await coord.fetch(`https://repo-coordinator.internal${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json()) as { ok: boolean; run?: boolean; status?: string; error?: string };

    expect(await post("/deliveries/claim", { deliveryId: "ev-1", agentId: "a" })).toMatchObject({ ok: true, run: true });
    expect(await post("/deliveries/complete", { deliveryId: "ev-1", agentId: "a", status: "delivered" })).toMatchObject({ ok: true });
    // The second claim for the same pair does not run again.
    expect(await post("/deliveries/claim", { deliveryId: "ev-1", agentId: "a" })).toMatchObject({ ok: true, run: false });
    // A failed pair is retried.
    expect(await post("/deliveries/complete", { deliveryId: "ev-1", agentId: "a", status: "failed" })).toMatchObject({ ok: true });
    expect(await post("/deliveries/claim", { deliveryId: "ev-1", agentId: "a" })).toMatchObject({ ok: true, run: true });
    // Validation and the listing.
    expect((await post("/deliveries/claim", {})).ok).toBe(false);
    expect((await post("/deliveries/complete", { deliveryId: "ev-1", agentId: "a", status: "nonsense" })).ok).toBe(false);
    // Two runs claimed the pair (the skipped claim does not count); it is
    // currently started again, so a crash mid-flight is retried.
    expect(await ledger(repository, "ev-1")).toEqual([{ agentId: "a", status: "started", attempts: 2, updatedAt: expect.any(String) }]);
  });

  it("does not post a review twice when a partially failed event is retried", async () => {
    const repository = "acme/idempotency-retry";
    await provision(repository, "pr.review");
    const documentId = await storeDocument(repository, mixedLayout(), "Mixed");
    await enqueue(repository, "retry-1", pullRequest(repository, 51));
    const first = stubUpstream();

    const firstReport = (await (await runDocument(repository, documentId)).json()) as {
      ran: number;
      failed: number;
      agents: Array<{ agentId: string; status: string; error?: string }>;
    };
    expect(firstReport.ran).toBe(2);
    expect(firstReport.failed).toBe(1);
    expect(firstReport.agents.find((agent) => agent.agentId === "n-reviewer")?.status).toBe("ran");
    expect(firstReport.agents.find((agent) => agent.agentId === "n-docs")?.status).toBe("failed");
    expect(first.calls).toHaveLength(1);
    // Pair-level rows (no `#`) say what each agent did; `agent#action` rows record
    // each action so a partial failure retries only what failed (j1y).
    const retryRows = await ledger(repository, "retry-1");
    expect(retryRows.filter((row) => !row.agentId.includes("#"))).toEqual([
      { agentId: "n-docs", status: "failed", attempts: 1, updatedAt: expect.any(String) },
      { agentId: "n-reviewer", status: "delivered", attempts: 1, updatedAt: expect.any(String) },
    ]);
    expect(retryRows.find((row) => row.agentId === "n-reviewer#github:pr:review")).toMatchObject({
      status: "delivered",
      attempts: 1,
    });

    // The failed event comes back after its backoff; the reviewer must not post
    // a second review, and the docs agent retries.
    vi.unstubAllGlobals();
    await makeDue(repository, "retry-1");
    const second = stubUpstream();
    const secondReport = (await (await runDocument(repository, documentId)).json()) as {
      ran: number;
      deduped: number;
      failed: number;
      agents: Array<{ agentId: string; status: string; runs: Array<{ duplicate?: boolean }> }>;
    };
    expect(secondReport.deduped).toBe(1);
    expect(secondReport.ran).toBe(1);
    expect(secondReport.failed).toBe(1);
    expect(secondReport.agents.find((agent) => agent.agentId === "n-reviewer")?.runs[0]?.duplicate).toBe(true);
    // No second provider call: the review was delivered once.
    expect(second.calls).toHaveLength(0);
  }, 60_000);
});

describe("one ledger for every runner (cloud-factory-cf-7wj, cloud-factory-cf-lbi)", () => {
  /** Two agents on one PR source; the docs agent always fails so the event retries. */
  function mixedLayout(): Record<string, unknown> {
    return layout(
      [
        { id: "n-source", kind: "source", label: "Pull requests", config: { provider: "github", event: "pull_request" } },
        { id: "n-reviewer", kind: "agent", label: "Reviewer", config: { prompt: "Review.", model: "m" } },
        { id: "n-docs", kind: "agent", label: "Docs", config: { prompt: "Check docs.", model: "m" } },
        { id: "n-review-sink", kind: "sink", label: "Review", config: { type: "github-pr-review" } },
        { id: "n-unknown-sink", kind: "sink", label: "Beads", config: { type: "beads-task" } },
      ],
      [
        ["n-source", "n-reviewer"],
        ["n-source", "n-docs"],
        ["n-reviewer", "n-review-sink"],
        ["n-docs", "n-unknown-sink"],
      ],
    );
  }

  function stubUpstream() {
    const calls: Array<{ url: string }> = [];
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        calls.push({ url: String(input) });
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      }) as unknown as typeof fetch,
    );
    return { calls };
  }

  async function drain(repository: string): Promise<{ claimed: number; skipped: number; ran: number }> {
    const response = await SELF.fetch(`https://example.com/runs/${repository}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { claimed: number; skipped: number; ran: number };
  }

  it("does not post the review twice when the queue drain retries a canvas event", async () => {
    const repository = "acme/ledger-drain";
    await provision(repository, "pr.review");
    // The docs agent is wired to beads with no beads deployment configured here,
    // so that pair fails and the event goes back to the queue.
    const documentId = await storeDocument(repository, mixedLayout(), "Mixed");
    await enqueue(repository, "drain-1", pullRequest(repository, 61));
    const first = stubUpstream();

    const firstReport = (await (await runDocument(repository, documentId)).json()) as { failed: number };
    expect(firstReport.failed).toBe(1);
    expect(first.calls).toHaveLength(1);

    // The other public runner, which used to bypass the ledger entirely.
    vi.unstubAllGlobals();
    await makeDue(repository, "drain-1");
    const second = stubUpstream();
    const drained = await drain(repository);
    expect(drained.claimed).toBe(1);
    // No second review: the reviewer's pair is already delivered, so the drain
    // has nothing to do and hands the event back for the canvas runner instead of
    // acknowledging the docs agent's failure.
    expect(second.calls).toHaveLength(0);
    expect(drained.skipped).toBe(1);
    const drainRows = await ledger(repository, "drain-1");
    expect(drainRows.filter((row) => !row.agentId.includes("#"))).toEqual([
      { agentId: "n-docs", status: "failed", attempts: 1, updatedAt: expect.any(String) },
      { agentId: "n-reviewer", status: "delivered", attempts: 1, updatedAt: expect.any(String) },
    ]);
    // Still queued, with no attempt spent by the drain.
    const stats = (await (
      await coordinator(repository).fetch(
        "https://repo-coordinator.internal/stats",
      )
    ).json()) as { counts: Record<string, number> };
    expect(stats.counts["pending"]).toBe(1);
  }, 60_000);

});

describe("fan-out settlement when a ledger write is lost (cloud-factory-cf-lbi)", () => {
  const outcome = (overrides: Partial<{ status: "succeeded" | "failed" | "skipped"; deliveryError: string }>) => ({
    deliveryId: "d-1",
    status: "succeeded" as const,
    settled: true,
    prompt: "",
    actionTypes: [] as string[],
    durationMs: 0,
    ...overrides,
  });

  it("retries the event when an agent simply failed", () => {
    const chosen = chooseSettlement([outcome({}), outcome({ status: "failed" })]);
    expect(chosen.retry).toBe(true);
    expect(chosen.outcome.status).toBe("failed");
    expect(chosen.ledgerErrors).toEqual([]);
  });

  it("acknowledges instead of retrying when a delivered agent's ledger write was lost", () => {
    // The reviewer delivered but its completion was rejected; the docs agent
    // failed. Retrying would post the review a second time, so the event is
    // acknowledged and the gap reported.
    const chosen = chooseSettlement([
      outcome({ deliveryError: "delivery ledger rejected the completion (503)" }),
      outcome({ status: "failed" }),
    ]);
    expect(chosen.retry).toBe(false);
    expect(chosen.outcome.status).toBe("succeeded");
    expect(chosen.ledgerErrors).toEqual(["delivery ledger rejected the completion (503)"]);
  });

  it("acknowledges a single failed outcome that carries a ledger gap (ww9)", () => {
    // One agent: the provider call happened, the ledger write was rejected and the
    // run also failed. Settling as failed would retry and repeat the provider call.
    const chosen = chooseSettlement([
      outcome({ status: "failed", deliveryError: "delivery ledger rejected the completion (503)" }),
    ]);
    expect(chosen.retry).toBe(false);
    expect(chosen.outcome.status).toBe("succeeded");
    expect(chosen.ledgerErrors).toEqual(["delivery ledger rejected the completion (503)"]);
  });

  it("acknowledges when every agent delivered", () => {
    const chosen = chooseSettlement([outcome({}), outcome({})]);
    expect(chosen.retry).toBe(false);
    expect(chosen.outcome.status).toBe("succeeded");
  });
});
