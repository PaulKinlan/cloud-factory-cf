import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalView,
  decideAction,
  drainRepository,
  numberFrom,
  recordingSinks,
  reviewBody,
  ruleBasedReview,
  titleFrom,
  type EventFacts,
} from "../src/pipeline";
import { githubRequest, TEST_SECRET } from "./support/webhook";
import { getRepoCoordinator } from "../src/repo-coordinator-addressing";

/**
 * End-to-end: a signed webhook lands on the queue, `POST /runs/:owner/:repo`
 * claims it, an agent run emits a sink action, the sink asks the credential
 * broker for a capability, the broker attaches the real credential upstream,
 * and the event is acked. Nothing here is mocked except the provider itself.
 */
const CONTROL_KEY = "test-control-key";
const GITHUB_CREDENTIAL = "ghp_test_github_credential";
/**
 * Every test gets its own repository: provisioning, capability quota and
 * repository memory are all keyed by it, so the tests stay independent.
 */
const REPOSITORY = "acme/pipeline";

async function provision(repository: string, action: string): Promise<void> {
  const response = await SELF.fetch(`https://example.com/broker/${repository}/provisioning`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
    body: JSON.stringify({ agent: `cloud-factory:${repository}`, service: "github", action }),
  });
  expect([200, 201]).toContain(response.status);
}

async function run(
  init: { repository?: string; controlKey?: string | null; method?: string; limit?: number } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.controlKey !== null) headers["x-factory-control-key"] = init.controlKey ?? CONTROL_KEY;
  const method = init.method ?? "POST";
  return SELF.fetch(`https://example.com/runs/${init.repository ?? REPOSITORY}`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(init.limit === undefined ? {} : { limit: init.limit }) : undefined,
  });
}

