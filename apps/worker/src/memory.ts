export interface MemoryRow extends Record<string, SqlStorageValue> {
  key: string;
  value: string;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export function migrateMemoryTable(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS memory_updated_idx ON memory (updated_at);
  `);
}

export class MemoryHandler {
  constructor(private sql: SqlStorage) {}

  get(key: string): Response {
    if (!key) return Response.json({ ok: false, error: "missing key" }, { status: 400 });
    const rows = this.sql
      .exec<MemoryRow>("SELECT * FROM memory WHERE key = ?", key)
      .toArray();
    if (rows.length === 0) {
      return Response.json({ ok: false, error: "not found", key }, { status: 404 });
    }
    const row = rows[0]!;
    return Response.json({
      ok: true,
      key: row.key,
      value: safeParseJson(row.value),
      metadata: row.metadata ? safeParseJson(row.metadata) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  list(prefix: string): Response {
    let rows: MemoryRow[];
    if (prefix) {
      // Escape SQL LIKE wildcards '%' and '_' and '\' (fixes cloud-factory-cf-f8d)
      const escaped = prefix.replace(/([%_\\])/g, "\\$1");
      rows = this.sql
        .exec<MemoryRow>(
          "SELECT * FROM memory WHERE key LIKE ? ESCAPE '\\' ORDER BY key ASC",
          `${escaped}%`,
        )
        .toArray();
    } else {
      rows = this.sql
        .exec<MemoryRow>("SELECT * FROM memory ORDER BY key ASC")
        .toArray();
    }

    return Response.json({
      ok: true,
      count: rows.length,
      keys: rows.map((r) => r.key),
      entries: rows.map((r) => ({
        key: r.key,
        value: safeParseJson(r.value),
        metadata: r.metadata ? safeParseJson(r.metadata) : undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  }

  set(key: string, body: Record<string, unknown> | null): Response {
    if (!key) return Response.json({ ok: false, error: "missing key" }, { status: 400 });
    if (!body || !("value" in body)) {
      return Response.json({ ok: false, error: "missing value" }, { status: 400 });
    }

    const valueStr = JSON.stringify(body["value"]);
    const metadataStr =
      "metadata" in body && body["metadata"] !== undefined
        ? JSON.stringify(body["metadata"])
        : null;
    const now = new Date().toISOString();

    this.sql.exec(
      `INSERT INTO memory (key, value, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         metadata = excluded.metadata,
         updated_at = excluded.updated_at`,
      key,
      valueStr,
      metadataStr,
      now,
      now,
    );

    return Response.json({ ok: true, key });
  }

  delete(key: string): Response {
    if (!key) return Response.json({ ok: false, error: "missing key" }, { status: 400 });

    const existing = this.sql
      .exec<{ key: string }>("SELECT key FROM memory WHERE key = ?", key)
      .toArray();
    if (existing.length === 0) {
      return Response.json({ ok: false, error: "not found", key, deleted: false }, { status: 404 });
    }

    this.sql.exec("DELETE FROM memory WHERE key = ?", key);
    return Response.json({ ok: true, key, deleted: true });
  }

  total(): number {
    return this.sql.exec<{ total: number }>("SELECT count(*) AS total FROM memory").one().total;
  }
}

export function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
