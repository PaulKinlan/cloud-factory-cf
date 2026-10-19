import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubRequest } from "./support/webhook";

/**
 * Auto-drain (cloud-factory-cf-7or.1): a webhook alone must produce a review.
 *
 * Before this, `POST /runs/:owner/:repo` was the only caller of the pipeline, so the
 * "bot" needed a human or a cron to poke it. The tests below drive the Durable
 * Object's own alarm, which is what a real deployment gets for free.
 */
const REPOSITORY = "acme/auto-drain";
const CONTROL_KEY = "test-control-key";

interface ReviewCall {
  body: unknown;
}

/** Stubs the one upstream the deterministic reviewer reaches (the PR review POST). */
function stubUpstream(): { reviews: ReviewCall[] } {
  const reviews: ReviewCall[] = [];
  vi.stubGlobal(
    "fetch",
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/reviews")) {
        reviews.push({ body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
        return Response.json({ id: reviews.length }, { status: 201 });
      }
      return new Response("unexpected upstream call", { status: 500 });
    }) as unknown as typeof fetch,
  );
  return { reviews };
}

async function provisionReview(): Promise<void> {
  const response = await SELF.fetch(`https://example.com/broker/${REPOSITORY}/provisioning`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
    body: JSON.stringify({ agent: `cloud-factory:${REPOSITORY}`, service: "github", action: "pr.review" }),
  });
  expect([200, 201]).toContain(response.status);
}

function coordinator() {
  return env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(REPOSITORY));
}

async function pullRequest(deliveryId: string): Promise<void> {
  const response = await SELF.fetch(
    await githubRequest(deliveryId, REPOSITORY, {
      body: JSON.stringify({
        action: "opened",
        number: 11,
        sender: { login: "octocat" },
        repository: { full_name: REPOSITORY },
      }),
    }),
  );
  expect(response.status).toBe(202);
}

async function armedAt(): Promise<number | null> {
  return runInDurableObject(coordinator(), (_instance, state) => state.storage.getAlarm());
}

async function events(): Promise<Array<{ deliveryId: string; status: string }>> {
  const response = await coordinator().fetch("https://repo-coordinator.internal/events?limit=20");
  const payload = (await response.json()) as { events?: Array<{ deliveryId: string; status: string }> };
  return payload.events ?? [];
}

async function fireAlarm(): Promise<void> {
  await runInDurableObject(coordinator(), (instance) => (instance as unknown as { alarm(): Promise<void> }).alarm());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auto-drain", () => {
  it("arms the alarm on a delivery and reviews it when the alarm fires", async () => {
    const { reviews } = stubUpstream();
    await provisionReview();

    await pullRequest("auto-1");

    // The delivery is due now, so the alarm must be armed for it. The old query only
    // looked at events due in the future, which is why nothing ever woke up.
    const armed = await armedAt();
    expect(armed).not.toBeNull();
    expect(armed as number).toBeLessThanOrEqual(Date.now() + 5_000);

    await fireAlarm();

    // No POST /runs anywhere in this test: the alarm is the only trigger.
    expect(reviews).toHaveLength(1);
    const body = reviews[0]?.body as Record<string, unknown> | undefined;
    expect(body?.["body"]).toContain("Automated review of #11");
    const settled = await events();
    expect(settled.find((event) => event.deliveryId === "auto-1")?.status).toBe("processed");
  });

  it("drains a burst in one pass and re-arms only for what is still due", async () => {
    const { reviews } = stubUpstream();
    await provisionReview();

    await pullRequest("auto-2");
    await pullRequest("auto-3");
    await pullRequest("auto-4");
    await fireAlarm();

    expect(reviews).toHaveLength(3);
    const settled = await events();
    for (const id of ["auto-2", "auto-3", "auto-4"]) {
      expect(settled.find((event) => event.deliveryId === id)?.status).toBe("processed");
    }
    // Nothing is left due, so the alarm is cleared rather than left spinning.
    expect(await armedAt()).toBeNull();
  });

  it("does nothing when the queue is empty", async () => {
    const { reviews } = stubUpstream();
    await fireAlarm();
    expect(reviews).toHaveLength(0);
    expect(await armedAt()).toBeNull();
  });
});
