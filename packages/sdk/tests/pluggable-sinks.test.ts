import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentContext,
  ActionSinkRegistry,
  DefaultCredentialBroker,
  GitHubPRReviewSink,
  GitHubIssueSink,
  BeadsTaskSink,
  CloudTelemetrySink,
} from '../src/index.ts';

function mockCtx(broker?: DefaultCredentialBroker) {
  return createAgentContext({
    repo: { owner: 'acme', name: 'repo' },
    org: { id: 'org_acme' },
    actor: { type: 'lane', id: 'imp-2' },
    credentials: broker,
  });
}

test('GitHubPRReviewSink: validates payload and dispatches via signed request or custom executor', async () => {
  // Test validation errors
  const sink = new GitHubPRReviewSink();
  const ctx = mockCtx();

  const invalidPr = await sink.handle(
    { id: '1', type: 'github:pr:review', payload: { prNumber: -1, event: 'APPROVE', body: 'looks good' }, timestamp: Date.now() },
    ctx,
  );
  assert.equal(invalidPr.success, false);
  assert.match(invalidPr.error!, /prNumber/);

  const invalidEvent = await sink.handle(
    { id: '2', type: 'github:pr:review', payload: { prNumber: 42, event: 'MERGE' as any, body: 'looks good' }, timestamp: Date.now() },
    ctx,
  );
  assert.equal(invalidEvent.success, false);
  assert.match(invalidEvent.error!, /unsupported review event/);

  const emptyBody = await sink.handle(
    { id: '3', type: 'github:pr:review', payload: { prNumber: 42, event: 'APPROVE', body: '   ' }, timestamp: Date.now() },
    ctx,
  );
  assert.equal(emptyBody.success, false);
  assert.match(emptyBody.error!, /non-empty string/);

  // Test fail-closed credential broker
  const denied = await sink.handle(
    { id: '4', type: 'github:pr:review', payload: { prNumber: 42, event: 'APPROVE', body: 'LGTM' }, timestamp: Date.now() },
    ctx,
  );
  assert.equal(denied.success, false);
  assert.match(denied.error!, /permission denied/i);

  // Test successful dispatch via credential broker
  const executedCalls: any[] = [];
  const allowedBroker = new DefaultCredentialBroker(
    ['github:create_pr_review'],
    async (req) => {
      executedCalls.push(req);
      return { reviewId: 'rev_123', status: 'submitted' };
    },
  );
  const allowedCtx = mockCtx(allowedBroker);

  const success = await sink.handle(
    { id: '5', type: 'github:pr:review', payload: { prNumber: 42, event: 'APPROVE', body: 'LGTM' }, timestamp: Date.now() },
    allowedCtx,
  );
  assert.equal(success.success, true);
  assert.deepEqual(success.result, { reviewId: 'rev_123', status: 'submitted' });
  assert.equal(executedCalls.length, 1);
  assert.equal(executedCalls[0].params.prNumber, 42);

  // Test custom executor override
  const customSink = new GitHubPRReviewSink({
    executor: async (payload) => ({ custom: true, pr: payload.prNumber }),
  });
  const customRes = await customSink.handle(
    { id: '6', type: 'github:pr:review', payload: { prNumber: 99, event: 'COMMENT', body: 'Nice work' }, timestamp: Date.now() },
    ctx,
  );
  assert.equal(customRes.success, true);
  assert.deepEqual(customRes.result, { custom: true, pr: 99 });
});

test('GitHubIssueSink: validates payload and dispatches via broker or custom executor', async () => {
  const sink = new GitHubIssueSink();
  const ctx = mockCtx();

  const emptyTitle = await sink.handle(
    { id: '1', type: 'github:issue:create', payload: { title: '', body: 'text' }, timestamp: Date.now() },
    ctx,
  );
  assert.equal(emptyTitle.success, false);
  assert.match(emptyTitle.error!, /non-empty string/);

  const customSink = new GitHubIssueSink({
    executor: async (p) => ({ issueNumber: 101, title: p.title }),
  });
  const res = await customSink.handle(
    { id: '2', type: 'github:issue:create', payload: { title: 'Bug found', body: 'description', labels: ['bug'] }, timestamp: Date.now() },
    ctx,
  );
  assert.equal(res.success, true);
  assert.deepEqual(res.result, { issueNumber: 101, title: 'Bug found' });
});

