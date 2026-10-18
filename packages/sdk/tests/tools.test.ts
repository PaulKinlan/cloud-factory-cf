import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRuntime,
  ToolRegistry,
  createAgentContext,
  type ToolDefinition,
} from '../src/index.ts';

test('ToolRegistry: registers tools and validates parameters', async () => {
  const registry = new ToolRegistry();
  const ctx = createAgentContext({
    repo: { owner: 'PaulKinlan', name: 'cloud-factory-cf' },
    org: { id: 'test-org' },
  });

  const toolDef: ToolDefinition<{ path: string; count?: number }, { lines: number }> = {
    name: 'read_lines',
    description: 'Read line count from a mock path',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        count: { type: 'number', description: 'Optional line limit' },
      },
      required: ['path'],
    },
    handler: async (params, _toolCtx) => {
      return { lines: params.count ?? 42 };
    },
  };

  registry.registerTool(toolDef);
  assert.equal(registry.hasTool('read_lines'), true);
  assert.equal(registry.getToolDefinitions().length, 1);

  // Missing required param
  const failure = await registry.executeTool('read_lines', {}, ctx);
  assert.equal(failure.success, false);
  assert.match(failure.error ?? '', /Missing required parameter "path"/);

  // Valid params
  const success = await registry.executeTool('read_lines', { path: 'src/main.ts', count: 100 }, ctx);
  assert.equal(success.success, true);
  assert.deepEqual(success.result, { lines: 100 });
  assert.ok(success.durationMs >= 0);

  // Type mismatch validation
  const typeMismatch = await registry.executeTool(
    'read_lines',
    { path: 'src/main.ts', count: 'not-a-number' as unknown as number },
    ctx
  );
  assert.equal(typeMismatch.success, false);
  assert.match(typeMismatch.error ?? '', /Invalid type for parameter "count".*expected number, got string/);
});

test('ToolRegistry: handles handler exceptions gracefully', async () => {
  const registry = new ToolRegistry();
  const ctx = createAgentContext({
    repo: { owner: 'PaulKinlan', name: 'cloud-factory-cf' },
    org: { id: 'test-org' },
  });

  registry.registerTool({
    name: 'failing_tool',
    description: 'Always fails',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      throw new Error('Database connection failed');
    },
  });

  const result = await registry.executeTool('failing_tool', {}, ctx);
  assert.equal(result.success, false);
  assert.equal(result.error, 'Database connection failed');
});

test('ToolRegistry: rejects execution when context signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort('Timeout reached');

  const ctx = createAgentContext({
    repo: { owner: 'PaulKinlan', name: 'cloud-factory-cf' },
    org: { id: 'test-org' },
    signal: controller.signal,
  });

  const registry = new ToolRegistry();
  registry.registerTool({
    name: 'test_tool',
    description: 'Should not run when aborted',
    parameters: { type: 'object', properties: {} },
    handler: async () => 'done',
  });

  const res = await registry.executeTool('test_tool', {}, ctx);
  assert.equal(res.success, false);
  assert.match(res.error ?? '', /aborted/i);
});

test('AgentRuntime: registerTool via ExtensionAPI and invokeTool', async () => {
  const runtime = new AgentRuntime();
  const ctx = createAgentContext({
    repo: { owner: 'PaulKinlan', name: 'cloud-factory-cf' },
    org: { id: 'test-org' },
  });

  // Load extension that registers a tool
  await runtime.loadExtension((pi) => {
    pi.registerTool({
      name: 'calculate_sum',
      description: 'Add two numbers',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      },
      handler: (params: { a: number; b: number }) => {
        return params.a + params.b;
      },
    });
  });

  const execRes = await runtime.invokeTool('calculate_sum', { a: 15, b: 27 }, ctx);
  assert.equal(execRes.success, true);
  assert.equal(execRes.result, 42);
});
