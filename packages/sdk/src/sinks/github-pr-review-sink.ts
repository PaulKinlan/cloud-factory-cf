import type { ActionSink, SinkAction, SinkDispatchResult, GitHubPRReviewPayload } from '../types/sinks.ts';
import type { AgentContext } from '../types/context.ts';

export type GitHubPRReviewExecutor = (
  payload: GitHubPRReviewPayload,
  ctx: AgentContext,
) => Promise<Record<string, unknown> | undefined>;

export interface GitHubPRReviewSinkOptions {
  name?: string;
  executor?: GitHubPRReviewExecutor;
}

export class GitHubPRReviewSink implements ActionSink {
  readonly name: string;
  readonly supportedActions: readonly string[] = ['github:pr:review', 'github.pr.review'];
  private readonly customExecutor?: GitHubPRReviewExecutor;

  constructor(options: GitHubPRReviewSinkOptions = {}) {
    this.name = options.name ?? 'github-pr-review-sink';
    this.customExecutor = options.executor;
  }

  canHandle(action: SinkAction): boolean {
    return this.supportedActions.includes(action.type);
  }

  async handle(action: SinkAction, ctx: AgentContext): Promise<SinkDispatchResult> {
    const start = Date.now();
    const payload = action.payload as GitHubPRReviewPayload;

    if (!payload || typeof payload !== 'object') {
      return {
        sinkName: this.name,
        actionId: action.id,
        actionType: action.type,
        success: false,
        error: 'Invalid payload: expected GitHubPRReviewPayload object',
        durationMs: Date.now() - start,
      };
    }

    if (typeof payload.prNumber !== 'number' || payload.prNumber <= 0 || !Number.isInteger(payload.prNumber)) {
      return {
        sinkName: this.name,
        actionId: action.id,
        actionType: action.type,
        success: false,
        error: 'Invalid payload: prNumber must be a positive integer',
        durationMs: Date.now() - start,
      };
    }

    if (!['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(payload.event)) {
      return {
        sinkName: this.name,
        actionId: action.id,
        actionType: action.type,
        success: false,
        error: `Invalid payload: unsupported review event '${payload.event}'`,
        durationMs: Date.now() - start,
      };
    }

    if (typeof payload.body !== 'string' || payload.body.trim().length === 0) {
      return {
        sinkName: this.name,
        actionId: action.id,
        actionType: action.type,
        success: false,
        error: 'Invalid payload: review body must be a non-empty string',
        durationMs: Date.now() - start,
      };
    }

    try {
      if (this.customExecutor) {
        const result = await this.customExecutor(payload, ctx);
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
        service: 'github',
        action: 'create_pr_review',
        params: {
          repo: ctx.repo ? `${ctx.repo.owner}/${ctx.repo.name}` : undefined,
          prNumber: payload.prNumber,
          event: payload.event,
          body: payload.body,
          commitSha: payload.commitSha,
          comments: payload.comments,
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
