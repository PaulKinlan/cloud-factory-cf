import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionSinkRegistry,
  MemoryActionSink,
  AgentRuntime,
  createAgentContext,
  type ActionSink,
  type GitHubPRReviewPayload,
  type BeadsTaskPayload,
  type TelemetryMetricPayload,
} from '../src/index.ts';

test('ActionSinkRegistry: registers, routes actions, and unregisters', async () => {
  const registry = new ActionSinkRegistry();
  const ctx = createAgentContext({
    repo: { owner: 'PaulKinlan', name: 'cloud-factory-cf' },
    org: { id: 'test-org' },
    sinks: registry,
  });

  const prSink = new MemoryActionSink('github-pr-sink', ['github.pr_review']);
  const beadsSink = new MemoryActionSink('beads-task-sink', ['beads.task']);
  const telemetrySink = new MemoryActionSink('telemetry-sink', ['telemetry.metric', 'telemetry.log']);

  const unregPr = registry.registerSink(prSink);
  registry.registerSink(beadsSink);
  registry.registerSink(telemetrySink);

  assert.equal(registry.getSinks().length, 3);

  // Dispatch PR review action
  const prPayload: GitHubPRReviewPayload = {
    prNumber: 42,
    event: 'APPROVE',
    body: 'LGTM! Great test coverage.',
  };
  const prResults = await registry.emit({ type: 'github.pr_review', payload: prPayload }, ctx);
  assert.equal(prResults.length, 1);
  assert.equal(prResults[0]?.sinkName, 'github-pr-sink');
  assert.equal(prResults[0]?.success, true);
  assert.equal(prSink.getEmittedActions().length, 1);
  assert.equal(beadsSink.getEmittedActions().length, 0);

  // Dispatch Beads task action
  const beadsPayload: BeadsTaskPayload = {
    title: 'Implement edge caching for Durable Object memory',
    description: 'Ensure memory queries are cached at the worker layer',
    priority: 'P1',
  };
  const beadsResults = await registry.emit({ type: 'beads.task', payload: beadsPayload }, ctx);
  assert.equal(beadsResults.length, 1);
  assert.equal(beadsResults[0]?.sinkName, 'beads-task-sink');
  assert.equal(beadsSink.getEmittedActions().length, 1);

  // Unregister PR sink
  unregPr();
  assert.equal(registry.getSinks().length, 2);

  const secondPrResults = await registry.emit({ type: 'github.pr_review', payload: prPayload }, ctx);
  assert.equal(secondPrResults.length, 0); // No registered sinks handle pr_review anymore
});

test('ActionSinkRegistry: isolates sink errors so sibling sinks still execute', async () => {
  const registry = new ActionSinkRegistry();
  const ctx = createAgentContext({
    repo: { owner: 'PaulKinlan', name: 'cloud-factory-cf' },
    org: { id: 'test-org' },
    sinks: registry,
  });

  const failingSink: ActionSink = {
    name: 'failing-webhook-sink',
    supportedActions: ['telemetry.metric'],
    handle: async () => {
      throw new Error('Remote webhook 503 Service Unavailable');
    },
  };

  const reliableSink = new MemoryActionSink('reliable-memory-sink', ['telemetry.metric']);

  registry.registerSink(failingSink);
  registry.registerSink(reliableSink);

  const metricPayload: TelemetryMetricPayload = {
    metric: 'agent.run.duration_ms',
    value: 1240,
    tags: { env: 'production' },
  };

  const results = await registry.emit({ type: 'telemetry.metric', payload: metricPayload }, ctx);
  assert.equal(results.length, 2);

  const failRes = results.find((r) => r.sinkName === 'failing-webhook-sink');
  const okRes = results.find((r) => r.sinkName === 'reliable-memory-sink');

  assert.equal(failRes?.success, false);
  assert.match(failRes?.error ?? '', /503 Service Unavailable/);
  assert.equal(okRes?.success, true);
  assert.equal(reliableSink.getEmittedActions().length, 1);
});

test('AgentRuntime: loadExtension with registerSink and dispatch via after_run hook', async () => {
  const runtime = new AgentRuntime();
  const memorySink = new MemoryActionSink('audit-sink', ['*']);

  // Extension that registers a sink and an after_run hook emitting to it
  await runtime.loadExtension((pi) => {
    pi.registerSink(memorySink);

    pi.on('after_run', async (event, ctx) => {
      await ctx.sinks.emit(
        {
          type: 'audit.run_completed',
          payload: {
            runId: event.runId,
            status: event.status,
            toolCalls: event.toolCallsCount,
          },
        },
        ctx
      );
    });
  });

  const ctx = createAgentContext({
    repo: { owner: 'PaulKinlan', name: 'cloud-factory-cf' },
    org: { id: 'test-org' },
    sinks: runtime.sinks,
  });

  await runtime.runAgent('Run audit test', ctx, async () => {
    return {
      status: 'success',
      output: 'All tests verified',
      toolCallsCount: 3,
    };
  });

  assert.equal(memorySink.getEmittedActions().length, 1);
  const emitted = memorySink.getEmittedActions()[0];
  assert.equal(emitted?.type, 'audit.run_completed');
  assert.equal((emitted?.payload as { status: string }).status, 'success');
});
