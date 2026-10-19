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
  claimed: Array<{ deliveryId: string; attempts: number; status: string; leaseId: string }>;
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
    expect(typeof first.claimed[0]?.leaseId).toBe("string");

    const second = await call<ClaimResponse>(repository, "/claim", { limit: 1 });
    expect(second.claimed).toHaveLength(1);
    expect(second.claimed[0]?.deliveryId).not.toBe(first.claimed[0]?.deliveryId);
    expect(typeof second.claimed[0]?.leaseId).toBe("string");

    // Nothing is due any more: a live lease is not claimable.
    const third = await call<ClaimResponse>(repository, "/claim", { limit: 10 });
    expect(third.claimed).toEqual([]);
  });

  it("acks a claimed event, after which it is no longer claimable", async () => {
    const repository = "acme/ack";
    await queue(repository, ["ack-1"]);

    const claim = await call<ClaimResponse>(repository, "/claim", { limit: 1 });
    const deliveryId = claim.claimed[0]?.deliveryId as string;
    const leaseId = claim.claimed[0]?.leaseId as string;

    await call(repository, "/ack", { deliveryIds: [deliveryId], leaseId });

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
      const leaseId = claim.claimed[0]?.leaseId as string;

      const failure = await call<FailResponse>(repository, "/fail", {
        deliveryIds: ["retry-1"],
        leaseId,
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

    // The alarm releases the lease AND drains what is due (cloud-factory-cf-7or.1),
    // so this event is picked up, its attempt counted, and handed back because the
    // sink cannot reach a provider without provisioning. The lease contract is what
    // this test is about: the row is pending again, not stuck in 'processing'.
    const pending = await call<{ events: Array<{ deliveryId: string; status: string; attempts: number }> }>(
      repository,
      "/events?status=pending",
    );
    expect(pending.events[0]).toMatchObject({ deliveryId: "lease-1", status: "pending", attempts: 2 });

    // It is claimable again, and the attempt counter is preserved.
    await makeDue(repository, "lease-1");
    const reclaim = await call<ClaimResponse>(repository, "/claim", { limit: 1 });
    expect(reclaim.claimed[0]).toMatchObject({ deliveryId: "lease-1", attempts: 3 });
  });

  it("does not resurrect an event that is already processed", async () => {
    const repository = "acme/idempotent-ack";
    await queue(repository, ["idem-1"]);

    const claim = await call<ClaimResponse>(repository, "/claim", { limit: 1 });
    const deliveryId = claim.claimed[0]?.deliveryId as string;
    const leaseId = claim.claimed[0]?.leaseId as string;
    await call(repository, "/ack", { deliveryIds: [deliveryId], leaseId });

    // A stale runner acking the same id again must be a no-op when already processed.
    await call(repository, "/ack", { deliveryIds: [deliveryId], leaseId });
    const failure = await coordinator(repository).fetch(`${COORDINATOR_URL}/fail`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryIds: [deliveryId], leaseId, error: "stale runner" }),
    });
    // Already processed, so fail is rejected with 409
    expect(failure.status).toBe(409);

    const processed = await call<{ count: number }>(repository, "/events?status=processed");
    expect(processed.count).toBe(1);
    const pending = await call<{ count: number }>(repository, "/events?status=pending");
    expect(pending.count).toBe(0);
  });

  it("rejects acks and fails with 409 when leaseId is stale or mismatched (fixes cloud-factory-cf-1q4)", async () => {
    const repository = "acme/lease-conflict";
    await queue(repository, ["conflict-1"]);

    // Runner 1 claims event
    const claim1 = await call<ClaimResponse>(repository, "/claim", { limit: 1, visibilityMs: 1_000 });
    const deliveryId = claim1.claimed[0]?.deliveryId as string;
    const lease1 = claim1.claimed[0]?.leaseId as string;
    expect(lease1).toBeTruthy();

    // Runner 1 is slow: lease expires and event is requeued by alarm
    await makeDue(repository, deliveryId);
    const alarmRan = await runDurableObjectAlarm(coordinator(repository));
    expect(alarmRan).toBe(true);

    // The alarm also drained what it could (cloud-factory-cf-7or.1), so make the
    // handed-back event due again before measuring the lease conflict.
    await makeDue(repository, deliveryId);

    // Runner 2 claims event and gets a new lease
    const claim2 = await call<ClaimResponse>(repository, "/claim", { limit: 1, visibilityMs: 60_000 });
    const lease2 = claim2.claimed[0]?.leaseId as string;
    expect(lease2).toBeTruthy();
    expect(lease2).not.toBe(lease1);

    // Runner 1 attempts to ack with old lease -> 409 Conflict
    const staleAckResponse = await coordinator(repository).fetch(`${COORDINATOR_URL}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId, leaseId: lease1 }),
    });
    expect(staleAckResponse.status).toBe(409);
    const staleAckBody = (await staleAckResponse.json()) as { error: string };
    expect(staleAckBody.error).toBe("lease conflict");

    // Runner 1 attempts to fail with old lease -> 409 Conflict
    const staleFailResponse = await coordinator(repository).fetch(`${COORDINATOR_URL}/fail`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId, leaseId: lease1, error: "runner 1 timeout" }),
    });
    expect(staleFailResponse.status).toBe(409);

    // Event is STILL in processing state owned by Runner 2
    const status = await call<{ events: Array<{ status: string; leaseId: string }> }>(
      repository,
      "/events?status=processing",
    );
    expect(status.events[0]?.leaseId).toBe(lease2);

    // Runner 2 completes successfully with its valid lease -> 200 OK
    const validAck = await coordinator(repository).fetch(`${COORDINATOR_URL}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId, leaseId: lease2 }),
    });
    expect(validAck.status).toBe(200);

    // Stale runner 1 attempting to ack after runner 2 completed must return 409 Conflict (fixes cloud-factory-cf-wa8)
    const staleAckAfterCompleted = await coordinator(repository).fetch(`${COORDINATOR_URL}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId, leaseId: lease1 }),
    });
    expect(staleAckAfterCompleted.status).toBe(409);
    const staleAckAfterCompletedBody = (await staleAckAfterCompleted.json()) as { error: string };
    expect(staleAckAfterCompletedBody.error).toBe("lease conflict");

    // Idempotent retry by the runner that actually completed it succeeds -> 200 OK
    const idempotentAck = await coordinator(repository).fetch(`${COORDINATOR_URL}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId, leaseId: lease2 }),
    });
    expect(idempotentAck.status).toBe(200);

    const processed = await call<{ count: number }>(repository, "/events?status=processed");
    expect(processed.count).toBe(1);
  });

  it("atomic batch ack and fail reject mixed-validity batches with 409 without mutating earlier rows (fixes cloud-factory-cf-010)", async () => {
    const repository = "acme/atomic-batch";
    await queue(repository, ["batch-A", "batch-B"]);

    const claim = await call<ClaimResponse>(repository, "/claim", { limit: 2 });
    expect(claim.claimed).toHaveLength(2);
    const claimA = claim.claimed.find((c) => c.deliveryId === "batch-A")!;
    const claimB = claim.claimed.find((c) => c.deliveryId === "batch-B")!;

    // Test mixed batch /fail: A has valid lease, B has stale lease
    const mixedFail = await coordinator(repository).fetch(`${COORDINATOR_URL}/fail`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        claims: [
          { deliveryId: "batch-A", leaseId: claimA.leaseId },
          { deliveryId: "batch-B", leaseId: "stale-lease-token" },
        ],
        error: "test batch failure",
      }),
    });
    expect(mixedFail.status).toBe(409);

    // Verify row A was NOT mutated: still in processing state with claimA.leaseId!
    const eventsAfterFail = await call<{ events: Array<{ deliveryId: string; status: string; leaseId: string }> }>(
      repository,
      "/events?status=processing",
    );
    expect(eventsAfterFail.events.find((e) => e.deliveryId === "batch-A")).toMatchObject({
      status: "processing",
      leaseId: claimA.leaseId,
    });

    // Test mixed batch /ack: A has valid lease, B has stale lease
    const mixedAck = await coordinator(repository).fetch(`${COORDINATOR_URL}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        claims: [
          { deliveryId: "batch-A", leaseId: claimA.leaseId },
          { deliveryId: "batch-B", leaseId: "stale-lease-token" },
        ],
      }),
    });
    expect(mixedAck.status).toBe(409);

    // Verify row A was NOT processed: still in processing state!
    const processedEvents = await call<{ events: Array<{ deliveryId: string }> }>(
      repository,
      "/events?status=processed",
    );
    expect(processedEvents.events).toHaveLength(0);

    // Now valid batch ack succeeds atomically
    const validBatchAck = await coordinator(repository).fetch(`${COORDINATOR_URL}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        claims: [
          { deliveryId: "batch-A", leaseId: claimA.leaseId },
          { deliveryId: "batch-B", leaseId: claimB.leaseId },
        ],
      }),
    });
    expect(validBatchAck.status).toBe(200);

    const finalProcessed = await call<{ events: Array<{ deliveryId: string }> }>(
      repository,
      "/events?status=processed",
    );
    expect(finalProcessed.events).toHaveLength(2);
  });

  it("rejects acks and fails with 409 when lease has expired even before alarm runs (fixes cloud-factory-cf-xh7)", async () => {
    const repository = "acme/expired-lease";
    await queue(repository, ["expired-ack", "expired-fail"]);

    const claim = await call<ClaimResponse>(repository, "/claim", { limit: 2, visibilityMs: 60_000 });
    expect(claim.claimed).toHaveLength(2);
    const ackClaim = claim.claimed.find((c) => c.deliveryId === "expired-ack")!;
    const failClaim = claim.claimed.find((c) => c.deliveryId === "expired-fail")!;

    // Time passes past visibilityMs without alarm having fired yet
    await makeDue(repository, "expired-ack");
    await makeDue(repository, "expired-fail");

    // Ack with expired lease must return 409 Conflict
    const expiredAck = await coordinator(repository).fetch(`${COORDINATOR_URL}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId: "expired-ack", leaseId: ackClaim.leaseId }),
    });
    expect(expiredAck.status).toBe(409);
    const expiredAckBody = (await expiredAck.json()) as { error: string };
    expect(expiredAckBody.error).toBe("lease conflict");

    // Fail with expired lease must return 409 Conflict
    const expiredFail = await coordinator(repository).fetch(`${COORDINATOR_URL}/fail`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId: "expired-fail", leaseId: failClaim.leaseId, error: "too late" }),
    });
    expect(expiredFail.status).toBe(409);
    const expiredFailBody = (await expiredFail.json()) as { error: string };
    expect(expiredFailBody.error).toBe("lease conflict");

    // Next claim re-claims both expired events with fresh leases
    const reclaim = await call<ClaimResponse>(repository, "/claim", { limit: 2, visibilityMs: 60_000 });
    expect(reclaim.claimed).toHaveLength(2);
    expect(reclaim.claimed.map((c) => c.deliveryId).sort()).toEqual(["expired-ack", "expired-fail"]);
  });

  it("rejects acks and fails without delivery ids or leaseId", async () => {
    const repository = "acme/bad-requests";
    const noAck = await coordinator(repository).fetch(`${COORDINATOR_URL}/ack`, {
      method: "POST",
      body: "{}",
    });
    expect(noAck.status).toBe(400);

    const noLeaseAck = await coordinator(repository).fetch(`${COORDINATOR_URL}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryIds: ["some-id"] }),
    });
    expect(noLeaseAck.status).toBe(400);
    const noLeaseBody = (await noLeaseAck.json()) as { error: string };
    expect(noLeaseBody.error).toBe("missing leaseId");

    const noFail = await coordinator(repository).fetch(`${COORDINATOR_URL}/fail`, {
      method: "POST",
      body: "{}",
    });
    expect(noFail.status).toBe(400);

    const noLeaseFail = await coordinator(repository).fetch(`${COORDINATOR_URL}/fail`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryIds: ["some-id"] }),
    });
    expect(noLeaseFail.status).toBe(400);
  });
});
