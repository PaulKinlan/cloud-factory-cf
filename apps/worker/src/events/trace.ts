import { asRecord, clampInt, safeParseJson } from "./helpers";

/**
 * Execution trace for the observability suite (cloud-factory-cf-2ng).
 *
 * Every pipeline run appends ordered steps ("claimed" → "facts" → "agent" →
 * "settled") so an operator can see what the factory actually did, not just the
 * final status. Steps live in the repository's Durable Object beside the event
 * queue: they are per repository by construction, they survive a restart, and a
 * live socket can be fed from the same rows the HTTP reads serve (no second
 * source of truth).
 *
 * The table is a bounded ring: an observability buffer must never become the
 * reason a Durable Object runs out of storage, and old steps are worth less than
 * the newest ones.
 */
export const TRACE_CAP = 500;

export type TraceStatus = "info" | "ok" | "warn" | "error";

export interface TraceStep {
  id: string;
  deliveryId: string;
  /** Monotonic per delivery, so a viewer can order steps without timestamps. */
  sequence: number;
  /** Free label: "claimed", "facts", "policy", "agent", "sink", "settled", "error". */
  step: string;
  status: TraceStatus;
  detail: string;
  /** Anything worth inspecting later: the prompt, the agent output, the action list. */
  artifact: unknown;
  at: string;
  ms: number | null;
}

/** What a pipeline may hand the store; the store assigns id/at/sequence. */
export interface TraceInput {
  deliveryId: string;
  step: string;
  status: TraceStatus;
  detail: string;
  artifact?: unknown;
  ms?: number;
}

/** Called for every recorded step; the coordinator forwards this to open sockets. */
export type TraceBroadcaster = (step: TraceStep) => void;

export function migrateRunTraceTable(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS run_trace (
      id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      step TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT NOT NULL,
      artifact TEXT NOT NULL,
      created_at TEXT NOT NULL,
      ms INTEGER
    );
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS run_trace_delivery_idx ON run_trace (delivery_id, sequence);`);
  sql.exec(`CREATE INDEX IF NOT EXISTS run_trace_created_idx ON run_trace (created_at);`);
}

const ARTIFACT_LIMIT = 8192;

function serialiseArtifact(artifact: unknown): string {
  if (artifact === undefined || artifact === null) return "null";
  try {
    const json = JSON.stringify(artifact);
    if (json === undefined) return "null";
    return json.length > ARTIFACT_LIMIT ? JSON.stringify({ truncated: true, json: json.slice(0, ARTIFACT_LIMIT) }) : json;
  } catch {
    return JSON.stringify({ encodingError: true });
  }
}

export class RunTraceStore {
  constructor(
    private sql: SqlStorage,
    private broadcast: TraceBroadcaster = () => {},
  ) {}

  /**
   * Append one step. Accepts unvalidated input because the same path serves the
   * Durable Object's internal POST; malformed steps are refused, not thrown.
   * Never throws into the pipeline: a trace must not fail a run.
   */
  record(input: TraceInput | unknown): TraceStep | null {
    const normalised = normaliseInput(input);
    if (normalised === null) return null;
    try {
      const previous = this.sql
        .exec(`SELECT MAX(sequence) AS seq FROM run_trace WHERE delivery_id = ?`, normalised.deliveryId)
        .toArray();
      const last = previous[0]?.["seq"];
      const sequence = (typeof last === "number" ? last : 0) + 1;
      const step: TraceStep = {
        id: crypto.randomUUID(),
        deliveryId: normalised.deliveryId,
        sequence,
        step: normalised.step,
        status: normalised.status,
        detail: normalised.detail.slice(0, 500),
        artifact: normalised.artifact ?? null,
        at: new Date().toISOString(),
        ms: typeof normalised.ms === "number" && Number.isFinite(normalised.ms) ? Math.round(normalised.ms) : null,
      };
      this.sql.exec(
        `INSERT INTO run_trace (id, delivery_id, sequence, step, status, detail, artifact, created_at, ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        step.id,
        step.deliveryId,
        step.sequence,
        step.step,
        step.status,
        step.detail,
        serialiseArtifact(step.artifact),
        step.at,
        step.ms,
      );
      this.trim();
      this.broadcast(step);
      return step;
    } catch {
      return null;
    }
  }

  /** Recent steps as data (used to prime a live socket). Newest first. */
  recent(limit = 20): TraceStep[] {
    return this.sql
      .exec(
        `SELECT * FROM run_trace ORDER BY created_at DESC, sequence DESC LIMIT ?`,
        clampInt(String(limit), 1, 200, 20),
      )
      .toArray()
      .map(toStep);
  }

  /** Recent steps, newest first, optionally for one delivery. */
  list(url: URL): Response {
    const limit = clampInt(url.searchParams.get("limit"), 1, 200, 50);
    const deliveryId = url.searchParams.get("deliveryId");
    const rows = this.sql
      .exec(
        deliveryId === null
          ? `SELECT * FROM run_trace ORDER BY created_at DESC, sequence DESC LIMIT ?`
          : `SELECT * FROM run_trace WHERE delivery_id = ? ORDER BY sequence ASC LIMIT ?`,
        ...(deliveryId === null ? [limit] : [deliveryId, limit]),
      )
      .toArray()
      .map(toStep);
    return Response.json({ ok: true, count: rows.length, steps: rows });
  }

  /**
   * Aggregate the settled steps into the cost HUD's numbers.
   *
   * Token counts are ESTIMATES: the pipeline has no model to report real usage,
   * so it records character counts and this turns them into tokens with the
   * usual ~4 characters per token rule. The response says `estimated: true` so a
   * viewer is never told a guess is a measurement.
   */
  usage(): Response {
    const rows = this.sql.exec(`SELECT step, status, artifact, created_at FROM run_trace`).toArray();
    let runs = 0;
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let actions = 0;
    const byAction: Record<string, number> = {};
    const byStep: Record<string, number> = {};
    let latestAt: string | null = null;
    for (const row of rows) {
      const step = String(row["step"] ?? "");
      byStep[step] = (byStep[step] ?? 0) + 1;
      if (step !== "settled") continue;
      const artifact = asRecord(safeParseJson(String(row["artifact"] ?? "null")));
      if (!artifact) continue;
      const status = String(artifact["status"] ?? "");
      runs += 1;
      if (status === "succeeded") succeeded += 1;
      else if (status === "failed") failed += 1;
      else if (status === "skipped") skipped += 1;
      const list = Array.isArray(artifact["actionTypes"]) ? artifact["actionTypes"] : [];
      actions += list.length;
      for (const action of list) {
        const key = String(action);
        byAction[key] = (byAction[key] ?? 0) + 1;
      }
      const at = String(row["created_at"] ?? "");
      if (at !== "" && (latestAt === null || at > latestAt)) latestAt = at;
    }
    const tokensIn = Number(
      this.sql.exec(`SELECT SUM(JSON_EXTRACT(artifact, '$.tokensIn')) AS n FROM run_trace WHERE step = 'settled'`).toArray()[0]?.["n"] ?? 0,
    );
    const tokensOut = Number(
      this.sql.exec(`SELECT SUM(JSON_EXTRACT(artifact, '$.tokensOut')) AS n FROM run_trace WHERE step = 'settled'`).toArray()[0]?.["n"] ?? 0,
    );
    return Response.json({
      ok: true,
      usage: {
        runs,
        succeeded,
        failed,
        skipped,
        actions,
        tokensIn: Number.isFinite(tokensIn) ? tokensIn : 0,
        tokensOut: Number.isFinite(tokensOut) ? tokensOut : 0,
        estimated: true,
        byAction,
        byStep,
        latestAt,
      },
    });
  }

  /** Keep the newest TRACE_CAP rows; older steps are dropped oldest-first. */
  private trim(): void {
    this.sql.exec(
      `DELETE FROM run_trace WHERE id NOT IN (SELECT id FROM run_trace ORDER BY created_at DESC, sequence DESC LIMIT ?)`,
      TRACE_CAP,
    );
  }
}

