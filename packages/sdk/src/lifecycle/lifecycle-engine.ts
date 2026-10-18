/**
 * Pi-inspired lifecycle hooks engine for Cloud Factory CF.
 */

import type { AgentContext } from '../types/context.ts';
import type {
  FactoryEvent,
  BeforeRunEvent,
  BeforeRunResult,
  AfterRunEvent,
  AfterRunResult,
  EventHandler,
  BeforeRunHandler,
  AfterRunHandler,
  CustomEventHandler,
  Unsubscribe,
} from '../types/events.ts';

export interface BeforeRunPipelineResult {
  readonly cancelled: boolean;
  readonly cancelReason?: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly tools: readonly string[];
  readonly metadata: Record<string, unknown>;
}

export interface AfterRunPipelineResult {
  readonly shouldContinue: boolean;
  readonly nextPrompt?: string;
  readonly metadata: Record<string, unknown>;
}

export class LifecycleEngine {
  private readonly eventHandlers: EventHandler[] = [];
  private readonly beforeRunHandlers: BeforeRunHandler[] = [];
  private readonly afterRunHandlers: AfterRunHandler[] = [];
  private readonly customHandlers = new Map<string, CustomEventHandler[]>();

  onEvent(handler: EventHandler): Unsubscribe {
    this.eventHandlers.push(handler);
    return () => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx !== -1) this.eventHandlers.splice(idx, 1);
    };
  }

  onBeforeRun(handler: BeforeRunHandler): Unsubscribe {
    this.beforeRunHandlers.push(handler);
    return () => {
      const idx = this.beforeRunHandlers.indexOf(handler);
      if (idx !== -1) this.beforeRunHandlers.splice(idx, 1);
    };
  }

  onAfterRun(handler: AfterRunHandler): Unsubscribe {
    this.afterRunHandlers.push(handler);
    return () => {
      const idx = this.afterRunHandlers.indexOf(handler);
      if (idx !== -1) this.afterRunHandlers.splice(idx, 1);
    };
  }

  onCustom(eventName: string, handler: CustomEventHandler): Unsubscribe {
    let list = this.customHandlers.get(eventName);
    if (!list) {
      list = [];
      this.customHandlers.set(eventName, list);
    }
    list.push(handler);
    return () => {
      const current = this.customHandlers.get(eventName);
      if (current) {
        const idx = current.indexOf(handler);
        if (idx !== -1) current.splice(idx, 1);
      }
    };
  }

  async emitEvent(event: FactoryEvent, ctx: AgentContext): Promise<void> {
    for (const handler of this.eventHandlers) {
      try {
        await handler(event, ctx);
      } catch (err) {
        ctx.log('error', `Error in event handler for "${event.type}"`, err);
      }
    }
  }

  async emitCustom(eventName: string, data: unknown, ctx: AgentContext): Promise<unknown[]> {
    const handlers = this.customHandlers.get(eventName) ?? [];
    const results: unknown[] = [];
    for (const handler of handlers) {
      try {
        const res = await handler(data, ctx);
        results.push(res);
      } catch (err) {
        ctx.log('error', `Error in custom event handler for "${eventName}"`, err);
      }
    }
    return results;
  }

  async executeBeforeRun(
    initialEvent: BeforeRunEvent,
    ctx: AgentContext
  ): Promise<BeforeRunPipelineResult> {
    let currentPrompt = initialEvent.prompt;
    let currentSystemPrompt = initialEvent.systemPrompt;
    let currentTools = [...initialEvent.tools];
    const aggregatedMetadata: Record<string, unknown> = { ...(initialEvent.metadata ?? {}) };

    for (const handler of this.beforeRunHandlers) {
      if (ctx.signal.aborted) {
        return {
          cancelled: true,
          cancelReason: `Run aborted: ${ctx.signal.reason ?? 'signal aborted'}`,
          prompt: currentPrompt,
          systemPrompt: currentSystemPrompt,
          tools: currentTools,
          metadata: aggregatedMetadata,
        };
      }

      try {
        const result = await handler(
          {
            runId: initialEvent.runId,
            prompt: currentPrompt,
            systemPrompt: currentSystemPrompt,
            tools: currentTools,
            metadata: aggregatedMetadata,
          },
          ctx
        );

        if (result) {
          if (result.cancel) {
            return {
              cancelled: true,
              cancelReason: result.cancelReason ?? 'Cancelled by before_run hook',
              prompt: currentPrompt,
              systemPrompt: currentSystemPrompt,
              tools: currentTools,
              metadata: aggregatedMetadata,
            };
          }
          if (result.prompt !== undefined) {
            currentPrompt = result.prompt;
          }
          if (result.systemPrompt !== undefined) {
            currentSystemPrompt = result.systemPrompt;
          }
          if (result.tools !== undefined) {
            currentTools = [...result.tools];
          }
          if (result.metadata) {
            Object.assign(aggregatedMetadata, result.metadata);
          }
        }
      } catch (err) {
        ctx.log('error', `Error in before_run hook for run ${initialEvent.runId}`, err);
        return {
          cancelled: true,
          cancelReason: `before_run hook failure: ${err instanceof Error ? err.message : String(err)}`,
          prompt: currentPrompt,
          systemPrompt: currentSystemPrompt,
          tools: currentTools,
          metadata: aggregatedMetadata,
        };
      }
    }

    return {
      cancelled: false,
      prompt: currentPrompt,
      systemPrompt: currentSystemPrompt,
      tools: currentTools,
      metadata: aggregatedMetadata,
    };
  }

  async executeAfterRun(
    event: AfterRunEvent,
    ctx: AgentContext
  ): Promise<AfterRunPipelineResult> {
    let shouldContinue = false;
    let nextPrompt: string | undefined;
    const aggregatedMetadata: Record<string, unknown> = { ...(event.metadata ?? {}) };

    for (const handler of this.afterRunHandlers) {
      try {
        const result = await handler(event, ctx);
        if (result) {
          if (result.continue) {
            shouldContinue = true;
            if (result.nextPrompt) {
              nextPrompt = result.nextPrompt;
            }
          }
          if (result.metadata) {
            Object.assign(aggregatedMetadata, result.metadata);
          }
        }
      } catch (err) {
        ctx.log('error', `Error in after_run hook for run ${event.runId}`, err);
      }
    }

    return {
      shouldContinue,
      nextPrompt,
      metadata: aggregatedMetadata,
    };
  }
}