async function enqueue(deliveryId: string, body: string, event = "pull_request", repository = REPOSITORY): Promise<void> {
  const response = await SELF.fetch(`https://example.com/webhooks/github/${repository}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": event,
      "x-hub-signature-256": await sign(deliveryId, body, repository),
    },
    body,
  });
  expect(response.status).toBe(202);
}

async function sign(deliveryId: string, body: string, repository = REPOSITORY): Promise<string> {
  const request = await githubRequest(deliveryId, repository, { body });
  return request.headers.get("x-hub-signature-256") as string;
}

function pullRequestPayload(
  deliveryId: string,
  overrides: { number?: number; action?: string; title?: string; repository?: string } = {},
): string {
  const repository = overrides.repository ?? REPOSITORY;
  return JSON.stringify({
    action: overrides.action ?? "opened",
    number: overrides.number ?? 7,
    delivery: deliveryId,
    sender: { login: "octocat" },
    repository: { full_name: repository },
    pull_request: { number: overrides.number ?? 7, title: overrides.title ?? "Add the pipeline", state: "open" },
  });
}

interface UpstreamCall {
  url: string;
  authorization: string | null;
  body?: unknown;
}

function stubUpstream(status = 201): { calls: UpstreamCall[] } {
  const calls: UpstreamCall[] = [];
  vi.stubGlobal(
    "fetch",
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify({ id: 1 }), { status });
    }) as unknown as typeof fetch,
  );
  return { calls };
}

async function queueEvents(
  repository = REPOSITORY,
): Promise<Array<{ deliveryId: string; status: string; attempts: number; lastError: string | null }>> {
  const { env } = await import("cloudflare:test");
  const coordinator = getRepoCoordinator(env, repository, "github");
  const response = await coordinator.fetch("https://repo-coordinator.internal/events?limit=50");
  const payload = (await response.json()) as {
    events?: Array<{ deliveryId: string; status: string; attempts: number; lastError: string | null }>;
  };
  return payload.events ?? [];
}

async function stats(repository = REPOSITORY): Promise<{ processed: number; failed: number; pending: number; processing: number }> {
  const { env } = await import("cloudflare:test");
  const coordinator = getRepoCoordinator(env, repository, "github");
  const queue = await coordinator.fetch("https://repo-coordinator.internal/stats");
  const payload = (await queue.json()) as { counts?: Record<string, number> };
  const counts = payload.counts ?? {};
  return {
    processed: counts["processed"] ?? 0,
    failed: counts["failed"] ?? 0,
    pending: counts["pending"] ?? 0,
    processing: counts["processing"] ?? 0,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pipeline decisions", () => {
  const facts = (overrides: Partial<EventFacts> = {}): EventFacts => ({
    deliveryId: "d1",
    provider: "github",
    event: "pull_request",
    action: "opened",
    repository: REPOSITORY,
    actor: "octocat",
    attempts: 1,
    leaseId: "lease-1",
    payload: {},
    number: 7,
    title: "Add the pipeline",
    ...overrides,
  });

  it("reviews opened/reopened/synchronize pull requests and ignores the rest", () => {
    expect(decideAction(facts())).toMatchObject({ type: "github:pr:review", payload: { prNumber: 7, event: "COMMENT" } });
    expect(decideAction(facts({ action: "synchronize" }))?.type).toBe("github:pr:review");
    expect(decideAction(facts({ action: "closed" }))).toBeNull();
    expect(decideAction(facts({ number: null }))).toBeNull();
    expect(decideAction(facts({ event: "push", action: null }))).toBeNull();
    expect(decideAction(facts({ event: "issues", action: "opened" }))?.type).toBe("github:issue:comment");
  });

  it("decides on the canonical event, so GitLab and Gitea reach the same action", () => {
    // GitLab Merge Request Hook: raw event + action are provider words; the queue row
    // carries kind/canonicalAction, and that is what the decision reads (ADR 003).
    const gitlab = facts({
      provider: "gitlab",
      event: "Merge Request Hook",
      action: "open",
      kind: "merge_request",
      canonicalAction: "opened",
    });
    expect(decideAction(gitlab)).toMatchObject({ type: "github:pr:review", payload: { prNumber: 7 } });

    const gitea = facts({
      provider: "gitea",
      event: "pull_request",
      action: "synchronize",
      kind: "merge_request",
      canonicalAction: "updated",
    });
    expect(decideAction(gitea)?.type).toBe("github:pr:review");

    // A merged request is not reviewed, whatever the provider called it.
    expect(decideAction(facts({ kind: "merge_request", canonicalAction: "merged" }))).toBeNull();

    // An issue through GitLab is still an issue.
    const issue = facts({ provider: "gitlab", event: "Issue Hook", action: "open", kind: "issue", canonicalAction: "opened" });
    expect(decideAction(issue)?.type).toBe("github:issue:comment");
  });

  it("falls back to the provider vocabulary for a row written before the columns", () => {
    // Legacy rows have no kind: the raw event name still maps through the shared
    // kind table, so nothing that was queued before slice 2 stops being handled.
    expect(canonicalView(facts({ kind: null, canonicalAction: null }))).toEqual({
      kind: "merge_request",
      action: "opened",
    });
    expect(decideAction(facts({ action: "synchronize", kind: null, canonicalAction: null }))?.type).toBe(
      "github:pr:review",
    );
    expect(canonicalView(facts({ provider: "unknown-forge", kind: null })).kind).toBe("unknown");
  });

  it("reads the number and title out of the shapes providers actually send", () => {
    expect(numberFrom({ number: 3 })).toBe(3);
    expect(numberFrom({ pull_request: { number: 5 } })).toBe(5);
    expect(numberFrom({ issue: { number: 6 } })).toBe(6);
    expect(numberFrom({ number: 0 })).toBeNull();
    expect(numberFrom({ number: "7" })).toBeNull();
    expect(titleFrom({ title: "  hello  " })).toBe("hello");
    expect(titleFrom({ pull_request: { title: "pr" } })).toBe("pr");
    expect(titleFrom({})).toBeNull();
  });

  it("includes the review counter in the body and records emitted sinks", async () => {
    expect(reviewBody(facts(), 2)).toContain("review #2");
    const emitted: string[] = [];
    const [wrapped] = recordingSinks(
      [
        {
          name: "s",
          supportedActions: ["github:pr:review"],
          handle: async (action) => ({
            sinkName: "s",
            actionId: action.id,
            actionType: action.type,
            success: true,
            durationMs: 0,
          }),
        },
      ],
      emitted,
    );
    const result = await wrapped!.handle(
      { id: "a1", type: "github:pr:review", payload: {}, timestamp: 0 },
      {} as never,
    );
    expect(result.success).toBe(true);
    expect(emitted).toEqual(["github:pr:review"]);
  });
});

describe("pipeline end to end", () => {
  it("reviews a queued pull request through the broker and acks the event", async () => {
    const repository = "acme/pipeline-review";
    await provision(repository, "pr.review");
    await enqueue("pipe-1", pullRequestPayload("pipe-1", { repository }), "pull_request", repository);
    const { calls } = stubUpstream(201);

    const response = await run({ repository });
    expect(response.status).toBe(200);
    const report = (await response.json()) as {
      ok: boolean;
      repository: string;
      claimed: number;
      succeeded: number;
      failed: number;
      runs: Array<{ deliveryId: string; status: string; actionTypes: string[] }>;
    };
    expect(report).toMatchObject({ ok: true, repository, claimed: 1, succeeded: 1, failed: 0 });
    expect(report.runs[0]).toMatchObject({ deliveryId: "pipe-1", status: "succeeded", actionTypes: ["github:pr:review"] });

    // The provider saw the review with the real credential, once.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.github.com/repos/${repository}/pulls/7/reviews`);
    expect(calls[0]?.authorization).toBe(`Bearer ${GITHUB_CREDENTIAL}`);
    expect(calls[0]?.body).toMatchObject({ event: "COMMENT" });
    expect(String((calls[0]?.body as { body?: string }).body)).toContain("Automated review of #7");

    // The queue moved on.
    expect(await stats(repository)).toMatchObject({ processed: 1, pending: 0, processing: 0 });

    // Draining again finds nothing to do (no double review).
    const second = (await (await run({ repository })).json()) as { claimed: number };
    expect(second.claimed).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("counts reviews across runs using repository memory", async () => {
    const repository = "acme/pipeline-memory";
    await provision(repository, "pr.review");

    await enqueue("pipe-2", pullRequestPayload("pipe-2", { number: 8, repository }), "pull_request", repository);
    const first = stubUpstream(201);
    expect((await run({ repository })).status).toBe(200);
    vi.unstubAllGlobals();

    await enqueue("pipe-3", pullRequestPayload("pipe-3", { number: 9, repository }), "pull_request", repository);
    const second = stubUpstream(201);
    expect((await run({ repository })).status).toBe(200);

    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    const firstBody = String((first.calls[0]?.body as { body?: string }).body);
    const secondBody = String((second.calls[0]?.body as { body?: string }).body);
    // Repository memory is durable across runs, which is what a model runtime
    // will rely on for context.
    expect(firstBody).toContain("review #1");
    expect(secondBody).toContain("review #2");
  });

  it("fails the event when the provider rejects the call", async () => {
    const repository = "acme/pipeline-fail";
    await provision(repository, "pr.review");
    await enqueue("pipe-4", pullRequestPayload("pipe-4", { number: 11, repository }), "pull_request", repository);
    vi.stubGlobal(
      "fetch",
      (async () => {
        throw new Error("connection reset");
      }) as unknown as typeof fetch,
    );

    const failed = (await (await run({ repository })).json()) as {
      failed: number;
      runs: Array<{ status: string; error?: string }>;
    };
    expect(failed.failed).toBe(1);
    expect(failed.runs[0]?.status).toBe("failed");
    expect(failed.runs[0]?.error ?? "").toContain("upstream request failed");

    // A first failure is a retry, not a dead letter: the event goes back to
    // `pending` with its error recorded and a backoff.
    const after = await stats(repository);
    expect(after.processing).toBe(0);
    expect(after.pending + after.failed).toBe(1);
    const [event] = await queueEvents(repository);
    expect(event?.status).toBe("pending");
    expect(event?.attempts).toBe(1);
    expect(event?.lastError ?? "").toContain("upstream request failed");
  });

  it("acknowledges events the agent decides not to act on", async () => {
    const repository = "acme/pipeline-skip";
    await enqueue(
      "pipe-5",
      pullRequestPayload("pipe-5", { action: "closed", repository }),
      "pull_request",
      repository,
    );
    const { calls } = stubUpstream(201);

    const report = (await (await run({ repository })).json()) as { claimed: number; skipped: number; succeeded: number };
    expect(report).toMatchObject({ claimed: 1, skipped: 1, succeeded: 0 });
    expect(calls).toHaveLength(0);
    expect((await stats(repository)).processed).toBeGreaterThanOrEqual(1);
  });

  it("requires the control key and POST", async () => {
    expect((await run({ controlKey: null })).status).toBe(401);
    expect((await run({ controlKey: "wrong" })).status).toBe(401);
    expect((await run({ method: "GET" })).status).toBe(405);
  });

  it("fails the run when the agent is not provisioned", async () => {
    const repository = "acme/pipeline-unprovisioned";
    await enqueue(
      "pipe-6",
      pullRequestPayload("pipe-6", { number: 12, repository }),
      "pull_request",
      repository,
    );
    const { calls } = stubUpstream(201);

    const report = (await (await run({ repository })).json()) as { failed: number; runs: Array<{ error?: string }> };
    expect(report.failed).toBe(1);
    expect(report.runs[0]?.error ?? "").toContain("not provisioned");
    expect(calls).toHaveLength(0);
  });
});

