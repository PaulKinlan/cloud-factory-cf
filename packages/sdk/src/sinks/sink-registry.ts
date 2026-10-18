/**
 * ActionSinkRegistry implementation and built-in sinks.
 */

import { generateId } from '../utils/id.ts';
import type { AgentContext } from '../types/context.ts';
import type {
  ActionSink,
  ActionSinkDispatcher,
  SinkAction,
  SinkActionInput,
  SinkDispatchResult,
} from '../types/sinks.ts';

export class ActionSinkRegistry implements ActionSinkDispatcher {
  private readonly sinks = new Map<string, ActionSink>();

  registerSink(sink: ActionSink): () => void {
    if (!sink.name) {
      throw new Error('ActionSink must have a non-empty name');
    }
    this.sinks.set(sink.name, sink);
    return () => this.unregisterSink(sink.name);
  }

  unregisterSink(sinkName: string): boolean {
    return this.sinks.delete(sinkName);
  }

  getSinks(): readonly ActionSink[] {
    return Array.from(this.sinks.values());
  }

  async emit<TPayload = unknown>(
    actionInput: SinkActionInput<TPayload>,
    ctx?: AgentContext
  ): Promise<SinkDispatchResult[]> {
    const action: SinkAction<TPayload> = {
      id: actionInput.id ?? generateId(),
      type: actionInput.type,
      payload: actionInput.payload,
      timestamp: actionInput.timestamp ?? Date.now(),
      target: actionInput.target,
      metadata: actionInput.metadata,
    };

    const matchingSinks: ActionSink[] = [];
    for (const sink of this.sinks.values()) {
      const acceptsType =
        sink.supportedActions.includes('*') ||
        sink.supportedActions.includes(action.type);

      if (acceptsType) {
        if (!ctx) {
          // Without ctx, include all type-matched sinks so they fail consistently (fixes cloud-factory-cf-qp4)
          matchingSinks.push(sink);
        } else if (!sink.canHandle) {
          matchingSinks.push(sink);
        } else {
          try {
            if (sink.canHandle(action, ctx)) {
              matchingSinks.push(sink);
            }
          } catch (err) {
            ctx.log(
              'error',
              `ActionSink "${sink.name}" canHandle threw error for action "${action.type}"`,
              err
            );
          }
        }
      }
    }

    if (matchingSinks.length === 0) {
      return [];
    }

    const results = await Promise.all(
      matchingSinks.map(async (sink) => {
        const start = Date.now();
        try {
          if (!ctx) {
            throw new Error(`Cannot dispatch action "${action.type}" to sink "${sink.name}" without an AgentContext`);
          }
          const result = await sink.handle(action, ctx);
          return result;
        } catch (err) {
          const durationMs = Date.now() - start;
          const errorMsg = err instanceof Error ? err.message : String(err);
          return {
            sinkName: sink.name,
            actionId: action.id,
            actionType: action.type,
            success: false,
            error: errorMsg,
            durationMs,
          };
        }
      })
    );

    return results;
  }
}

/**
 * MemoryActionSink stores emitted actions in memory, useful for tests,
 * verification, and local buffering.
 */
export class MemoryActionSink implements ActionSink {
  readonly name: string;
  readonly supportedActions: readonly string[];
  private readonly actions: SinkAction[] = [];

  constructor(name = 'memory-sink', supportedActions: readonly string[] = ['*']) {
    this.name = name;
    this.supportedActions = supportedActions;
  }

  async handle(action: SinkAction, _ctx: AgentContext): Promise<SinkDispatchResult> {
    this.actions.push(action);
    return {
      sinkName: this.name,
      actionId: action.id,
      actionType: action.type,
      success: true,
      result: { count: this.actions.length },
      durationMs: 0,
    };
  }

  getEmittedActions(): readonly SinkAction[] {
    return this.actions;
  }

  clear(): void {
    this.actions.length = 0;
  }
}
