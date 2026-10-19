import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { MemoryHandler, migrateMemoryTable } from "./memory";
import { safeDecode } from "./events/helpers";

export class OrgCoordinator extends DurableObject<Env> {
  private memoryHandler!: MemoryHandler;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
    this.memoryHandler = new MemoryHandler(this.ctx.storage.sql);
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname.startsWith("/memory/")) {
      const key = safeDecode(url.pathname.slice("/memory/".length));
      if (key === null) return Response.json({ ok: false, error: "malformed key" }, { status: 400 });
      return this.memoryHandler.get(key);
    }

    if (request.method === "GET" && url.pathname === "/memory") {
      const key = url.searchParams.get("key");
      if (key) return this.memoryHandler.get(key);
      const prefix = url.searchParams.get("prefix") ?? "";
      return this.memoryHandler.list(prefix);
    }

    if ((request.method === "POST" || request.method === "PUT") && url.pathname.startsWith("/memory/")) {
      const key = safeDecode(url.pathname.slice("/memory/".length));
      if (key === null) return Response.json({ ok: false, error: "malformed key" }, { status: 400 });
      const body = await readJson(request);
      return this.memoryHandler.set(key, body);
    }

    if (request.method === "POST" && url.pathname === "/memory") {
      const body = await readJson(request);
      const key = typeof body?.["key"] === "string" ? body["key"] : undefined;
      if (!key) {
        return Response.json({ ok: false, error: "missing key" }, { status: 400 });
      }
      return this.memoryHandler.set(key, body);
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/memory/")) {
      const key = safeDecode(url.pathname.slice("/memory/".length));
      if (key === null) return Response.json({ ok: false, error: "malformed key" }, { status: 400 });
      return this.memoryHandler.delete(key);
    }

    if (request.method === "DELETE" && url.pathname === "/memory") {
      const key = url.searchParams.get("key");
      if (!key) {
        return Response.json({ ok: false, error: "missing key" }, { status: 400 });
      }
      return this.memoryHandler.delete(key);
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      return this.stats();
    }

    if (request.method === "POST" && url.pathname === "/installations") {
      return this.handleRecordInstallation(request);
    }

    if (request.method === "GET" && url.pathname === "/repos") {
      return this.handleListRepos();
    }

    return new Response("not found", { status: 404 });
  }

  private migrate(): void {
    migrateMemoryTable(this.sql);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS github_installations (
        installation_id TEXT PRIMARY KEY,
        account_login TEXT NOT NULL,
        account_type TEXT NOT NULL,
        installed_at TEXT NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS authorized_repos (
        full_name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        is_private INTEGER NOT NULL DEFAULT 0,
        default_branch TEXT NOT NULL DEFAULT 'main',
        installation_id TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS authorized_repos_owner_idx ON authorized_repos (owner);
    `);
  }

  private async handleRecordInstallation(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (!body) return Response.json({ ok: false, error: "invalid json" }, { status: 400 });

    const installationId = String(body["installationId"] ?? "");
    const accountLogin = String(body["accountLogin"] ?? this.ctx.id.name ?? "unknown");
    const accountType = String(body["accountType"] ?? "User");
    const now = new Date().toISOString();

    if (installationId) {
      this.sql.exec(
        `INSERT INTO github_installations (installation_id, account_login, account_type, installed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (installation_id) DO UPDATE SET account_login = excluded.account_login, installed_at = excluded.installed_at`,
        installationId,
        accountLogin,
        accountType,
        now,
      );
    }

    const repos = Array.isArray(body["repos"]) ? (body["repos"] as Array<Record<string, unknown>>) : [];
    for (const r of repos) {
      const fullName = String(r["fullName"] ?? "");
      const owner = String(r["owner"] ?? accountLogin);
      const name = String(r["name"] ?? fullName.split("/")[1] ?? fullName);
      const isPrivate = r["private"] === true || r["isPrivate"] === true ? 1 : 0;
      const defaultBranch = String(r["defaultBranch"] ?? "main");

      if (fullName) {
        this.sql.exec(
          `INSERT INTO authorized_repos (full_name, owner, name, is_private, default_branch, installation_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (full_name) DO UPDATE SET
             owner = excluded.owner,
             name = excluded.name,
             is_private = excluded.is_private,
             default_branch = excluded.default_branch,
             installation_id = excluded.installation_id,
             updated_at = excluded.updated_at`,
          fullName,
          owner,
          name,
          isPrivate,
          defaultBranch,
          installationId || null,
          now,
        );
      }
    }

    return Response.json({ ok: true, installationId, count: repos.length });
  }

  private handleListRepos(): Response {
    const rows = this.sql
      .exec<{
        full_name: string;
        owner: string;
        name: string;
        is_private: number;
        default_branch: string;
        installation_id: string | null;
        updated_at: string;
      }>(`SELECT full_name, owner, name, is_private, default_branch, installation_id, updated_at FROM authorized_repos ORDER BY updated_at DESC`)
      .toArray();

    const repositories = rows.map((row) => ({
      fullName: row.full_name,
      owner: row.owner,
      name: row.name,
      isPrivate: row.is_private === 1,
      defaultBranch: row.default_branch,
      installationId: row.installation_id,
      updatedAt: row.updated_at,
    }));

    return Response.json({
      ok: true,
      org: this.ctx.id.name ?? "unknown",
      count: repositories.length,
      repositories,
    });
  }

  private stats(): Response {
    return Response.json({
      ok: true,
      org: this.ctx.id.name ?? "unknown",
      totalKeys: this.memoryHandler.total(),
    });
  }
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
