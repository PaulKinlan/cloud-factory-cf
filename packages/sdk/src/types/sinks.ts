/**
 * Pluggable ActionSink interfaces and action definitions for Cloud Factory CF.
 */

import type { AgentContext } from './context.ts';

export interface SinkAction<TPayload = unknown> {
  readonly id: string;
  readonly type: string;
  readonly payload: TPayload;
  readonly timestamp: number;
  readonly target?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type SinkActionInput<TPayload = unknown> = Omit<SinkAction<TPayload>, 'id' | 'timestamp'> & {
  id?: string;
  timestamp?: number;
};

export interface SinkDispatchResult<TResult = unknown> {
  readonly sinkName: string;
  readonly actionId: string;
  readonly actionType: string;
  readonly success: boolean;
  readonly result?: TResult;
  readonly error?: string;
  readonly durationMs: number;
}

/**
 * ActionSink interface for pluggable destinations such as GitHub PR reviews,
 * Issues, Beads tasks, and Cloud Telemetry.
 */
export interface ActionSink {
  readonly name: string;
  /**
   * Action types this sink accepts. Use ['*'] to accept all actions.
   */
  readonly supportedActions: readonly string[];

  /**
   * Optional check to determine if an action should be routed to this sink.
   */
  canHandle?(action: SinkAction, ctx: AgentContext): boolean;

  /**
   * Dispatch the action to the sink destination.
   */
  handle(action: SinkAction, ctx: AgentContext): Promise<SinkDispatchResult>;
}

export interface ActionSinkDispatcher {
  emit<TPayload = unknown>(
    action: SinkActionInput<TPayload>,
    ctx?: AgentContext
  ): Promise<SinkDispatchResult[]>;
  registerSink(sink: ActionSink): () => void;
  unregisterSink(sinkName: string): boolean;
  getSinks(): readonly ActionSink[];
}

/* Typed Action Payloads */

export interface GitHubPRReviewPayload {
  readonly prNumber: number;
  readonly event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  readonly body: string;
  readonly commitSha?: string;
  readonly comments?: readonly {
    readonly path: string;
    readonly line: number;
    readonly body: string;
  }[];
}

export interface GitHubIssuePayload {
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
}

export interface BeadsTaskPayload {
  readonly id?: string;
  readonly taskId?: string;
  readonly title: string;
  readonly description: string;
  readonly priority?: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
  readonly labels?: readonly string[];
  readonly assignee?: string;
  readonly parentId?: string;
  readonly status?: string;
}

export interface TelemetryMetricPayload {
  readonly metric: string;
  readonly value: number;
  readonly unit?: string;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface TelemetryLogPayload {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}
