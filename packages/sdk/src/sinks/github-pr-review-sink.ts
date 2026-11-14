import type { ActionSink, SinkAction, SinkDispatchResult, GitHubPRReviewPayload } from '../types/sinks.ts';
import type { AgentContext } from '../types/context.ts';
import { assertUpstreamAccepted, type SignedBrokerResult } from './broker-result.ts';

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

      // Inline review comments are structured objects the broker's `pr.review` action
      // cannot carry (its body is body/event/commit_id), so refuse rather than file a
      // review that quietly lost them (cloud-factory-cf-v1y0). A custom executor gets
      // the whole payload and can carry them.
      if (payload.comments !== undefined && payload.comments.length > 0) {
        return {
          sinkName: this.name,
          actionId: action.id,
          actionType: action.type,
          success: false,
          error: 'Invalid payload: inline comments are not forwarded by the broker\'s pr.review action; use a custom executor',
          durationMs: Date.now() - start,
        };
      }

      const result = await ctx.credentials.executeSignedRequest<SignedBrokerResult>({
        service: 'github',
        // The broker's own action name (`pr.review`), not a GitHub-style verb: an
        // unknown action is refused before it reaches GitHub (cloud-factory-cf-g9aw).
        action: 'pr.review',
        includeStatus: true,
        params: {
          // The broker fills `{number}` from this path parameter.
          number: payload.prNumber,
          event: payload.event,
          body: payload.body,
          // Pins the review to the commit it describes; the policy forwards `commit_id`.
          ...(payload.commitSha === undefined ? {} : { commit_id: payload.commitSha }),
        },
      });

      return {
        sinkName: this.name,
        actionId: action.id,
        actionType: action.type,
        success: true,
        result: assertUpstreamAccepted(result, 'pr.review'),
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
