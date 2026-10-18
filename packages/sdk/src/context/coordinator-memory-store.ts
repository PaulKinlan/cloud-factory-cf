import type {
  HierarchicalMemoryStore,
  MemoryScope,
  MemoryEntry,
} from "../types/context.ts";

export interface MemoryFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export class CoordinatorMemoryStore implements HierarchicalMemoryStore {
  private readonly fetcher: MemoryFetcher;
  private readonly baseUrl: string;

  constructor(
    fetcher: MemoryFetcher,
    baseUrl: string = "https://repo-coordinator.internal",
  ) {
    this.fetcher = fetcher;
    this.baseUrl = baseUrl;
  }

  async get(scope: MemoryScope, key: string): Promise<unknown | undefined> {
    const url = new URL(`${this.baseUrl}/memory/${encodeURIComponent(key)}`);
    url.searchParams.set("scope", scope);
    const res = await this.fetcher.fetch(url.toString(), { method: "GET" });
    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new Error(`Memory get failed with status ${res.status}`);
    }
    const data = (await res.json()) as { ok: boolean; value: unknown };
    return data.value;
  }

  async set(
    scope: MemoryScope,
    key: string,
    value: unknown,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const url = new URL(`${this.baseUrl}/memory/${encodeURIComponent(key)}`);
    url.searchParams.set("scope", scope);
    const res = await this.fetcher.fetch(url.toString(), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value, metadata }),
    });
    if (!res.ok) {
      throw new Error(`Memory set failed with status ${res.status}`);
    }
  }

  async delete(scope: MemoryScope, key: string): Promise<boolean> {
    const url = new URL(`${this.baseUrl}/memory/${encodeURIComponent(key)}`);
    url.searchParams.set("scope", scope);
    const res = await this.fetcher.fetch(url.toString(), { method: "DELETE" });
    if (res.status === 404) return false;
    if (!res.ok) {
      throw new Error(`Memory delete failed with status ${res.status}`);
    }
    const data = (await res.json().catch(() => ({}))) as { deleted?: boolean };
    return data.deleted ?? true;
  }

  async list(scope: MemoryScope, prefix?: string): Promise<MemoryEntry[]> {
    const url = new URL(`${this.baseUrl}/memory`);
    url.searchParams.set("scope", scope);
    if (prefix) {
      url.searchParams.set("prefix", prefix);
    }
    const res = await this.fetcher.fetch(url.toString(), { method: "GET" });
    if (!res.ok) {
      throw new Error(`Memory list failed with status ${res.status}`);
    }
    const data = (await res.json()) as {
      ok: boolean;
      keys?: string[];
      entries?: Array<{
        key: string;
        value: unknown;
        metadata?: Record<string, unknown>;
        updatedAt?: string | number;
      }>;
    };

    if (data.entries) {
      return data.entries.map((e) => ({
        key: e.key,
        value: e.value,
        scope,
        updatedAt: typeof e.updatedAt === "number" ? e.updatedAt : Date.parse(e.updatedAt ?? "") || Date.now(),
        metadata: e.metadata,
      }));
    }

    if (data.keys) {
      return data.keys.map((k) => ({
        key: k,
        value: undefined,
        scope,
        updatedAt: Date.now(),
      }));
    }

    return [];
  }
}