function toStep(row: Record<string, unknown>): TraceStep {
  const ms = row["ms"];
  return {
    id: String(row["id"] ?? ""),
    deliveryId: String(row["delivery_id"] ?? ""),
    sequence: Number(row["sequence"] ?? 0),
    step: String(row["step"] ?? ""),
    status: String(row["status"] ?? "info") as TraceStatus,
    detail: String(row["detail"] ?? ""),
    artifact: safeParseJson(String(row["artifact"] ?? "null")),
    at: String(row["created_at"] ?? ""),
    ms: typeof ms === "number" ? ms : null,
  };
}

/** ~4 characters per token, the conventional rough estimate for English text. */
export function estimateTokens(text: string | undefined | null): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/** Coerce an untrusted payload into a TraceInput, or null when it cannot be one. */
export function normaliseInput(input: unknown): TraceInput | null {
  const body = asRecord(input);
  if (!body) return null;
  const deliveryId = typeof body["deliveryId"] === "string" ? body["deliveryId"].slice(0, 200) : "";
  const step = typeof body["step"] === "string" ? body["step"].slice(0, 60) : "";
  if (deliveryId === "" || step === "") return null;
  const statusRaw = String(body["status"] ?? "info");
  const status: TraceStatus = statusRaw === "ok" || statusRaw === "warn" || statusRaw === "error" ? statusRaw : "info";
  const detail = typeof body["detail"] === "string" ? body["detail"] : "";
  const ms = typeof body["ms"] === "number" ? body["ms"] : undefined;
  return { deliveryId, step, status, detail, artifact: body["artifact"] ?? null, ...(ms === undefined ? {} : { ms }) };
}

/**
 * A pipeline `onStep` that persists each step in the repository's coordinator.
 *
 * The pipeline runs in the Worker (or a caller) while the rows live in the
 * Durable Object, so steps travel as one small POST each. Ordering is preserved
 * because the pipeline awaits the hook; a failed POST is swallowed, because an
 * observability write must never fail a run.
 */
export function traceSink(coordinator: {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}): (input: TraceInput) => Promise<void> {
  return async (input: TraceInput) => {
    try {
      await coordinator.fetch("https://repo-coordinator.internal/trace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    } catch {
      // The run continues without its trace rather than failing on it.
    }
  };
}
