import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  githubIssuesPayload,
  githubPingPayload,
  githubPullRequestPayload,
  githubPushPayload,
  githubRequest,
  signBody,
  TEST_SECRET,
} from "./support/webhook";

/**
 * End-to-end: synthetic GitHub App deliveries against the real Worker endpoints
 * (cloud-factory-cf-fwzl).
 *
 * Every case drives the public HTTP surface and then the real machinery behind it —
 * the Durable Object queue, the alarm-driven drain, the pipeline decision and the
 * credential broker — with only the provider itself stubbed. The payloads come from
 * `support/webhook.ts` in the shape a GitHub App actually sends (installation,
 * repository, pull_request/issue objects, html urls), because the minimal fixtures
 * the queue and decision tests use cannot catch a change that starts reading a
 * different field.
 *
 * Each case owns its repository: queue state, provisioning, memory and the alarm are
 * all keyed by the Durable Object name, so the tests are independent and safe to run
 * in any order.
 */
const CONTROL_KEY = "test-control-key";
const DIFF = [
  "diff --git a/src/adapter.ts b/src/adapter.ts",
  "index 1111111..2222222 100644",
  "--- a/src/adapter.ts",
  "+++ b/src/adapter.ts",
  "@@ -1,2 +1,3 @@",
  " export const adapt = 1;",
  "+export const normalise = (event: unknown) => event;",
].join("\n");

interface Call {
  url: string;
  method: string;
  accept: string | null;
  body: unknown;
}

/** Stub only GitHub: the worker, queue, alarm, pipeline and broker stay real. */
function stubGitHub(): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      let body: unknown;
      try {
        body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      } catch {
        body = init?.body;
      }
      calls.push({ url, method, accept: new Headers(init?.headers).get("accept"), body });
      if (method === "GET" && /\/pulls\/\d+$/.test(url)) {
        return new Response(DIFF, { status: 200, headers: { "content-type": "text/plain" } });
      }
      if (method === "POST" && /\/pulls\/\d+\/reviews$/.test(url)) {
        return Response.json({ id: 1 }, { status: 201 });
      }
      if (method === "POST" && /\/issues\/\d+\/comments$/.test(url)) {
        return Response.json({ id: 2 }, { status: 201 });
      }
      return new Response(`unexpected upstream call ${method} ${url}`, { status: 500 });
    }) as unknown as typeof fetch,
  );
  return { calls };
}

async function provision(repository: string, action: string): Promise<void> {
  const response = await SELF.fetch(`https://example.com/broker/${repository}/provisioning`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
    body: JSON.stringify({ agent: `cloud-factory:${repository}`, service: "github", action }),
  });
  expect([200, 201]).toContain(response.status);
}

interface Delivery {
  deliveryId: string;
  event: string;
  action: string | null;
  kind: string | null;
  canonicalAction: string | null;
  repository: string;
  actor: string | null;
  status: string;
}

/**
 * The suite must not encode the RepoCoordinator addressing scheme: ADR 003 slice 3
 * (cloud-factory-cf-6to.3) moved it from `idFromName("<owner>/<repo>")` to a
 * platform-prefixed key (`github:<owner>/<repo>`), and a test that hard-codes either
 * one silently inspects the wrong Durable Object after the other lands. So resolve
 * the instance that actually holds the delivery, from the keys the worker has used.
 */
function coordinatorKeys(repository: string): string[] {
  return [`github:${repository}`, repository];
}

function stubForKey(key: string) {
  return env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(key));
}

async function eventsAt(stub: ReturnType<typeof stubForKey>): Promise<Delivery[]> {
  const response = await stub.fetch("https://repo-coordinator.internal/events?limit=50");
  const payload = (await response.json()) as { events?: Delivery[] };
  return payload.events ?? [];
}

/** The instance holding `deliveryId`, whichever key the webhook route addressed. */
async function queueFor(repository: string, deliveryId: string) {
  for (const key of coordinatorKeys(repository)) {
    const stub = stubForKey(key);
    if ((await eventsAt(stub)).some((event) => event.deliveryId === deliveryId)) return stub;
  }
  throw new Error(`no RepoCoordinator holds delivery ${deliveryId} for ${repository}`);
}

/** Every event queued for the repository, under either addressing scheme. */
async function anyQueued(repository: string): Promise<Delivery[]> {
  const all: Delivery[] = [];
  for (const key of coordinatorKeys(repository)) all.push(...(await eventsAt(stubForKey(key))));
  return all;
}

function queueOf(stub: ReturnType<typeof stubForKey>): Promise<Delivery[]> {
  return eventsAt(stub);
}

async function countsOf(stub: ReturnType<typeof stubForKey>): Promise<Record<string, number>> {
  const response = await stub.fetch("https://repo-coordinator.internal/stats");
  const payload = (await response.json()) as { counts?: Record<string, number> };
  return payload.counts ?? {};
}

function armedAt(stub: ReturnType<typeof stubForKey>): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

/**
 * Drain the queue through the control route, the way an operator or CI would. Used by
 * the two cases whose shape the alarm path does not route yet (cloud-factory-cf-jtg9:
 * closed/merged pull requests and issue events).
 */
