/**
 * AgentStudio: Prompt-to-Agent authoring, simulation, and installation engine.
 */

import { PromptToAgentCompiler } from './prompt-compiler.ts';
import {
  STANDARD_SINK_TYPES,
  type AgentManifest,
  type AgentCapabilityRequest,
  type StudioContext,
  type SimulationRequest,
  type SimulationResult,
  type SimulationContext,
  type SimulatedToolCall,
  type SimulatedMemoryMutation,
  type SimulatedPermissionCheck,
  type AgentSynthesisFn,
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
      const triggers = Array.isArray(manifest.triggers) ? manifest.triggers : [];
      for (const trigger of triggers) {
        if (trigger && typeof trigger.event === 'string') {
          api.on(trigger.event, async (eventPayload, ctx) => {
            ctx.log('info', `Agent ${manifest.name} triggered by event: ${trigger.event}`);
            if (options.customExecutor) {
              await options.customExecutor(ctx, eventPayload);
            }
          });
        }
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
      credentialBroker?: CredentialBroker;
      allowedCapabilities?: readonly AgentCapabilityRequest[];
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

    if (
      !request ||
      typeof request !== 'object' ||
      !request.manifest ||
      typeof request.manifest !== 'object'
    ) {
      return {
        runId,
        status: 'failed',
        logs,
        toolCalls,
        sinkActions,
        memoryMutations,
        permissionChecks,
        error: 'Invalid request: manifest must be a non-null object',
        durationMs: 0,
      };
    }
    const manifestName = request.manifest.name;
    if (!manifestName || typeof manifestName !== 'string') {
      return {
        runId,
        status: 'failed',
        logs,
        toolCalls,
        sinkActions,
        memoryMutations,
        permissionChecks,
        error: 'Invalid manifest: missing required field "name"',
        durationMs: 0,
      };
    }
    const manifestPrompt = request.manifest.prompt;
    if (!manifestPrompt || typeof manifestPrompt !== 'string') {
      return {
        runId,
        status: 'failed',
        logs,
        toolCalls,
        sinkActions,
        memoryMutations,
        permissionChecks,
        error: 'Invalid manifest: missing required field "prompt"',
        durationMs: 0,
      };
    }

    if (
      request.manifest.capabilities !== undefined &&
      !Array.isArray(request.manifest.capabilities)
    ) {
      return {
        runId,
        status: 'failed',
        logs,
        toolCalls,
        sinkActions,
        memoryMutations,
        permissionChecks,
        error: 'Invalid manifest: field "capabilities" must be an array if provided',
        durationMs: 0,
      };
    }
    if (request.manifest.tools !== undefined && !Array.isArray(request.manifest.tools)) {
      return {
        runId,
        status: 'failed',
        logs,
        toolCalls,
        sinkActions,
        memoryMutations,
        permissionChecks,
        error: 'Invalid manifest: field "tools" must be an array if provided',
        durationMs: 0,
      };
    }
    if (request.manifest.sinks !== undefined && !Array.isArray(request.manifest.sinks)) {
      return {
        runId,
        status: 'failed',
        logs,
        toolCalls,
        sinkActions,
        memoryMutations,
        permissionChecks,
        error: 'Invalid manifest: field "sinks" must be an array if provided',
        durationMs: 0,
      };
    }
    if (
      request.manifest.triggers !== undefined &&
      !Array.isArray(request.manifest.triggers)
    ) {
      return {
        runId,
        status: 'failed',
        logs,
        toolCalls,
        sinkActions,
        memoryMutations,
        permissionChecks,
        error: 'Invalid manifest: field "triggers" must be an array if provided',
        durationMs: 0,
      };
    }

    const manifestCapabilities = request.manifest.capabilities ?? [];
    const manifestTools = request.manifest.tools ?? [];
    const manifestSinks = request.manifest.sinks ?? [];
    const manifestTriggers = request.manifest.triggers ?? [];

    for (const cap of manifestCapabilities) {
      if (
        !cap ||
        typeof cap !== 'object' ||
        typeof cap.service !== 'string' ||
        !cap.service ||
        typeof cap.action !== 'string' ||
        !cap.action
      ) {
        return {
          runId,
          status: 'failed',
          logs,
          toolCalls,
          sinkActions,
          memoryMutations,
          permissionChecks,
          error:
            'Invalid manifest: field "capabilities" must contain objects with string service and action',
          durationMs: 0,
        };
      }
    }

    for (const tool of manifestTools) {
      if (typeof tool !== 'string' || !tool) {
        return {
          runId,
          status: 'failed',
          logs,
          toolCalls,
          sinkActions,
          memoryMutations,
          permissionChecks,
          error: 'Invalid manifest: field "tools" must contain string tool names',
          durationMs: 0,
        };
      }
    }

    for (const sink of manifestSinks) {
      if (
        !sink ||
        typeof sink !== 'object' ||
        typeof sink.type !== 'string' ||
        !sink.type
      ) {
        return {
          runId,
          status: 'failed',
          logs,
          toolCalls,
          sinkActions,
          memoryMutations,
          permissionChecks,
          error:
            'Invalid manifest: field "sinks" must contain objects with string type',
          durationMs: 0,
        };
      }
    }

    for (const trigger of manifestTriggers) {
      if (
        !trigger ||
        typeof trigger !== 'object' ||
        typeof trigger.event !== 'string' ||
        !trigger.event
      ) {
        return {
          runId,
          status: 'failed',
          logs,
          toolCalls,
          sinkActions,
          memoryMutations,
          permissionChecks,
          error:
            'Invalid manifest: field "triggers" must contain objects with string event',
          durationMs: 0,
        };
      }
    }

    // 1. Build sandboxed memory tracking
    const innerMemory = options.memoryStore ?? new InMemoryHierarchicalMemoryStore();
    const trackedMemory = new TrackedMemoryStore(innerMemory, (mutation) => {
      memoryMutations.push(mutation);
    });

    // 2. Build mock CredentialBroker to track permission checks against environment policy
    const allowedCaps = new Set<string>(
      (options.allowedCapabilities ?? []).map((c) => `${c.service}:${c.action}`)
    );

    const credentialBroker: CredentialBroker = {
      async hasPermission(service: string, action: string): Promise<boolean> {
        if (options.credentialBroker) {
          const allowed = await options.credentialBroker.hasPermission(service, action);
          permissionChecks.push({ service, action, allowed });
          return allowed;
        }
        const allowed = allowedCaps.has(`${service}:${action}`);
        permissionChecks.push({ service, action, allowed });
        return allowed;
      },
      async executeSignedRequest<T = unknown>(req: CredentialCapabilityRequest): Promise<T> {
        if (options.credentialBroker) {
          const res = await options.credentialBroker.executeSignedRequest<T>(req);
          permissionChecks.push({ service: req.service, action: req.action, allowed: true });
          return res;
        }
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

    // Pre-validate capabilities against policy (fail-closed)
    for (const cap of manifestCapabilities) {
      const allowed = await credentialBroker.hasPermission(cap.service, cap.action);
      if (!allowed) {
        return {
          runId,
          status: 'denied',
          logs,
          toolCalls,
          sinkActions,
          memoryMutations,
          permissionChecks,
          error: `Capability check failed: unauthorized capability "${cap.service}:${cap.action}"`,
          durationMs: Date.now() - startTime,
        };
      }
    }

    // Pre-validate required tools exist in simulation environment
    const providedTools = options.tools ?? [];
    const availableToolNames = new Set(providedTools.map((t) => t.name));
    for (const toolName of manifestTools) {
      if (!availableToolNames.has(toolName)) {
        return {
          runId,
          status: 'failed',
          logs,
          toolCalls,
          sinkActions,
          memoryMutations,
          permissionChecks,
          error: `Tool "${toolName}" requested by manifest is not available in simulation environment`,
          durationMs: Date.now() - startTime,
        };
      }
    }

    // Pre-validate required sinks exist in simulation environment
    const callerSinks = options.sinks ?? [];
    const knownSinkTypes = new Set([
      ...STANDARD_SINK_TYPES,
      ...callerSinks.flatMap((s) => [s.name, ...s.supportedActions]),
    ]);

    for (const sink of manifestSinks) {
      const isAvailable =
        knownSinkTypes.has(sink.type) ||
        knownSinkTypes.has('*') ||
        callerSinks.some(
          (s) =>
            s.name === sink.type ||
            s.supportedActions.includes(sink.type) ||
            s.supportedActions.includes('*')
        );
      if (!isAvailable) {
        return {
          runId,
          status: 'failed',
          logs,
          toolCalls,
          sinkActions,
          memoryMutations,
          permissionChecks,
          error: `Sink "${sink.type}" requested by manifest is not registered in simulation environment`,
          durationMs: Date.now() - startTime,
        };
      }
    }

    // 3. Build ActionSink dispatcher: caller sinks take priority, simulated fallback handles remaining
    const runtime = new AgentRuntime();
    const sinkRegistry = new ActionSinkRegistry();
    if (options.sinks) {
      for (const s of options.sinks) {
        sinkRegistry.registerSink(s);
        runtime.registerSink(s);
      }
    }

    const simulatedSink: ActionSink = {
      name: 'studio-simulated-sink',
      supportedActions: ['*'],
      canHandle: (action) => {
        return !callerSinks.some(
          (s) =>
            s.name === action.type ||
            s.supportedActions.includes(action.type) ||
            s.supportedActions.includes('*')
        );
      },
      handle: async (action, sinkCtx) => {
        sinkCtx.log('info', `Simulated sink handled action: ${action.type}`, {
          target: action.target,
        });
        return {
          sinkName: 'studio-simulated-sink',
          actionId: action.id ?? generateId(),
          actionType: action.type,
          success: true,
          durationMs: 0,
        };
      },
    };
    sinkRegistry.registerSink(simulatedSink);
    runtime.registerSink(simulatedSink);

    // 4. Build simulated tools with call tracking
    for (const tool of providedTools) {
      if (manifestTools.includes(tool.name)) {
        runtime.registerTool({
          ...tool,
          handler: async (params, ctx) => {
            const toolStart = Date.now();
            let result: unknown;
            try {
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
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);
              toolCalls.push({
                tool: tool.name,
                params,
                result: { error: errMsg },
                durationMs: Date.now() - toolStart,
              });
              throw err;
            }
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
          if (options.agentExecutor) {
            agentOutput = await options.agentExecutor(simCtx, request.event);
          } else {
            // Default simulation executor: actually exercises declared tools and sinks
            const toolResults: Record<string, unknown> = {};
            const toolsExecuted: string[] = [];
            for (const toolName of manifestTools) {
              const mockParams =
                (request.mockToolInputs?.[toolName] as Record<string, unknown> | undefined) ??
                (toolName === 'read_file'
                  ? { path: 'README.md' }
                  : toolName === 'list_files'
                    ? { dir: '.' }
                    : toolName === 'exec_command'
                      ? { command: 'echo "simulated test"' }
                      : {});
              const res = await simCtx.invokeTool(toolName, mockParams);
              if (!res.success) {
                throw new Error(
                  `Tool "${toolName}" execution failed: ${res.error ?? 'unknown error'}`,
                );
              }
              toolResults[toolName] = res.result;
              toolsExecuted.push(toolName);
            }

            const sinksEmitted: string[] = [];
            for (const sink of manifestSinks) {
              const dispatchResults = await simCtx.ctx.sinks.emit(
                {
                  type: sink.type,
                  target: `simulated-target-${manifestName}`,
                  payload: {
                    agent: manifestName,
                    event: request.event,
                    toolResults,
                  },
                },
                simCtx.ctx,
              );
              for (const dr of dispatchResults) {
                if (!dr.success) {
                  throw new Error(
                    `Sink "${sink.type}" dispatch failed: ${dr.error ?? 'unknown error'}`,
                  );
                }
              }
              sinksEmitted.push(sink.type);
            }

            agentOutput = {
              executed: true,
              agent: manifestName,
              toolsExecuted,
              sinksEmitted,
            };
          }
          return {
            status: 'success',
            output: typeof agentOutput === 'string' ? agentOutput : JSON.stringify(agentOutput),
            toolCallsCount: toolCalls.length,
          };
        },
        {
          runId,
          systemPrompt: manifestPrompt,
          tools: manifestTools,
          metadata: request.manifest.metadata,
        }
      );

      return {
        runId,
        status:
          runSummary.status === 'success'
            ? 'completed'
            : runSummary.status === 'cancelled'
              ? 'denied'
              : 'failed',
        logs,
        toolCalls,
        sinkActions,
        memoryMutations,
        permissionChecks,
        output: runSummary.output,
        error: runSummary.error,
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
    if (manifest.memoryScope === 'org') {
      await storage.set('org', `agents:${manifest.name}`, manifest);
    } else if (manifest.memoryScope === 'both') {
      await storage.set('repo', `agents:${manifest.name}`, manifest);
      await storage.set('org', `agents:${manifest.name}`, manifest);
    } else {
      await storage.set('repo', `agents:${manifest.name}`, manifest);
    }
  }

  /**
   * Loads an installed AgentManifest from central memory storage.
   */
  async load(
    name: string,
    storage: HierarchicalMemoryStore,
    scope?: 'repo' | 'org',
  ): Promise<AgentManifest | null> {
    if (scope === 'org') {
      const inOrg = await storage.get('org', `agents:${name}`);
      return (inOrg as AgentManifest) ?? null;
    }
    if (scope === 'repo') {
      const inRepo = await storage.get('repo', `agents:${name}`);
      return (inRepo as AgentManifest) ?? null;
    }
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
