/**
 * AgentStudio: Prompt-to-Agent authoring, simulation, and installation engine.
 */

import { PromptToAgentCompiler } from './prompt-compiler.ts';
import type {
  AgentManifest,
  StudioContext,
  SimulationRequest,
  SimulationResult,
  SimulationContext,
  SimulatedToolCall,
  SimulatedMemoryMutation,
  SimulatedPermissionCheck,
  AgentSynthesisFn,
} from '../types/studio.ts';
import type { Extension, ExtensionAPI } from '../types/extension.ts';
import type {
  AgentContext,
  CredentialBroker,
  HierarchicalMemoryStore,
  MemoryScope,
  MemoryEntry,
  LogEntry,
  CredentialCapabilityRequest,
} from '../types/context.ts';
import type { SinkAction, ActionSink, ActionSinkDispatcher } from '../types/sinks.ts';
import type { ToolDefinition } from '../types/tools.ts';
import { AgentRuntime } from '../runtime/agent-runtime.ts';
import { createAgentContext, InMemoryHierarchicalMemoryStore } from '../context/agent-context.ts';
import { ActionSinkRegistry } from '../sinks/sink-registry.ts';
import { generateId } from '../utils/id.ts';

export class AgentStudio {
  private compiler = new PromptToAgentCompiler();

  /**
   * Authors an AgentManifest from a natural language prompt grounded in context.
   */
  async author(
    prompt: string,
    context: StudioContext = {},
    synthesisFn?: AgentSynthesisFn
  ): Promise<AgentManifest> {
    return this.compiler.compile(prompt, context, synthesisFn);
  }

  /**
   * Compiles an AgentManifest into an executable Extension compatible with AgentRuntime.
   */
  compileToExtension(
    manifest: AgentManifest,
    options: {
      customExecutor?: (ctx: AgentContext, event: unknown) => Promise<unknown>;
    } = {}
  ): Extension {
    return (api: ExtensionAPI) => {
      // Listen to triggers
      for (const trigger of manifest.triggers) {
        api.on(trigger.event === 'event' ? 'event' : trigger.event, async (eventPayload, ctx) => {
          ctx.log('info', `Agent ${manifest.name} triggered by event: ${trigger.event}`);
          if (options.customExecutor) {
            await options.customExecutor(ctx, eventPayload);
          }
        });
      }

      // Configure before_run hook
      if (manifest.lifecycleHooks?.beforeRun) {
        api.on('before_run', async (_event, ctx) => {
          ctx.log('info', `Agent ${manifest.name} executing before_run hook`);
          return {
            systemPrompt: manifest.prompt,
          };
        });
      }

      // Configure after_run hook
      if (manifest.lifecycleHooks?.afterRun) {
        api.on('after_run', async (_result, ctx) => {
          ctx.log('info', `Agent ${manifest.name} after_run evaluation completed`);
          return {
            continue: false,
          };
        });
      }
    };
  }

