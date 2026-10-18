import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { pushPayload, signBody, TEST_SECRET } from "./support/webhook";

function coordinator(repository: string) {
  return env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repository));
}

async function post(
  repository: string,
  deliveryId: string,
  options: { signature?: string } = {},
): Promise<Response> {
  const body = pushPayload(deliveryId, repository);
  const signature = options.signature ?? (await signBody(TEST_SECRET, body));
  return coordinator(repository).fetch("https://repo-coordinator.internal/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature,
    },
    body,
  });
}

describe("RepoCoordinator durable object", () => {
  it("rejects an unsigned event at the object boundary", async () => {
    const response = await post("acme/unsigned", "unsigned-1", { signature: "sha256=" });
    expect(response.status).toBe(401);
  });

  it("queues, persists and drains events with durable sqlite storage", async () => {
    const stub = coordinator("acme/persist");
    const queued = await stub.fetch("https://repo-coordinator.internal/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "persist-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": await signBody(TEST_SECRET, pushPayload("persist-1", "acme/persist")),
      },
      body: pushPayload("persist-1", "acme/persist"),
    });
    expect(queued.status).toBe(202);

    const drained = await stub.fetch("https://repo-coordinator.internal/drain", {
      method: "POST",
    });
    await expect(drained.json()).resolves.toMatchObject({ ok: true, drained: 1 });

    // Second drain is a no-op: the queue is empty, not double-counted.
    const drainedAgain = await stub.fetch("https://repo-coordinator.internal/drain", {
      method: "POST",
    });
    await expect(drainedAgain.json()).resolves.toMatchObject({ ok: true, drained: 0 });

    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ delivery_id: string; status: string; repository: string }>(
          "SELECT delivery_id, status, repository FROM events ORDER BY delivery_id",
        )
        .toArray(),
    );
    expect(rows).toEqual([
      { delivery_id: "persist-1", status: "processed", repository: "acme/persist" },
    ]);
  });
});
