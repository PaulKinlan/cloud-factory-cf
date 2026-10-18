import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { githubRequest, gitlabRequest, signBody, TEST_SECRET } from "./support/webhook";

describe("webhook ingestion", () => {
  it("accepts a GitLab webhook authenticated with X-Gitlab-Token", async () => {
    const response = await SELF.fetch(await gitlabRequest("gitlab-1", "acme/widgets"));
    expect(response.status).toBe(202);

    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName("acme/widgets"));
    const events = (await (await stub.fetch("https://repo-coordinator.internal/events")).json()) as {
      events: Array<Record<string, unknown>>;
    };
    const event = events.events.find((entry) => entry["deliveryId"] === "gitlab-1");
    expect(event).toMatchObject({
      provider: "gitlab",
      event: "Merge Request Hook",
      action: "open",
      repository: "acme/widgets",
      actor: "tanuki",
      status: "pending",
    });
  });

  it("rejects a GitLab webhook with a wrong or missing token", async () => {
    const wrong = await SELF.fetch(await gitlabRequest("gitlab-2", "acme/widgets", { token: "nope" }));
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toMatchObject({ error: "invalid token" });

    const missing = await SELF.fetch(
      new Request("https://example.com/webhooks/gitlab/acme/widgets", {
        method: "POST",
        headers: { "content-type": "application/json", "x-gitlab-event-uuid": "gitlab-3" },
        body: JSON.stringify({ object_kind: "push", project: { path_with_namespace: "acme/widgets" } }),
      }),
    );
    expect(missing.status).toBe(401);
  });

  it("rejects an unsupported provider and a missing delivery id", async () => {
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName("acme/widgets"));

    const unknownProvider = await stub.fetch("https://repo-coordinator.internal/events?provider=bitbucket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(unknownProvider.status).toBe(400);

    // Unauthenticated requests learn nothing about the payload's validity.
    const unsignedNoDelivery = await stub.fetch(
      "https://repo-coordinator.internal/events?provider=github",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(unsignedNoDelivery.status).toBe(401);

    // Authenticated but without a delivery id: 400, because dedupe is impossible.
    const signedBody = "{}";
    const noDelivery = await stub.fetch("https://repo-coordinator.internal/events?provider=github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": await signBody(TEST_SECRET, signedBody),
      },
      body: signedBody,
    });
    expect(noDelivery.status).toBe(400);
  });

  it("rejects malformed json and oversized payloads at the object boundary", async () => {
    const signed = await githubRequest("malformed-1");
    const body = "{not json";
    const signature = signed.headers.get("x-hub-signature-256");
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName("acme/widgets"));

    const malformed = await stub.fetch("https://repo-coordinator.internal/events?provider=github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "malformed-1",
        "x-hub-signature-256": await signBody(TEST_SECRET, body),
      },
      body,
    });
    expect(signature).not.toBeNull();
    expect(malformed.status).toBe(400);

    const huge = "x".repeat(1024 * 1024 + 1);
    const oversized = await stub.fetch("https://repo-coordinator.internal/events?provider=github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "huge-1",
        "x-hub-signature-256": await signBody(TEST_SECRET, huge),
      },
      body: huge,
    });
    expect(oversized.status).toBe(413);
  });

  it("keeps github and gitlab deliveries in one per-repository queue", async () => {
    const repository = "acme/mixed";
    expect((await SELF.fetch(await githubRequest("mixed-gh", repository))).status).toBe(202);
    expect((await SELF.fetch(await gitlabRequest("mixed-gl", repository))).status).toBe(202);

    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repository));
    const body = (await (await stub.fetch("https://repo-coordinator.internal/stats")).json()) as {
      counts: Record<string, number>;
    };
    expect(body.counts["pending"]).toBe(2);
  });
});
