import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { githubRequest } from "./support/webhook";

const COORDINATOR_URL = "https://repo-coordinator.internal";

function coordinator(repository: string) {
  return env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repository));
}

async function queue(repository: string, deliveryIds: string[]): Promise<void> {
  for (const id of deliveryIds) {
    const response = await SELF.fetch(await githubRequest(id, repository));
    expect(response.status).toBe(202);
  }
}

async function call<T>(repository: string, path: string, body?: unknown): Promise<T> {
  const response = await coordinator(repository).fetch(`${COORDINATOR_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as T;
}

/** Simulates a lease/backoff elapsing without sleeping in the test. */
async function makeDue(repository: string, deliveryId: string): Promise<void> {
  await runInDurableObject(coordinator(repository), (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE events SET available_at = ? WHERE delivery_id = ?",
      new Date(Date.now() - 1_000).toISOString(),
      deliveryId,
    );
  });
}

interface ClaimResponse {
  claimed: Array<{ deliveryId: string; attempts: number; status: string }>;
  leaseUntil: string;
}

interface FailResponse {
  retried: number;
  deadLettered: number;
}

describe("coordinator queue", () => {
  it("claims events one at a time and never hands the same event to two claims", async () => {
    const repository = "acme/claim";
    await queue(repository, ["claim-1", "claim-2"]);

    const first = await call<ClaimResponse>(repository, "/claim", { limit: 1 });
    expect(first.claimed).toHaveLength(1);
    expect(first.claimed[0]).toMatchObject({ attempts: 1, status: "processing" });

    const second = await call<ClaimResponse>(repository, "/claim", { limit: 1 });
    expect(second.claimed).toHaveLength(1);
    expect(second.claimed[0]?.deliveryId).not.toBe(first.claimed[0]?.deliveryId);

    // Nothing is due any more: a live lease is not claimable.
    const third = await call<ClaimResponse>(repository, "/claim", { limit: 10 });
    expect(third.claimed).toEqual([]);
  });

  it("acks a claimed event, after which it is no longer claimable", async () => {
    const repository = "acme/ack";
    await queue(repository, ["ack-1"]);

    const claim = await call<ClaimResponse>(repository, "/claim", { limit: 1 });
    const deliveryId = claim.claimed[0]?.deliveryId as string;

    await call(repository, "/ack", { deliveryIds: [deliveryId] });

    const events = await call<{ events: Array<{ deliveryId: string; status: string }> }>(
      repository,
      "/events?status=processed",
    );
    expect(events.events.map((event) => event.deliveryId)).toContain(deliveryId);

    await makeDue(repository, deliveryId);
    const after = await call<ClaimResponse>(repository, "/claim", { limit: 10 });
    expect(after.claimed).toEqual([]);
  });

  it("retries a failed event and dead-letters it after MAX_ATTEMPTS", async () => {
    const repository = "acme/retry";
    await queue(repository, ["retry-1"]);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claim = await call<ClaimResponse>(repository, "/claim", { limit: 1 });
      expect(claim.claimed[0]?.attempts).toBe(attempt);

      const failure = await call<FailResponse>(repository, "/fail", {
        deliveryIds: ["retry-1"],
        error: `runner failure ${attempt}`,
      });

      if (attempt < 5) {
        expect(failure).toMatchObject({ retried: 1, deadLettered: 0 });
        // Backoff means it is not due yet...
        const notDue = await call<ClaimResponse>(repository, "/claim", { limit: 1 });
        expect(notDue.claimed).toEqual([]);
        // ...until the backoff elapses.
        await makeDue(repository, "retry-1");
      } else {
        expect(failure).toMatchObject({ retried: 0, deadLettered: 1 });
      }
    }

    const failed = await call<{ events: Array<{ deliveryId: string; status: string; lastError: string }> }>(
      repository,
      "/events?status=failed",
    );
    expect(failed.events[0]).toMatchObject({
      deliveryId: "retry-1",
      status: "failed",
      lastError: "runner failure 5",
    });

    await makeDue(repository, "retry-1");
    const after = await call<ClaimResponse>(repository, "/claim", { limit: 10 });
    expect(after.claimed).toEqual([]);
  });

  it("hands an expired lease back to the queue when the alarm fires", async () => {
    const repository = "acme/lease";
    await queue(repository, ["lease-1"]);

    const claim = await call<ClaimResponse>(repository, "/claim", { limit: 1, visibilityMs: 60_000 });
    expect(claim.claimed[0]?.status).toBe("processing");

    // The runner died mid-flight: its lease expires with the row still processing.
    await makeDue(repository, "lease-1");
    const ran = await runDurableObjectAlarm(coordinator(repository));
    expect(ran).toBe(true);

    const pending = await call<{ events: Array<{ deliveryId: string; status: string; attempts: number }> }>(
      repository,
      "/events?status=pending",
    );
    expect(pending.events[0]).toMatchObject({ deliveryId: "lease-1", status: "pending", attempts: 1 });

    // It is claimable again, and the attempt counter is preserved.
    const reclaim = await call<ClaimResponse>(repository, "/claim", { limit: 1 });
    expect(reclaim.claimed[0]).toMatchObject({ deliveryId: "lease-1", attempts: 2 });
  });

  it("does not resurrect an event that is already processed", async () => {
    const repository = "acme/idempotent-ack";
    await queue(repository, ["idem-1"]);

    const claim = await call<ClaimResponse>(repository, "/claim", { limit: 1 });
    const deliveryId = claim.claimed[0]?.deliveryId as string;
    await call(repository, "/ack", { deliveryIds: [deliveryId] });

    // A stale runner acking or failing the same id again must be a no-op.
    await call(repository, "/ack", { deliveryIds: [deliveryId] });
    const failure = await call<FailResponse>(repository, "/fail", {
      deliveryIds: [deliveryId],
      error: "stale runner",
    });
    expect(failure).toMatchObject({ retried: 0, deadLettered: 0 });

    const processed = await call<{ count: number }>(repository, "/events?status=processed");
    expect(processed.count).toBe(1);
    const pending = await call<{ count: number }>(repository, "/events?status=pending");
    expect(pending.count).toBe(0);
  });

  it("rejects acks and fails without delivery ids", async () => {
    const repository = "acme/bad-requests";
    const noAck = await coordinator(repository).fetch(`${COORDINATOR_URL}/ack`, {
      method: "POST",
      body: "{}",
    });
    expect(noAck.status).toBe(400);

    const noFail = await coordinator(repository).fetch(`${COORDINATOR_URL}/fail`, {
      method: "POST",
      body: JSON.stringify({ error: "no ids" }),
    });
    expect(noFail.status).toBe(400);
  });
});
