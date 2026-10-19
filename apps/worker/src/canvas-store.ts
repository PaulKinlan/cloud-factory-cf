/**
 * Per-repository canvas documents.
 *
 * The canvas in `apps/web` is local-first (`localStorage`); this store is the
 * shared copy, so a layout can be handed to another operator or fed into a run
 * later. Documents are opaque JSON that must keep the shape the canvas exports,
 * validated here so the API never stores something the client cannot load.
 */

export const MAX_DOCUMENT_BYTES = 256 * 1024;
export const MAX_NODES = 500;
export const MAX_EDGES = 2_000;
export const MAX_DOCUMENTS_PER_REPOSITORY = 200;
export const MAX_NAME_LENGTH = 120;

export interface CanvasDocumentRow extends Record<string, SqlStorageValue> {
  id: string;
  name: string;
  document: string;
  created_at: string;
  updated_at: string;
}

export function migrateCanvasTable(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS canvas_documents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      document TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS canvas_documents_updated_idx ON canvas_documents (updated_at DESC);
  `);
}

export interface CanvasDocumentValidation {
  ok: boolean;
  error?: string;
  name?: string;
  serialised?: string;
}

/**
 * Accepts the document shape the canvas produces (`version: 1`, `nodes`, `edges`)
 * and refuses anything else: wrong version, non-arrays, too many elements, a
 * payload past the size cap, or a body that is not an object at all.
 */
export function validateDocument(document: unknown, name: unknown): CanvasDocumentValidation {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { ok: false, error: "document must be an object" };
  }
  const candidate = document as { version?: unknown; nodes?: unknown; edges?: unknown };
  if (candidate.version !== 1) {
    return { ok: false, error: "unsupported document version" };
  }
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) {
    return { ok: false, error: "document needs nodes and edges arrays" };
  }
  if (candidate.nodes.length > MAX_NODES) {
    return { ok: false, error: `document has more than ${MAX_NODES} nodes` };
  }
  if (candidate.edges.length > MAX_EDGES) {
    return { ok: false, error: `document has more than ${MAX_EDGES} edges` };
  }
  const serialised = JSON.stringify(document);
  if (serialised.length > MAX_DOCUMENT_BYTES) {
    return { ok: false, error: `document is larger than ${MAX_DOCUMENT_BYTES} bytes` };
  }

  const supplied = typeof name === "string" ? name.trim() : "";
  const resolved = supplied.length > 0 ? supplied : "Untitled canvas";
  if (resolved.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `name is longer than ${MAX_NAME_LENGTH} characters` };
  }
  return { ok: true, name: resolved, serialised };
}

function describe(row: CanvasDocumentRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

export class CanvasStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly repository: string,
  ) {}

  list(url: URL): Response {
    const requested = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 200) : 50;
    const rows = this.sql
      .exec<CanvasDocumentRow>(
        `SELECT id, name, document, created_at, updated_at FROM canvas_documents ORDER BY updated_at DESC LIMIT ?`,
        limit,
      )
      .toArray();
    return Response.json({
      ok: true,
      repository: this.repository,
      count: rows.length,
      documents: rows.map(describe),
    });
  }

  get(id: string): Response {
    if (!id) return Response.json({ ok: false, error: "missing document id" }, { status: 400 });
    const rows = this.sql
      .exec<CanvasDocumentRow>(`SELECT * FROM canvas_documents WHERE id = ?`, id)
      .toArray();
    const row = rows[0];
    if (!row) return Response.json({ ok: false, error: "not found", id }, { status: 404 });
    return Response.json({
      ok: true,
      repository: this.repository,
      ...describe(row),
      document: safeParse(row.document),
    });
  }

  put(id: string, body: unknown, now = new Date()): Response {
    const payload = (typeof body === "object" && body !== null ? body : {}) as {
      name?: unknown;
      document?: unknown;
    };
    const validation = validateDocument(payload.document, payload.name);
    if (!validation.ok) {
      return Response.json({ ok: false, error: validation.error }, { status: 400 });
    }

    const documentId = id.length > 0 ? id : crypto.randomUUID();
    if (documentId.length > 128) {
      return Response.json({ ok: false, error: "document id is too long" }, { status: 400 });
    }

    const existing = this.sql
      .exec<{ id: string; created_at: string }>(`SELECT id, created_at FROM canvas_documents WHERE id = ?`, documentId)
      .toArray()[0];

    if (!existing) {
      const total = this.sql
        .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM canvas_documents`)
        .one().count;
      if (total >= MAX_DOCUMENTS_PER_REPOSITORY) {
        return Response.json(
          { ok: false, error: `repository already holds ${MAX_DOCUMENTS_PER_REPOSITORY} documents` },
          { status: 409 },
        );
      }
    }

    const stamp = now.toISOString();
    this.sql.exec(
      `INSERT INTO canvas_documents (id, name, document, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, document = excluded.document, updated_at = excluded.updated_at`,
      documentId,
      validation.name ?? "Untitled canvas",
      validation.serialised ?? "{}",
      existing?.created_at ?? stamp,
      stamp,
    );

    return Response.json(
      {
        ok: true,
        repository: this.repository,
        id: documentId,
        name: validation.name,
        created: existing === undefined,
        updatedAt: stamp,
      },
      { status: existing === undefined ? 201 : 200 },
    );
  }

  remove(id: string): Response {
    if (!id) return Response.json({ ok: false, error: "missing document id" }, { status: 400 });
    const before = this.sql
      .exec<{ id: string }>(`SELECT id FROM canvas_documents WHERE id = ?`, id)
      .toArray()[0];
    this.sql.exec(`DELETE FROM canvas_documents WHERE id = ?`, id);
    if (!before) return Response.json({ ok: false, error: "not found", id }, { status: 404 });
    return Response.json({ ok: true, repository: this.repository, id });
  }
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
