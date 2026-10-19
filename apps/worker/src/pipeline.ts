/**
 * End-to-end execution pipeline for one repository.
 *
 * Queue (RepoCoordinator) → agent run (SDK `AgentRuntime`) → sinks (SDK
 * `ActionSink` implementations) → credential broker (signed capability, so the
 * agent never holds a secret) → provider → ack/fail back onto the queue.
 *
 * The agent's reasoning is an `AgentExecutionFn` seam: the default
 * `ruleBasedReview` is deterministic and needs no model, and a model-backed or
 * `@cloudflare/computer` runtime can be dropped in without touching this file.
 * The same SDK contracts drive the local runtime in `packages/cli`, which is why
 * both runtimes dispatch to the same sinks and credential interface.
 */
import {
  AgentRuntime,
  CoordinatorMemoryStore,
  GitHubPRReviewSink,
  createAgentContext,
  type ActionSink,
  type AgentContext,
  type AgentExecutionFn,
  type CredentialBroker,
  type CredentialCapabilityRequest,
} from "@factory-cloud/sdk";

/** How many events one drain handles, and how long a claim is held. */
export const DEFAULT_RUN_BATCH = 10;
export const DEFAULT_RUN_VISIBILITY_MS = 60_000;
const CAPABILITY_SAFETY_MARGIN_SECONDS = 30;

export interface ClaimedEvent {
  deliveryId: string;
  provider: string;
  event: string;
  action: string | null;
  repository: string;
  actor: string | null;
  attempts: number;
  /** Lease handed out with the claim; ack/fail must present it. */
  leaseId: string;
}

export interface EventFacts extends ClaimedEvent {
  /** Decoded provider payload, already size-capped by ingestion. */
  payload: Record<string, unknown>;
  /** PR/issue number when the provider payload names one. */
  number: number | null;
  title: string | null;
}

export interface RunOutcome {
  deliveryId: string;
  status: "succeeded" | "failed" | "skipped";
  /** `false` when the queue rejected the ack/fail, so the event will be redelivered. */
  settled: boolean;
  settlementError?: string;
  prompt: string;
  output?: string;
  error?: string;
  actionTypes: string[];
  durationMs: number;
}

export interface RunReport {
  repository: string;
  claimed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** Events the queue refused to settle (lease conflict/expired) — they will be retried. */
  unsettled: number;
  runs: RunOutcome[];
}

/** Anything the pipeline talks to on the other side of a DO stub. */
interface CoordinatorStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface PipelineDeps {
  repository: string;
  coordinator: CoordinatorStub;
  broker: CoordinatorStub;
  /** Control key: issues the capability each run uses to act. */
  controlKey: string;
  /** Seam for a model / `@cloudflare/computer` runtime. */
  executionFn?: AgentExecutionFn;
  /** Sinks for a run; defaults to the PR-review sink over the broker. */
  sinks?: readonly ActionSink[];
}

/**
 * Credentials for one run: every call asks the broker for a capability for the
 * exact (service, action) and presents it to `/proxy`. The agent never sees a
 * token, and the broker attaches the real credential upstream.
 */
