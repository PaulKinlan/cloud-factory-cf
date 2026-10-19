import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_QUOTA_PER_MINUTE, parseQuotaLimit } from "../src/credential-broker-object";

/**
 * `BROKER_QUOTA_PER_MINUTE` is "4" in `vitest.config.ts` so the 429 path is
 * reachable with a handful of calls. Each test below uses its own repository
 * and agent, because the quota lives in the per-repository Durable Object.
 */
const CONTROL_KEY = "test-control-key";
const LIMIT = 4;
const REPOSITORY = "acme/rta5-quota";

async function call(repository: string, operation: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`https://example.com/broker/${repository}/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function issue(repository: string, agent: string, action: string): Promise<string> {
  const response = await call(repository, "capabilities", { agent, service: "github", action });
  const payload = (await response.json()) as { ok: boolean; capability?: string };
  expect(payload.ok).toBe(true);
  expect(payload.capability).toBeTypeOf("string");
  return payload.capability as string;
}

function stubUpstream(): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", stub as unknown as typeof fetch);
  return stub;
}

async function audit(repository: string): Promise<Array<{ outcome: string; agent: string; status: number | null }>> {
  const response = await SELF.fetch(`https://example.com/broker/${repository}/audit?limit=50`, {
    headers: { "x-factory-control-key": CONTROL_KEY },
  });
  const payload = (await response.json()) as { entries: Array<{ outcome: string; agent: string; status: number | null }> };
  return payload.entries;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("quota limit parsing", () => {
  const cases: Array<[unknown, number, string]> = [
    [undefined, DEFAULT_QUOTA_PER_MINUTE, "unset falls back to the default"],
    [null, DEFAULT_QUOTA_PER_MINUTE, "null falls back to the default"],
    ["", DEFAULT_QUOTA_PER_MINUTE, "an empty binding never disables the throttle"],
    ["   ", DEFAULT_QUOTA_PER_MINUTE, "whitespace never disables the throttle"],
    ["0.5", DEFAULT_QUOTA_PER_MINUTE, "a fractional limit never truncates to 0"],
    ["-1", DEFAULT_QUOTA_PER_MINUTE, "a negative limit falls back to the default"],
    ["abc", DEFAULT_QUOTA_PER_MINUTE, "a non-numeric value falls back to the default"],
    ["1e3", DEFAULT_QUOTA_PER_MINUTE, "only plain digits are accepted"],
    ["9007199254740993", DEFAULT_QUOTA_PER_MINUTE, "an unsafe integer falls back"],
    ["0", 0, "an explicit 0 disables the throttle"],
    ["4", 4, "a plain integer is honoured"],
    [" 4 ", 4, "surrounding whitespace is trimmed"],
  ];

  for (const [raw, expected, description] of cases) {
    it(`${description} (${JSON.stringify(raw)} → ${expected})`, () => {
      expect(parseQuotaLimit(raw)).toBe(expected);
    });
  }
});

describe("credential broker object: per-agent quota", () => {
  it("allows the window's worth of calls, then answers 429 with an audit row", async () => {
    const repository = `${REPOSITORY}-limit`;
    const capability = await issue(repository, "agent-quota-1", "repo.read");
    const upstream = stubUpstream();

    for (let attempt = 1; attempt <= LIMIT; attempt += 1) {
      const allowed = await call(repository, "proxy", { capability });
      expect(allowed.status, `call ${attempt} of ${LIMIT} should pass`).toBe(200);
    }
    expect(upstream).toHaveBeenCalledTimes(LIMIT);

    const throttled = await call(repository, "proxy", { capability });
    expect(throttled.status).toBe(429);
    const retryAfter = Number(throttled.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    await expect(throttled.json()).resolves.toMatchObject({
      ok: false,
      error: "quota exceeded",
      limit: LIMIT,
      windowSeconds: 60,
      retryAfter,
    });

    // A throttled call never reaches the provider.
    expect(upstream).toHaveBeenCalledTimes(LIMIT);

    const entries = await audit(repository);
    const throttledRows = entries.filter((entry) => entry.outcome === "quota_exceeded");
    expect(throttledRows).toHaveLength(1);
    expect(throttledRows[0]).toMatchObject({ agent: "agent-quota-1", status: 429 });
  });

  it("counts per agent and per action, not per repository", async () => {
    const repository = `${REPOSITORY}-keys`;
    const agentA = await issue(repository, "agent-quota-a", "repo.read");
    const agentB = await issue(repository, "agent-quota-b", "repo.read");
    const agentAOther = await issue(repository, "agent-quota-a", "issue.comment");
    stubUpstream();

    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      expect((await call(repository, "proxy", { capability: agentA })).status).toBe(200);
    }
    expect((await call(repository, "proxy", { capability: agentA })).status).toBe(429);

    // Same repository, different agent: unaffected.
    expect((await call(repository, "proxy", { capability: agentB })).status).toBe(200);
    // Same agent, different action: its own window (and its own parameters).
    const other = await call(repository, "proxy", {
      capability: agentAOther,
      params: { number: 1, body: "quota window check" },
    });
    expect(other.status).toBe(200);
  });

  it("does not spend a slot on a request refused before the upstream call", async () => {
    const repository = `${REPOSITORY}-denied`;
    const capability = await issue(repository, "agent-quota-denied", "repo.read");
    stubUpstream();

    for (let attempt = 0; attempt < LIMIT + 3; attempt += 1) {
      const denied = await call(repository, "proxy", { capability: "not-a-token" });
      expect(denied.status).toBe(401);
    }

    // Denied requests did not consume the window.
    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      expect((await call(repository, "proxy", { capability })).status).toBe(200);
    }
  });

  it("spends a slot even when the upstream call fails", async () => {
    const repository = `${REPOSITORY}-upstream`;
    const capability = await issue(repository, "agent-quota-upstream", "repo.read");
    vi.stubGlobal(
      "fetch",
      (async () => {
        throw new Error("connection reset");
      }) as unknown as typeof fetch,
    );

    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      const failed = await call(repository, "proxy", { capability });
      expect(failed.status).toBe(502);
    }
    expect((await call(repository, "proxy", { capability })).status).toBe(429);
  });
});
