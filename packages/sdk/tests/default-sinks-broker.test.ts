import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUpstreamAccepted } from '../src/sinks/broker-result.ts';
import {
  ActionSinkRegistry,
  BeadsTaskSink,
  GitHubIssueSink,
  GitHubPRReviewSink,
  createAgentContext,
  type CredentialBroker,
  type CredentialCapabilityRequest,
} from '../src/index.ts';

/**
 * The default sinks are the SDK's contract with the credential broker
 * (cloud-factory-cf-g9aw). Two things went wrong and both looked like success:
 *
 *   1. they asked for actions the broker does not permit (`create_pr_review`,
 *      `create_issue`, `create_task`, `update_task`), which the worker refuses
 *      before any upstream call, and
 *   2. they reported the broker's answer as `success: true` without looking at the
 *      upstream status, so a rejection was indistinguishable from a review that landed.
 *
 * These tests pin the action names, the parameters the worker's policy actually
 * forwards, `includeStatus`, and — the point of the exercise — that a rejected call
 * fails the action.
 */

interface RecordedCall {
  service: string;
  action: string;
  params?: Record<string, unknown>;
  includeStatus?: boolean;
}

function brokerReturning(
  responder: (call: RecordedCall) => { status: number; body: unknown },
): { broker: CredentialBroker; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const broker: CredentialBroker = {
    async executeSignedRequest<T>(request: CredentialCapabilityRequest): Promise<T> {
      const call: RecordedCall = {
        service: request.service,
        action: request.action,
        params: request.params as Record<string, unknown> | undefined,
        includeStatus: request.includeStatus,
      };
      calls.push(call);
      return responder(call) as T;
    },
    async hasPermission(): Promise<boolean> {
      return true;
    },
  };
  return { broker, calls };
}

function contextWith(broker: CredentialBroker) {
  return createAgentContext({
    repo: { owner: 'octodev', name: 'widget-service' },
    org: { id: 'octodev' },
    credentials: broker,
  });
}

test('GitHubPRReviewSink asks for the broker action pr.review and forwards {number}', async () => {
  const { broker, calls } = brokerReturning(() => ({ status: 201, body: { id: 9 } }));
  const sink = new GitHubPRReviewSink();

  const result = await sink.handle(
    {
      id: '1',
      type: 'github:pr:review',
      payload: { prNumber: 42, event: 'COMMENT', body: 'hello' },
      timestamp: 0,
    },
    contextWith(broker),
  );

  assert.equal(result.success, true);
  assert.deepEqual(result.result, { status: 201 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.service, 'github');
  assert.equal(calls[0]?.action, 'pr.review');
  assert.equal(calls[0]?.includeStatus, true);
  // The broker fills the `{number}` path parameter from this exact name.
  assert.equal(calls[0]?.params?.number, 42);
  assert.equal(calls[0]?.params?.event, 'COMMENT');
  assert.equal(calls[0]?.params?.body, 'hello');
});

test('GitHubPRReviewSink fails when the broker reports a rejected review', async () => {
  const { broker } = brokerReturning(() => ({ status: 404, body: { error: 'unsupported action' } }));
  const sink = new GitHubPRReviewSink();

  const result = await sink.handle(
    {
      id: '1',
      type: 'github:pr:review',
      payload: { prNumber: 42, event: 'COMMENT', body: 'hello' },
      timestamp: 0,
    },
    contextWith(broker),
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /pr\.review answered 404/);
});

test('GitHubIssueSink asks for issue.create and fails a rejected create', async () => {
  const accepting = brokerReturning(() => ({ status: 201, body: { number: 7 } }));
  const okSink = new GitHubIssueSink();
  const accepted = await okSink.handle(
    { id: '2', type: 'github:issue:create', payload: { title: 'Bug', body: 'It broke' }, timestamp: 0 },
    contextWith(accepting.broker),
  );

  assert.equal(accepted.success, true);
  assert.equal(accepting.calls[0]?.action, 'issue.create');
  assert.equal(accepting.calls[0]?.includeStatus, true);
  assert.deepEqual(accepting.calls[0]?.params, { title: 'Bug', body: 'It broke' });

  const rejecting = brokerReturning(() => ({ status: 404, body: { error: 'unsupported action' } }));
  const rejected = await new GitHubIssueSink().handle(
    { id: '3', type: 'github:issue:create', payload: { title: 'Bug', body: 'It broke' }, timestamp: 0 },
    contextWith(rejecting.broker),
  );

  assert.equal(rejected.success, false);
  assert.match(rejected.error ?? '', /issue\.create answered 404/);
});

test('BeadsTaskSink asks for task.create / task.update and fails a rejected write', async () => {
  const create = brokerReturning(() => ({ status: 201, body: { id: 'cf-1' } }));
  const createdResult = await new BeadsTaskSink().handle(
    {
      id: '4',
      type: 'beads:task:create',
      payload: { title: 'Ship it', description: 'With tests', priority: 'P2', assignee: 'imp-1' },
      timestamp: 0,
    },
    contextWith(create.broker),
  );

  assert.equal(createdResult.success, true);
  assert.equal(create.calls[0]?.action, 'task.create');
  assert.equal(create.calls[0]?.includeStatus, true);
  assert.deepEqual(create.calls[0]?.params, {
    title: 'Ship it',
    description: 'With tests',
    priority: 'P2',
    assignee: 'imp-1',
  });

  const update = brokerReturning(() => ({ status: 200, body: { id: 'cf-1' } }));
  const updated = await new BeadsTaskSink().handle(
    { id: '5', type: 'beads:task:update', payload: { id: 'cf-1', title: 'Ship it', description: 'Fixed' }, timestamp: 0 },
    contextWith(update.broker),
  );

  assert.equal(updated.success, true);
  assert.equal(update.calls[0]?.action, 'task.update');
  // `task.update`'s route is /tasks/{taskId}, so the id travels as that path parameter.
  assert.equal(update.calls[0]?.params?.taskId, 'cf-1');

  const rejecting = brokerReturning(() => ({ status: 404, body: { error: 'unsupported action' } }));
  const rejected = await new BeadsTaskSink().handle(
    { id: '6', type: 'beads:task:create', payload: { title: 'Ship it', description: 'With tests' }, timestamp: 0 },
    contextWith(rejecting.broker),
  );

  assert.equal(rejected.success, false);
  assert.match(rejected.error ?? '', /beads task\.create answered 404/);
});

test('assertUpstreamAccepted: only 200–399 is accepted, and no status is a failure', () => {
  assert.deepEqual(assertUpstreamAccepted({ status: 201, body: null }, 'pr.review'), { status: 201 });
  assert.deepEqual(assertUpstreamAccepted({ status: 302, body: null }, 'pr.review'), { status: 302 });
  assert.deepEqual(assertUpstreamAccepted({ status: 399, body: null }, 'pr.review'), { status: 399 });
  assert.throws(
    () => assertUpstreamAccepted({ status: 404, body: { error: 'unsupported action' } }, 'pr.review'),
    /pr\.review answered 404/,
  );
  assert.throws(() => assertUpstreamAccepted(undefined, 'issue.create'), /issue\.create answered no status/);
  // The worker path coerces a status-less broker answer to 0 (pipeline.ts), and a 1xx is
  // not an outcome any GitHub or Beads action returns: neither may look accepted
  // (cloud-factory-cf-g9aw follow-up).
  assert.throws(() => assertUpstreamAccepted({ status: 0, body: { ok: true } }, 'pr.review'), /answered 0/);
  assert.throws(() => assertUpstreamAccepted({ status: 101, body: null }, 'pr.review'), /answered 101/);
  assert.throws(() => assertUpstreamAccepted({ status: 199, body: null }, 'task.create'), /answered 199/);
});

test('a rejected default sink does not report success through the sink registry', async () => {
  // The end-to-end shape the review described: the sink's own `success` flag is what a
  // caller sees, so a 404 has to arrive as a failed action, not a silent pass.
  const { broker } = brokerReturning(() => ({ status: 403, body: { error: 'action not permitted' } }));
  const registry = new ActionSinkRegistry();
  registry.registerSink(new GitHubPRReviewSink());

  const results = await registry.emit(
    { type: 'github:pr:review', payload: { prNumber: 7, event: 'APPROVE', body: 'LGTM' } },
    contextWith(broker),
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]?.success, false);
  assert.match(results[0]?.error ?? '', /answered 403/);
});