  /**
   * Simulates an agent execution in an isolated test harness, capturing an execution trace.
   */
  async simulate(
    request: SimulationRequest,
    options: {
      tools?: readonly ToolDefinition[];
      sinks?: readonly ActionSink[];
      memoryStore?: HierarchicalMemoryStore;
      agentExecutor?: (simCtx: SimulationContext, event: unknown) => Promise<unknown>;
    } = {}
  ): Promise<SimulationResult> {
    const startTime = Date.now();
    const runId = generateId();
    const logs: LogEntry[] = [];
    const toolCalls: SimulatedToolCall[] = [];
    const sinkActions: SinkAction[] = [];
    const memoryMutations: SimulatedMemoryMutation[] = [];
    const permissionChecks: SimulatedPermissionCheck[] = [];

    // 1. Build sandboxed memory tracking
    const innerMemory = options.memoryStore ?? new InMemoryHierarchicalMemoryStore();
    const trackedMemory = new TrackedMemoryStore(innerMemory, (mutation) => {
      memoryMutations.push(mutation);
    });

    // 2. Build mock CredentialBroker to track permission checks and signed requests
    const allowedCaps = new Set(
      request.manifest.capabilities.map((c) => `${c.service}:${c.action}`)
    );

    const credentialBroker: CredentialBroker = {
      async hasPermission(service: string, action: string): Promise<boolean> {
        const allowed = allowedCaps.has(`${service}:${action}`);
        permissionChecks.push({ service, action, allowed });
        return allowed;
      },
      async executeSignedRequest<T = unknown>(req: CredentialCapabilityRequest): Promise<T> {
        const key = `${req.service}:${req.action}`;
        const allowed = allowedCaps.has(key);
        permissionChecks.push({ service: req.service, action: req.action, allowed });
        if (!allowed) {
          throw new Error(`Capability denied by policy: ${key}`);
        }
        return {
          ok: true,
          simulated: true,
          service: req.service,
          action: req.action,
        } as T;
      },
    };

    // 3. Build simulated ActionSink capturing emitted actions
    const simulatedSink: ActionSink = {
      name: 'studio-simulated-sink',
      supportedActions: ['*'],
      canHandle: (_action) => true,
      handle: async (action, ctx) => {
        ctx.log('info', `Simulated sink handled action: ${action.type}`, {
          target: action.target,
        });
        return {
          sinkName: 'studio-simulated-sink',
          actionId: action.id ?? 'sim',
          actionType: action.type,
          success: true,
          durationMs: 0,
        };
      },
    };

    // 4. Build simulated tools with call tracking
    const runtime = new AgentRuntime();
    const sinkRegistry = new ActionSinkRegistry();
    sinkRegistry.registerSink(simulatedSink);
    if (options.sinks) {
      for (const s of options.sinks) {
        sinkRegistry.registerSink(s);
        runtime.registerSink(s);
      }
    }

    const providedTools = options.tools ?? [];
    for (const tool of providedTools) {
      if (request.manifest.tools.includes(tool.name)) {
        runtime.registerTool({
          ...tool,
          handler: async (params, ctx) => {
            const toolStart = Date.now();
            let result: unknown;
            if (request.mockToolResponses?.[tool.name] !== undefined) {
              result = request.mockToolResponses[tool.name];
            } else {
              result = await tool.handler(params, ctx);
            }
            toolCalls.push({
              tool: tool.name,
              params,
              result,
              durationMs: Date.now() - toolStart,
            });
            return result;
          },
        });
      }
    }

    // 5. Load compiled extension
    const extension = this.compileToExtension(request.manifest);
    runtime.loadExtension(extension);

    // 6. Execute in AgentContext
    const sinkDispatcher: ActionSinkDispatcher = {
      registerSink: (sink) => sinkRegistry.registerSink(sink),
      unregisterSink: (name) => sinkRegistry.unregisterSink(name),
      getSinks: () => sinkRegistry.getSinks(),
      emit: async (action, sinkCtx) => {
        const fullAction: SinkAction = {
          id: action.id ?? generateId(),
          timestamp: action.timestamp ?? Date.now(),
          type: action.type,
          target: action.target,
          payload: action.payload,
          metadata: action.metadata,
        };
        sinkActions.push(fullAction);
        sinkCtx?.log('info', `Simulated sink received action: ${action.type}`, {
          target: action.target,
        });
        return sinkRegistry.emit(action, sinkCtx);
      },
    };

    const ctx = createAgentContext({
      id: runId,
      repo: {
        owner: (request.manifest.metadata?.owner as string) || 'test-owner',
        name: (request.manifest.metadata?.repo as string) || 'test-repo',
      },
      org: {
        id: (request.manifest.metadata?.org as string) || 'test-org',
      },
      memory: trackedMemory,
      credentials: credentialBroker,
      sinks: sinkDispatcher,
      logs,
    });

    const simCtx: SimulationContext = {
      ctx,
      invokeTool: async (name: string, params: Record<string, unknown>) => {
        return runtime.invokeTool(name, params, ctx);
      },
    };

    try {
      const initialPrompt = request.promptInput || request.manifest.prompt;
      const runSummary = await runtime.runAgent(
        initialPrompt,
        ctx,
        async (_input) => {
          let agentOutput: unknown;
          try {
            if (options.agentExecutor) {
              agentOutput = await options.agentExecutor(simCtx, request.event);
            } else {
              agentOutput = {
                executed: true,
                agent: request.manifest.name,
              };
            }
          } catch (execErr) {
            console.error('AGENT EXECUTOR THREW:', execErr);
            throw execErr;
          }
          return {
            status: 'success',
            output: typeof agentOutput === 'string' ? agentOutput : JSON.stringify(agentOutput),
            toolCallsCount: toolCalls.length,
          };
        },
        {
          runId,
          systemPrompt: request.manifest.prompt,
          tools: request.manifest.tools,
          metadata: request.manifest.metadata,
        }
      );

      return {
        runId,
        status: runSummary.status === 'success' ? 'completed' : runSummary.status === 'cancelled' ? 'denied' : 'failed',
        logs,
        toolCalls,
        sinkActions,
        memoryMutations,
        permissionChecks,
        output: runSummary.output,
        durationMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logs.push({
        timestamp: Date.now(),
        level: 'error',
        message: `Simulation failed: ${errorMessage}`,
      });
      return {
        runId,
        status: errorMessage.includes('denied') ? 'denied' : 'failed',
        logs,
        toolCalls,
        sinkActions,
        memoryMutations,
        permissionChecks,
        error: errorMessage,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Persists an AgentManifest into central memory storage under agents:<name>.
   */
  async install(manifest: AgentManifest, storage: HierarchicalMemoryStore): Promise<void> {
    const scope = manifest.memoryScope === 'org' ? 'org' : 'repo';
    await storage.set(scope, `agents:${manifest.name}`, manifest);
  }

  /**
   * Loads an installed AgentManifest from central memory storage.
   */
  async load(name: string, storage: HierarchicalMemoryStore): Promise<AgentManifest | null> {
    const inRepo = await storage.get('repo', `agents:${name}`);
    if (inRepo) return inRepo as AgentManifest;
    const inOrg = await storage.get('org', `agents:${name}`);
    return (inOrg as AgentManifest) ?? null;
  }

  /**
   * Lists all installed AgentManifests from central memory storage.
   */
  async list(
    storage: HierarchicalMemoryStore,
    scope: 'repo' | 'org' | 'both' = 'both'
  ): Promise<AgentManifest[]> {
    const manifests: AgentManifest[] = [];
    const seen = new Set<string>();

    const checkScope = async (s: 'repo' | 'org') => {
      const items = (await storage.list(s, 'agents:')) as (MemoryEntry | string)[];
      for (const item of items) {
        const key = typeof item === 'string' ? item : item.key;
        if (!seen.has(key)) {
          seen.add(key);
          const rawVal =
            typeof item === 'object' && item !== null && 'value' in item
              ? (item as MemoryEntry).value
              : undefined;
          if (rawVal) {
            manifests.push(rawVal as AgentManifest);
          } else {
            const val = await storage.get(s, key);
            if (val) {
              manifests.push(val as AgentManifest);
            }
          }
        }
      }
    };

    if (scope === 'repo' || scope === 'both') {
      await checkScope('repo');
    }
    if (scope === 'org' || scope === 'both') {
      await checkScope('org');
    }

    return manifests;
  }
}

class TrackedMemoryStore implements HierarchicalMemoryStore {
  private inner: HierarchicalMemoryStore;
  private onMutation: (m: SimulatedMemoryMutation) => void;

  constructor(
    inner: HierarchicalMemoryStore,
    onMutation: (m: SimulatedMemoryMutation) => void
  ) {
    this.inner = inner;
    this.onMutation = onMutation;
  }

  async get(scope: MemoryScope, key: string): Promise<unknown | undefined> {
    return this.inner.get(scope, key);
  }

  async set(
    scope: MemoryScope,
    key: string,
    value: unknown,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    this.onMutation({ scope, key, operation: 'set', value });
    return this.inner.set(scope, key, value, metadata);
  }

  async delete(scope: MemoryScope, key: string): Promise<boolean> {
    this.onMutation({ scope, key, operation: 'delete' });
    return this.inner.delete(scope, key);
  }

  async list(scope: MemoryScope, prefix?: string): Promise<MemoryEntry[]> {
    return this.inner.list(scope, prefix);
  }
}
