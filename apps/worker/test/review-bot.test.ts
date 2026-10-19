import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainRepository } from "../src/pipeline";
import {
  fetchPullRequestDiff,
  llmReviewer,
  parseReviewModel,
  reviewRuntime,
  reviewWithModel,
  type ReviewModelConfig,
} from "../src/review/bot";
import { githubRequest } from "./support/webhook";

/**
 * The end-to-end pull-request reviewer (cloud-factory-cf-7or):
 * webhook → queue → claim → diff (broker) → model (broker) → PR review (broker).
 *
 * Everything below the provider is real: the webhook route, the Durable Object
 * queue, the credential broker's capability issuance and quota, the sinks. Only the
 * two upstream hosts are stubbed, which is the one thing a test cannot do without.
 */
const CONTROL_KEY = "test-control-key";
const REPOSITORY = "acme/review-bot";
const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "+const b = eval(userInput);",
  " export { a };",
].join("\n");
const REVIEW_TEXT = "src/app.ts: `eval(userInput)` executes untrusted input. Parse it instead.";

const CONFIG: ReviewModelConfig = {
  service: "anthropic",
  model: "claude-review-test",
  maxTokens: 256,
  maxDiffChars: 5_000,
};

interface UpstreamCall {
  url: string;
  method: string;
  accept: string | null;
  authorization: string | null;
  apiKey: string | null;
  body: unknown;
}

/** Routes each upstream call by host and records exactly what was sent. */
function stubUpstream(): { calls: UpstreamCall[] } {
  const calls: UpstreamCall[] = [];
  vi.stubGlobal(
    "fetch",
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const raw = typeof init?.body === "string" ? init.body : undefined;
      let body: unknown;
      try {
        body = raw === undefined ? undefined : JSON.parse(raw);
      } catch {
        body = raw;
      }
      calls.push({
        url,
        method: init?.method ?? "GET",
        accept: headers.get("accept"),
        authorization: headers.get("authorization"),
        apiKey: headers.get("x-api-key"),
        body,
      });

      if (url === "https://api.github.com/repos/acme/review-bot/pulls/3" && (init?.method ?? "GET") === "GET") {
        return new Response(DIFF, { status: 200, headers: { "content-type": "text/plain" } });
      }
      if (url === "https://api.anthropic.com/v1/messages") {
        return Response.json({ content: [{ type: "text", text: REVIEW_TEXT }] });
      }
      if (url === "https://api.github.com/repos/acme/review-bot/pulls/3/reviews") {
        return Response.json({ id: 1 }, { status: 201 });
      }
      return new Response("unexpected upstream call", { status: 500 });
    }) as unknown as typeof fetch,
  );
  return { calls };
}

async function provision(service: string, action: string): Promise<void> {
  const response = await SELF.fetch(`https://example.com/broker/${REPOSITORY}/provisioning`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
    body: JSON.stringify({ agent: `cloud-factory:${REPOSITORY}`, service, action }),
  });
  expect([200, 201]).toContain(response.status);
}

function credentials(): CredentialBrokerLike {
  const broker = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(REPOSITORY));
  const capabilities = new Map<string, string>();
  return {
    async hasPermission() {
      return true;
    },
    async executeSignedRequest<T>(request: {
      service: string;
      action: string;
      params?: Record<string, unknown>;
    }): Promise<T> {
      const key = `${request.service}:${request.action}`;
      let capability = capabilities.get(key);
      if (capability === undefined) {
        const issued = await broker.fetch("https://credential-broker.internal/capabilities", {
          method: "POST",
          headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
          body: JSON.stringify({ agent: `cloud-factory:${REPOSITORY}`, service: request.service, action: request.action }),
        });
        const payload = (await issued.json()) as { capability?: string; error?: string };
        if (typeof payload.capability !== "string") throw new Error(payload.error ?? "no capability");
        capability = payload.capability;
        capabilities.set(key, capability);
      }
      const response = await broker.fetch("https://credential-broker.internal/proxy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability, params: request.params ?? {} }),
      });
      const payload = (await response.json()) as { ok?: boolean; status?: number; body?: unknown; error?: string };
      if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? "broker refused");
      return { status: payload.status, body: payload.body } as T;
    },
  };
}

interface CredentialBrokerLike {
  hasPermission(service: string, action: string): Promise<boolean>;
  executeSignedRequest<T = unknown>(request: {
    service: string;
    action: string;
    params?: Record<string, unknown>;
  }): Promise<T>;
}

async function queueState(): Promise<Array<{ deliveryId: string; status: string; attempts: number }>> {
  const coordinator = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(REPOSITORY));
  const response = await coordinator.fetch("https://repo-coordinator.internal/events?limit=20");
  const payload = (await response.json()) as { events?: Array<{ deliveryId: string; status: string; attempts: number }> };
  return payload.events ?? [];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("review model configuration", () => {
  it("reads service/model and refuses guesses", () => {
    expect(parseReviewModel("anthropic/claude-sonnet-4-5")).toMatchObject({
      service: "anthropic",
      model: "claude-sonnet-4-5",
    });
    expect(parseReviewModel("openai/gpt-6-sol", { maxTokens: 99 })?.maxTokens).toBe(99);
    expect(parseReviewModel(undefined)).toBeNull();
    expect(parseReviewModel("claude-sonnet")).toBeNull();
    expect(parseReviewModel("/model")).toBeNull();
    expect(parseReviewModel("anthropic/")).toBeNull();
  });

  it("is off unless a deployment names a model", () => {
    expect(reviewRuntime({})).toBeUndefined();
    expect(reviewRuntime({ REVIEW_MODEL: "nonsense" })).toBeUndefined();
    expect(reviewRuntime({ REVIEW_MODEL: "anthropic/claude-review-test" })).toBeTypeOf("function");
  });
});

