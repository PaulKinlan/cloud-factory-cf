/**
 * The sinks a canvas agent can actually reach from the Worker.
 *
 * Each one is wired to something real: the credential broker for provider calls
 * (a review, an issue, a beads task) and a configurable endpoint or the
 * structured log for telemetry. A layout may name only these types; anything else
 * is refused rather than silently mapped onto a different provider.
 */
import {
  BeadsTaskSink,
  CloudTelemetrySink,
  GitHubIssueSink,
  type ActionSink,
  type AgentContext,
} from "@factory-cloud/sdk";

export interface SinkDeps {
  /** Where telemetry is exported; absent means the structured log. */
  telemetryEndpoint?: string;
  /** Structured log sink, injectable so tests can read it. */
  log?: (entry: Record<string, unknown>) => void;
}

/** Canvas sink type → the sink implementation that serves it. */
export const SINK_TYPES: Record<string, string> = {
  "github-pr-review": "github-pr-review-sink",
  "github-issue-comment": "github-issue-comment-sink",
  "github-issue-create": "github-issue-create-sink",
  "beads-task": "beads-task-sink",
  telemetry: "cloud-telemetry-sink",
  "cloud-telemetry": "cloud-telemetry-sink",
};

/** Sink name → the action types it accepts, so a decision can target it. */
export const SINK_ACTIONS: Record<string, string> = {
  "github-pr-review-sink": "github:pr:review",
  "github-issue-comment-sink": "github:issue:comment",
  "github-issue-create-sink": "github:issue:create",
  "beads-task-sink": "beads:task:create",
  "cloud-telemetry-sink": "telemetry:log",
};

/** Issue creation goes through the broker's `issue.create` action. */
export function issueCreateSink(): ActionSink {
  return new GitHubIssueSink({
    name: "github-issue-create-sink",
    executor: async (payload, ctx) => {
      const result = await ctx.credentials.executeSignedRequest<{ status?: number }>({
        service: "github",
        action: "issue.create",
        params: { title: payload.title, body: payload.body },
      });
      return { status: result?.status ?? 200 };
    },
  });
}

/**
 * Beads tasks go through the broker too: the worker never holds the token, and a
 * deployment without `BEADS_API_HOST`/`BEADS_TOKEN` gets a clear 503 rather than
 * a silent no-op.
 */
export function beadsTaskSink(): ActionSink {
  return new BeadsTaskSink({
    executor: async (payload, actionType, ctx) => {
      const isUpdate = actionType.includes("update");
      const result = await ctx.credentials.executeSignedRequest<{ status?: number }>({
        service: "beads",
        action: isUpdate ? "task.update" : "task.create",
        params: isUpdate
          ? { taskId: payload.taskId ?? payload.id, title: payload.title, description: payload.description }
          : {
              title: payload.title,
              description: payload.description,
              ...(payload.priority === undefined ? {} : { priority: payload.priority }),
              ...(payload.assignee === undefined ? {} : { assignee: payload.assignee }),
            },
      });
      return { status: result?.status ?? 200 };
    },
  });
}

/**
 * Telemetry: exported to `TELEMETRY_ENDPOINT` when configured, otherwise written
 * to the structured log. Both are observable, and neither can be dropped
 * silently, so a run that emits telemetry always says where it went.
 */
export function telemetrySink(deps: SinkDeps = {}): ActionSink {
  const log = deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify(entry)));
  return new CloudTelemetrySink({
    exporter: async (entry, ctx: AgentContext) => {
      const record = {
        type: entry.type,
        payload: entry.payload,
        timestamp: entry.timestamp,
        repository: ctx.repo ? `${ctx.repo.owner}/${ctx.repo.name}` : undefined,
        agent: ctx.state["agentId"] ?? undefined,
      };
      if (deps.telemetryEndpoint === undefined || deps.telemetryEndpoint.length === 0) {
        log({ sink: "cloud-telemetry-sink", exported: "log", ...record });
        return { exported: "log" };
      }
      const response = await fetch(deps.telemetryEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(record),
      });
      if (!response.ok) {
        throw new Error(`telemetry endpoint answered ${response.status}`);
      }
      return { exported: "endpoint", status: response.status };
    },
  });
}

/** Every sink the Worker can serve, keyed by sink name. */
export function allSinks(deps: SinkDeps = {}): Record<string, ActionSink> {
  return {
    "github-pr-review-sink": prReviewSink(),
    "github-issue-comment-sink": issueCommentSink(),
    "github-issue-create-sink": issueCreateSink(),
    "beads-task-sink": beadsTaskSink(),
    "cloud-telemetry-sink": telemetrySink(deps),
  };
}

function prReviewSink(): ActionSink {
  return {
    name: "github-pr-review-sink",
    supportedActions: ["github:pr:review"],
    canHandle: (action) => action.type === "github:pr:review",
    async handle(action, ctx) {
      const start = Date.now();
      const payload = action.payload as { prNumber?: unknown; event?: unknown; body?: unknown };
      if (typeof payload.prNumber !== "number" || typeof payload.body !== "string" || payload.body.length === 0) {
        return failure("github-pr-review-sink", action.id, action.type, "invalid review payload", start);
      }
      try {
        const result = await ctx.credentials.executeSignedRequest<{ status?: number }>({
          service: "github",
          action: "pr.review",
          params: { number: payload.prNumber, event: payload.event ?? "COMMENT", body: payload.body },
        });
        return {
          sinkName: "github-pr-review-sink",
          actionId: action.id,
          actionType: action.type,
          success: true,
          result: { status: result?.status ?? 200 },
          durationMs: Date.now() - start,
        };
      } catch (error) {
        return failure("github-pr-review-sink", action.id, action.type, messageOf(error), start);
      }
    },
  };
}

function issueCommentSink(): ActionSink {
  return {
    name: "github-issue-comment-sink",
    supportedActions: ["github:issue:comment"],
    canHandle: (action) => action.type === "github:issue:comment",
    async handle(action, ctx) {
      const start = Date.now();
      const payload = action.payload as { issueNumber?: unknown; body?: unknown };
      if (typeof payload.issueNumber !== "number" || typeof payload.body !== "string" || payload.body.length === 0) {
        return failure("github-issue-comment-sink", action.id, action.type, "invalid comment payload", start);
      }
      try {
        const result = await ctx.credentials.executeSignedRequest<{ status?: number }>({
          service: "github",
          action: "issue.comment",
          params: { number: payload.issueNumber, body: payload.body },
        });
        return {
          sinkName: "github-issue-comment-sink",
          actionId: action.id,
          actionType: action.type,
          success: true,
          result: { status: result?.status ?? 200 },
          durationMs: Date.now() - start,
        };
      } catch (error) {
        return failure("github-issue-comment-sink", action.id, action.type, messageOf(error), start);
      }
    },
  };
}

function failure(sinkName: string, actionId: string, actionType: string, error: string, start: number) {
  return {
    sinkName,
    actionId,
    actionType,
    success: false as const,
    error,
    durationMs: Date.now() - start,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
