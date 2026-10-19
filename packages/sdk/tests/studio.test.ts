import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentStudio,
  PromptToAgentCompiler,
  type StudioContext,
  type ToolDefinition,
  type AgentManifest,
} from '../src/index.ts';

test('PromptToAgentCompiler: compiles natural language prompt into AgentManifest', async () => {
  const compiler = new PromptToAgentCompiler();

  const context: StudioContext = {
    availableTools: [
      {
        name: 'read_file',
        description: 'Read file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        handler: async () => 'content',
      },
      {
        name: 'exec_command',
        description: 'Run command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
        handler: async () => ({ stdout: 'ok' }),
      },
    ],
    availableSinks: ['github-pr-review', 'cloud-telemetry'],
    availablePermissions: [
      { service: 'github', action: 'pr.review' },
      { service: 'github', action: 'repo.read' },
    ],
  };

  const manifest = await compiler.compile(
    'Create an agent called pr-auditor that reviews PRs, reads repository files, runs tests, and posts a github pr review',
    context
  );

  assert.equal(manifest.name, 'pr-auditor');
  assert.equal(manifest.version, '0.1.0');
  assert.ok(manifest.triggers.some((t) => t.event.includes('pull_request')));
  assert.ok(manifest.tools.includes('read_file'));
  assert.ok(manifest.tools.includes('exec_command'));
  assert.ok(manifest.capabilities.some((c) => c.service === 'github' && c.action === 'pr.review'));
  assert.ok(manifest.sinks.some((s) => s.type === 'github-pr-review'));
});

test('PromptToAgentCompiler: fails closed on unauthorized capability requests', async () => {
  const compiler = new PromptToAgentCompiler();

  const context: StudioContext = {
    availablePermissions: [
      { service: 'github', action: 'repo.read' },
    ],
  };

  await assert.rejects(
    async () => {
      await compiler.compile(
        'Agent that will delete repository secrets and submit github pr reviews',
        context,
        async () => ({
          name: 'malicious-agent',
          capabilities: [{ service: 'github', action: 'admin.delete_all' }],
        })
      );
    },
    /Security violation: prompt requests unauthorized capabilities: github:admin\.delete_all/
  );
});

test('PromptToAgentCompiler: fails closed on unavailable tools', async () => {
  const compiler = new PromptToAgentCompiler();

  const context: StudioContext = {
    availableTools: [
      {
        name: 'read_file',
        description: 'Read file',
        parameters: { type: 'object', properties: {} },
        handler: async () => '',
      },
    ],
  };

  await assert.rejects(
    async () => {
      await compiler.compile(
        'Agent that runs raw system bash scripts',
        context,
        async () => ({
          name: 'unauthorized-tool-agent',
          tools: ['exec_command'],
        })
      );
    },
    /Agent manifest requests tools that are not available in current context: exec_command/
  );
});

test('PromptToAgentCompiler: fails closed when available context is empty or absent', async () => {
  const compiler = new PromptToAgentCompiler();

  // 1. Empty context rejects any requested tools
  await assert.rejects(
    async () => {
      await compiler.compile('do anything', {}, async () => ({
        name: 'test-agent',
        tools: ['exec_command'],
      }));
    },
    /Agent manifest requests tools \(exec_command\) but no tools are available in current context/
  );

  // 2. Empty context rejects any requested capabilities
  await assert.rejects(
    async () => {
      await compiler.compile('do anything', {}, async () => ({
        name: 'test-agent',
        capabilities: [{ service: 'github', action: 'admin.delete_all' }],
      }));
    },
    /Security violation: prompt requests unauthorized capabilities: github:admin.delete_all/
  );

  // 3. Empty context rejects any requested sinks
  await assert.rejects(
    async () => {
      await compiler.compile('do anything', {}, async () => ({
        name: 'test-agent',
        sinks: [{ type: 'custom-sink' }],
      }));
    },
    /Agent manifest requests sinks \(custom-sink\) but no sinks are registered in current context/
  );
});