describe("settlement and retry semantics (cloud-factory-cf-cyk)", () => {
  const claimedEvent = {
    deliveryId: "evt-1",
    provider: "github",
    event: "pull_request",
    action: "opened",
    repository: "acme/settle",
    actor: "octocat",
    attempts: 1,
    leaseId: "lease-1",
  };

  /** A coordinator stub: one claim, then whatever the test wants for settlement. */
  function coordinatorStub(settlement: () => Response | Promise<Response>): {
    fetch: (input: RequestInfo | URL) => Promise<Response>;
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        calls.push(path);
        if (path === "/claim") {
          return Response.json({ ok: true, claimed: [claimedEvent], leaseUntil: "later" });
        }
        if (path === "/events/evt-1/payload") {
          return Response.json({ ok: true, payload: { number: 3, title: "T", pull_request: { number: 3 } } });
        }
        if (path === "/ack" || path === "/fail") return settlement();
        // Delivery ledger: the drain goes through the same idempotency path as a
        // canvas run, so the first claim for a pair is "run".
        if (path === "/deliveries/claim") return Response.json({ ok: true, run: true });
        if (path === "/deliveries/complete") return Response.json({ ok: true });
        return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
      },
    };
  }

  it("reports an event as unsettled when the queue rejects the ack", async () => {
    const coordinator = coordinatorStub(() => Response.json({ ok: false, error: "lease conflict" }, { status: 409 }));
    const report = await drainRepository({
      repository: "acme/settle",
      controlKey: "k",
      coordinator,
      broker: { fetch: async () => Response.json({ ok: true }) },
      executionFn: async () => ({ status: "success", output: "no action", toolCallsCount: 0 }),
    });

    // The stub execution emits no sink action, so the run itself is a skip; the
    // queue refusal is what this test is about.
    expect(report).toMatchObject({ claimed: 1, skipped: 1, failed: 0, unsettled: 1 });
    expect(report.runs[0]?.settled).toBe(false);
    expect(report.runs[0]?.settlementError ?? "").toContain("409");
    expect(report.runs[0]?.settlementError ?? "").toContain("lease conflict");
  });

  it("reports a rejected fail without pretending the run settled", async () => {
    const coordinator = coordinatorStub(() => new Response("gone", { status: 410 }));
    const report = await drainRepository({
      repository: "acme/settle",
      controlKey: "k",
      coordinator,
      broker: { fetch: async () => Response.json({ ok: true }) },
      executionFn: async () => ({ status: "failure", error: "sink exploded", toolCallsCount: 0 }),
    });

    expect(report).toMatchObject({ claimed: 1, failed: 1, succeeded: 0, unsettled: 1 });
    expect(report.runs[0]?.settlementError ?? "").toContain("410");
  });

  it("settles cleanly when the queue accepts the ack", async () => {
    const coordinator = coordinatorStub(() => Response.json({ ok: true }));
    const report = await drainRepository({
      repository: "acme/settle",
      controlKey: "k",
      coordinator,
      broker: { fetch: async () => Response.json({ ok: true }) },
      executionFn: async () => ({ status: "success", output: "done", toolCallsCount: 0 }),
    });
    expect(report).toMatchObject({ claimed: 1, skipped: 1, unsettled: 0 });
    expect(report.runs[0]?.settled).toBe(true);
  });

  it("does not advance the review counter when the sink fails", async () => {
    const memory = new Map<string, unknown>();
    const facts: EventFacts = {
      ...claimedEvent,
      payload: { number: 4, title: "T" },
      number: 4,
      title: "T",
    };
    let sinkFails = true;
    const makeContext = () =>
      ({
        state: { event: facts },
        memory: {
          get: async (_scope: string, key: string) => memory.get(key),
          set: async (_scope: string, key: string, value: unknown) => {
            memory.set(key, value);
          },
        },
        sinks: {
          emit: async () =>
            sinkFails
              ? [{ sinkName: "s", actionId: "a", actionType: "github:pr:review", success: false, error: "boom", durationMs: 0 }]
              : [{ sinkName: "s", actionId: "a", actionType: "github:pr:review", success: true, durationMs: 0 }],
        },
      }) as never;

    const failed = await ruleBasedReview({ runId: "r1", prompt: "p", tools: [], ctx: makeContext() });
    expect(failed.status).toBe("failure");
    expect(memory.get("review-count")).toBeUndefined();

    sinkFails = false;
    const retried = await ruleBasedReview({ runId: "r2", prompt: "p", tools: [], ctx: makeContext() });
    expect(retried.status).toBe("success");
    // A retry counts as the first review, not the second.
    expect(memory.get("review-count")).toBe(1);
  });
});

