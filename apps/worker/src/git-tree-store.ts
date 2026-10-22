/** A bounded, provider-independent snapshot of a repository tree for offline analysis. */
export const MAX_TREE_BYTES = 4 * 1024 * 1024;
export const MAX_TREE_FILES = 5_000;
const MAX_PATH_BYTES = 1_024;

export interface TreeFile {
  path: string;
  size: number;
  content?: string;
}

export interface TreeSnapshot {
  source: "isomorphic-git" | "tarball";
  revision: string;
  files: TreeFile[];
}

function validPath(path: string): boolean {
  return path.length > 0 && new TextEncoder().encode(path).length <= MAX_PATH_BYTES &&
    !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
    !path.split("/").some((part) => !part || part === "." || part === "..");
}

export function validateTree(value: unknown): TreeSnapshot {
  if (!value || typeof value !== "object") throw new Error("tree must be an object");
  const tree = value as Record<string, unknown>;
  if (tree.source !== "isomorphic-git" && tree.source !== "tarball") throw new Error("unsupported tree source");
  if (typeof tree.revision !== "string" || !tree.revision || tree.revision.length > 200) throw new Error("invalid revision");
  if (!Array.isArray(tree.files) || tree.files.length > MAX_TREE_FILES) throw new Error("invalid file list");
  const paths = new Set<string>();
  let total = 0;
  for (const file of tree.files) {
    if (!file || typeof file !== "object") throw new Error("invalid file");
    const entry = file as Record<string, unknown>;
    if (typeof entry.path !== "string" || !validPath(entry.path) || paths.has(entry.path)) throw new Error("invalid or duplicate file path");
    if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("invalid file size");
    if (entry.content !== undefined && typeof entry.content !== "string") throw new Error("invalid file content");
    const contentBytes = entry.content === undefined ? 0 : new TextEncoder().encode(entry.content).length;
    if (contentBytes > entry.size) throw new Error("content exceeds file size");
    total += contentBytes + new TextEncoder().encode(entry.path).length;
    if (total > MAX_TREE_BYTES) throw new Error("tree exceeds size limit");
    paths.add(entry.path);
  }
  return tree as unknown as TreeSnapshot;
}

export class GitTreeStore {
  constructor(private readonly sql: SqlStorage) {}

  replace(value: unknown): Response {
    let tree: TreeSnapshot;
    try {
      tree = validateTree(value);
    } catch (error) {
      return Response.json({ ok: false, error: (error as Error).message }, { status: 400 });
    }
    // Every replacement is atomic: consumers never observe a half-ingested tree.
    this.sql.exec("DELETE FROM git_tree_files");
    for (const file of tree.files) {
      this.sql.exec("INSERT INTO git_tree_files (path, size, content) VALUES (?, ?, ?)", file.path, file.size, file.content ?? null);
    }
    this.sql.exec("INSERT OR REPLACE INTO git_tree_snapshot (id, source, revision, updated_at) VALUES (1, ?, ?, ?)", tree.source, tree.revision, Date.now());
    return Response.json({ ok: true, source: tree.source, revision: tree.revision, count: tree.files.length }, { status: 201 });
  }

  list(url: URL): Response {
    const snapshot = this.sql.exec<{ source: string; revision: string; updated_at: number }>(
      "SELECT source, revision, updated_at FROM git_tree_snapshot WHERE id = 1",
    ).toArray()[0];
    if (!snapshot) return Response.json({ ok: false, error: "no tree snapshot" }, { status: 404 });
    const prefix = url.searchParams.get("prefix") ?? "";
    if (prefix && !validPath(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix)) {
      return Response.json({ ok: false, error: "invalid prefix" }, { status: 400 });
    }
    const files = this.sql.exec<{ path: string; size: number }>("SELECT path, size FROM git_tree_files ORDER BY path").toArray()
      .filter((file) => file.path.startsWith(prefix));
    return Response.json({ ok: true, ...snapshot, count: files.length, files });
  }

  file(path: string): Response {
    if (!validPath(path)) return Response.json({ ok: false, error: "invalid path" }, { status: 400 });
    const file = this.sql.exec<{ path: string; size: number; content: string | null }>(
      "SELECT path, size, content FROM git_tree_files WHERE path = ?", path,
    ).toArray()[0];
    return file ? Response.json({ ok: true, ...file }) : Response.json({ ok: false, error: "file not found" }, { status: 404 });
  }
}

export function migrateGitTreeTable(sql: SqlStorage): void {
  sql.exec("CREATE TABLE IF NOT EXISTS git_tree_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), source TEXT NOT NULL, revision TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS git_tree_files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, content TEXT)");
}