test('BeadsTaskSink: validates payload and priority, dispatches task actions', async () => {
  const sink = new BeadsTaskSink();
  const ctx = mockCtx();

  const invalidPriority = await sink.handle(
    { id: '1', type: 'beads:task:create', payload: { title: 'task 1', description: 'desc', priority: 'P9' as any }, timestamp: Date.now() },
    ctx,
  );
  assert.equal(invalidPriority.success, false);
  assert.match(invalidPriority.error!, /unsupported priority/);

  const customSink = new BeadsTaskSink({
    executor: async (p, type) => ({ beadId: 'cf-abc', title: p.title, action: type }),
  });
  const res = await customSink.handle(
    { id: '2', type: 'beads:task:create', payload: { title: 'New Task', description: 'desc', priority: 'P1' }, timestamp: Date.now() },
    ctx,
  );
  assert.equal(res.success, true);
  assert.deepEqual(res.result, { beadId: 'cf-abc', title: 'New Task', action: 'beads:task:create' });
});

test('CloudTelemetrySink: validates metrics and logs, buffers and exports', async () => {
  const telemetryEntries: any[] = [];
  const sink = new CloudTelemetrySink({
    exporter: async (entry) => {
      telemetryEntries.push(entry);
    },
  });
  const ctx = mockCtx();

  // Test invalid metric
  const invalidVal = await sink.handle(
    { id: '1', type: 'telemetry:metric', payload: { metric: 'runs', value: NaN }, timestamp: Date.now() },
    ctx,
  );
  assert.equal(invalidVal.success, false);
  assert.match(invalidVal.error!, /finite number/);

  // Test valid metric
  const metricRes = await sink.handle(
    { id: '2', type: 'telemetry:metric', payload: { metric: 'runs_total', value: 1, unit: 'count', tags: { env: 'prod' } }, timestamp: Date.now() },
    ctx,
  );
  assert.equal(metricRes.success, true);

  // Test valid log
  const logRes = await sink.handle(
    { id: '3', type: 'telemetry:log', payload: { level: 'info', message: 'Agent execution started' }, timestamp: Date.now() },
    ctx,
  );
  assert.equal(logRes.success, true);

  assert.equal(telemetryEntries.length, 2);
  assert.equal(sink.getBufferedEntries().length, 2);
});

test('ActionSinkRegistry: routes actions to registered pluggable sinks', async () => {
  const registry = new ActionSinkRegistry();

  const reviewCalls: any[] = [];
  const issueCalls: any[] = [];
  const beadsCalls: any[] = [];
  const telemetryCalls: any[] = [];

  registry.registerSink(new GitHubPRReviewSink({ executor: async (p) => { reviewCalls.push(p); return { ok: true }; } }));
  registry.registerSink(new GitHubIssueSink({ executor: async (p) => { issueCalls.push(p); return { ok: true }; } }));
  registry.registerSink(new BeadsTaskSink({ executor: async (p) => { beadsCalls.push(p); return { ok: true }; } }));
  registry.registerSink(new CloudTelemetrySink({ exporter: async (e) => { telemetryCalls.push(e); } }));

  const ctx = mockCtx();

  const results1 = await registry.emit(
    { type: 'github:pr:review', payload: { prNumber: 10, event: 'APPROVE', body: 'Looks good' } },
    ctx,
  );
  assert.equal(results1.length, 1);
  assert.equal(results1[0]!.success, true);
  assert.equal(reviewCalls.length, 1);

  const results2 = await registry.emit(
    { type: 'github:issue:create', payload: { title: 'Issue 1', body: 'Body 1' } },
    ctx,
  );
  assert.equal(results2.length, 1);
  assert.equal(results2[0]!.success, true);
  assert.equal(issueCalls.length, 1);

  const results3 = await registry.emit(
    { type: 'beads:task:create', payload: { title: 'Bead 1', description: 'Bead desc', priority: 'P2' } },
    ctx,
  );
  assert.equal(results3.length, 1);
  assert.equal(results3[0]!.success, true);
  assert.equal(beadsCalls.length, 1);

  const results4 = await registry.emit(
    { type: 'telemetry:metric', payload: { metric: 'cpu', value: 42 } },
    ctx,
  );
  assert.equal(results4.length, 1);
  assert.equal(results4[0]!.success, true);
  assert.equal(telemetryCalls.length, 1);
});