describe("delivery ledger completion failures (cloud-factory-cf-lbi)", () => {
  const claimedEvent = {
    deliveryId: "evt-1",
    provider: "github",
    event: "pull_request",
    action: "opened",
    repository: "acme/ledger",
    actor: "octocat",
    attempts: 1,
    leaseId: "lease-1",
  };

  function ledgerStub(options: { completeStatus: number }): {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    paths: string[];
  } {
    const paths: string[] = [];
    return {
      paths,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === "/claim") {
          return Response.json({ ok: true, claimed: [claimedEvent], leaseUntil: "later" });
        }
        if (path === "/events/evt-1/payload") {
          return Response.json({ ok: true, payload: { number: 3, title: "T", pull_request: { number: 3 } } });
        }
        if (path === "/deliveries/claim") return Response.json({ ok: true, run: true });
        if (path === "/deliveries/complete") {
          return options.completeStatus === 200
            ? Response.json({ ok: true })
            : Response.json({ ok: false, error: "write unavailable" }, { status: options.completeStatus });
        }
        if (path === "/ack" || path === "/fail") return Response.json({ ok: true });
        return Response.json({ ok: false, error: `unexpected ${path}` }, { status: 500 });
      },
    };
  }

  it("reports a rejected completion instead of pretending the pair was recorded", async () => {
    const coordinator = ledgerStub({ completeStatus: 503 });
    const report = await drainRepository({
      repository: "acme/ledger",
      controlKey: "k",
      coordinator,
      broker: { fetch: async () => Response.json({ ok: true }) },
      executionFn: async () => ({ status: "success", output: "done", toolCallsCount: 0 }),
    });

    const outcome = report.runs[0];
    // The completion was retried, then reported — not swallowed.
    expect(coordinator.paths.filter((path) => path === "/deliveries/complete")).toHaveLength(3);
    expect(outcome?.deliveryError ?? "").toContain("delivery ledger rejected the completion");
    // The event is still settled: retrying would repeat the provider call.
    expect(outcome?.settled).toBe(true);
    expect(report.unsettled).toBe(0);
  });

  it("records the pair when the completion succeeds, so a redelivery is skipped", async () => {
    const coordinator = ledgerStub({ completeStatus: 200 });
    await drainRepository({
      repository: "acme/ledger",
      controlKey: "k",
      coordinator,
      broker: { fetch: async () => Response.json({ ok: true }) },
      executionFn: async () => ({ status: "success", output: "done", toolCallsCount: 0 }),
    });
    expect(coordinator.paths).toContain("/deliveries/complete");
    expect(coordinator.paths.filter((path) => path === "/deliveries/complete")).toHaveLength(1);
  });
});