test('default sinks refuse payload fields the broker action cannot carry instead of dropping them (cloud-factory-cf-v1y0)', async () => {
  const { broker, calls } = brokerReturning(() => ({ status: 201, body: {} }));

  const issueWithLabels = await new GitHubIssueSink().handle(
    {
      id: 'v1',
      type: 'github:issue:create',
      payload: { title: 'Bug', body: 'It broke', labels: ['bug'] },
      timestamp: 0,
    },
    contextWith(broker),
  );
  assert.equal(issueWithLabels.success, false);
  assert.match(issueWithLabels.error ?? '', /labels are not forwarded by the broker's issue\.create action/);

  const taskWithParent = await new BeadsTaskSink().handle(
    { id: 'v2', type: 'beads:task:create', payload: { title: 'T', description: 'D', parentId: 'cf-1' }, timestamp: 0 },
    contextWith(broker),
  );
  assert.equal(taskWithParent.success, false);
  assert.match(taskWithParent.error ?? '', /parentId are not forwarded/);

  const reviewWithComments = await new GitHubPRReviewSink().handle(
    {
      id: 'v3',
      type: 'github:pr:review',
      payload: { prNumber: 4, event: 'COMMENT', body: 'x', comments: [{ path: 'a.ts', line: 1, body: 'nit' }] },
      timestamp: 0,
    },
    contextWith(broker),
  );
  assert.equal(reviewWithComments.success, false);
  assert.match(reviewWithComments.error ?? '', /inline comments are not forwarded/);

  // Nothing was dispatched for any of them: a refused payload must not reach the provider.
  assert.equal(calls.length, 0);

  // A custom executor receives the whole payload, so it can carry what the broker cannot.
  let seen: Record<string, unknown> | undefined;
  const custom = new GitHubIssueSink({
    executor: async (payload) => {
      seen = payload as unknown as Record<string, unknown>;
      return { ok: true };
    },
  });
  const customResult = await custom.handle(
    { id: 'v4', type: 'github:issue:create', payload: { title: 'Bug', body: 'x', labels: ['bug'] }, timestamp: 0 },
    contextWith(broker),
  );
  assert.equal(customResult.success, true);
  assert.deepEqual(seen?.labels, ['bug']);
});

test('GitHubPRReviewSink forwards commitSha as the policy\'s commit_id', async () => {
  const { broker, calls } = brokerReturning(() => ({ status: 201, body: {} }));
  const result = await new GitHubPRReviewSink().handle(
    {
      id: 'c1',
      type: 'github:pr:review',
      payload: { prNumber: 9, event: 'APPROVE', body: 'LGTM', commitSha: 'abc123' },
      timestamp: 0,
    },
    contextWith(broker),
  );
  assert.equal(result.success, true);
  assert.equal(calls[0]?.params?.commit_id, 'abc123');
});