describe("reviewer upstream calls", () => {
  it("asks GitHub for the diff media type and reports a refusal as a failure", async () => {
    await provision("github", "pr.diff");
    const { calls } = stubUpstream();
    const diff = await fetchPullRequestDiff(credentials(), 3);
    expect(diff).toEqual({ ok: true, value: DIFF });
    expect(calls[0]).toMatchObject({ method: "GET", accept: "application/vnd.github.v3.diff" });

    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch,
    );
    const refused = await fetchPullRequestDiff(credentials(), 4);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("404");
  });

  it("reads the Anthropic and OpenAI answer shapes", async () => {
    await provision("anthropic", "messages.create");
    await provision("openai", "chat.completions");
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("anthropic")) return Response.json({ content: [{ type: "text", text: "anthropic text" }] });
        return Response.json({ choices: [{ message: { content: "openai text" } }] });
      }) as unknown as typeof fetch,
    );
    expect(await reviewWithModel(credentials(), CONFIG, "review this")).toEqual({
      ok: true,
      value: "anthropic text",
    });
    expect(
      await reviewWithModel(credentials(), { ...CONFIG, service: "openai", model: "gpt-test" }, "review this"),
    ).toEqual({ ok: true, value: "openai text" });
  });
});

describe("end to end", () => {
  it("reviews a pull request webhook with the model and posts the comment", async () => {
    const { calls } = stubUpstream();
    await provision("github", "pr.diff");
    await provision("github", "pr.review");
    await provision("anthropic", "messages.create");

    const webhook = await SELF.fetch(await githubRequest("review-1", REPOSITORY, {
      body: JSON.stringify({
        action: "opened",
        number: 3,
        sender: { login: "octocat" },
        repository: { full_name: REPOSITORY },
      }),
    }));
    expect(webhook.status).toBe(202);

    const report = await drainRepository({
      repository: REPOSITORY,
      controlKey: CONTROL_KEY,
      coordinator: env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(REPOSITORY)),
      broker: env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(REPOSITORY)),
      executionFn: llmReviewer(CONFIG),
    });

    expect(report.failed).toBe(0);
    expect(report.runs[0]?.output ?? "").toContain("posted a review of #3");

    // The diff was read with the diff media type, from the real broker.
    const diffCall = calls.find((call) => call.url.endsWith("/pulls/3") && call.method === "GET");
    expect(diffCall).toMatchObject({ accept: "application/vnd.github.v3.diff" });
    expect(diffCall?.authorization).toContain("ghp_test_github_credential");

    // The model saw the diff and the facts, through the broker's credential.
    const modelCall = calls.find((call) => call.url === "https://api.anthropic.com/v1/messages");
    const prompt = JSON.stringify(modelCall?.body ?? {});
    expect(prompt).toContain("eval(userInput)");
    expect(prompt).toContain("pull request #3");
    expect(modelCall?.apiKey).toBe("sk-ant-test-review-key");
    expect(modelCall?.authorization).toBeNull();

    // The comment carries the model's text rather than a template.
    const reviewCall = calls.find((call) => call.url.endsWith("/pulls/3/reviews"));
    const reviewBody = (reviewCall?.body as Record<string, unknown> | undefined)?.["body"];
    expect(typeof reviewBody).toBe("string");
    expect(reviewBody as string).toContain("eval(userInput)");
    expect(reviewBody as string).toContain("anthropic/claude-review-test");

    // And the event is settled, so the queue does not redeliver it.
    const events = await queueState();
    expect(events.find((event) => event.deliveryId === "review-1")?.status).toBe("processed");
  });

  it("does not settle an event as reviewed when the model cannot answer", async () => {
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/pulls/3") && !url.includes("reviews")) return new Response(DIFF, { status: 200 });
        return Response.json({ error: { type: "overloaded_error" } }, { status: 529 });
      }) as unknown as typeof fetch,
    );
    await provision("github", "pr.diff");
    await provision("anthropic", "messages.create");

    await SELF.fetch(await githubRequest("review-2", REPOSITORY, {
      body: JSON.stringify({
        action: "opened",
        number: 3,
        sender: { login: "octocat" },
        repository: { full_name: REPOSITORY },
      }),
    }));

    const report = await drainRepository({
      repository: REPOSITORY,
      controlKey: CONTROL_KEY,
      coordinator: env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(REPOSITORY)),
      broker: env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(REPOSITORY)),
      executionFn: llmReviewer(CONFIG),
    });

    expect(report.failed).toBe(1);
    expect(report.runs[0]?.error ?? "").toContain("529");
    const events = await queueState();
    expect(events.find((event) => event.deliveryId === "review-2")?.status).not.toBe("processed");
  });

  it("leaves a non-review event alone instead of failing it", async () => {
    const { calls } = stubUpstream();
    await SELF.fetch(await githubRequest("review-3", REPOSITORY, {
      body: JSON.stringify({
        action: "opened",
        sender: { login: "octocat" },
        repository: { full_name: REPOSITORY },
      }),
    }));
    const report = await drainRepository({
      repository: REPOSITORY,
      controlKey: CONTROL_KEY,
      coordinator: env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(REPOSITORY)),
      broker: env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(REPOSITORY)),
      executionFn: llmReviewer(CONFIG),
    });
    expect(report.failed).toBe(0);
    expect(report.runs[0]?.output ?? "").toContain("only merge requests are reviewed");
    expect(calls.some((call) => call.url.includes("anthropic"))).toBe(false);
  });
});
