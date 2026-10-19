/**
 * Canvas-driven runs: a stored layout is the agent configuration, so creating a
 * run means resolving the document, planning one run per agent node, and
 * sending the queued events each agent's sources name through the execution
 * pipeline.
 *
 * The document stays the source of truth: the plan is derived from the same
 * `toAgentConfig()` the canvas exports, from the shared
 * `@factory-cloud/canvas-model` package, so a layout cannot mean one thing in
 * the browser and another in the worker.
 */
import {
  parseDoc,
  toAgentConfig,
  type AgentConfig,
  type CanvasDoc,
} from "@factory-cloud/canvas-model";
import {
  runEvent,
  settleEvent,
  type ClaimedEvent,
  type PipelineDeps,
  type RunOutcome,
} from "./pipeline";

/** Default events per run, and the cap a caller can ask for. */
export const DEFAULT_EVENTS_PER_RUN = 5;
export const MAX_EVENTS_PER_RUN = 50;

export interface AgentSource {
  provider: string;
  event: string;
}

export interface AgentPlan {
  id: string;
  name: string;
  prompt: string;
  model: string;
  sources: AgentSource[];
  memoryScope: string | null;
  sinks: string[];
}

export interface AgentRunSummary {
  agentId: string;
  name: string;
  sources: AgentSource[];
  sinks: string[];
  /** Events this agent ran; empty when nothing matched. */
  runs: RunOutcome[];
  status: "ran" | "no-events" | "failed";
  error?: string;
}

/**
 * How one event settles after fan-out (cloud-factory-cf-lbi).
 *
 * A failed agent is retried, but an agent whose side effects happened and whose
 * ledger write was lost must never run again — so if any outcome carries a
 * `deliveryError`, the event is acknowledged and the gap is reported instead of
 * failing it and repeating that agent's provider call.
*/
export function chooseSettlement(outcomes: readonly RunOutcome[]): {
  outcome: RunOutcome;
  retry: boolean;
  ledgerErrors: string[];
} {
  const ledgerErrors = outcomes
    .map((outcome) => outcome.deliveryError)
    .filter((error): error is string => error !== undefined);
  const synthetic: RunOutcome = {
    deliveryId: outcomes[0]?.deliveryId ?? "",
    status: "skipped",
    settled: true,
    prompt: "",
    actionTypes: [],
    durationMs: 0,
  };
  const outcome = outcomes[0] ?? synthetic;
  if (ledgerErrors.length > 0) {
    // Force a success-shaped settlement: the side effect happened and could not be
    // recorded, so the event must be acknowledged. Falling back to a failed
    // outcome would `/fail` it and the retry would repeat the provider call
    // (finding cloud-factory-cf-ww9).
    const delivered = outcomes.find((entry) => entry.status !== "failed") ?? outcome;
    return { outcome: { ...delivered, status: "succeeded" }, retry: false, ledgerErrors };
  }
  const failure = outcomes.find((entry) => entry.status === "failed");
  return { outcome: failure ?? outcome, retry: failure !== undefined, ledgerErrors };
}

export interface CanvasRunReport {
  documentId: string;
  name: string;
  agents: AgentRunSummary[];
  /** Agent executions (an event wired to two agents counts twice). */
  ran: number;
/** Events claimed and settled in this run. */
  events: number;
  /** Agent executions skipped because that (event, agent) pair had already delivered. */
  deduped: number;
  /** Delivery-ledger write failures: the side effect happened but is not recorded. */
  ledgerErrors: string[];
  failed: number;
}

export type PlanResult = { ok: true; plan: AgentPlan[]; name: string } | { ok: false; error: string };

/**
 * Turns a stored document into a run plan. Pure, so the route can reject a bad
 * layout before anything is claimed from the queue.
 */
export function planAgents(document: unknown): PlanResult {
  const parsed = parseDocument(document);
  if (!parsed.ok) return parsed;

  const config: AgentConfig = toAgentConfig(parsed.doc);
  if (config.agents.length === 0) {
    return { ok: false, error: "the layout has no agent nodes, so there is nothing to run" };
  }

  const plan: AgentPlan[] = [];
  for (const agent of config.agents) {
    const prompt = agent.prompt.trim();
    if (prompt.length === 0) {
      return { ok: false, error: `agent “${agent.name}” has no prompt, so it cannot run` };
    }
    const sources = agent.sources.map(toSource).filter((source): source is AgentSource => source !== null);
    if (sources.length === 0) {
      return { ok: false, error: `agent “${agent.name}” has no event source wired to it` };
    }
    plan.push({
      id: agent.id,
      name: agent.name,
      prompt,
      model: agent.model,
      sources,
      memoryScope: scopeOf(agent.memory),
      sinks: agent.sinks.map((sink) => sink.config["type"] ?? "").filter((type) => type.length > 0),
    });
  }
  return { ok: true, plan, name: parsed.doc.nodes.length === 0 ? "Untitled canvas" : "Canvas layout" };
}

function parseDocument(document: unknown): { ok: true; doc: CanvasDoc } | { ok: false; error: string } {
  if (typeof document === "string") {
    const doc = parseDoc(document);
    return doc === null
      ? { ok: false, error: "the stored document is not a canvas this version can read" }
      : { ok: true, doc };
  }
  if (typeof document === "object" && document !== null) {
    const doc = parseDoc(JSON.stringify(document));
    return doc === null
      ? { ok: false, error: "the stored document is not a canvas this version can read" }
      : { ok: true, doc };
  }
  return { ok: false, error: "the stored document is missing" };
}

function toSource(node: { config: Record<string, string> }): AgentSource | null {
  const provider = (node.config["provider"] ?? "").trim();
  const event = (node.config["event"] ?? "").trim();
  if (provider.length === 0 || event.length === 0) return null;
  return { provider, event };
}