describe("per-action idempotency for a multi-sink agent (cloud-factory-cf-j1y)", () => {
  const facts = {
    deliveryId: "evt-multi",
    provider: "github",
    event: "issues",
    action: "opened",
    repository: "acme/multi-sink",
    actor: "octocat",
    attempts: 1,
    leaseId: "lease-1",
    number: 9,
    title: "One issue, two sinks",
    prNumber: null,
  } as never;

  it("retries only the action that failed, so the issue is created once", async () => {
    const emitted: string[] = [];
    const delivered = new Set<string>();
    let telemetryFails = true;

    const ledger = {
      claim: async (actionType: string) => (delivered.has(actionType) ? "skip" : "run"),
      complete: async (actionType: string, status: "delivered" | "failed") => {
        if (status === "delivered") delivered.add(actionType);
        return null;
      },
    };
    const makeContext = () =>
      ({
        state: { event: facts, wiredSinks: ["github-issue-create", "telemetry"], actionLedger: ledger },
        memory: { get: async () => undefined, set: async () => {} },
        sinks: {
          emit: async (action: { type: string }) => {
            if (action.type === "telemetry:log" && telemetryFails) {
              return [{ sinkName: "cloud-telemetry-sink", actionId: "a", actionType: action.type, success: false, error: "endpoint 500", durationMs: 0 }];
            }
            emitted.push(action.type);
            return [{ sinkName: "s", actionId: "a", actionType: action.type, success: true, durationMs: 0 }];
          },
        },
      }) as never;

    const first = await ruleBasedReview({ runId: "r1", prompt: "p", tools: [], ctx: makeContext() });
    expect(first.status).toBe("failure");
    expect(emitted).toEqual(["github:issue:create"]);

    // The retry re-runs the agent, but only the telemetry action is attempted:
    // the issue is not created a second time.
    telemetryFails = false;
    const second = await ruleBasedReview({ runId: "r2", prompt: "p", tools: [], ctx: makeContext() });
    expect(second.status).toBe("success");
    expect(emitted).toEqual(["github:issue:create", "telemetry:log"]);
  });

  it("does not start an action when the ledger cannot answer", async () => {
    const emitted: string[] = [];
    const makeContext = () =>
      ({
        state: {
          event: facts,
          wiredSinks: ["github-issue-create"],
          actionLedger: { claim: async () => "unavailable", complete: async () => null },
        },
        memory: { get: async () => undefined, set: async () => {} },
        sinks: {
          emit: async (action: { type: string }) => {
            emitted.push(action.type);
            return [{ sinkName: "s", actionId: "a", actionType: action.type, success: true, durationMs: 0 }];
          },
        },
      }) as never;

    const result = await ruleBasedReview({ runId: "r3", prompt: "p", tools: [], ctx: makeContext() });
    expect(result.status).toBe("failure");
    expect(result.error ?? "").toContain("delivery ledger unavailable");
    expect(emitted).toEqual([]);
  });
});

