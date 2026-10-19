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
  SINK_TYPES,
  allSinks,
  canonicalSinkTypes,
  type SinkDeps,
} from "./action-sinks";
import {
  AgentRuntime,
  CoordinatorMemoryStore,
  createAgentContext,
  type ActionSink,
  type AgentContext,
  type AgentExecutionFn,
  type CredentialBroker,
  type CredentialCapabilityRequest,
  type MemoryScope,
} from "@factory-cloud/sdk";

/** How many events one drain handles, and how long a claim is held. */
export const DEFAULT_RUN_BATCH = 10;
export const DEFAULT_RUN_VISIBILITY_MS = 60_000;
const CAPABILITY_SAFETY_MARGIN_SECONDS = 30;

/**
 * A capability request plus the one thing a sink may need beyond it: the upstream
 * status, so it can tell an accepted provider call from a rejected one.
 */
type CapabilityRequest = CredentialCapabilityRequest & { readonly includeStatus?: boolean };

function parseJsonOrString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** What the decision loop uses to make each action idempotent (cloud-factory-cf-j1y). */
export interface ActionLedger {
  claim(actionType: string): Promise<"run" | "skip" | "unavailable">;
  complete(actionType: string, status: "delivered" | "failed"): Promise<string | null>;
}

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
  /** True when the (event, agent) pair had already delivered, so this is not a second side effect. */
  duplicate?: boolean;
  /**
   * Set when the side effects happened but the delivery ledger could not record
   * them. The event is still acknowledged — retrying would repeat provider calls
   * — but the gap is reported instead of hidden (cloud-factory-cf-lbi).
   */
  deliveryError?: string;
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
  /** Sinks for a run; defaults to the sinks the layout wired. */
  sinks?: readonly ActionSink[];
  /** Where telemetry is exported; absent means the structured log. */
  telemetryEndpoint?: string;
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

  async executeSignedRequest<T = unknown>(request: CapabilityRequest): Promise<T> {
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
    // A sink that has to tell "the provider accepted this" from "the provider
    // rejected it" asks for the status; without it a 500 upstream looks like a
    // success (cloud-factory-cf-2f5).
    if (request.includeStatus === true) {
      return {
        status: payload.status ?? 0,
        body: typeof payload.body === "string" ? parseJsonOrString(payload.body) : payload.body,
      } as T;
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
 * Everything the deterministic agent does for an event, given the sink types the
 * layout wired. A wired provider sink produces its action; with no wiring (the
 * queue route) the base decision is the whole answer.
 */
export function actionsFor(facts: EventFacts, wired: readonly string[] | undefined, reviewCount = 0): Decision[] {
  const actions: Decision[] = [];
  const base = decideAction(facts);
  const wiredTypes =
    wired === undefined ? ["github-pr-review", "github-issue-comment"] : canonicalSinkTypes(wired);
  const wants = (type: string) => wiredTypes.includes(type) || wiredTypes.includes("*");

  if (base !== null && wants(base.type === "github:pr:review" ? "github-pr-review" : "github-issue-comment")) {
    if (facts.event === "pull_request") base.payload["body"] = reviewBody(facts, reviewCount);
    actions.push(base);
  }
  const summary = `#${facts.number ?? "?"} in ${facts.repository}`;
  const detail = facts.title === null ? summary : `${summary}: ${facts.title}`;
  if (wants("github-issue-create")) {
    actions.push({
      type: "github:issue:create",
      payload: {
        title: `Follow up on ${detail}`,
        body: `Raised by cloud-factory from ${facts.event}.${facts.action ?? ""}`.trim(),
      },
    });
  }
  if (wants("beads-task")) {
    actions.push({
      type: "beads:task:create",
      payload: {
        title: `Act on ${detail}`,
        description: `cloud-factory task for ${facts.event}.${facts.action ?? "-"} (${facts.deliveryId})`,
        priority: "P2",
      },
    });
  }
  if (wants("telemetry") || wants("cloud-telemetry")) {
    actions.push({
      type: "telemetry:log",
      payload: {
        level: "info",
        message: `handled ${facts.event}.${facts.action ?? "-"} for ${facts.repository}`,
        attributes: { deliveryId: facts.deliveryId, repository: facts.repository },
      },
    });
  }
  return actions;
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
  // A canvas agent supplies the instruction; the deterministic runtime keeps the
  // decision rules but records the instruction it acted under.
  const agentPrompt = ctx.state["agentPrompt"];
  const instruction = typeof agentPrompt === "string" && agentPrompt.trim().length > 0 ? agentPrompt.trim() : null;

  // The counter is the number of reviews that actually reached the provider; it
  // is read before the emit and written only after it succeeds, so a failed run
  // that is retried reports the same number instead of skipping one.
  const memoryScope: MemoryScope = ctx.state["memoryScope"] === "org" ? "org" : "repo";
  let reviewCount = 0;
  if (facts.event === "pull_request") {
    const previous = await ctx.memory.get(memoryScope, "review-count");
    reviewCount = typeof previous === "number" ? previous + 1 : 1;
  }

  // The layout decides what the agent does: a wired sink contributes its action,
  // and nothing else is emitted (cloud-factory-cf-n4s).
  const wired = Array.isArray(ctx.state["wiredSinks"]) ? (ctx.state["wiredSinks"] as string[]) : undefined;
  const decisions = actionsFor(facts, wired, reviewCount);
  if (decisions.length === 0) {
    const output =
      decideAction(facts) === null
        ? `no action for ${facts.event}.${facts.action ?? "-"}`
        : "nothing to do: the wiring has no sink this event can use";
    return { status: "success", output, toolCallsCount: 0 };
  }

  const ledger = ctx.state["actionLedger"] as ActionLedger | undefined;
  const results = [];
  for (const decision of decisions) {
    // Skip an action this pair already delivered; refuse to start one when the
    // ledger cannot answer, because repeating a provider call is worse than
    // reporting the gap (cloud-factory-cf-j1y).
    const permission = ledger === undefined ? "run" : await ledger.claim(decision.type);
    if (permission === "skip") continue;
    if (permission === "unavailable") {
      results.push({
        sinkName: "delivery-ledger",
        actionId: decision.type,
        actionType: decision.type,
        success: false,
        error: "delivery ledger unavailable, so the action was not started",
        durationMs: 0,
      });
      continue;
    }
    const emitted = await ctx.sinks.emit(decision, ctx);
    const failed = emitted.some((result) => !result.success) || emitted.length === 0;
    const completionError = await ledger?.complete(decision.type, failed ? "failed" : "delivered");
    if (completionError !== null && completionError !== undefined) {
      if (failed) {
        // The provider rejected the action, so nothing was delivered and a retry is
        // safe: recording the gap here would acknowledge the event and silently
        // drop a comment or task that never happened (finding cloud-factory-cf-uil).
        // The action's own failure is already in the run's result.
      } else {
        // The side effect happened but could not be recorded: retrying would repeat
        // it, so the gap is reported and the run is settled rather than retried
        // (findings cloud-factory-cf-lbi / -835).
        const errors = (ctx.state["actionDeliveryErrors"] as string[] | undefined) ?? [];
        errors.push(`${decision.type}: ${completionError}`);
        ctx.state["actionDeliveryErrors"] = errors;
      }
    }
    results.push(...emitted);
  }
  if (results.length === 0) {
    // Every action was already delivered by an earlier attempt.
    return {
      status: "success",
      output: `all actions for ${facts.deliveryId} were already delivered`,
      toolCallsCount: 0,
    };
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
    await ctx.memory.set(memoryScope, "review-count", reviewCount, { event: facts.deliveryId });
  }
  return {
    status: "success",
    output: instruction === null ? prompt : `${instruction}\n\n${prompt}`,
    toolCallsCount: 0,
  };
};

// ------------------------------------------------------------------- pipeline

export function defaultSinks(deps: SinkDeps = {}): ActionSink[] {
  const catalogue = allSinks(deps);
  return ["github-pr-review-sink", "github-issue-comment-sink"].map((name) => catalogue[name] as ActionSink);
}

function sinkDeps(deps: PipelineDeps): SinkDeps {
  return deps.telemetryEndpoint === undefined ? {} : { telemetryEndpoint: deps.telemetryEndpoint };
}

export function buildContext(
  deps: PipelineDeps,
  facts: EventFacts,
  runtime: AgentRuntime,
  options: RunEventOptions = {},
): AgentContext {
  const [owner, name] = facts.repository.split("/");
  const ctx = createAgentContext({
    id: `run:${facts.deliveryId}`,
    repo: { owner: owner ?? "", name: name ?? "" },
    org: { id: owner ?? "" },
    actor: { type: facts.actor === null ? "system" : "user", id: facts.actor ?? "cloud-factory" },
    memory: new CoordinatorMemoryStore(deps.coordinator),
    credentials: new BrokerCredentialBroker(deps.broker, deps.controlKey, deps.repository),
    sinks: runtime.sinks,
    state: {
      event: facts,
      ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
      ...(options.agentPrompt === undefined ? {} : { agentPrompt: options.agentPrompt }),
      ...(options.memoryScope === undefined ? {} : { memoryScope: options.memoryScope }),
      ...(options.sinks === undefined ? {} : { wiredSinks: [...options.sinks] }),
    },
  });
  return ctx;
}

/** Which sinks a run may use, and the agent it belongs to. */
export interface RunEventOptions {
  /** Canvas sink types wired to the agent; omitted means the default set. */
  sinks?: readonly string[];
  agentPrompt?: string;
  agentId?: string;
  /** Memory scope from the agent's wiring (`repo` unless a hub says otherwise). */
  memoryScope?: string;
}

export function sinksFor(types: readonly string[] | undefined, deps: SinkDeps = {}): ActionSink[] {
  const catalogue = allSinks(deps);
  // No wiring at all means "the default agent" (the queue route), which uses the
  // standard sinks. Wiring that names sinks means only those: if none of the
  // names is one we implement, the agent gets no sink and the run fails loudly
  // instead of quietly posting to a provider the layout never asked for
  // (finding cloud-factory-cf-xkg).
  const names =
    types === undefined
      ? new Set(["github-pr-review-sink", "github-issue-comment-sink"])
      : new Set(types.map((type) => SINK_TYPES[type]).filter((name): name is string => name !== undefined));
  // Match on the catalogue key, not the sink's own `name`: an SDK sink carries
  // its own default name.
  return Object.entries(catalogue)
    .filter(([key]) => names.has(key))
    .map(([, sink]) => sink);
}

/** Runs one agent invocation for a claimed event; never throws. */
/** Hands a claimed event back to the queue without spending an attempt. */
async function releaseEvent(deps: PipelineDeps, event: ClaimedEvent): Promise<boolean> {
  try {
    const response = await deps.coordinator.fetch("https://repo-coordinator.internal/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claims: [{ deliveryId: event.deliveryId, leaseId: event.leaseId }] }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Asks the repository's ledger whether this (event, agent) pair still has work.
 * Anything but a definitive answer is `unavailable`: without the ledger the run
 * cannot promise idempotency, so it does not start.
 */
async function claimDelivery(
  deps: PipelineDeps,
  deliveryId: string,
  agentId: string,
  skipIfAnyDelivered = false,
): Promise<"run" | "skip" | "unavailable"> {
  try {
    const response = await deps.coordinator.fetch("https://repo-coordinator.internal/deliveries/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId, agentId, ...(skipIfAnyDelivered ? { skipIfAnyDelivered: true } : {}) }),
    });
    if (!response.ok) return "unavailable";
    const payload = (await response.json().catch(() => ({}))) as { run?: unknown };
    return payload.run === false ? "skip" : "run";
  } catch {
    return "unavailable";
  }
}

/**
 * Records what happened after the side effects. A rejected write is retried, and
 * if it keeps failing the run reports it (`deliveryError`) instead of pretending
 * the pair was recorded: the event is acknowledged (a retry would repeat the
 * provider call) and the gap stays visible to an operator.
 */
async function completeDelivery(
  deps: PipelineDeps,
  deliveryId: string,
  agentId: string,
  status: "delivered" | "failed",
): Promise<string | null> {
  let lastError = "delivery ledger did not record the run";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await deps.coordinator.fetch("https://repo-coordinator.internal/deliveries/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deliveryId, agentId, status }),
      });
      if (response.ok) return null;
      lastError = `delivery ledger rejected the completion (${response.status})`;
    } catch (error) {
      lastError = `delivery ledger unreachable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return lastError;
}

export async function runEvent(
  deps: PipelineDeps,
  event: ClaimedEvent,
  options: RunEventOptions = {},
): Promise<RunOutcome> {
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
    const sinks = deps.sinks ?? sinksFor(options.sinks, sinkDeps(deps));
    if (sinks.length === 0 && deps.sinks === undefined && options.sinks !== undefined) {
      // The layout named sinks and this worker serves none of them. Saying so is
      // the point: silently doing nothing (or falling back to a provider the
      // layout never asked for) would hide a broken layout
      // (findings cloud-factory-cf-xkg / cloud-factory-cf-n4s).
      return {
        ...base,
        prompt: promptFor(facts),
        status: "failed",
        error: `no sink in the wiring is one this worker can serve: ${options.sinks.join(", ")}`,
      };
    }
    for (const sink of recordingSinks(sinks, emitted)) {
      runtime.registerSink(sink);
    }
    const prompt = promptFor(facts);

    // Enforce the delivery ledger here, not in a caller: every runner shares this
    // path, so the queue drain cannot bypass idempotency the way it could when
    // only the canvas route consulted the ledger (cloud-factory-cf-7wj).
    const agentKey = options.agentId ?? "default";
    const permission = await claimDelivery(deps, event.deliveryId, agentKey, options.agentId === undefined);
    if (permission === "skip") {
      return {
        ...base,
        prompt,
        status: "succeeded",
        duplicate: true,
        actionTypes: [],
        output: `already delivered ${event.deliveryId} as ${agentKey}`,
      };
    }
    if (permission === "unavailable") {
      return {
        ...base,
        prompt,
        status: "failed",
        error: "delivery ledger unavailable, so the run was not started",
      };
    }

    const ctx = buildContext(deps, facts, runtime, options);
    // Per-action idempotency: one agent can emit several actions (an issue and a
    // beads task, say), so a partial failure must retry only the actions that
    // failed. The pair-level claim above cannot express that
    // (cloud-factory-cf-j1y).
    ctx.state["actionLedger"] = {
      claim: (actionType: string) => claimDelivery(deps, event.deliveryId, `${agentKey}#${actionType}`),
      complete: (actionType: string, status: "delivered" | "failed") =>
        completeDelivery(deps, event.deliveryId, `${agentKey}#${actionType}`, status),
    } satisfies ActionLedger;
    const summary = await runtime.runAgent(prompt, ctx, executionFn);

    const pairDeliveryError = await completeDelivery(
      deps,
      event.deliveryId,
      agentKey,
      summary.status === "success" ? "delivered" : "failed",
    );
    // A rejected write only means "the side effect may have happened" when the run
    // actually succeeded. For a failed run nothing was delivered, so the event must
    // stay retryable — recording a gap there acknowledges it and drops the work
    // (findings cloud-factory-cf-uil / -lbi pair level).
    const pairGap = summary.status === "success" ? pairDeliveryError : null;
    const actionErrors = (ctx.state["actionDeliveryErrors"] as string[] | undefined) ?? [];
    const deliveryError =
      [pairGap, ...actionErrors].filter((entry): entry is string => typeof entry === "string").join("; ") || null;
    if (summary.status === "failure") {
      return {
        ...base,
        prompt,
        status: "failed",
        error: summary.error ?? "run failed",
        actionTypes: emitted,
        ...(deliveryError === null ? {} : { deliveryError }),
      };
    }
    if (summary.status === "cancelled") {
      return {
        ...base,
        prompt,
        status: "failed",
        error: sequenceReason(summary.error),
        actionTypes: emitted,
        ...(deliveryError === null ? {} : { deliveryError }),
      };
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
      ...(deliveryError === null ? {} : { deliveryError }),
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
export async function settleEvent(
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

    // An event another runner already delivered is handed back rather than
    // acknowledged: this drain has no work for it, but a canvas run still might
    // (it knows which agents the event is wired to and which of them failed).
    if (outcome.duplicate === true) {
      const released = await releaseEvent(deps, event);
      if (!released) {
        outcome.settled = false;
        outcome.settlementError = "could not release an already-delivered event";
      }
      report.runs.push(outcome);
      report.skipped += 1;
      if (!outcome.settled) report.unsettled += 1;
      continue;
    }

    // A run whose provider side effect happened but could not be recorded must
    // not be retried: that repeats the side effect. Acknowledge it and let the
    // report carry the gap (same stance as chooseSettlement for fan-out).
    if (outcome.deliveryError !== undefined) {
      const settledAnyway = await settleEvent(deps, event, { ...outcome, status: "succeeded" });
      if (!settledAnyway.ok) {
        outcome.settled = false;
        outcome.settlementError = settledAnyway.error;
      }
      report.runs.push(outcome);
      if (outcome.status === "failed") report.failed += 1;
      else report.succeeded += 1;
      if (!outcome.settled) report.unsettled += 1;
      continue;
    }

    // The run's own result and the queue's settlement are separate facts: a
    // rejected ack/fail means the event will be redelivered, so the report must
    // not present it as a clean success.
    const settlement = await settleEvent(deps, event, outcome);
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
