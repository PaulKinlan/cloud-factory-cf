import type { ActionSink, SinkAction, SinkDispatchResult, BeadsTaskPayload } from '../types/sinks.ts';
import type { AgentContext } from '../types/context.ts';

export type BeadsTaskExecutor = (
  payload: BeadsTaskPayload,
  actionType: string,
  ctx: AgentContext,
) => Promise<Record<string, unknown> | undefined>;

export interface BeadsTaskSinkOptions {
  name?: string;
  executor?: BeadsTaskExecutor;
}

export class BeadsTaskSink implements ActionSink {
  readonly name: string;
  readonly supportedActions: readonly string[] = [
    'beads:task:create',
    'beads.task.create',
    'beads:task:update',
    'beads.task.update',
  ];
  private readonly customExecutor?: BeadsTaskExecutor;

  constructor(options: BeadsTaskSinkOptions = {}) {
    this.name = options.name ?? 'beads-task-sink';
    this.customExecutor = options.executor;
  }

  canHandle(action: SinkAction): boolean {
    return this.supportedActions.includes(action.type);
  }

  async handle(action: SinkAction, ctx: AgentContext): Promise<SinkDispatchResult> {
    const start = Date.now();
    const payload = action.payload as BeadsTaskPayload;

    if (!payload || typeof payload !== 'object') {
      return {
        sinkName: this.name,
        actionId: action.id,
        actionType: action.type,
        success: false,
        error: 'Invalid payload: expected BeadsTaskPayload object',
        durationMs: Date.now() - start,
      };
    }

    if (typeof payload.title !== 'string' || payload.title.trim().length === 0) {
      return {
        sinkName: this.name,
        actionId: action.id,
        actionType: action.type,
        success: false,
        error: 'Invalid payload: beads task title must be a non-empty string',
        durationMs: Date.now() - start,
      };
    }

    if (payload.priority && !['P0', 'P1', 'P2', 'P3', 'P4'].includes(payload.priority)) {
      return {
        sinkName: this.name,
        actionId: action.id,
        actionType: action.type,
        success: false,
        error: `Invalid payload: unsupported priority '${payload.priority}'`,
        durationMs: Date.now() - start,
      };
    }

    const isUpdate = action.type.includes('update');
    const taskId = payload.id ?? payload.taskId ?? action.target;

    if (isUpdate && (!taskId || taskId.trim().length === 0)) {
      return {
        sinkName: this.name,
        actionId: action.id,
        actionType: action.type,
        success: false,
        error: 'Invalid payload: beads:task:update requires a task ID (via payload.id, payload.taskId, or action.target)',
        durationMs: Date.now() - start,
      };
    }

    const effectivePayload: BeadsTaskPayload = taskId
      ? { ...payload, id: payload.id ?? taskId, taskId: payload.taskId ?? taskId }
      : payload;

    try {
      if (this.customExecutor) {
        const result = await this.customExecutor(effectivePayload, action.type, ctx);
        return {
          sinkName: this.name,
          actionId: action.id,
          actionType: action.type,
          success: true,
          result,
          durationMs: Date.now() - start,
        };
      }

      const result = await ctx.credentials.executeSignedRequest({
        service: 'beads',
        action: isUpdate ? 'update_task' : 'create_task',
        params: {
          id: isUpdate ? taskId : (payload.id ?? payload.taskId),
          taskId: isUpdate ? taskId : (payload.taskId ?? payload.id),
          title: payload.title,
          description: payload.description,
          priority: payload.priority,
          labels: payload.labels,
          assignee: payload.assignee,
          parentId: payload.parentId,
          status: payload.status,
        },
      });

      return {
        sinkName: this.name,
        actionId: action.id,
        actionType: action.type,
        success: true,
        result,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        sinkName: this.name,
        actionId: action.id,
        actionType: action.type,
        success: false,
        error: message,
        durationMs: Date.now() - start,
      };
    }
  }
}