describe("a rejected action-ledger write is reported, not retried (cloud-factory-cf-835)", () => {
  const facts = {
    deliveryId: "evt-835",
    provider: "github",
    event: "issues",
    action: "opened",
    repository: "acme/action-write",
    actor: "octocat",
    attempts: 1,
    leaseId: "lease-1",
    number: 11,
    title: "Completion rejected",
    prNumber: null,
  } as never;

  it("carries the gap on the run context so the event is settled, not repeated", async () => {
    const emitted: string[] = [];
    const ctx = {
      state: {
        event: facts,
        wiredSinks: ["github-issue-create"],
        actionLedger: {
          claim: async () => "run",
          // The provider accepted the issue, but the ledger rejects the write.
          complete: async () => "delivery ledger rejected the completion (503)",
        },
      },
      memory: { get: async () => undefined, set: async () => {} },
      sinks: {
        emit: async (action: { type: string }) => {
          emitted.push(action.type);
          return [{ sinkName: "s", actionId: "a", actionType: action.type, success: true, durationMs: 0 }];
        },
      },
    } as never;

    const result = await ruleBasedReview({ runId: "r835", prompt: "p", tools: [], ctx });
    expect(result.status).toBe("success");
    expect(emitted).toEqual(["github:issue:create"]);
    const state = (ctx as unknown as { state: Record<string, unknown> }).state;
    expect(state["actionDeliveryErrors"]).toEqual([
      "github:issue:create: delivery ledger rejected the completion (503)",
    ]);
  });
});

