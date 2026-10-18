import test from 'node:test';
import assert from 'node:assert/strict';
import { QueueWorker, type WireEvent, type Fetcher } from '../src/index.ts';

test('QueueWorker: claims events, runs local runner, and acknowledges with lease tokens', async () => {
  const eventsInQueue: WireEvent[] = [
    {
      deliveryId: 'del-1',
      provider: 'github',
      event: 'pull_request',
      action: 'opened',
      repository: 'acme/cool-repo',
      actor: 'alice',
      receivedAt: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
      availableAt: new Date().toISOString(),
      lastError: null,
      leaseId: 'lease-token-123',
    },
    {
      deliveryId: 'del-2',
      provider: 'github',
      event: 'issues',
      action: 'opened',
      repository: 'acme/cool-repo',
      actor: 'bob',
      receivedAt: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
      availableAt: new Date().toISOString(),
      lastError: null,
      leaseId: 'lease-token-456',
    },
  ];

  const ackedClaims: any[] = [];
  const failedClaims: any[] = [];

  const mockFetcher: Fetcher = async (url, init) => {
    const urlStr = url.toString();
    const body = init?.body ? JSON.parse(init.body as string) : {};

    if (urlStr.endsWith('/claim')) {
      return Response.json({
        ok: true,
        claimed: eventsInQueue.splice(0, body.limit ?? 5),
        leaseUntil: new Date(Date.now() + 30000).toISOString(),
      });
    }

    if (urlStr.endsWith('/ack')) {
      ackedClaims.push(...body.claims);
      return Response.json({ ok: true, acknowledged: body.claims.length });
    }

    if (urlStr.endsWith('/fail')) {
      failedClaims.push({ claims: body.claims, error: body.error });
      return Response.json({ ok: true, failed: body.claims.length });
    }

    return new Response('Not found', { status: 404 });
  };

  const processedEvents: string[] = [];
  const worker = new QueueWorker({
    coordinatorUrl: 'https://coordinator.local',
    fetcher: mockFetcher,
    eventHandler: async (evt) => {
      processedEvents.push(evt.deliveryId);
      if (evt.deliveryId === 'del-2') {
        throw new Error('Simulated processing failure for del-2');
      }
    },
  });

  const batch = await worker.processNextBatch();

  assert.equal(batch.claimedCount, 2);
  assert.equal(batch.successCount, 1);
  assert.equal(batch.failCount, 1);

  assert.deepEqual(processedEvents, ['del-1', 'del-2']);

  // del-1 succeeded and acked with leaseId
  assert.equal(ackedClaims.length, 1);
  assert.deepEqual(ackedClaims[0], { deliveryId: 'del-1', leaseId: 'lease-token-123' });

  // del-2 failed and called fail with leaseId and error message
  assert.equal(failedClaims.length, 1);
  assert.deepEqual(failedClaims[0].claims, [{ deliveryId: 'del-2', leaseId: 'lease-token-456' }]);
  assert.match(failedClaims[0].error, /Simulated processing failure/);
});
