/**
 * AgentRuntime orchestrating extensions, lifecycle hooks, tools, and sinks.
 */

import { randomUUID } from 'node:crypto';
import type { AgentContext } from '../types/context.ts';
import type {
  Extension,
  ExtensionAPI,
} from '../types/extension.ts';
import type {
  EventHandler,
  BeforeRunHandler,
  AfterRunHandler,
  CustomEventHandler,
  FactoryEvent,
  Unsubscribe,
} from '../types/events.ts';
import type {
  ToolDefinition,
  ToolExecutionResult,
} from '../types/tools.ts';
import type {
  ActionSink,
  ActionSinkDispatcher,
  SinkActionInput,
  SinkDispatchResult,
} from '../types/sinks.ts';
import { LifecycleEngine, type BeforeRunPipelineResult, type AfterRunPipelineResult } from '../lifecycle/lifecycle-engine.ts';
import { ToolRegistry } from '../tools/tool-registry.ts';
import { ActionSinkRegistry } from '../sinks/sink-registry.ts';

export interface AgentExecutionInput {
  readonly runId: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly tools: readonly string[];
  readonly ctx: AgentContext;
}

export interface AgentExecutionOutput {
  readonly status: 'success' | 'failure';
  readonly output?: string;
  readonly error?: string;
  readonly toolCallsCount: number;
  readonly metadata?: Record<string, unknown>;
}

export type AgentExecutionFn = (
  input: AgentExecutionInput
) => Promise<AgentExecutionOutput>;

export interface AgentRunSummary {
  readonly runId: string;
  readonly status: 'success' | 'failure' | 'cancelled';
  readonly prompt: string;
  readonly finalPrompt: string;
  readonly output?: string;
  readonly error?: string;
  readonly toolCallsCount: number;
  readonly durationMs: number;
  readonly beforeRun: BeforeRunPipelineResult;
  readonly afterRun?: AfterRunPipelineResult;
  readonly continuation?: {
    readonly requested: boolean;
    readonly nextPrompt?: string;
  };
}

export class AgentRuntime implements ExtensionAPI {
  readonly lifecycle = new LifecycleEngine();
  readonly tools = new ToolRegistry();
  readonly sinks = new ActionSinkRegistry();

  private readonly loadedExtensions: Extension[] = [];

  /* --- ExtensionAPI implementation --- */

  on(event: 'event', handler: EventHandler): Unsubscribe;
  on(event: 'before_run', handler: BeforeRunHandler): Unsubscribe;
  on(event: 'after_run', handler: AfterRunHandler): Unsubscribe;
  on<T = unknown>(event: string, handler: CustomEventHandler<T>): Unsubscribe;
  on(
    event: string,
    handler: EventHandler | BeforeRunHandler | AfterRunHandler | CustomEventHandler
  ): Unsubscribe {
    switch (event) {
      case 'event':
        return this.lifecycle.onEvent(handler as EventHandler);
      case 'before_run':
        return this.lifecycle.onBeforeRun(handler as BeforeRunHandler);
      case 'after_run':
        return this.lifecycle.onAfterRun(handler as AfterRunHandler);
      default:
        return this.lifecycle.onCustom(event, handler as CustomEventHandler);
    }
  }

  registerTool<
    TParams extends Record<string, unknown> = Record<string, unknown>,
    TResult = unknown,
  >(tool: ToolDefinition<TParams, TResult>): void {
    this.tools.registerTool(tool);
  }

  registerSink(sink: ActionSink): void {
    this.sinks.registerSink(sink);
  }

  /* --- Extension loading --- */

  async loadExtension(extension: Extension): Promise<void> {
    await extension(this);
    this.loadedExtensions.push(extension);
  }

  /* --- Execution and Event Dispatching --- */

  async emitEvent(event: FactoryEvent, ctx: AgentContext): Promise<void> {
    await this.lifecycle.emitEvent(event, ctx);
  }

  async invokeTool(
    name: string,
    params: Record<string, unknown>,
    ctx: AgentContext
  ): Promise<ToolExecutionResult> {
    return this.tools.executeTool(name, params, ctx);
  }

  async dispatchAction<TPayload = unknown>(
    action: SinkActionInput<TPayload>,
    ctx: AgentContext
  ): Promise<SinkDispatchResult[]> {
    return this.sinks.emit(action, ctx);
  }

  /**
   * Run the agent lifecycle:
   * 1. before_run hooks (can mutate prompt, systemPrompt, tool selection, or cancel)
   * 2. Agent execution function
   * 3. after_run hooks (can evaluate output, emit actions to sinks, request continuation)
   */
  async runAgent(
    initialPrompt: string,
    ctx: AgentContext,
    executionFn: AgentExecutionFn,
    options?: {
      systemPrompt?: string;
      tools?: readonly string[];
      metadata?: Record<string, unknown>;
    }
  ): Promise<AgentRunSummary> {
    const runId = ctx.id ?? randomUUID();
    const startTime = Date.now();
    const availableToolNames = options?.tools ?? this.tools.getToolDefinitions().map((t) => t.name);

    // 1. Lifecycle: before_run
    const beforeRunResult = await this.lifecycle.executeBeforeRun(
      {
        runId,
        prompt: initialPrompt,
        systemPrompt: options?.systemPrompt,
        tools: availableToolNames,
        metadata: options?.metadata,
      },
      ctx
    );

    if (beforeRunResult.cancelled) {
      const durationMs = Date.now() - startTime;
      return {
        runId,
        status: 'cancelled',
        prompt: initialPrompt,
        finalPrompt: beforeRunResult.prompt,
        error: beforeRunResult.cancelReason,
        toolCallsCount: 0,
        durationMs,
        beforeRun: beforeRunResult,
      };
    }

    // 2. Execution phase
    let executionOutput: AgentExecutionOutput;
    try {
      if (ctx.signal.aborted) {
        throw new Error(`Execution aborted: ${ctx.signal.reason ?? 'signal aborted'}`);
      }

      executionOutput = await executionFn({
        runId,
        prompt: beforeRunResult.prompt,
        systemPrompt: beforeRunResult.systemPrompt,
        tools: beforeRunResult.tools,
        ctx,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      executionOutput = {
        status: 'failure',
        error: errorMsg,
        toolCallsCount: 0,
      };
    }

    const durationMs = Date.now() - startTime;

    // 3. Lifecycle: after_run
    const afterRunResult = await this.lifecycle.executeAfterRun(
      {
        runId,
        prompt: beforeRunResult.prompt,
        status: executionOutput.status,
        output: executionOutput.output,
        error: executionOutput.error,
        toolCallsCount: executionOutput.toolCallsCount,
        durationMs,
        metadata: executionOutput.metadata,
      },
      ctx
    );

    return {
      runId,
      status: executionOutput.status,
      prompt: initialPrompt,
      finalPrompt: beforeRunResult.prompt,
      output: executionOutput.output,
      error: executionOutput.error,
      toolCallsCount: executionOutput.toolCallsCount,
      durationMs,
      beforeRun: beforeRunResult,
      afterRun: afterRunResult,
      continuation: {
        requested: Boolean(afterRunResult.shouldContinue),
        nextPrompt: afterRunResult.nextPrompt,
      },
    };
  }
}
