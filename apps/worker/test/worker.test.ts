import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { pushPayload, signBody, TEST_SECRET } from "./support/webhook";

const WEBHOOK_URL = "https://example.com/webhooks/github/acme/widgets";

async function signedRequest(deliveryId: string, repository = "acme/widgets"): Promise<Request> {
  const body = pushPayload(deliveryId, repository);
  // Routing is by URL path: the webhook is registered per repository, so the
  // path (not the payload) decides which Durable Object sees the event.
  return new Request(`https://example.com/webhooks/github/${repository}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "pull_request",
      "x-hub-signature-256": await signBody(TEST_SECRET, body),
    },
    body,
  });
}

describe("worker entry point", () => {
  it("serves a health response", async () => {
    const response = await SELF.fetch("https://example.com/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "cloud-factory-cf",
    });
  });

  it("404s unknown routes", async () => {
    const response = await SELF.fetch("https://example.com/nope");
    expect(response.status).toBe(404);
  });

  it("rejects webhooks without a valid signature", async () => {
    const body = pushPayload("unsigned-1");
    const response = await SELF.fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "unsigned-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=" + "0".repeat(64),
      },
      body,
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  it("accepts a signed webhook into the repo coordinator and dedupes redelivery", async () => {
    const deliveryId = "worker-signed-1";

    const accepted = await SELF.fetch(await signedRequest(deliveryId));
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toMatchObject({
      ok: true,
      queued: true,
      deliveryId,
    });

    // Replaying the same delivery id (GitHub retry) must not enqueue twice.
    const duplicate = await SELF.fetch(await signedRequest(deliveryId));
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({ ok: true, duplicate: true });

    const stub = env.REPO_COORDINATOR.get(
      env.REPO_COORDINATOR.idFromName("acme/widgets"),
    );
    const queued = await stub.fetch("https://repo-coordinator.internal/events");
    const body = (await queued.json()) as { count: number; events: Array<{ deliveryId: string }> };
    expect(body.count).toBe(1);
    expect(body.events[0]?.deliveryId).toBe(deliveryId);

    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ status: string }>("SELECT status FROM events WHERE delivery_id = ?", deliveryId)
        .toArray(),
    );
    expect(rows).toEqual([{ status: "pending" }]);
  });

  it("isolates repositories into separate durable objects", async () => {
    const response = await SELF.fetch(await signedRequest("worker-other-repo-1", "acme/gadgets"));
    expect(response.status).toBe(202);

    const widgets = env.REPO_COORDINATOR.get(
      env.REPO_COORDINATOR.idFromName("acme/widgets"),
    );
    const gadgets = env.REPO_COORDINATOR.get(
      env.REPO_COORDINATOR.idFromName("acme/gadgets"),
    );

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
});
