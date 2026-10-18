import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { MemoryHandler, migrateMemoryTable } from "./memory";

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

    return new Response("not found", { status: 404 });
  }

  private migrate(): void {
    migrateMemoryTable(this.sql);
  }

  private stats(): Response {
    return Response.json({
      ok: true,
      org: this.ctx.id.name ?? "unknown",
      totalKeys: this.memoryHandler.total(),
    });
  }
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
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
