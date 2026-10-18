import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRuntime,
  createAgentContext,
  type FactoryEvent,
  type BeforeRunEvent,
  type AfterRunEvent,
} from '../src/index.ts';

test('LifecycleEngine: on("event") registers, handles events, and unsubscribes', async () => {
  const runtime = new AgentRuntime();
  const ctx = createAgentContext({
    repo: { owner: 'PaulKinlan', name: 'cloud-factory-cf' },
    org: { id: 'org-test' },
  });

  const received: string[] = [];
  const unsubscribe = runtime.on('event', async (event) => {
    received.push(event.type);
  });

  await runtime.emitEvent(
    {
      type: 'webhook.push',
      payload: { ref: 'refs/heads/main' },
      timestamp: Date.now(),
    },
    ctx
  );

  assert.equal(received.length, 1);
  assert.equal(received[0], 'webhook.push');

  unsubscribe();

  await runtime.emitEvent(
    {
      type: 'webhook.pull_request',
      payload: { action: 'opened' },
      timestamp: Date.now(),
    },
    ctx
  );

  assert.equal(received.length, 1); // Unsubscribed, should not receive second event
});

test('LifecycleEngine: on("before_run") transforms prompt and tools sequentially', async () => {
  const runtime = new AgentRuntime();
  const ctx = createAgentContext({
    repo: { owner: 'PaulKinlan', name: 'cloud-factory-cf' },
    org: { id: 'org-test' },
  });

  // First hook adds context to prompt
  runtime.on('before_run', (event: BeforeRunEvent) => {
    return {
      prompt: `${event.prompt} [augmented-1]`,
      systemPrompt: 'System rule 1.',
      tools: ['tool-a', 'tool-b'],
    };
  });

  // Second hook filters tools and further decorates prompt
  runtime.on('before_run', (event: BeforeRunEvent) => {
    return {
      prompt: `${event.prompt} [augmented-2]`,
      systemPrompt: `${event.systemPrompt} System rule 2.`,
      tools: event.tools.filter((t) => t !== 'tool-b'),
    };
  });

  const summary = await runtime.runAgent(
    'Initial user prompt',
    ctx,
    async (input) => {
      assert.equal(input.prompt, 'Initial user prompt [augmented-1] [augmented-2]');
      assert.equal(input.systemPrompt, 'System rule 1. System rule 2.');
      assert.deepEqual(input.tools, ['tool-a']);
      return {
        status: 'success',
        output: 'Agent executed successfully',
        toolCallsCount: 1,
      };
    }
  );

  assert.equal(summary.status, 'success');
  assert.equal(summary.finalPrompt, 'Initial user prompt [augmented-1] [augmented-2]');
  assert.equal(summary.output, 'Agent executed successfully');
});

test('LifecycleEngine: on("before_run") can cancel execution early', async () => {
  const runtime = new AgentRuntime();
  const ctx = createAgentContext({
    repo: { owner: 'PaulKinlan', name: 'cloud-factory-cf' },
    org: { id: 'org-test' },
  });

  runtime.on('before_run', () => {
    return {
      cancel: true,
      cancelReason: 'Rate limit guard triggered',
    };
  });

  let executed = false;
  const summary = await runtime.runAgent(
    'Halted prompt',
    ctx,
    async () => {
      executed = true;
      return { status: 'success', toolCallsCount: 0 };
    }
  );

  assert.equal(executed, false);
  assert.equal(summary.status, 'cancelled');
  assert.equal(summary.error, 'Rate limit guard triggered');
});

test('LifecycleEngine: on("after_run") evaluates results and can request continuation', async () => {
  const runtime = new AgentRuntime();
  const ctx = createAgentContext({
    repo: { owner: 'PaulKinlan', name: 'cloud-factory-cf' },
    org: { id: 'org-test' },
  });

  let inspectedOutput: string | undefined;

  runtime.on('after_run', (event: AfterRunEvent) => {
    inspectedOutput = event.output;
    if (event.output?.includes('NEEDS_FOLLOW_UP')) {
      return {
        continue: true,
        nextPrompt: 'Proceed with step 2 follow-up',
      };
    }
  });

  const summary = await runtime.runAgent(
    'Do step 1',
    ctx,
    async () => {
      return {
        status: 'success',
        output: 'Step 1 complete; status: NEEDS_FOLLOW_UP',
        toolCallsCount: 2,
      };
    }
  );

  assert.equal(summary.status, 'success');
  assert.equal(inspectedOutput, 'Step 1 complete; status: NEEDS_FOLLOW_UP');
  assert.equal(summary.continuation?.requested, true);
  assert.equal(summary.continuation?.nextPrompt, 'Proceed with step 2 follow-up');
});
