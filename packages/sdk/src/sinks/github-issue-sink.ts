import type { ActionSink, SinkAction, SinkDispatchResult, GitHubIssuePayload } from '../types/sinks.ts';
import type { AgentContext } from '../types/context.ts';
import { assertUpstreamAccepted, type SignedBrokerResult } from './broker-result.ts';

export type GitHubIssueExecutor = (
  payload: GitHubIssuePayload,
  ctx: AgentContext,
) => Promise<Record<string, unknown> | undefined>;

export interface GitHubIssueSinkOptions {
  name?: string;
  executor?: GitHubIssueExecutor;
}

export class GitHubIssueSink implements ActionSink {
  readonly name: string;
  readonly supportedActions: readonly string[] = ['github:issue:create', 'github.issue.create'];
  private readonly customExecutor?: GitHubIssueExecutor;

  constructor(options: GitHubIssueSinkOptions = {}) {
    this.name = options.name ?? 'github-issue-sink';
    this.customExecutor = options.executor;
  }

  canHandle(action: SinkAction): boolean {
    return this.supportedActions.includes(action.type);
  }

  async handle(action: SinkAction, ctx: AgentContext): Promise<SinkDispatchResult> {
    const start = Date.now();
    const payload = action.payload as GitHubIssuePayload;

    if (!payload || typeof payload !== 'object') {
      return {
        sinkName: this.name,
        actionId: action.id,
        actionType: action.type,
        success: false,
        error: 'Invalid payload: expected GitHubIssuePayload object',
        durationMs: Date.now() - start,
      };
    }

    if (typeof payload.title !== 'string' || payload.title.trim().length === 0) {
      return {
        sinkName: this.name,
        actionId: action.id,
        actionType: action.type,
        success: false,
        error: 'Invalid payload: issue title must be a non-empty string',
        durationMs: Date.now() - start,
      };
    }

    if (typeof payload.body !== 'string') {
      return {
        sinkName: this.name,
        actionId: action.id,
        actionType: action.type,
        success: false,
        error: 'Invalid payload: issue body must be a string',
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

      const result = await ctx.credentials.executeSignedRequest<SignedBrokerResult>({
        service: 'github',
        // The broker's action name is `issue.create`; `create_issue` is refused as an
        // unknown action before GitHub sees it (cloud-factory-cf-g9aw). Its forwarded body
        // is title/body, so labels and assignees are not silently promised here.
        action: 'issue.create',
        includeStatus: true,
        params: {
          title: payload.title,
          body: payload.body,
        },
      });

      return {
        sinkName: this.name,
        actionId: action.id,
        actionType: action.type,
        success: true,
        result: assertUpstreamAccepted(result, 'issue.create'),
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
