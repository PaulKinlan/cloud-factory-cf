import {
  createAgentContext,
  AgentRuntime,
  ToolRegistry,
  ActionSinkRegistry,
  LifecycleEngine,
  InMemoryHierarchicalMemoryStore,
  DefaultCredentialBroker,
  type AgentContext,
  type AgentExecutionFn,
  type AgentRunSummary,
  type Extension,
  type ToolDefinition,
  type ActionSink,
  type CredentialBroker,
  type HierarchicalMemoryStore,
} from '@factory-cloud/sdk';
import { createLocalTools, type LocalToolsOptions } from '../tools/local-tools.ts';

export interface LocalAgentRunnerOptions {
  cwd?: string;
  repo?: { owner: string; name: string; defaultBranch?: string };
  org?: { id: string; name?: string };
  actor?: { type: 'lane' | 'user' | 'system'; id: string };
  env?: Record<string, unknown>;
  credentials?: CredentialBroker;
  memory?: HierarchicalMemoryStore;
  sinks?: readonly ActionSink[];
  extensions?: readonly Extension[];
  tools?: readonly ToolDefinition[];
  localToolsOptions?: LocalToolsOptions;
}

export class LocalAgentRunner {
  readonly cwd: string;
  private readonly repo: { owner: string; name: string; defaultBranch?: string };
  private readonly org: { id: string; name?: string };
  private readonly actor: { type: 'lane' | 'user' | 'system'; id: string };
  private readonly env: Record<string, unknown>;
  private readonly credentials: CredentialBroker;
  private readonly memory: HierarchicalMemoryStore;
  private readonly sinks: readonly ActionSink[];
  private readonly extensions: readonly Extension[];
  private readonly additionalTools: readonly ToolDefinition[];
  private readonly localToolsOptions?: LocalToolsOptions;

  constructor(options: LocalAgentRunnerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.repo = options.repo ?? { owner: 'local', name: 'local-repo', defaultBranch: 'main' };
    this.org = options.org ?? { id: 'local-org' };
    this.actor = options.actor ?? { type: 'system', id: 'local-runner' };
    this.env = options.env ?? { ...process.env };
    this.credentials = options.credentials ?? new DefaultCredentialBroker(['*'], async (req) => {
      // Local development fallback capability executor
      return { executedLocally: true, service: req.service, action: req.action, params: req.params };
    });
    this.memory = options.memory ?? new InMemoryHierarchicalMemoryStore();
    this.sinks = options.sinks ?? [];
    this.extensions = options.extensions ?? [];
    this.additionalTools = options.tools ?? [];
    this.localToolsOptions = options.localToolsOptions;
  }

  async run(
    prompt: string,
    execute?: AgentExecutionFn,
    contextOverrides: Partial<Parameters<typeof createAgentContext>[0]> = {},
  ): Promise<AgentRunSummary> {
    const runtime = new AgentRuntime();

    // Register local filesystem / process tools
    const localTools = createLocalTools({ cwd: this.cwd, ...this.localToolsOptions });
    for (const tool of localTools) {
      runtime.registerTool(tool);
    }
    for (const tool of this.additionalTools) {
      runtime.registerTool(tool);
    }

    // Register sinks
    for (const sink of this.sinks) {
      runtime.registerSink(sink);
    }

    // Load extensions
    for (const ext of this.extensions) {
      await runtime.loadExtension(ext);
    }

    // Create AgentContext
    const ctx: AgentContext = createAgentContext({
      repo: this.repo,
      org: this.org,
      actor: this.actor,
      env: this.env,
      credentials: this.credentials,
      memory: this.memory,
      sinks: runtime.sinks,
      ...contextOverrides,
    });

    // Default executor if none supplied
    const execFn: AgentExecutionFn =
      execute ??
      (async (input) => {
        input.ctx.log('info', `Local runner executing prompt: ${input.prompt.slice(0, 100)}...`);
        return {
          status: 'success',
          output: `Executed locally in ${this.cwd} with prompt: ${input.prompt}`,
          toolCallsCount: 0,
          metadata: { local: true, toolsCount: input.tools.length },
        };
      });

    return runtime.runAgent(prompt, ctx, execFn);
  }
}