test('AgentStudio: author, simulate, install, load, and list', async () => {
  const studio = new AgentStudio();

  const testTool: ToolDefinition = {
    name: 'read_file',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    handler: async (params) => {
      return `Content of ${params.path}`;
    },
  };

  const context: StudioContext = {
    availableTools: [testTool],
    availableSinks: ['github-pr-review'],
    availablePermissions: [{ service: 'github', action: 'pr.review' }],
  };

  // 1. Author agent
  const manifest = await studio.author(
    'Create an agent called pr-checker that reviews pull requests and reads code files',
    context
  );

  assert.equal(manifest.name, 'pr-checker');
  assert.ok(manifest.tools.includes('read_file'));

  // 2. Simulate agent execution
  const simulation = await studio.simulate(
    {
      manifest,
      event: {
        action: 'opened',
        pull_request: { number: 42, title: 'feat: add new feature' },
      },
      mockToolResponses: {
        read_file: 'Simulated file content for testing',
      },
    },
    {
      tools: [testTool],
      allowedCapabilities: manifest.capabilities,
      agentExecutor: async (simCtx, event) => {
        simCtx.ctx.log('info', 'Invoking tool inside simulation');
        const res = await simCtx.invokeTool('read_file', { path: 'src/main.ts' });
        await simCtx.ctx.sinks.emit({
          type: 'github-pr-review',
          target: 'PR#42',
          payload: { verdict: 'APPROVE', detail: res },
        });
        await simCtx.ctx.memory.set('repo', 'last_reviewed_pr', 42);
        return { success: true };
      },
    }
  );

  assert.equal(simulation.status, 'completed');
  assert.equal(simulation.toolCalls.length, 1);
  assert.equal(simulation.toolCalls[0].tool, 'read_file');
  assert.equal(simulation.toolCalls[0].result, 'Simulated file content for testing');
  assert.equal(simulation.sinkActions.length, 1);
  assert.equal(simulation.sinkActions[0].type, 'github-pr-review');
  assert.equal(simulation.memoryMutations.length, 1);
  assert.equal(simulation.memoryMutations[0].key, 'last_reviewed_pr');
  assert.ok(simulation.logs.some((l) => l.message.includes('Invoking tool inside simulation')));

  // 3. Test storage (install, load, list)
  const memoryStore = new (class {
    data = new Map<string, unknown>();
    async get<T>(_scope: 'org' | 'repo', key: string) {
      return (this.data.get(key) as T) ?? null;
    }
    async set<T>(_scope: 'org' | 'repo', key: string, value: T) {
      this.data.set(key, value);
    }
    async delete(_scope: 'org' | 'repo', key: string) {
      return this.data.delete(key);
    }
    async list(_scope: 'org' | 'repo', prefix?: string) {
      const keys = Array.from(this.data.keys());
      return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
    }
  })();

  await studio.install(manifest, memoryStore);
  const loaded = await studio.load('pr-checker', memoryStore);
  assert.ok(loaded);
  assert.equal(loaded.name, 'pr-checker');

  const allAgents = await studio.list(memoryStore);
  assert.equal(allAgents.length, 1);
  assert.equal(allAgents[0].name, 'pr-checker');

  // 4. Test simulation security denial against unauthorized capabilities (fixes cloud-factory-cf-pf5)
  const deniedSim = await studio.simulate({
    manifest: {
      name: 'over-privileged',
      version: '0.1.0',
      description: 'test',
      prompt: 'p',
      triggers: [{ event: 'push' }],
      tools: [],
      capabilities: [{ service: 'github', action: 'admin.delete_all' }],
      sinks: [],
      memoryScope: 'repo',
    },
  });
  assert.equal(deniedSim.status, 'denied');
  assert.ok(deniedSim.error?.includes('Capability check failed'));
  assert.equal(deniedSim.permissionChecks[0].allowed, false);

  // 5. Test simulation failure on unavailable tools (fixes cloud-factory-cf-2vp)
  const toolFailSim = await studio.simulate({
    manifest: {
      name: 'missing-tools',
      version: '0.1.0',
      description: 'test',
      prompt: 'p',
      triggers: [{ event: 'push' }],
      tools: ['non_existent_tool'],
      capabilities: [],
      sinks: [],
      memoryScope: 'repo',
    },
  });
  assert.equal(toolFailSim.status, 'failed');
  assert.ok(toolFailSim.error?.includes('Tool "non_existent_tool" requested by manifest is not available'));

  // 6. Test default simulation executor exercises tools and sinks without agentExecutor (fixes cloud-factory-cf-2vp)
  const autoSim = await studio.simulate(
    {
      manifest: {
        name: 'auto-exercised',
        version: '0.1.0',
        description: 'test',
        prompt: 'p',
        triggers: [{ event: 'push' }],
        tools: ['read_file'],
        capabilities: [{ service: 'github', action: 'pr.review' }],
        sinks: [{ type: 'github-pr-review' }],
        memoryScope: 'repo',
      },
      mockToolInputs: {
        read_file: { path: 'src/index.ts' },
      },
    },
    {
      tools: [testTool],
      allowedCapabilities: [{ service: 'github', action: 'pr.review' }],
    }
  );
  assert.equal(autoSim.status, 'completed');
  assert.equal(autoSim.toolCalls.length, 1);
  assert.equal(autoSim.toolCalls[0].tool, 'read_file');
  assert.equal(autoSim.sinkActions.length, 1);
  assert.equal(autoSim.sinkActions[0].type, 'github-pr-review');

  // 7. Test install with memoryScope: 'both' installs to both org and repo (fixes cloud-factory-cf-w8v)
  const bothMemory = new (class {
    repoData = new Map<string, unknown>();
    orgData = new Map<string, unknown>();
    async get<T>(scope: 'org' | 'repo', key: string) {
      return (scope === 'org' ? this.orgData.get(key) : this.repoData.get(key)) as T ?? null;
    }
    async set<T>(scope: 'org' | 'repo', key: string, value: T) {
      if (scope === 'org') this.orgData.set(key, value);
      else this.repoData.set(key, value);
    }
    async delete(scope: 'org' | 'repo', key: string) {
      return scope === 'org' ? this.orgData.delete(key) : this.repoData.delete(key);
    }
    async list(scope: 'org' | 'repo', prefix?: string) {
      const keys = Array.from((scope === 'org' ? this.orgData : this.repoData).keys());
      return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
    }
  })();

  const dualAgent: AgentManifest = {
    ...manifest,
    name: 'dual-agent',
    memoryScope: 'both',
  };
  await studio.install(dualAgent, bothMemory);
  const repoAgent = await studio.load('dual-agent', bothMemory, 'repo');
  const orgAgent = await studio.load('dual-agent', bothMemory, 'org');
  assert.ok(repoAgent);
  assert.ok(orgAgent);
  assert.equal(repoAgent.name, 'dual-agent');
  assert.equal(orgAgent.name, 'dual-agent');
});
