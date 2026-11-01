import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { githubRequest, pushPayload, signBody, TEST_SECRET } from "./support/webhook";
import { getRepoCoordinator } from "../src/repo-coordinator-addressing";

describe("worker entry point", () => {
  it("serves a health response", async () => {
    const response = await SELF.fetch("https://example.com/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "cloud-factory-cf",
    });
  });

  it("404s unknown routes and 405s non-POST webhooks", async () => {
    expect((await SELF.fetch("https://example.com/nope")).status).toBe(404);
    const notPost = await SELF.fetch("https://example.com/webhooks/github/acme/widgets");
    expect(notPost.status).toBe(405);
  });

  it("rejects webhooks without a valid signature", async () => {
    const response = await SELF.fetch(
      await githubRequest("unsigned-1", "acme/widgets", { signature: "sha256=" + "0".repeat(64) }),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  it("accepts a signed webhook into the repo coordinator and dedupes redelivery", async () => {
    const deliveryId = "worker-signed-1";

    const accepted = await SELF.fetch(await githubRequest(deliveryId));
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toMatchObject({
      ok: true,
      queued: true,
      deliveryId,
    });

    // Replaying the same delivery id (GitHub retry) must not enqueue twice.
    const duplicate = await SELF.fetch(await githubRequest(deliveryId));
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({ ok: true, duplicate: true });

    const stub = getRepoCoordinator(env, "acme/widgets", "github");
    const queued = await stub.fetch("https://repo-coordinator.internal/events");
    const body = (await queued.json()) as {
      count: number;
      events: Array<{ deliveryId: string; status: string; actor: string | null }>;
    };
    expect(body.count).toBe(1);
    // A 200 means accepted, not "still pending": the drain may claim the delivery between the
    // write and either of the reads below. Both of them used to pin "pending" and both were
    // observed returning "processing" - body.events[0] (fixed in d58c1e8 on the parallel
    // branch, still racy on main) and this direct SQL read, which the fast gate for
    // b5901b8 caught at line 64. What must hold is that exactly one delivery exists for the
    // id, it belongs to the right actor, and it is queued or already taken; a dropped event,
    // a duplicate or the wrong actor still fails.
    expect(body.events[0]).toMatchObject({ deliveryId, actor: "octocat" });
    expect(["pending", "processing"]).toContain(body.events[0]!.status);

    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ status: string; actor: string | null }>(
          "SELECT status, actor FROM events WHERE delivery_id = ?",
          deliveryId,
        )
        .toArray(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("octocat");
    expect(["pending", "processing"]).toContain(rows[0]!.status);
  });

  it("isolates repositories into separate durable objects", async () => {
    const response = await SELF.fetch(await githubRequest("worker-other-repo-1", "acme/gadgets"));
    expect(response.status).toBe(202);

    const widgets = getRepoCoordinator(env, "acme/widgets", "github");
    const gadgets = getRepoCoordinator(env, "acme/gadgets", "github");

    const widgetsEvents = (await (
      await widgets.fetch("https://repo-coordinator.internal/events")
    ).json()) as { events: Array<{ deliveryId: string }> };
    const gadgetsEvents = (await (
      await gadgets.fetch("https://repo-coordinator.internal/events")
    ).json()) as { events: Array<{ deliveryId: string }> };

    expect(widgetsEvents.events.map((event) => event.deliveryId)).not.toContain(
      "worker-other-repo-1",
    );
    expect(gadgetsEvents.events.map((event) => event.deliveryId)).toEqual([
      "worker-other-repo-1",
    ]);
  });

  it("refuses a payload that names a different repository than the endpoint", async () => {
    // Signed correctly for the body, but the body is about acme/gadgets while the
    // endpoint is acme/widgets: a misconfigured or forged hook.
    const body = pushPayload("mismatch-1", "acme/gadgets");
    const response = await SELF.fetch(
      new Request("https://example.com/webhooks/github/acme/widgets", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "mismatch-1",
          "x-github-event": "pull_request",
          "x-hub-signature-256": await signBody(TEST_SECRET, body),
        },
        body,
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "repository mismatch" });
  });

  it("refuses a payload that names a different platform than the endpoint (cloud-factory-cf-29nb)", async () => {
    const stub = getRepoCoordinator(env, "acme/widgets", "github");
    const body = pushPayload("mismatch-platform-1", "gitlab:acme/widgets");
    const response = await stub.fetch("https://repo-coordinator.internal/events?provider=github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "mismatch-platform-1",
        "x-github-event": "pull_request",
        "x-factory-repository": "github:acme/widgets",
        "x-hub-signature-256": await signBody(TEST_SECRET, body),
      },
      body,
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "repository mismatch" });
  });
});
