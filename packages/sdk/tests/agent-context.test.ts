import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentContext,
  InMemoryHierarchicalMemoryStore,
  DefaultCredentialBroker,
  AgentRuntime,
} from '../src/index.ts';

test('AgentContext: initializes with default hierarchical memory, credentials, and logging', async () => {
  const ctx = createAgentContext({
    repo: { owner: 'PaulKinlan', name: 'cloud-factory-cf', defaultBranch: 'main' },
    org: { id: 'org_fleet_1' },
    env: { FLEET_ENV: 'testing' },
  });

  assert.ok(ctx.id);
  assert.equal(ctx.sessionId, ctx.id);
  assert.equal(ctx.repo.owner, 'PaulKinlan');
  assert.equal(ctx.repo.name, 'cloud-factory-cf');
  assert.equal(ctx.org.id, 'org_fleet_1');
  assert.equal(ctx.env.FLEET_ENV, 'testing');
  assert.equal(ctx.signal.aborted, false);

  // Default credentials fail closed
  assert.equal(await ctx.credentials.hasPermission('github', 'delete_repo'), false);
  assert.equal(await ctx.credentials.hasPermission('aws', 's3_upload'), false);

  // Logging
  ctx.log('info', 'Test log message', { detail: 123 });
  ctx.log('warn', 'Warning notice');
  const logs = ctx.getLogs();
  assert.equal(logs.length, 2);
  assert.equal(logs[0]?.level, 'info');
  assert.equal(logs[0]?.message, 'Test log message');
  assert.equal(logs[1]?.level, 'warn');
});

test('HierarchicalMemoryStore: isolates org and repo memory scopes', async () => {
  const memory = new InMemoryHierarchicalMemoryStore();

  // Set org memory
  await memory.set('org', 'coding_standards', 'Clean TypeScript with no raw secrets');
  // Set repo memory
  await memory.set('repo', 'coding_standards', 'Cloudflare Workers & Durable Objects target');

  // Query each scope
  const orgVal = await memory.get('org', 'coding_standards');
  const repoVal = await memory.get('repo', 'coding_standards');

  assert.equal(orgVal, 'Clean TypeScript with no raw secrets');
  assert.equal(repoVal, 'Cloudflare Workers & Durable Objects target');

  // List keys
  const orgEntries = await memory.list('org');
  assert.equal(orgEntries.length, 1);
  assert.equal(orgEntries[0]?.key, 'coding_standards');

  // Delete from repo memory
  const deleted = await memory.delete('repo', 'coding_standards');
  assert.equal(deleted, true);
  assert.equal(await memory.get('repo', 'coding_standards'), undefined);
  assert.equal(await memory.get('org', 'coding_standards'), 'Clean TypeScript with no raw secrets');
});

test('CredentialBroker: fails closed by default and requires executor for signed requests', async () => {
  // Empty allowlist fails closed
  const emptyBroker = new DefaultCredentialBroker();
  assert.equal(await emptyBroker.hasPermission('aws', 's3_upload'), false);
  assert.equal(await emptyBroker.hasPermission('github', 'pull_request'), false);

  await assert.rejects(
    async () => {
      await emptyBroker.executeSignedRequest({ service: 'aws', action: 's3_upload' });
    },
    /permission denied for capability "aws:s3_upload"/
  );

  // Permitted without executor throws configuration error rather than returning fake success
  const brokerNoExecutor = new DefaultCredentialBroker(['github:pull_request']);
  assert.equal(await brokerNoExecutor.hasPermission('github', 'pull_request'), true);
  await assert.rejects(
    async () => {
      await brokerNoExecutor.executeSignedRequest({ service: 'github', action: 'pull_request' });
    },
    /no capability executor configured/
  );

  // Permitted with executor executes real handler
  const mockExecutor = async (req: { service: string; action: string }) => {
    return { ok: true, proxiedService: req.service };
  };
  const brokerWithExecutor = new DefaultCredentialBroker(['github:pull_request'], mockExecutor);
  const result = await brokerWithExecutor.executeSignedRequest<{ ok: boolean; proxiedService: string }>({
    service: 'github',
    action: 'pull_request',
  });
  assert.equal(result.ok, true);
  assert.equal(result.proxiedService, 'github');
});

test('AgentContext: createChildContext propagates logs to parent', async () => {
  const parent = createAgentContext({
    repo: { owner: 'PaulKinlan', name: 'cloud-factory-cf' },
    org: { id: 'org_root' },
    state: { parentState: 'inherited' },
  });

  const child = parent.createChildContext({
    id: 'child_run_123',
    state: { childState: 'active' },
  });

  assert.equal(child.id, 'child_run_123');
  assert.equal(child.sessionId, parent.sessionId);
  assert.equal(child.repo.name, 'cloud-factory-cf');
  assert.equal(child.state.parentState, 'inherited');
  assert.equal(child.state.childState, 'active');

  // Log in child should be visible in parent
  child.log('info', 'Logged from child context');
  const parentLogs = parent.getLogs();
  assert.equal(parentLogs.length, 1);
  assert.equal(parentLogs[0]?.message, 'Logged from child context');
});

test('AgentRuntime: multiple runAgent calls generate unique runIds', async () => {
  const runtime = new AgentRuntime();
  const ctx = createAgentContext({
    repo: { owner: 'PaulKinlan', name: 'cloud-factory-cf' },
    org: { id: 'org_root' },
  });

  const run1 = await runtime.runAgent('Prompt 1', ctx, async (input) => {
    return { status: 'success', output: `run1:${input.runId}`, toolCallsCount: 0 };
  });

  const run2 = await runtime.runAgent('Prompt 2', ctx, async (input) => {
    return { status: 'success', output: `run2:${input.runId}`, toolCallsCount: 0 };
  });

  assert.notEqual(run1.runId, ctx.id);
  assert.notEqual(run2.runId, ctx.id);
  assert.notEqual(run1.runId, run2.runId);
});