describe("the drain acknowledges a successful run it could not record (cloud-factory-cf-835)", () => {
  it("acks instead of failing the event when the side effect is unrecorded", async () => {
    const claimedEvent = {
      deliveryId: "evt-835-drain",
      provider: "github",
      event: "issues",
      action: "opened",
      repository: "acme/action-write-drain",
      actor: "octocat",
      attempts: 1,
      leaseId: "lease-1",
    };
    const paths: string[] = [];
    const coordinator = {
      fetch: async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === "/claim") return Response.json({ ok: true, claimed: [claimedEvent], leaseUntil: "later" });
        if (path === "/events/evt-835-drain/payload") {
          return Response.json({ ok: true, payload: { number: 12, title: "T", issue: { number: 12 } } });
        }
        if (path === "/deliveries/claim") return Response.json({ ok: true, run: true });
        if (path === "/deliveries/complete") return Response.json({ ok: false, error: "nope" }, { status: 503 });
        if (path === "/ack" || path === "/fail" || path === "/release") return Response.json({ ok: true });
        return Response.json({ ok: false, error: `unexpected ${path}` }, { status: 500 });
      },
    };

    const report = await drainRepository({
      repository: "acme/action-write-drain",
      controlKey: "k",
      coordinator,
      broker: { fetch: async () => Response.json({ ok: true }) },
      executionFn: async () => ({ status: "success", output: "delivered", toolCallsCount: 0 }),
    });

    expect(report.runs[0]?.deliveryError ?? "").toContain("delivery ledger rejected the completion");
    // The event is acknowledged (a retry would repeat the provider call).
    expect(paths).toContain("/ack");
    expect(paths).not.toContain("/fail");
    expect(report.succeeded).toBe(1);
    expect(report.unsettled).toBe(0);
  });
});

describe("a failed action stays retryable despite a rejected ledger write (cloud-factory-cf-uil)", () => {
  const facts = {
    deliveryId: "evt-uil",
    provider: "github",
    event: "issues",
    action: "opened",
    repository: "acme/failed-action",
    actor: "octocat",
    attempts: 1,
    leaseId: "lease-1",
    number: 13,
    title: "Rejected comment",
    prNumber: null,
  } as never;

  it("does not record a delivery gap when the provider rejected the action", async () => {
    const ctx = {
      state: {
        event: facts,
        wiredSinks: ["github-issue-comment"],
        actionLedger: {
          claim: async () => "run",
          // Even the "failed" write is rejected by the ledger.
          complete: async () => "delivery ledger rejected the completion (503)",
        },
      },
      memory: { get: async () => undefined, set: async () => {} },
      sinks: {
        emit: async (action: { type: string }) => [
          { sinkName: "s", actionId: "a", actionType: action.type, success: false, error: "GitHub rejected comment (500)", durationMs: 0 },
        ],
      },
    } as never;

    const result = await ruleBasedReview({ runId: "ruil", prompt: "p", tools: [], ctx });
    expect(result.status).toBe("failure");
    // Nothing was delivered, so nothing must be recorded as a delivery gap: the
    // event has to stay retryable.
    const state = (ctx as unknown as { state: Record<string, unknown> }).state;
    expect(state["actionDeliveryErrors"]).toBeUndefined();
  });
});

describe("a failed run stays retryable when the pair write is rejected (uit)", () => {
  it("fails the event instead of acknowledging it when nothing was delivered", async () => {
    const claimedEvent = {
      deliveryId: "evt-pair-fail",
      provider: "github",
      event: "issues",
      action: "opened",
      repository: "acme/pair-fail",
      actor: "octocat",
      attempts: 1,
      leaseId: "lease-1",
    };
    const paths: string[] = [];
    const coordinator = {
      fetch: async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === "/claim") return Response.json({ ok: true, claimed: [claimedEvent], leaseUntil: "later" });
        if (path === "/events/evt-pair-fail/payload") {
          return Response.json({ ok: true, payload: { number: 14, title: "T", issue: { number: 14 } } });
        }
        if (path === "/deliveries/claim") return Response.json({ ok: true, run: true });
        if (path === "/deliveries/complete") return Response.json({ ok: false, error: "nope" }, { status: 503 });
        if (path === "/ack" || path === "/fail" || path === "/release") return Response.json({ ok: true });
        return Response.json({ ok: false, error: `unexpected ${path}` }, { status: 500 });
      },
    };

    const report = await drainRepository({
      repository: "acme/pair-fail",
      controlKey: "k",
      coordinator,
      broker: { fetch: async () => Response.json({ ok: true }) },
      executionFn: async () => ({ status: "failure", error: "provider said no", toolCallsCount: 0 }),
    });

    // Nothing was delivered, so the rejected pair write must not look like a gap:
    // the event is failed and therefore retried.
    expect(report.runs[0]?.deliveryError).toBeUndefined();
    expect(paths).toContain("/fail");
    expect(paths).not.toContain("/ack");
    expect(report.failed).toBe(1);
  });
});