async function runRepository(repository: string): Promise<Record<string, number>> {
  const response = await SELF.fetch(`https://example.com/runs/${repository}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, number>;
}

/** Fire the alarm the delivery armed, exactly as the platform would. */
async function drain(stub: ReturnType<typeof stubForKey>): Promise<void> {
  await runInDurableObject(stub, (instance) =>
    (instance as unknown as { alarm(): Promise<void> }).alarm(),
  );
}

async function deliver(
  repository: string,
  deliveryId: string,
  event: string,
  body: string,
): Promise<Response> {
  return SELF.fetch(
    await githubRequest(deliveryId, repository, {
      body,
      event,
      signature: await signBody(TEST_SECRET, body),
    }),
  );
}

/**
 * `stats` only reports the statuses that have rows, so "pending: 0" is an absent
 * key rather than a zero: assert the settled total and that nothing is left due.
 */
async function expectSettled(stub: ReturnType<typeof stubForKey>, processed: number): Promise<void> {
  const statuses = await countsOf(stub);
  expect(statuses["pending"] ?? 0).toBe(0);
  expect(statuses["processing"] ?? 0).toBe(0);
  expect(statuses["failed"] ?? 0).toBe(0);
  expect(statuses["processed"] ?? 0).toBe(processed);
}

function reviews(calls: Call[]): Call[] {
  return calls.filter((call) => call.method === "POST" && /\/reviews$/.test(call.url));
}

function comments(calls: Call[]): Call[] {
  return calls.filter((call) => call.method === "POST" && /\/issues\/\d+\/comments$/.test(call.url));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("synthetic GitHub deliveries, end to end", () => {
  it("turns a signed pull_request.opened delivery into a review, a settled queue and a trace", async () => {
    const repository = "acme/e2e-opened";
    const { calls } = stubGitHub();
    await provision(repository, "pr.diff");
    await provision(repository, "pr.review");

    const response = await deliver(
      repository,
      "e2e-opened-1",
      "pull_request",
      githubPullRequestPayload({ repository, number: 42, title: "Add the webhook adapter" }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, queued: true, deliveryId: "e2e-opened-1" });

    // The delivery is on the real queue, normalised through the platform adapter.
    const queue = await queueFor(repository, "e2e-opened-1");
    const queued = await queueOf(queue);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      deliveryId: "e2e-opened-1",
      event: "pull_request",
      action: "opened",
      kind: "merge_request",
      canonicalAction: "opened",
      repository,
      actor: "octocat",
      status: "pending",
    });

    // The delivery itself armed the alarm: no POST /runs anywhere in this test.
    const armed = await armedAt(queue);
    expect(armed).not.toBeNull();
    expect(armed as number).toBeLessThanOrEqual(Date.now() + 5_000);

    await drain(queue);

    const diff = calls.find((call) => call.method === "GET" && call.url.endsWith("/pulls/42"));
    expect(diff?.accept).toBe("application/vnd.github.v3.diff");
    expect(reviews(calls)).toHaveLength(1);
    expect(reviews(calls)[0].url).toContain(`/repos/${repository}/pulls/42/reviews`);
    expect(reviews(calls)[0].body).toMatchObject({ event: "COMMENT" });
    expect(String((reviews(calls)[0].body as Record<string, unknown>)["body"])).toContain("Cloud Factory PR Review");

    await expectSettled(queue, 1);
    expect(await armedAt(queue)).toBeNull();

    const trace = await SELF.fetch(`https://example.com/trace/${repository}?deliveryId=e2e-opened-1`, {
      headers: { "x-factory-control-key": CONTROL_KEY },
    });
    const steps = ((await trace.json()) as { steps: Array<{ deliveryId: string; step: string; status: string }> }).steps;
    expect(steps.map((step) => step.step)).toContain("claimed");
    expect(steps.at(-1)).toMatchObject({ deliveryId: "e2e-opened-1", step: "settled", status: "ok" });
  });

  it("reviews a redelivered delivery once, and answers the duplicate without queueing it", async () => {
    const repository = "acme/e2e-redelivery";
    const { calls } = stubGitHub();
    await provision(repository, "pr.diff");
    await provision(repository, "pr.review");

    const body = githubPullRequestPayload({ repository, number: 7 });
    expect((await deliver(repository, "e2e-redelivery-1", "pull_request", body)).status).toBe(202);
    const duplicate = await deliver(repository, "e2e-redelivery-1", "pull_request", body);
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({ ok: true, duplicate: true });

    const queue = await queueFor(repository, "e2e-redelivery-1");
    expect(await queueOf(queue)).toHaveLength(1);
    await drain(queue);
    expect(reviews(calls)).toHaveLength(1);
    await expectSettled(queue, 1);
  });

  it("reviews a synchronize delivery as a new head of the same pull request", async () => {
    const repository = "acme/e2e-synchronize";
    const { calls } = stubGitHub();
    await provision(repository, "pr.diff");
    await provision(repository, "pr.review");

    expect((await deliver(repository, "e2e-sync-1", "pull_request", githubPullRequestPayload({ repository }))).status).toBe(202);
    expect(
      (
        await deliver(
          repository,
          "e2e-sync-2",
          "pull_request",
          githubPullRequestPayload({ repository, action: "synchronize", headSha: "4444444444444444444444444444444444444444" }),
        )
      ).status,
    ).toBe(202);

    const queue = await queueFor(repository, "e2e-sync-1");
    await drain(queue);

    expect(reviews(calls)).toHaveLength(2);
    await expectSettled(queue, 2);
    const settled = await queueOf(queue);
    expect(settled.map((delivery) => delivery.deliveryId).sort()).toEqual(["e2e-sync-1", "e2e-sync-2"]);
    expect(settled.every((delivery) => delivery.status === "processed")).toBe(true);
  });

  it("acknowledges a closed pull request without calling the provider", async () => {
    // The rule-based runner is the ADR 003 decision path: decideAction() deliberately
    // does not review a merged/closed request, and the event is acknowledged rather
    // than retried. It is driven here through POST /runs because the alarm path
    // currently runs the SDK review engine instead, which reviews every
    // pull_request regardless of action — a divergence tracked in
    // cloud-factory-cf-jtg9 (the same divergence is why an opened issue reaches no
    // sink on the alarm path).
    const repository = "acme/e2e-closed";
    const { calls } = stubGitHub();
    await provision(repository, "pr.diff");
    await provision(repository, "pr.review");

    expect(
      (await deliver(repository, "e2e-closed-1", "pull_request", githubPullRequestPayload({ repository, action: "closed", merged: true }))).status,
    ).toBe(202);

    const report = await runRepository(repository);
    const queue = await queueFor(repository, "e2e-closed-1");

    expect(report).toMatchObject({ claimed: 1, skipped: 1, failed: 0 });
    expect(calls).toHaveLength(0);
    await expectSettled(queue, 1);
    const [event] = await queueOf(queue);
    expect(event).toMatchObject({ deliveryId: "e2e-closed-1", canonicalAction: "closed", status: "processed" });
  });

  it("comments on an opened issue through the broker", async () => {
    // Same note as the closed-request case: the decision lives in the rule-based
    // runner (POST /runs), which is the path the ADR 003 rules are written for.
    const repository = "acme/e2e-issue";
    const { calls } = stubGitHub();
    await provision(repository, "issue.comment");

    expect((await deliver(repository, "e2e-issue-1", "issues", githubIssuesPayload({ repository, number: 9 }))).status).toBe(202);

    const report = await runRepository(repository);
    const queue = await queueFor(repository, "e2e-issue-1");

    expect(report).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(comments(calls)).toHaveLength(1);
    expect(comments(calls)[0].url).toContain(`/repos/${repository}/issues/9/comments`);
    expect(String((comments(calls)[0].body as Record<string, unknown>)["body"])).toContain("#9");
    await expectSettled(queue, 1);
  });

  it("queues a push delivery and settles it without an action", async () => {
    const repository = "acme/e2e-push";
    const { calls } = stubGitHub();

    expect((await deliver(repository, "e2e-push-1", "push", githubPushPayload({ repository }))).status).toBe(202);
    const queue = await queueFor(repository, "e2e-push-1");
    await drain(queue);

    expect(calls).toHaveLength(0);
    await expectSettled(queue, 1);
    expect((await queueOf(queue))[0]).toMatchObject({ deliveryId: "e2e-push-1", event: "push", status: "processed" });
  });

  it("acknowledges the hook handshake without queueing work", async () => {
    const repository = "acme/e2e-ping";
    const { calls } = stubGitHub();

    const response = await deliver(repository, "e2e-ping-1", "ping", githubPingPayload({ repository }));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, ping: true });

    expect(await anyQueued(repository)).toHaveLength(0);
    expect(await armedAt(stubForKey(repository))).toBeNull();

    const connect = await SELF.fetch(`https://example.com/trace/${repository}/connect`, {
      headers: { "x-factory-control-key": CONTROL_KEY },
    });
    const state = (await connect.json()) as { ok?: boolean; connect?: { pings?: number; events?: number } };
    expect(state.connect?.pings).toBeGreaterThanOrEqual(1);
    expect(calls).toHaveLength(0);
  });

  it("refuses a body that does not match its signature and queues nothing", async () => {
    const repository = "acme/e2e-tampered";
    stubGitHub();

    const forged = await SELF.fetch(
      await githubRequest("e2e-tampered-1", repository, {
        body: githubPullRequestPayload({ repository, title: "Benign title" }),
        signature: await signBody(TEST_SECRET, githubPullRequestPayload({ repository, title: "Something else" })),
      }),
    );
    expect(forged.status).toBe(401);
    await expect(forged.json()).resolves.toMatchObject({ ok: false, error: "invalid signature" });

    expect(await anyQueued(repository)).toHaveLength(0);
    await expectSettled(stubForKey(repository), 0);
    expect(await armedAt(stubForKey(repository))).toBeNull();
  });
});
