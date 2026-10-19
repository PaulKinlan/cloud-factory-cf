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

/** Default events per agent, and the cap a caller can ask for. */
export const DEFAULT_EVENTS_PER_AGENT = 5;
export const MAX_EVENTS_PER_AGENT = 50;

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
  /** Events this agent claimed and ran; empty when nothing matched. */
  runs: RunOutcome[];
  status: "ran" | "no-events" | "failed";
  error?: string;
}

export interface CanvasRunReport {
  documentId: string;
  name: string;
  agents: AgentRunSummary[];
  ran: number;
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

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_EVENTS_PER_AGENT, 1), MAX_EVENTS_PER_AGENT);
  const report: CanvasRunReport = {
    documentId,
    name: typeof body.name === "string" && body.name.length > 0 ? body.name : planned.name,
    agents: [],
    ran: 0,
    failed: 0,
  };

  for (const agent of planned.plan) {
    const summary = await runAgent(deps, agent, limit);
    report.agents.push(summary);
    report.ran += summary.runs.length;
    if (summary.status === "failed") report.failed += 1;
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

async function runAgent(deps: PipelineDeps, agent: AgentPlan, limit: number): Promise<AgentRunSummary> {
  const summary: AgentRunSummary = {
    agentId: agent.id,
    name: agent.name,
    sources: agent.sources,
    sinks: agent.sinks,
    runs: [],
    status: "no-events",
  };

  const claimed = await claim(deps, limit * 4);
  const matching = claimed.filter((event) =>
    agent.sources.some((source) => sourceMatches(source, event)),
  );
  const running = matching.slice(0, limit);
  // Matched but over this run's limit: they go straight back on the queue rather
  // than sitting on a lease until it expires and wasting an attempt
  // (finding cloud-factory-cf-mj7).
  const deferred = matching.slice(limit);

  for (const event of running) {
    // The agent's own prompt and wiring drive the run; the deterministic runtime
    // still decides what it can actually deliver today.
    const outcome = await runEvent(deps, event, {
      agentPrompt: agent.prompt,
      agentId: agent.id,
      sinks: agent.sinks,
      ...(agent.memoryScope === null ? {} : { memoryScope: agent.memoryScope }),
    });
    summary.runs.push(outcome);
    if (outcome.status === "failed") {
      summary.status = "failed";
      summary.error = outcome.error;
    } else if (summary.status !== "failed") {
      summary.status = "ran";
    }
    const settlement = await settleEvent(deps, event, outcome);
    if (!settlement.ok) {
      outcome.settled = false;
      outcome.settlementError = settlement.error;
    }
  }

  // Events that matched nothing this agent may consume, and the ones over its
  // limit, are released back to the queue so another agent (or a later run) can
  // take them.
  const unused = claimed.filter((event) => !running.includes(event));
  await release(deps, [...unused, ...deferred]);
  return summary;
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

/** Puts claimed events back without counting an attempt. */
async function release(deps: PipelineDeps, events: ClaimedEvent[]): Promise<void> {
  if (events.length === 0) return;
  await deps.coordinator.fetch("https://repo-coordinator.internal/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ claims: events.map((event) => ({ deliveryId: event.deliveryId, leaseId: event.leaseId })) }),
  });
}
