import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LIMIT,
  ObservabilitySession,
  clampLimit,
  actionRows,
  artifactPreview,
  clockTime,
  formatStep,
  mergeStep,
  traceUrls,
  usageRows,
  type SocketLike,
  type TraceStep,
} from "../src/observability";

/**
 * The observability panel's decisions, tested without a DOM or a network: the
 * session takes its fetch and socket from the caller (cloud-factory-cf-2ng).
 */

function step(overrides: Partial<TraceStep> = {}): TraceStep {
  return {
    id: "s-1",
    deliveryId: "d-1",
    sequence: 1,
    step: "claimed",
    status: "info",
    detail: "pull_request.opened on acme/widget",
    artifact: null,
    at: "2026-10-19T13:23:08.383Z",
    ms: null,
    ...overrides,
  };
}

function fakeSocket(): SocketLike & { emit: (type: string, payload?: unknown) => void; closed: boolean } {
  const listeners = new Map<string, Array<(event?: unknown) => void>>();
  return {
    closed: false,
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener as (event?: unknown) => void]);
    },
    close() {
      this.closed = true;
    },
    emit(type, payload) {
      for (const listener of listeners.get(type) ?? []) listener({ data: payload });
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("step stream", () => {
  it("keeps newest first and de-duplicates by id", () => {
    const first = step({ id: "a", sequence: 1 });
    const second = step({ id: "b", sequence: 2, step: "facts" });
    let list = mergeStep([], first);
    list = mergeStep(list, second);
    expect(list.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(mergeStep(list, second).map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("bounds the list so a long-lived panel cannot grow without limit", () => {
    let list: TraceStep[] = [];
    for (let index = 0; index < 10; index += 1) list = mergeStep(list, step({ id: `s-${index}` }), 4);
    expect(list).toHaveLength(4);
    expect(list[0]?.id).toBe("s-9");
  });

  it("formats a step line with status, duration and time", () => {
    const formatted = formatStep(step({ status: "ok", ms: 12, detail: "" }));
    expect(formatted.label).toBe("claimed");
    expect(formatted.detail).toBe("(no detail)");
    expect(formatted.meta).toContain("ok");
    expect(formatted.meta).toContain("12ms");
  });

  it("falls back to the raw timestamp when it cannot be parsed", () => {
    expect(clockTime("not-a-date")).toBe("not-a-date");
  });
});

describe("artifact inspector", () => {
  it("says so when a step has no artifact", () => {
    expect(artifactPreview(null)).toEqual({ text: "no artifact for this step", truncated: false });
  });

  it("pretty-prints JSON and marks a truncated preview", () => {
    expect(artifactPreview({ tokensIn: 3 }).text).toContain('"tokensIn": 3');
    const long = artifactPreview({ prompt: "x".repeat(50) }, 20);
    expect(long.truncated).toBe(true);
    expect(long.text).toContain("more characters");
  });

  it("survives a value JSON cannot encode", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(artifactPreview(cyclic)).toEqual({ text: "artifact could not be rendered", truncated: false });
  });
});

describe("cost HUD", () => {
  it("labels token counts as estimates, because they are", () => {
    const rows = usageRows({
      runs: 3,
      succeeded: 2,
      failed: 1,
      skipped: 0,
      actions: 4,
      tokensIn: 50,
      tokensOut: 12,
      estimated: true,
      byAction: { "pr.review": 3, "issue.create": 1 },
      latestAt: "2026-10-19T13:23:08.383Z",
    });
    expect(rows.find((row) => row.label === "Tokens in")).toMatchObject({
      value: "50",
      note: "estimated from character counts",
    });
    expect(rows.find((row) => row.label === "Runs")?.value).toBe("3");
    expect(rows.some((row) => row.label === "Latest")).toBe(true);
  });

  it("marks real reported usage differently from an estimate", () => {
    const rows = usageRows({
      runs: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
      actions: 0,
      tokensIn: 5,
      tokensOut: 1,
      estimated: false,
    });
    expect(rows.find((row) => row.label === "Tokens in")?.note).toBe("reported by the runtime");
  });

  it("shows a placeholder before anything is loaded", () => {
    expect(usageRows(null)).toEqual([{ label: "Usage", value: "—", note: "not loaded yet" }]);
  });

  it("sorts the per-action table so it does not jump between renders", () => {
    expect(actionRows({ runs: 0, succeeded: 0, failed: 0, skipped: 0, actions: 0, tokensIn: 0, tokensOut: 0, byAction: { b: 2, a: 1 } }).map((row) => row.label)).toEqual(["a", "b"]);
    expect(actionRows(null)).toEqual([]);
  });
});

describe("urls", () => {
  it("clamps the limit to what the trace route accepts", () => {
    expect(clampLimit(Number.NaN)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(7.8)).toBe(7);
    expect(clampLimit(10_000)).toBe(200);
  });

  it("asks the trace route for the limit it was given", () => {
    // Regression (cloud-factory-cf-9t2): the panel's Limit field was read and dropped.
    expect(traceUrls("https://factory.example", "acme", "widget", "k", 12).trace).toBe(
      "https://factory.example/trace/acme/widget?limit=12",
    );
  });

  it("builds the three endpoints and encodes the key", () => {
    const urls = traceUrls("https://factory.example/", "acme", "widget", "a b");
    expect(urls.trace).toBe("https://factory.example/trace/acme/widget?limit=50");
    expect(urls.usage).toBe("https://factory.example/trace/acme/widget/usage");
    expect(urls.socket).toBe("wss://factory.example/trace/acme/widget/socket?key=a%20b");
  });
});

describe("session", () => {
  it("loads usage and trace, then streams steps over the socket", async () => {
    const socket = fakeSocket();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/usage")) {
        return jsonResponse({ ok: true, usage: { runs: 1, succeeded: 0, failed: 0, skipped: 1, actions: 0, tokensIn: 5, tokensOut: 1, estimated: true } });
      }
      return jsonResponse({ ok: true, count: 1, steps: [step({ id: "seed" })] });
    });
    const session = new ObservabilitySession({
      base: "https://factory.example",
      owner: "acme",
      repo: "widget",
      key: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      socketFactory: () => socket,
      pollMs: 5,
    });

    await session.connect();
    expect(session.state.usage?.runs).toBe(1);
    expect(session.state.steps.map((entry) => entry.id)).toEqual(["seed"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Both requests carried the control key in a header, never in the URL.
    for (const call of fetchImpl.mock.calls) {
      expect(String(call[0])).not.toContain("key=k");
      expect((call[1] as RequestInit).headers).toEqual({ "x-factory-control-key": "k" });
    }

    socket.emit("open");
    expect(session.state.status).toBe("live");
    socket.emit("message", JSON.stringify({ type: "step", step: step({ id: "live-1", sequence: 2 }) }));
    expect(session.state.steps[0]?.id).toBe("live-1");
    socket.emit("message", "not json");
    expect(session.state.steps).toHaveLength(2);
  });

  it("refreshes the HUD when a run settles on the stream", async () => {
    const socket = fakeSocket();
    let runs = 1;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/usage")) {
        return jsonResponse({ ok: true, usage: { runs, succeeded: 0, failed: 0, skipped: runs, actions: 0, tokensIn: 0, tokensOut: 0, estimated: true } });
      }
      return jsonResponse({ ok: true, steps: [] });
    });
    const session = new ObservabilitySession({
      base: "https://factory.example",
      owner: "acme",
      repo: "widget",
      key: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      socketFactory: () => socket,
      pollMs: 100000,
    });
    await session.connect();
    expect(session.state.usage?.runs).toBe(1);
    runs = 2;
    socket.emit("message", JSON.stringify({ type: "step", step: step({ id: "settle", step: "settled", status: "ok" }) }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.state.usage?.runs).toBe(2);
    session.disconnect();
  });

  it("reports a rejected control key instead of an empty panel", async () => {
    const session = new ObservabilitySession({
      base: "https://factory.example",
      owner: "acme",
      repo: "widget",
      key: "wrong",
      fetchImpl: (async () => jsonResponse({ ok: false, error: "nope" }, 401)) as unknown as typeof fetch,
    });
    await session.connect();
    expect(session.state.status).toBe("error");
    expect(session.state.error).toContain("401");
    expect(session.polling).toBe(false);
  });

  it("falls back to polling when the socket fails, and disconnect clears the timer", async () => {
    const socket = fakeSocket();
    const session = new ObservabilitySession({
      base: "https://factory.example",
      owner: "acme",
      repo: "widget",
      key: "k",
      fetchImpl: (async () => jsonResponse({ ok: true, usage: null, steps: [] })) as unknown as typeof fetch,
      socketFactory: () => socket,
      pollMs: 100000,
    });
    await session.connect();
    socket.emit("open");
    expect(session.state.status).toBe("live");
    socket.emit("error");
    expect(session.state.status).toBe("polling");
    expect(session.polling).toBe(true);
    session.disconnect();
    expect(session.polling).toBe(false);
    expect(socket.closed).toBe(true);
    expect(session.state.status).toBe("idle");
  });

  it("calls the global fetch with a global receiver when none is injected", async () => {
    // Regression: a bare `fetch` invoked as a method threw "Illegal invocation" in
    // the browser even though the injected fake hid it in tests.
    const calls: string[] = [];
    const original = globalThis.fetch;
    // No WebSocket in this environment: the panel must take the polling path.
    const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
    globalThis.fetch = function (this: unknown, input: RequestInfo | URL) {
      if (this !== globalThis && this !== undefined) throw new TypeError("Illegal invocation");
      calls.push(String(input));
      return Promise.resolve(jsonResponse({ ok: true, usage: null, steps: [] }));
    } as typeof fetch;
    try {
      const session = new ObservabilitySession({
        base: "https://factory.example",
        owner: "acme",
        repo: "widget",
        key: "k",
      });
      await session.connect();
      // Two reads, then the polling fallback's first tick (there is no WebSocket here).
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls.some((url) => url.endsWith("/usage"))).toBe(true);
      expect(calls.some((url) => url.includes("/trace/acme/widget?limit=50"))).toBe(true);
      expect(session.state.error).toBeNull();
      session.disconnect();
      expect(session.polling).toBe(false);
    } finally {
      globalThis.fetch = original;
      (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
    }
  });

  it("opens the browser WebSocket when no factory is injected", async () => {
    // The panel must stream in a browser, not silently poll forever.
    const socket = fakeSocket();
    const opened: string[] = [];
    const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
    class FakeWebSocket {
      constructor(url: string) {
        opened.push(url);
        return socket as unknown as FakeWebSocket;
      }
    }
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    try {
      const session = new ObservabilitySession({
        base: "https://factory.example",
        owner: "acme",
        repo: "widget",
        key: "k",
        fetchImpl: (async () => jsonResponse({ ok: true, usage: null, steps: [] })) as unknown as typeof fetch,
        pollMs: 100000,
      });
      await session.connect();
      expect(opened).toEqual(["wss://factory.example/trace/acme/widget/socket?key=k"]);
      expect(session.polling).toBe(false);
      socket.emit("open");
      expect(session.state.status).toBe("live");
      session.disconnect();
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
    }
  });

  it("re-reads the trace with a reconfigured limit", async () => {
    const seen: string[] = [];
    const session = new ObservabilitySession({
      base: "https://factory.example",
      owner: "acme",
      repo: "widget",
      key: "k",
      fetchImpl: (async (input: RequestInfo | URL) => {
        seen.push(String(input));
        return jsonResponse({ ok: true, usage: null, steps: [] });
      }) as unknown as typeof fetch,
      pollMs: 100000,
    });
    session.reconfigure({ limit: 5 });
    await session.connect();
    expect(seen.some((url) => url.includes("?limit=5"))).toBe(true);
    session.disconnect();
  });

  it("selects a step for the inspector", async () => {
    const session = new ObservabilitySession({
      base: "https://factory.example",
      owner: "acme",
      repo: "widget",
      key: "k",
      fetchImpl: (async () => jsonResponse({ ok: true, usage: null, steps: [step({ id: "pick", artifact: { a: 1 } })] })) as unknown as typeof fetch,
    });
    await session.connect();
    session.select("pick");
    expect(session.selected()?.artifact).toEqual({ a: 1 });
    session.select(null);
    expect(session.selected()).toBeNull();
  });
});
