import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { githubRequest, gitlabRequest, signBody, TEST_SECRET } from "./support/webhook";
import { getRepoCoordinator } from "../src/repo-coordinator-addressing";
import { MAX_WEBHOOK_BYTES } from "../src/webhooks";
import { readBodyWithinLimit } from "../src/events/helpers";

describe("webhook ingestion", () => {
  it("accepts a GitLab webhook authenticated with X-Gitlab-Token", async () => {
    const response = await SELF.fetch(await gitlabRequest("gitlab-1", "acme/ingest-repo"));
    expect(response.status).toBe(202);

    const stub = getRepoCoordinator(env, "acme/ingest-repo", "gitlab");
    const events = (await (await stub.fetch("https://repo-coordinator.internal/events")).json()) as {
      events: Array<Record<string, unknown>>;
    };
    const event = events.events.find((entry) => entry["deliveryId"] === "gitlab-1");
    expect(event).toMatchObject({
      provider: "gitlab",
      event: "Merge Request Hook",
      action: "open",
      kind: "merge_request",
      canonicalAction: "opened",
      repository: "acme/ingest-repo",
      actor: "tanuki",
      status: "pending",
    });
  });

  it("rejects a GitLab webhook with a wrong or missing token", async () => {
    const wrong = await SELF.fetch(await gitlabRequest("gitlab-2", "acme/ingest-repo", { token: "nope" }));
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toMatchObject({ error: "invalid token" });

    const missing = await SELF.fetch(
      new Request("https://example.com/webhooks/gitlab/acme/ingest-repo", {
        method: "POST",
        headers: { "content-type": "application/json", "x-gitlab-event-uuid": "gitlab-3" },
        body: JSON.stringify({ object_kind: "push", project: { path_with_namespace: "acme/ingest-repo" } }),
      }),
    );
    expect(missing.status).toBe(401);
  });

  it("rejects an unsupported provider and a missing delivery id", async () => {
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName("acme/ingest-repo"));

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

  it("stops reading an unauthenticated body at the size cap instead of buffering it (cloud-factory-cf-v0xd)", async () => {
    // 1. End to end: a chunked delivery declares no content-length, so only the read can
    // stop it - it is refused with 413 rather than buffered.
    const oversized = new Uint8Array(MAX_WEBHOOK_BYTES + 1024);
    const chunked = await SELF.fetch(
      new Request("https://example.com/webhooks/gitlab/acme/ingest-repo", {
        method: "POST",
        headers: { "content-type": "application/json", "x-gitlab-event-uuid": "gitlab-oversize" },
        body: oversized,
      }),
    );
    expect(chunked.status).toBe(413);
    await expect(chunked.json()).resolves.toMatchObject({ error: "payload too large" });

    // 2. The reader itself stops at the cap and cancels: driven directly, because the
    // test runtime materialises a request body before the Worker (or this suite) sees
    // the stream, so an end-to-end assertion cannot observe where reading stopped.
    const CHUNK = 64 * 1024;
    const TOTAL_CHUNKS = 48;
    let produced = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= TOTAL_CHUNKS) {
          controller.close();
          return;
        }
        produced += 1;
        controller.enqueue(new Uint8Array(CHUNK));
      },
      cancel() {
        cancelled = true;
      },
    });
    const direct = new Request("https://example.com/webhooks/gitlab/acme/ingest-repo", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);

    const read = await readBodyWithinLimit(direct, 1024 * 1024);

    expect(read).toBeNull();
    expect(cancelled).toBe(true);
    // 1 MiB / 64 KiB is 16 chunks: nowhere near the 48 the stream would have produced.
    expect(produced).toBeLessThanOrEqual(20);
  });

  it("refuses a length-less oversized body at the app-level GitHub endpoint too (cloud-factory-cf-v0xd)", async () => {
    // Same rule on the other unauthenticated entry point: no content-length means the
    // read has to stop, not the declared-length check.
    const response = await SELF.fetch(
      new Request("https://example.com/webhooks/github", {
        method: "POST",
        headers: { "content-type": "application/json", "x-github-event": "push" },
        body: new Uint8Array(MAX_WEBHOOK_BYTES + 1024),
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "payload too large" });
  });

  it("rejects malformed json and oversized payloads at the object boundary", async () => {
    const signed = await githubRequest("malformed-1");
    const body = "{not json";
    const signature = signed.headers.get("x-hub-signature-256");
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName("acme/ingest-repo"));

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

  it("isolates github and gitlab deliveries by platform key", async () => {
    const repository = "acme/mixed";
    expect((await SELF.fetch(await githubRequest("mixed-gh", repository))).status).toBe(202);
    expect((await SELF.fetch(await gitlabRequest("mixed-gl", repository))).status).toBe(202);

    const ghStub = getRepoCoordinator(env, repository, "github");
    const glStub = getRepoCoordinator(env, repository, "gitlab");
    const ghBody = (await (await ghStub.fetch("https://repo-coordinator.internal/stats")).json()) as {
      counts: Record<string, number>;
    };
    const glBody = (await (await glStub.fetch("https://repo-coordinator.internal/stats")).json()) as {
      counts: Record<string, number>;
    };
    expect(ghBody.counts["pending"]).toBe(1);
    expect(glBody.counts["pending"]).toBe(1);
  });
});
