import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubRequest } from "./support/webhook";

/**
 * Auto-drain with the SDK review engine (cloud-factory-cf-7or.1 graft).
 *
 * The webhook must produce the review on its own: the delivery arms the repository's
 * alarm, the alarm drains in process, the SDK engine fetches the diff and emits the
 * review, and the queue settles the event. No `POST /runs` anywhere.
 */
const REPOSITORY = "acme/auto-drain-sdk";
const CONTROL_KEY = "test-control-key";
const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,3 @@",
  " export const a = 1;",
  "+export const b = eval(userInput);",
].join("\n");

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stubUpstream(): { calls: Call[] } {
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
      calls.push({ url, method, body });
      if (url.endsWith("/pulls/11") && method === "GET") {
        return new Response(DIFF, { status: 200, headers: { "content-type": "text/plain" } });
      }
      if (url.endsWith("/pulls/11/reviews")) return Response.json({ id: 1 }, { status: 201 });
      return new Response("unexpected upstream call", { status: 500 });
    }) as unknown as typeof fetch,
  );
  return { calls };
}

async function provision(action: string): Promise<void> {
  const response = await SELF.fetch(`https://example.com/broker/${REPOSITORY}/provisioning`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
    body: JSON.stringify({ agent: `cloud-factory:${REPOSITORY}`, service: "github", action }),
  });
  expect([200, 201]).toContain(response.status);
}

function coordinator() {
  return env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(REPOSITORY));
}

async function armedAt(): Promise<number | null> {
  return runInDurableObject(coordinator(), (_instance, state) => state.storage.getAlarm());
}

async function fireAlarm(): Promise<void> {
  await runInDurableObject(coordinator(), (instance) => (instance as unknown as { alarm(): Promise<void> }).alarm());
}

async function events(): Promise<Array<{ deliveryId: string; status: string }>> {
  const response = await coordinator().fetch("https://repo-coordinator.internal/events?limit=20");
  const payload = (await response.json()) as { events?: Array<{ deliveryId: string; status: string }> };
  return payload.events ?? [];
}

async function pullRequest(deliveryId: string): Promise<void> {
  const response = await SELF.fetch(
    await githubRequest(deliveryId, REPOSITORY, {
      body: JSON.stringify({
        action: "opened",
        number: 11,
        pull_request: { number: 11, title: "Add the adapter" },
        sender: { login: "octocat" },
        repository: { full_name: REPOSITORY },
      }),
    }),
  );
  expect(response.status).toBe(202);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auto-drain with the SDK review engine", () => {
  it("reviews a delivery from the alarm alone", async () => {
    const { calls } = stubUpstream();
    await provision("pr.diff");
    await provision("pr.review");

    await pullRequest("sdk-auto-1");

    const armed = await armedAt();
    expect(armed).not.toBeNull();
    expect(armed as number).toBeLessThanOrEqual(Date.now() + 5_000);

    await fireAlarm();

    // The diff was read and the review posted, with no POST /runs.
    const diffCall = calls.find((call) => call.url.endsWith("/pulls/11") && call.method === "GET");
    expect(diffCall).toBeDefined();
    const review = calls.find((call) => call.url.endsWith("/pulls/11/reviews"));
    expect(review).toBeDefined();
    const body = review?.body as Record<string, unknown> | undefined;
    expect(typeof body?.["body"]).toBe("string");
    expect(body?.["body"] as string).toContain("Cloud Factory PR Review");

    expect((await events()).find((event) => event.deliveryId === "sdk-auto-1")?.status).toBe("processed");
  });

  it("drains a burst in one pass and clears the alarm when nothing is left", async () => {
    const { calls } = stubUpstream();
    await provision("pr.diff");
    await provision("pr.review");

    await pullRequest("sdk-auto-2");
    await pullRequest("sdk-auto-3");
    await fireAlarm();

    expect(calls.filter((call) => call.url.endsWith("/reviews"))).toHaveLength(2);
    const settled = await events();
    expect(settled.find((event) => event.deliveryId === "sdk-auto-2")?.status).toBe("processed");
    expect(settled.find((event) => event.deliveryId === "sdk-auto-3")?.status).toBe("processed");
    expect(await armedAt()).toBeNull();
  });
});
