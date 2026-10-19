import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planAgents, sourceMatches, uniqueClaims } from "../src/canvas-runs";
import { sinksFor } from "../src/pipeline";
import { signBody, TEST_SECRET } from "./support/webhook";

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
  const coordinator = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repository));
  const response = await coordinator.fetch("https://repo-coordinator.internal/runs/audit?limit=10");
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
    const coordinator = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repository));
    const stats = await coordinator.fetch("https://repo-coordinator.internal/stats");
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
    const documentId = await storeDocument(repository, wiredLayout({ sink: "beads-task" }), "Unsupported sink");
    await enqueue(repository, "nosink-1", pullRequest(repository, 31));
    const { calls } = stubUpstream();

    const report = (await (await runDocument(repository, documentId)).json()) as {
      failed: number;
      agents: Array<{ status: string; error?: string; runs: Array<{ error?: string }> }>;
    };
    expect(report.failed).toBe(1);
    expect(report.agents[0]?.error ?? "").toContain("no sink accepted");
    // Nothing reached the provider: the layout never wired a provider sink.
    expect(calls).toHaveLength(0);
    expect(sinksFor([])).toHaveLength(0);
    expect(sinksFor(["beads-task"])).toHaveLength(0);
    expect(sinksFor(undefined).map((sink) => sink.name)).toEqual(["github-pr-review-sink", "github-issue-comment-sink"]);
  });

  it("releases matched events beyond the limit instead of leaving them on a lease", async () => {
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

    // The second delivery is back on the queue, not stuck processing with an
    // attempt spent.
    const coordinator = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repository));
    const stats = await coordinator.fetch("https://repo-coordinator.internal/stats");
    const counts = ((await stats.json()) as { counts?: Record<string, number> }).counts ?? {};
    expect(counts["processing"] ?? 0).toBe(0);
    expect(counts["pending"]).toBe(1);
    const events = await coordinator.fetch("https://repo-coordinator.internal/events?limit=10");
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

    const coordinator = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repository));
    const repoMemory = await coordinator.fetch("https://repo-coordinator.internal/memory?scope=repo");
    expect(((await repoMemory.json()) as { total?: number }).total ?? 0).toBe(0);
  });
});
