import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentContext,
  InMemoryHierarchicalMemoryStore,
  DefaultCredentialBroker,
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

test('CredentialBroker: enforces capability permissions and proxies requests', async () => {
  const broker = new DefaultCredentialBroker(['github:pull_request', 'beads:*']);

  assert.equal(await broker.hasPermission('github', 'pull_request'), true);
  assert.equal(await broker.hasPermission('beads', 'create_task'), true);
  assert.equal(await broker.hasPermission('aws', 's3_upload'), false);

  // Permitted signed request succeeds without raw secret
  const signedResult = await broker.executeSignedRequest<{ status: string }>({
    service: 'github',
    action: 'pull_request',
    params: { pr: 12 },
  });
  assert.equal(signedResult.status, 'brokered');

  // Denied request throws error
  await assert.rejects(
    async () => {
      await broker.executeSignedRequest({
        service: 'aws',
        action: 's3_upload',
      });
    },
    /permission denied for capability "aws:s3_upload"/
  );
});

test('AgentContext: createChildContext inherits parents and overrides correctly', async () => {
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
});