export class BrokerCredentialBroker implements CredentialBroker {
  private readonly capabilities = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly broker: CoordinatorStub,
    private readonly controlKey: string,
    private readonly repository: string,
  ) {}

  async hasPermission(service: string, action: string): Promise<boolean> {
    const response = await this.broker.fetch(
      `https://credential-broker.internal/permissions?service=${encodeURIComponent(service)}&action=${encodeURIComponent(action)}`,
      { method: "GET" },
    );
    if (!response.ok) return false;
    const payload = (await response.json()) as { permitted?: unknown };
    return payload.permitted === true;
  }

  async executeSignedRequest<T = unknown>(request: CredentialCapabilityRequest): Promise<T> {
    const capability = await this.capabilityFor(request.service, request.action);
    const response = await this.broker.fetch("https://credential-broker.internal/proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability,
        params: request.params ?? {},
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      status?: number;
      body?: unknown;
      error?: string;
    };
    if (!response.ok || payload.ok !== true) {
      throw new Error(payload.error ?? `broker refused ${request.service}:${request.action}`);
    }
    // The broker returns the upstream body as a string (already scrubbed of the
    // credential); parse it when it is JSON so sinks get a real object.
    const body = payload.body;
    if (typeof body === "string") {
      try {
        return JSON.parse(body) as T;
      } catch {
        return body as unknown as T;
      }
    }
    return body as T;
  }

  private async capabilityFor(service: string, action: string): Promise<string> {
    const key = `${service}:${action}`;
    const cached = this.capabilities.get(key);
    const nowSeconds = Date.now() / 1000;
    if (cached && cached.expiresAt - CAPABILITY_SAFETY_MARGIN_SECONDS > nowSeconds) {
      return cached.token;
    }

    const response = await this.broker.fetch("https://credential-broker.internal/capabilities", {
      method: "POST",
      headers: { "content-type": "application/json", "x-factory-control-key": this.controlKey },
      body: JSON.stringify({ agent: agentIdFor(this.repository), service, action }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      capability?: string;
      expiresAt?: number;
      error?: string;
    };
    if (!response.ok || payload.ok !== true || typeof payload.capability !== "string") {
      throw new Error(payload.error ?? `could not obtain a capability for ${service}:${action}`);
    }
    this.capabilities.set(key, {
      token: payload.capability,
      expiresAt: typeof payload.expiresAt === "number" ? payload.expiresAt : nowSeconds + 60,
    });
    return payload.capability;
  }
}

/** Stable agent identity for a repository; provisioning is keyed by it. */
export function agentIdFor(repository: string): string {
  return `cloud-factory:${repository}`;
}

// ------------------------------------------------------------------ decisions

export interface Decision {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * The default agent policy, kept pure so it is unit-testable:
 * - `pull_request.opened|reopened|synchronize` → a COMMENT review;
 * - `issues.opened` → an issue comment;
 * - everything else → no action (the event is acknowledged and skipped, so the
 *   queue does not spin on events this agent does not care about).
 */
export function decideAction(facts: EventFacts): Decision | null {
  const number = facts.number;
  if (facts.event === "pull_request" && ["opened", "reopened", "synchronize"].includes(facts.action ?? "")) {
    if (number === null) return null;
    return {
      type: "github:pr:review",
      payload: {
        prNumber: number,
        event: "COMMENT",
        body: reviewBody(facts),
      },
    };
  }
  if (facts.event === "issues" && facts.action === "opened" && number !== null) {
    return {
      type: "github:issue:comment",
      payload: { issueNumber: number, body: issueBody(facts) },
    };
  }
  return null;
}

export function reviewBody(facts: EventFacts, reviewCount = 0): string {
  const title = facts.title ? ` (${facts.title})` : "";
  const attempt = reviewCount > 0 ? ` This is review #${reviewCount} for this repository.` : "";
  return `Automated review of #${facts.number ?? "?"}${title} on \`${facts.repository}\` by cloud-factory.${attempt}`;
}

export function issueBody(facts: EventFacts): string {
  const title = facts.title ? ` (${facts.title})` : "";
  return `Thanks for filing #${facts.number ?? "?"}${title} — cloud-factory picked it up.`;
}

/** A prompt from the event facts, so a model runtime gets the same context. */
export function promptFor(facts: EventFacts): string {
  return [
    `You are reviewing a ${facts.provider} ${facts.event} event (${facts.action ?? "no action"}) in ${facts.repository}.`,
    facts.title ? `Title: ${facts.title}` : "",
    facts.actor ? `Triggered by: ${facts.actor}` : "",
    "Decide whether to act and reply.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Deterministic agent runtime: decides an action, emits it through the context's
 * sinks (which route to the broker), and records a review counter in repo memory.
 */
export const ruleBasedReview: AgentExecutionFn = async ({ ctx, prompt }) => {
  const facts = ctx.state["event"] as EventFacts | undefined;
  if (!facts) {
    return { status: "failure", error: "no event facts in the run context", toolCallsCount: 0 };
  }

  const decision = decideAction(facts);
  if (!decision) {
    return { status: "success", output: `no action for ${facts.event}.${facts.action ?? "-"}`, toolCallsCount: 0 };
  }

  // The counter is the number of reviews that actually reached the provider; it
  // is read before the emit and written only after it succeeds, so a failed run
  // that is retried reports the same number instead of skipping one.
  let reviewCount = 0;
  if (facts.event === "pull_request") {
    const previous = await ctx.memory.get("repo", "review-count");
    reviewCount = typeof previous === "number" ? previous + 1 : 1;
    decision.payload["body"] = reviewBody(facts, reviewCount);
  }

  const results = await ctx.sinks.emit(decision, ctx);
  if (results.length === 0) {
    return { status: "failure", error: `no sink accepted ${decision.type}`, toolCallsCount: 0 };
  }
  const failures = results.filter((result) => !result.success);
  if (failures.length > 0) {
    return {
      status: "failure",
      error: failures.map((failure) => `${failure.sinkName}: ${failure.error ?? "unknown error"}`).join("; "),
      toolCallsCount: 0,
    };
  }
  if (reviewCount > 0) {
    await ctx.memory.set("repo", "review-count", reviewCount, { event: facts.deliveryId });
  }
  return { status: "success", output: prompt, toolCallsCount: 0 };
};

// ------------------------------------------------------------------- pipeline

export function defaultSinks(): ActionSink[] {
  return [
    new GitHubPRReviewSink({
      executor: async (payload, ctx) => {
        const result = await ctx.credentials.executeSignedRequest<{ status?: number }>({
          service: "github",
          action: "pr.review",
          params: {
            number: payload.prNumber,
            event: payload.event,
            body: payload.body,
          },
        });
        return { status: result?.status ?? 200 };
      },
    }),
    issueCommentSink(),
  ];
}

/** `issues.opened` → a comment on the issue (the policy's `issue.comment`). */
function issueCommentSink(): ActionSink {
  return {
    name: "github-issue-comment-sink",
    supportedActions: ["github:issue:comment"],
    canHandle: (action) => action.type === "github:issue:comment",
    async handle(action, ctx: AgentContext) {
      const start = Date.now();
      const payload = action.payload as { issueNumber?: unknown; body?: unknown };
      if (typeof payload.issueNumber !== "number" || typeof payload.body !== "string" || payload.body.length === 0) {
        return {
          sinkName: "github-issue-comment-sink",
          actionId: action.id,
          actionType: action.type,
          success: false,
          error: "invalid payload: issueNumber and body are required",
          durationMs: Date.now() - start,
        };
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
        return {
          sinkName: "github-issue-comment-sink",
          actionId: action.id,
          actionType: action.type,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - start,
        };
      }
    },
  };
}

export function buildContext(deps: PipelineDeps, facts: EventFacts, runtime: AgentRuntime): AgentContext {
  const [owner, name] = facts.repository.split("/");
  const ctx = createAgentContext({
    id: `run:${facts.deliveryId}`,
    repo: { owner: owner ?? "", name: name ?? "" },
    org: { id: owner ?? "" },
    actor: { type: facts.actor === null ? "system" : "user", id: facts.actor ?? "cloud-factory" },
    memory: new CoordinatorMemoryStore(deps.coordinator),
    credentials: new BrokerCredentialBroker(deps.broker, deps.controlKey, deps.repository),
    sinks: runtime.sinks,
    state: { event: facts },
  });
  return ctx;
}

/** Runs one agent invocation for a claimed event; never throws. */
export async function runEvent(deps: PipelineDeps, event: ClaimedEvent): Promise<RunOutcome> {
  const startedAt = Date.now();
  const executionFn = deps.executionFn ?? ruleBasedReview;
  const base: RunOutcome = {
    deliveryId: event.deliveryId,
    status: "failed",
    settled: true,
    prompt: "",
    actionTypes: [],
    durationMs: 0,
  };

  try {
    const facts = await loadFacts(deps.coordinator, event);
    const emitted: string[] = [];
    const runtime = new AgentRuntime();
    for (const sink of recordingSinks(deps.sinks ?? defaultSinks(), emitted)) {
      runtime.registerSink(sink);
    }
    const ctx = buildContext(deps, facts, runtime);
    const prompt = promptFor(facts);

    const summary = await runtime.runAgent(prompt, ctx, executionFn);

    if (summary.status === "failure") {
      return { ...base, prompt, status: "failed", error: summary.error ?? "run failed", actionTypes: emitted };
    }
    if (summary.status === "cancelled") {
      return { ...base, prompt, status: "failed", error: sequenceReason(summary.error), actionTypes: emitted };
    }
    return {
      ...base,
      prompt,
      // Nothing emitted means the agent decided this event needs no action;
      // acknowledging it keeps the queue from retrying it forever.
      status: emitted.length === 0 ? "skipped" : "succeeded",
      output: summary.output,
      actionTypes: emitted,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

/** Wraps sinks so the report can name what a run emitted, without monkey-patching. */
export function recordingSinks(sinks: readonly ActionSink[], emitted: string[]): ActionSink[] {
  return sinks.map((sink) => ({
    name: sink.name,
    supportedActions: sink.supportedActions,
    ...(sink.canHandle === undefined ? {} : { canHandle: sink.canHandle.bind(sink) }),
    handle: async (action, ctx) => {
      emitted.push(action.type);
      return sink.handle(action, ctx);
    },
  }));
}

function sequenceReason(reason: string | undefined): string {
  return reason === undefined || reason.length === 0 ? "run cancelled" : reason;
}

async function loadFacts(coordinator: CoordinatorStub, event: ClaimedEvent): Promise<EventFacts> {
  const response = await coordinator.fetch(
    `https://repo-coordinator.internal/events/${encodeURIComponent(event.deliveryId)}/payload`,
    { method: "GET" },
  );
  if (!response.ok) {
    throw new Error(`could not load payload for ${event.deliveryId} (${response.status})`);
  }
  const body = (await response.json()) as { payload?: unknown };
  const payload =
    typeof body.payload === "object" && body.payload !== null ? (body.payload as Record<string, unknown>) : {};
  return {
    ...event,
    payload,
    number: numberFrom(payload),
    title: titleFrom(payload),
  };
}

/** `pull_request.number` / `issue.number` / `number`, whichever the provider sent. */
export function numberFrom(payload: Record<string, unknown>): number | null {
  const candidates = [payload["number"], (payload["pull_request"] as { number?: unknown })?.number, (payload["issue"] as { number?: unknown })?.number];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) return candidate;
  }
  return null;
}

export function titleFrom(payload: Record<string, unknown>): string | null {
  const candidates = [
    payload["title"],
    (payload["pull_request"] as { title?: unknown })?.title,
    (payload["issue"] as { title?: unknown })?.title,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim().slice(0, 200);
  }
  return null;
}

/**
 * Claims and processes one batch. Each event is acked (succeeded/skipped) or
 * failed with its error; one bad event never stops the batch.
 */
/**
 * Acks a finished run, or fails it when the run itself failed. A non-2xx answer
 * is reported, never swallowed (the event is still leased and will come back).
 */
async function settle(
  deps: PipelineDeps,
  event: ClaimedEvent,
  outcome: RunOutcome,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const failed = outcome.status === "failed";
  const path = failed ? "/fail" : "/ack";
  const body: Record<string, unknown> = {
    claims: [{ deliveryId: event.deliveryId, leaseId: event.leaseId }],
  };
  if (failed) body["error"] = (outcome.error ?? "run failed").slice(0, 500);

  let response: Response;
  try {
    response = await deps.coordinator.fetch(`https://repo-coordinator.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, error: `${path} failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      ok: false,
      error: `${path} was refused (${response.status})${detail.length > 0 ? `: ${detail.slice(0, 200)}` : ""}`,
    };
  }
  return { ok: true };
}

export async function drainRepository(
  deps: PipelineDeps,
  options: { limit?: number; visibilityMs?: number } = {},
): Promise<RunReport> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_RUN_BATCH, 1), 100);
  const visibilityMs = options.visibilityMs ?? DEFAULT_RUN_VISIBILITY_MS;

  const claimResponse = await deps.coordinator.fetch("https://repo-coordinator.internal/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit, visibilityMs }),
  });
  if (!claimResponse.ok) {
    throw new Error(`could not claim events (${claimResponse.status})`);
  }
  const claim = (await claimResponse.json()) as { claimed?: ClaimedEvent[] };
  const claimed = Array.isArray(claim.claimed) ? claim.claimed : [];

  const report: RunReport = {
    repository: deps.repository,
    claimed: claimed.length,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    unsettled: 0,
    runs: [],
  };

  for (const event of claimed) {
    const outcome = await runEvent(deps, event);

    // The run's own result and the queue's settlement are separate facts: a
    // rejected ack/fail means the event will be redelivered, so the report must
    // not present it as a clean success.
    const settlement = await settle(deps, event, outcome);
    if (!settlement.ok) {
      outcome.settled = false;
      outcome.settlementError = settlement.error;
    }

    report.runs.push(outcome);
    if (outcome.status === "failed") report.failed += 1;
    else if (outcome.status === "skipped") report.skipped += 1;
    else report.succeeded += 1;
    if (!outcome.settled) report.unsettled += 1;
  }

  return report;
}
