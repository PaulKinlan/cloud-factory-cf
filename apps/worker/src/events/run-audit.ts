function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function migrateRunAuditTable(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS run_audit (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      name TEXT NOT NULL,
      agents INTEGER NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS run_audit_document_idx ON run_audit (document_id, created_at);
  `);
}

/**
 * Manages run audit logging and queries for canvas runs.
 */
export class RunAuditStore {
  constructor(private sql: SqlStorage) {}

  record(payload: unknown): Response {
    const body = asRecord(payload);
    if (!body) return Response.json({ ok: false, error: "invalid body" }, { status: 400 });
    const documentId = typeof body["documentId"] === "string" ? body["documentId"] : "";
    if (documentId.length === 0) {
      return Response.json({ ok: false, error: "documentId is required" }, { status: 400 });
    }
    const name = typeof body["name"] === "string" ? body["name"].slice(0, 120) : "";
    const agents = Array.isArray(body["agents"]) ? body["agents"].length : 0;
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO run_audit (id, document_id, name, agents, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      documentId,
      name,
      agents,
      JSON.stringify(body["agents"] ?? []).slice(0, 8192),
      createdAt,
    );
    return Response.json({ ok: true, id, createdAt }, { status: 201 });
  }

  list(url: URL): Response {
    const limit = clampInt(url.searchParams.get("limit"), 1, 100, 20);
    const documentId = url.searchParams.get("documentId");
    const rows = (
      documentId === null
        ? this.sql.exec(
            `SELECT id, document_id, name, agents, detail, created_at FROM run_audit ORDER BY created_at DESC, id LIMIT ?`,
            limit,
          )
        : this.sql.exec(
            `SELECT id, document_id, name, agents, detail, created_at FROM run_audit WHERE document_id = ? ORDER BY created_at DESC, id LIMIT ?`,
            documentId,
            limit,
          )
    )
      .toArray()
      .map((row) => ({
        id: String(row["id"] ?? ""),
        documentId: String(row["document_id"] ?? ""),
        name: String(row["name"] ?? ""),
        agents: Number(row["agents"] ?? 0),
        detail: safeParseJson(String(row["detail"] ?? "[]")),
        createdAt: String(row["created_at"] ?? ""),
      }));
    return Response.json({ ok: true, count: rows.length, runs: rows });
  }
}