function scopeOf(memory: Array<{ config: Record<string, string> }>): string | null {
  for (const hub of memory) {
    const scope = (hub.config["scope"] ?? "").trim();
    if (scope.length > 0) return scope;
  }
  return null;
}

/** `provider:event`, or `provider:*` when the source names every event. */
export function sourceMatches(source: AgentSource, event: { provider: string; event: string }): boolean {
  return source.provider === event.provider && (source.event === "*" || source.event === event.event);
}

/**
 * Runs a stored layout: one claim per agent, filtered by that agent's sources.
 * Agents run in document order, so a report reads like the canvas.
 */
export async function runCanvasDocument(
  deps: PipelineDeps,
  documentId: string,
  options: { limit?: number } = {},
): Promise<{ ok: true; report: CanvasRunReport } | { ok: false; error: string }> {
  const stored = await deps.coordinator.fetch(
    `https://repo-coordinator.internal/canvas/${encodeURIComponent(documentId)}`,
    { method: "GET" },
  );
  if (stored.status === 404) return { ok: false, error: "no such document in this repository" };
  if (!stored.ok) return { ok: false, error: `could not read the document (${stored.status})` };

  const body = (await stored.json().catch(() => ({}))) as { name?: unknown; document?: unknown };
  const planned = planAgents(body.document);
  if (!planned.ok) return planned;

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_EVENTS_PER_RUN, 1), MAX_EVENTS_PER_RUN);
  const report: CanvasRunReport = {
    documentId,
    name: typeof body.name === "string" && body.name.length > 0 ? body.name : planned.name,
    agents: planned.plan.map((agent) => ({
      agentId: agent.id,
      name: agent.name,
      sources: agent.sources,
      sinks: agent.sinks,
      runs: [],
      status: "no-events",
    })),
    ran: 0,
    events: 0,
    deduped: 0,
    ledgerErrors: [],
    failed: 0,
  };

  const claimed = await claim(deps, limit);
  for (const event of claimed) {
    // Fan-out: one event runs every agent whose sources name it, and the event is
    // settled once. The wiring on the canvas reads as fan-out — one source
    // feeding two agents means both act on the event (finding cloud-factory-cf-sdq).
    const agents = planned.plan.filter((agent) =>
      agent.sources.some((source) => sourceMatches(source, event)),
    );
    if (agents.length === 0) {
      // Nobody wants it: hand it back without spending an attempt.
      await release(deps, [event]);
      continue;
    }

    report.events += 1;
    const outcomes: RunOutcome[] = [];
    for (const agent of agents) {
      // runEvent enforces the delivery ledger for every runner, so a pair that
      // already delivered comes back as `duplicate` instead of acting again, and
      // the queue drain cannot bypass it (cloud-factory-cf-7wj / -lbi).
      const outcome = await runEvent(deps, event, {
        agentPrompt: agent.prompt,
        agentId: agent.id,
        sinks: agent.sinks,
        ...(agent.memoryScope === null ? {} : { memoryScope: agent.memoryScope }),
      });
      outcomes.push(outcome);
      if (outcome.duplicate === true) {
        report.deduped += 1;
      } else {
        report.ran += 1;
      }

      const summary = report.agents.find((entry) => entry.agentId === agent.id);
      if (summary) {
        summary.runs.push(outcome);
        if (outcome.status === "failed") {
          summary.status = "failed";
          summary.error = outcome.error;
        } else if (summary.status !== "failed") {
          summary.status = "ran";
        }
      }
      if (outcome.status === "failed") report.failed += 1;
    }

    // Settlement follows the event, not the agent: ack only when every agent
    // succeeded, unless a ledger write was lost — then an ack is the only way to
    // avoid repeating a delivered agent, and the gap is reported
    // (cloud-factory-cf-lbi).
    const chosen = chooseSettlement(outcomes);
    report.ledgerErrors.push(...chosen.ledgerErrors);
    const settlement = await settleEvent(deps, event, chosen.outcome);
    if (!settlement.ok) {
      for (const outcome of outcomes) {
        outcome.settled = false;
        outcome.settlementError = settlement.error;
      }
    }
  }

  await deps.coordinator.fetch("https://repo-coordinator.internal/runs/audit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documentId,
      name: report.name,
      agents: report.agents.map((agent) => ({
        agentId: agent.agentId,
        status: agent.status,
        deliveryIds: agent.runs.map((run) => run.deliveryId),
        error: agent.error,
      })),
    }),
  });

  return { ok: true, report };
}



async function claim(deps: PipelineDeps, limit: number): Promise<ClaimedEvent[]> {
  const response = await deps.coordinator.fetch("https://repo-coordinator.internal/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit: Math.min(Math.max(limit, 1), 100) }),
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as { claimed?: ClaimedEvent[] };
  return Array.isArray(payload.claimed) ? payload.claimed : [];
}

/** One claim per delivery id, keeping order; a lease is released at most once. */
export function uniqueClaims(events: ClaimedEvent[]): ClaimedEvent[] {
  const seen = new Map<string, ClaimedEvent>();
  for (const event of events) {
    if (!seen.has(event.deliveryId)) seen.set(event.deliveryId, event);
  }
  return [...seen.values()];
}

/** Puts claimed events back without counting an attempt. */
async function release(deps: PipelineDeps, events: ClaimedEvent[]): Promise<void> {
  const unique = uniqueClaims(events);
  if (unique.length === 0) return;
  await deps.coordinator.fetch("https://repo-coordinator.internal/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ claims: unique.map((event) => ({ deliveryId: event.deliveryId, leaseId: event.leaseId })) }),
  });
}
