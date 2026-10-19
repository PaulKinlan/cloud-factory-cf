import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubRequest } from "./support/webhook";

const CONTROL_KEY = "test-control-key";
const GITHUB_CREDENTIAL = "ghp_test_github_credential";

async function provision(repository: string, action: string): Promise<void> {
  const response = await SELF.fetch(`https://example.com/broker/${repository}/provisioning`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
    body: JSON.stringify({ agent: `cloud-factory:${repository}`, service: "github", action }),
  });
  expect([200, 201]).toContain(response.status);
}

async function enqueue(deliveryId: string, body: string, repository: string): Promise<void> {
  const request = await githubRequest(deliveryId, repository, { body });
  const response = await SELF.fetch(`https://example.com/webhooks/github/${repository}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "pull_request",
      "x-hub-signature-256": request.headers.get("x-hub-signature-256") as string,
    },
    body,
  });
  expect(response.status).toBe(202);
}

function pullRequestPayload(
  deliveryId: string,
  overrides: { number?: number; title?: string; repository: string },
): string {
  return JSON.stringify({
    action: "opened",
    number: overrides.number ?? 42,
    delivery: deliveryId,
    sender: { login: "octocat" },
    repository: { full_name: overrides.repository },
    pull_request: {
      number: overrides.number ?? 42,
      title: overrides.title ?? "Add calculator module",
      state: "open",
      user: { login: "octocat" },
      head: { ref: "feature/calc", sha: "abc1234" },
      base: { ref: "main" },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Core PR Reviewer Bot: End-to-end pull_request webhook -> diff fetch -> LLM review -> GitHub PR comment", () => {
  it("processes pull_request webhook, fetches diff with accept header, synthesizes review, and submits PR review", async () => {
    const repository = "acme/pr-bot-e2e";
    await provision(repository, "pr.diff");
    await provision(repository, "pr.review");

    const deliveryId = "deliv-pr-e2e-1";
    const prNumber = 42;
    await enqueue(
      deliveryId,
      pullRequestPayload(deliveryId, { number: prNumber, title: "Add calculator feature", repository }),
      repository,
    );

    const sampleDiff = [
      "diff --git a/src/calc.ts b/src/calc.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/calc.ts",
      "@@ -0,0 +1,4 @@",
      "+export function multiply(a: number, b: number): number {",
      "+  return a * b;",
      "+}",
      "diff --git a/tests/calc.test.ts b/tests/calc.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/tests/calc.test.ts",
      "@@ -0,0 +1,3 @@",
      "+import { multiply } from '../src/calc';",
      "+console.assert(multiply(2, 3) === 6);",
    ].join("\n");

    const calls: Array<{ url: string; method: string; acceptHeader: string | null; authHeader: string | null; body: any }> = [];

    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(input);
        const headers = new Headers(init?.headers);
        calls.push({
          url: urlStr,
          method: init?.method ?? "GET",
          acceptHeader: headers.get("accept"),
          authHeader: headers.get("authorization"),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });

        // 1. Upstream diff fetch
        if (urlStr === `https://api.github.com/repos/${repository}/pulls/${prNumber}` && init?.method === "GET") {
          return new Response(sampleDiff, {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }

        // 2. Upstream PR review post
        if (urlStr === `https://api.github.com/repos/${repository}/pulls/${prNumber}/reviews` && init?.method === "POST") {
          return new Response(JSON.stringify({ id: 999, state: "COMMENT" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

    // Trigger run with reviewer: "llm"
    const runRes = await SELF.fetch(`https://example.com/runs/${repository}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-control-key": CONTROL_KEY,
      },
      body: JSON.stringify({ reviewer: "llm" }),
    });

    const report = (await runRes.json()) as any;
    expect(runRes.status).toBe(200);

    expect(report.ok).toBe(true);
    expect(report.claimed).toBe(1);
    expect(report.succeeded).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.runs[0]?.actionTypes).toContain("github:pr:review");

    // Verify upstream diff fetch occurred
    const diffCall = calls.find((c) => c.url.includes(`/pulls/${prNumber}`) && c.method === "GET");
    expect(diffCall).toBeDefined();
    expect(diffCall?.authHeader).toBe(`Bearer ${GITHUB_CREDENTIAL}`);
    expect(diffCall?.acceptHeader).toBe("application/vnd.github.v3.diff");

    // Verify upstream PR review was posted
    const reviewCall = calls.find((c) => c.url.includes(`/pulls/${prNumber}/reviews`) && c.method === "POST");
    expect(reviewCall).toBeDefined();
    expect(reviewCall?.authHeader).toBe(`Bearer ${GITHUB_CREDENTIAL}`);
    expect(reviewCall?.body).toBeDefined();
    expect(["APPROVE", "COMMENT"]).toContain(reviewCall?.body.event);
    expect(reviewCall?.body.body).toContain(`Cloud Factory PR Review: #${prNumber}`);
    expect(reviewCall?.body.body).toContain("**Lines Added:** +5");

    // Verify output in run report
    expect(report.runs[0]?.output).toContain(`Cloud Factory PR Review: #${prNumber}`);
  });

  it("detects credential leak in diff and submits REQUEST_CHANGES review", async () => {
    const repository = "acme/pr-bot-leak";
    await provision(repository, "pr.diff");
    await provision(repository, "pr.review");

    const deliveryId = "deliv-pr-leak-2";
    const prNumber = 77;
    await enqueue(
      deliveryId,
      pullRequestPayload(deliveryId, { number: prNumber, title: "Add leaky config", repository }),
      repository,
    );

    const leakyDiff = [
      "diff --git a/src/secret.ts b/src/secret.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/secret.ts",
      "@@ -0,0 +1,3 @@",
      '+export const OPENAI_API_KEY = "sk-1234567890abcdef1234567890abcdef";',
    ].join("\n");

    const calls: Array<{ url: string; method: string; body: any }> = [];

    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(input);
        calls.push({
          url: urlStr,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });

        if (urlStr.includes(`/pulls/${prNumber}`) && init?.method === "GET") {
          return new Response(leakyDiff, {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }

        if (urlStr.includes(`/pulls/${prNumber}/reviews`) && init?.method === "POST") {
          return new Response(JSON.stringify({ id: 1000, state: "CHANGES_REQUESTED" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

    const runRes = await SELF.fetch(`https://example.com/runs/${repository}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-control-key": CONTROL_KEY,
      },
      body: JSON.stringify({ reviewer: "core" }),
    });

    expect(runRes.status).toBe(200);
    const report = (await runRes.json()) as { ok: boolean; succeeded: number };
    expect(report.ok).toBe(true);
    expect(report.succeeded).toBe(1);

    const reviewCall = calls.find((c) => c.url.includes(`/pulls/${prNumber}/reviews`));
    expect(reviewCall).toBeDefined();
    expect(reviewCall?.body.event).toBe("REQUEST_CHANGES");
    expect(reviewCall?.body.body).toContain("REQUEST CHANGES");
    expect(reviewCall?.body.body).toContain("OpenAI API Key");
  });

  it("incorporates custom review instructions into the generated review", async () => {
    const repository = "acme/pr-bot-custom";
    await provision(repository, "pr.diff");
    await provision(repository, "pr.review");

    const deliveryId = "deliv-pr-custom-3";
    const prNumber = 88;
    await enqueue(
      deliveryId,
      pullRequestPayload(deliveryId, { number: prNumber, title: "Add worker router", repository }),
      repository,
    );

    const diff = [
      "diff --git a/src/router.ts b/src/router.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/router.ts",
      "@@ -0,0 +1,5 @@",
      "+export function route(req: Request) {",
      "+  return new Response('OK');",
      "+}",
    ].join("\n");

    const calls: Array<{ url: string; method: string; body: any }> = [];

    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(input);
        calls.push({
          url: urlStr,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });

        if (urlStr.includes(`/pulls/${prNumber}`) && init?.method === "GET") {
          return new Response(diff, {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }

        if (urlStr.includes(`/pulls/${prNumber}/reviews`) && init?.method === "POST") {
          return new Response(JSON.stringify({ id: 1001, state: "COMMENT" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

    const instruction = "Verify strict adherence to Web Standards and zero nodejs dependencies";

    const runRes = await SELF.fetch(`https://example.com/runs/${repository}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-control-key": CONTROL_KEY,
      },
      body: JSON.stringify({
        reviewer: "llm",
        agentPrompt: instruction,
      }),
    });

    expect(runRes.status).toBe(200);
    const report = (await runRes.json()) as { ok: boolean; succeeded: number };
    expect(report.ok).toBe(true);
    expect(report.succeeded).toBe(1);

    const reviewCall = calls.find((c) => c.url.includes(`/pulls/${prNumber}/reviews`));
    expect(reviewCall).toBeDefined();
    expect(reviewCall?.body.body).toContain(instruction);
  });
});
