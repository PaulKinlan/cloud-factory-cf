import { describe, expect, it, vi } from "vitest";
// The panel's markup is part of its contract (see the native-constraints check below).
import indexHtml from "../index.html?raw";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MIN_LIMIT,
  ObservabilitySession,
  clampLimit,
  actionRows,
  artifactPreview,
  clockTime,
  formatStep,
  heartbeatAge,
  mergeStep,
  reconnectDelay,
  statusText,
  statusTone,
  traceUrls,
  usageRows,
  type SessionState,
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

/**
 * A socket the session can ping, recording what was sent. It behaves like a
 * browser WebSocket where it matters: it starts CONNECTING (readyState 0), only
 * becomes OPEN on `open`, and `send` throws before that (review cb3: a fake that
 * accepted sends while unopened hid a hanging-handshake bug).
 */
function pingableSocket(): SocketLike & {
  emit: (type: string, payload?: unknown) => void;
  closed: boolean;
  sent: string[];
  readyState: number;
} {
  const socket = fakeSocket() as SocketLike & {
    emit: (type: string, payload?: unknown) => void;
    closed: boolean;
    sent: string[];
    readyState: number;
  };
  const emit = socket.emit.bind(socket);
  const close = socket.close.bind(socket);
  socket.readyState = 0;
  socket.sent = [];
  socket.send = (data: string) => {
    if (socket.readyState !== 1) throw new Error("InvalidStateError");
    socket.sent.push(data);
  };
  socket.emit = (type: string, payload?: unknown) => {
    if (type === "open") socket.readyState = 1;
    if (type === "close") socket.readyState = 3;
    emit(type, payload);
  };
  socket.close = () => {
    close();
    socket.readyState = 3;
  };
  return socket;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

describe("markup contract", () => {
  it("keeps native constraints off the Limit field so the clamp can run", () => {
    // cloud-factory-cf-2xp: min/max made an out-of-range value invalid, so the browser
    // suppressed submit and the panel's clamp never executed.
    const html = indexHtml;
    const tag = /<input[^>]*obs-limit[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).not.toBe("");
    expect(tag).not.toMatch(/\bmin=/);
    expect(tag).not.toMatch(/\bmax=/);
    // The field and the clamp must agree on the bounds the hint states.
    expect(html).toContain("1–200 steps");
    expect(DEFAULT_LIMIT).toBeGreaterThanOrEqual(MIN_LIMIT);
    expect(MAX_LIMIT).toBe(200);
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

  it("builds the endpoints and ticket parameter, without key in the socket URL", () => {
    const urls = traceUrls("https://factory.example/", "acme", "widget", "a b");
    expect(urls.trace).toBe("https://factory.example/trace/acme/widget?limit=50");
    expect(urls.usage).toBe("https://factory.example/trace/acme/widget/usage");
    expect(urls.ticket).toBe("https://factory.example/trace/acme/widget/ticket");
    expect(urls.socket).toBe("wss://factory.example/trace/acme/widget/socket?ticket=a%20b&limit=50");
    expect(urls.socket).not.toContain("key=");
    expect(traceUrls("https://factory.example", "acme", "widget", "k", 12).socket).toContain("&limit=12");
    expect(traceUrls("https://factory.example", "acme", "widget", "k", 12).socket).not.toContain("key=");
  });
});

describe("session", () => {
  it("loads usage and trace, then streams steps over the socket", async () => {
    const socket = fakeSocket();
    let socketOpenedUrl = "";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/usage")) {
        return jsonResponse({ ok: true, usage: { runs: 1, succeeded: 0, failed: 0, skipped: 1, actions: 0, tokensIn: 5, tokensOut: 1, estimated: true } });
      }
      if (url.endsWith("/ticket")) {
        return jsonResponse({ ok: true, ticket: "test-ticket-xyz" });
      }
      return jsonResponse({ ok: true, count: 1, steps: [step({ id: "seed" })] });
    });
    const session = new ObservabilitySession({
      base: "https://factory.example",
      owner: "acme",
      repo: "widget",
      key: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      socketFactory: (url: string) => {
        socketOpenedUrl = url;
        return socket;
      },
      pollMs: 5,
    });

    await session.connect();
    expect(session.state.usage?.runs).toBe(1);
    expect(session.state.steps.map((entry) => entry.id)).toEqual(["seed"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // All three requests carried the control key in a header, never in the URL.
    for (const call of fetchImpl.mock.calls) {
      expect(String(call[0])).not.toContain("key=k");
      expect((call[1] as RequestInit).headers).toEqual({ "x-factory-control-key": "k" });
    }
    // Socket was opened with the freshly minted ticket in query string, never key=
    expect(socketOpenedUrl).toContain("ticket=test-ticket-xyz");
    expect(socketOpenedUrl).not.toContain("key=");

    socket.emit("open");
    expect(session.state.status).toBe("live");
    socket.emit("message", JSON.stringify({ type: "step", step: step({ id: "live-1", sequence: 2 }) }));
    expect(session.state.steps[0]?.id).toBe("live-1");
    socket.emit("message", "not json");
    expect(session.state.steps).toHaveLength(2);
    session.disconnect();
  });

  it("mints a fresh ticket before opening the socket and on each reconnect", async () => {
    let ticketCounter = 1;
    const socketUrls: string[] = [];
    const socket = pingableSocket();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/ticket")) {
        return jsonResponse({ ok: true, ticket: `ticket-${ticketCounter++}` });
      }
      return jsonResponse({ ok: true, usage: null, steps: [] });
    });
    const session = new ObservabilitySession({
      base: "https://factory.example",
      owner: "acme",
      repo: "widget",
      key: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      socketFactory: (url) => {
        socketUrls.push(url);
        return socket;
      },
      reconnectBaseMs: 100000,
      pollMs: 100000,
    });
    await session.connect();
    expect(socketUrls).toEqual(["wss://factory.example/trace/acme/widget/socket?ticket=ticket-1&limit=50"]);
    socket.emit("open");
    socket.emit("error");
    await session.reconnect();
    expect(socketUrls).toEqual([
      "wss://factory.example/trace/acme/widget/socket?ticket=ticket-1&limit=50",
      "wss://factory.example/trace/acme/widget/socket?ticket=ticket-2&limit=50",
    ]);
    session.disconnect();
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

  it("polling covers a failed socket, and disconnect clears every timer", async () => {
    const socket = fakeSocket();
    const session = new ObservabilitySession({
      base: "https://factory.example",
      owner: "acme",
      repo: "widget",
      key: "k",
      fetchImpl: (async () => jsonResponse({ ok: true, usage: null, steps: [] })) as unknown as typeof fetch,
      socketFactory: () => socket,
      pollMs: 100000,
      reconnectBaseMs: 100000,
    });
    await session.connect();
    socket.emit("open");
    expect(session.state.status).toBe("live");
    socket.emit("error");
    // The socket is the thing the panel wants back, so the status says so even
    // though polling is already filling in the rows underneath.
    expect(session.state.status).toBe("reconnecting");
    expect(session.polling).toBe(true);
    expect(session.retrying).toBe(true);
    expect(session.state.reconnectAttempts).toBe(1);
    expect(session.state.error).toBe("socket error");
    expect(socket.closed).toBe(true);
    session.disconnect();
    expect(session.polling).toBe(false);
    expect(session.retrying).toBe(false);
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
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith("/ticket")) return jsonResponse({ ok: true, ticket: "k-ticket" });
          return jsonResponse({ ok: true, usage: null, steps: [] });
        }) as unknown as typeof fetch,
        pollMs: 100000,
      });
      await session.connect();
      expect(opened).toEqual(["wss://factory.example/trace/acme/widget/socket?ticket=k-ticket&limit=50"]);
      expect(opened[0]).not.toContain("key=");
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

function sessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    status: "idle",
    steps: [],
    usage: null,
    selectedId: null,
    error: null,
    lastMessageAt: null,
    lastPongAt: null,
    reconnectAttempts: 0,
    nextRetryAt: null,
    ...overrides,
  };
}

describe("heartbeat", () => {
  it("pings the open socket and stays live while pongs come back", async () => {
    const socket = pingableSocket();
    const session = new ObservabilitySession({
      base: "https://factory.example",
      owner: "acme",
      repo: "widget",
      key: "k",
      fetchImpl: (async () => jsonResponse({ ok: true, usage: null, steps: [] })) as unknown as typeof fetch,
      socketFactory: () => socket,
      heartbeatMs: 10,
      pongTimeoutMs: 500,
      pollMs: 100000,
    });
    await session.connect();
    socket.emit("open");
    expect(session.heartbeating).toBe(true);
    await sleep(40);
    // A heartbeat is an explicit `ping`, which is exactly what the Worker answers.
    expect(socket.sent).toContain("ping");
    expect(session.state.status).toBe("live");
    socket.emit("message", JSON.stringify({ type: "pong", at: "2026-10-19T13:23:08.383Z" }));
    expect(session.state.status).toBe("live");
    expect(session.state.lastPongAt).not.toBeNull();
    expect(session.state.lastMessageAt).not.toBeNull();
    session.disconnect();
    expect(session.heartbeating).toBe(false);
  });

  it("reconnects instead of claiming to be live when a ping goes unanswered", async () => {
    const sockets: Array<ReturnType<typeof pingableSocket>> = [];
    const session = new ObservabilitySession({
      base: "https://factory.example",
      owner: "acme",
      repo: "widget",
      key: "k",
      fetchImpl: (async () => jsonResponse({ ok: true, usage: null, steps: [] })) as unknown as typeof fetch,
      socketFactory: () => {
        const socket = pingableSocket();
        sockets.push(socket);
        return socket;
      },
      heartbeatMs: 10,
      pongTimeoutMs: 25,
      reconnectBaseMs: 100000,
      pollMs: 100000,
    });
    await session.connect();
    sockets[0]?.emit("open");
    expect(session.state.status).toBe("live");
    await vi.waitFor(
      () => {
        expect(session.state.status).toBe("reconnecting");
        expect(session.state.error).toContain("heartbeat lost");
        expect(session.state.reconnectAttempts).toBe(1);
        expect(sockets[0]?.closed).toBe(true);
      },
      { timeout: 1000, interval: 20 },
    );
    // The socket still looked open; only the missing pong revealed it was dead.
    expect(session.state.nextRetryAt).not.toBeNull();
    expect(session.retrying).toBe(true);
    expect(session.polling).toBe(true);
    session.disconnect();
    expect(session.polling).toBe(false);
    expect(session.retrying).toBe(false);
    expect(session.heartbeating).toBe(false);
  });

  it("times out a handshake that never completes (review cb3)", async () => {
    const sockets: Array<ReturnType<typeof pingableSocket>> = [];
    const session = new ObservabilitySession({
      base: "https://factory.example",
      owner: "acme",
      repo: "widget",
      key: "k",
      fetchImpl: (async () => jsonResponse({ ok: true, usage: null, steps: [] })) as unknown as typeof fetch,
      socketFactory: () => {
        const socket = pingableSocket();
        sockets.push(socket);
        return socket;
      },
      heartbeatMs: 10,
      pongTimeoutMs: 25,
      reconnectBaseMs: 100000,
      pollMs: 100000,
    });
    await session.connect();
    // The socket stays CONNECTING and `send` throws, exactly like a browser whose
    // handshake is being swallowed: no `open` event will ever arrive.
    expect(session.state.status).toBe("connecting");
    expect(sockets[0]?.readyState).toBe(0);
    await sleep(90);
    expect(session.state.status).toBe("reconnecting");
    expect(session.state.error).toContain("handshake timed out");
    expect(session.state.reconnectAttempts).toBe(1);
    expect(sockets[0]?.closed).toBe(true);
    expect(session.polling).toBe(true);
    session.disconnect();
  });

  it("keeps backing off while a socket keeps dying before it proves itself", async () => {
    const sockets: Array<ReturnType<typeof pingableSocket>> = [];
    const session = new ObservabilitySession({
      base: "https://factory.example",
      owner: "acme",
      repo: "widget",
      key: "k",
      fetchImpl: (async () => jsonResponse({ ok: true, usage: null, steps: [] })) as unknown as typeof fetch,
      socketFactory: () => {
        const socket = pingableSocket();
        sockets.push(socket);
        setTimeout(() => socket.emit("open"), 5);
        return socket;
      },
      heartbeatMs: 10,
      pongTimeoutMs: 20,
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      pollMs: 100000,
    });
    await session.connect();
    sockets[0]?.emit("open");
    await vi.waitFor(
      () => {
        expect(session.state.reconnectAttempts).toBeGreaterThanOrEqual(2);
        expect(sockets.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 1500, interval: 20 },
    );
    session.disconnect();
  });

  it("resets the backoff once a reconnected socket answers a ping", async () => {
    const sockets: Array<ReturnType<typeof pingableSocket>> = [];
    let created = 0;
    const session = new ObservabilitySession({
      base: "https://factory.example",
      owner: "acme",
      repo: "widget",
      key: "k",
      fetchImpl: (async () => jsonResponse({ ok: true, usage: null, steps: [] })) as unknown as typeof fetch,
      socketFactory: () => {
        created += 1;
        const socket = pingableSocket();
        sockets.push(socket);
        if (created > 1) {
          // The retry worked: the new socket opens and then answers every ping,
          // so the backoff has proof of life rather than one lucky pong.
          const send = socket.send?.bind(socket);
          socket.send = (data: string) => {
            send?.(data);
            if (data === "ping") {
              setTimeout(() => {
                socket.emit("message", JSON.stringify({ type: "pong", at: "2026-10-19T13:23:08.383Z" }));
              }, 0);
            }
          };
          setTimeout(() => socket.emit("open"), 5);
        }
        return socket;
      },
      heartbeatMs: 10,
      pongTimeoutMs: 20,
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      pollMs: 100000,
    });
    await session.connect();
    sockets[0]?.emit("open");
    await vi.waitFor(
      () => {
        expect(created).toBeGreaterThanOrEqual(2);
        expect(session.state.reconnectAttempts).toBe(0);
        expect(session.state.status).toBe("live");
      },
      { timeout: 1000, interval: 20 },
    );
    session.disconnect();
  });

  it("retries immediately when the operator asks, cancelling the scheduled wait", async () => {
    const sockets: Array<ReturnType<typeof pingableSocket>> = [];
    const session = new ObservabilitySession({
      base: "https://factory.example",
      owner: "acme",
      repo: "widget",
      key: "k",
      fetchImpl: (async () => jsonResponse({ ok: true, usage: null, steps: [] })) as unknown as typeof fetch,
      socketFactory: () => {
        const socket = pingableSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectBaseMs: 100000,
      pollMs: 100000,
    });
    await session.connect();
    sockets[0]?.emit("open");
    sockets[0]?.emit("error");
    expect(session.state.status).toBe("reconnecting");
    expect(session.retrying).toBe(true);
    await session.reconnect();
    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.closed).toBe(true);
    expect(session.retrying).toBe(false);
    expect(session.state.reconnectAttempts).toBe(0);
    session.disconnect();
  });
});

describe("connection health", () => {
  it("reports how long ago the socket last answered", () => {
    const state = sessionState({ status: "live", lastPongAt: 1000, lastMessageAt: 1000 });
    expect(statusText(state, 13000)).toBe("live · 0 step(s) · heartbeat 12s ago");
    expect(statusTone(state)).toBe("ok");
  });

  it("says a live socket has no heartbeat yet rather than inventing one", () => {
    expect(statusText(sessionState({ status: "live" }), 5000)).toContain("no heartbeat yet");
  });

  it("counts down to the next reconnect and then says it is retrying", () => {
    const state = sessionState({ status: "reconnecting", reconnectAttempts: 2, nextRetryAt: 4000, error: "socket error" });
    expect(statusText(state, 1000)).toBe("reconnecting (attempt 2, retry in 3s) · socket error");
    expect(statusText(state, 4000)).toBe("reconnecting (attempt 2, retrying now) · socket error");
    expect(statusTone(state)).toBe("warn");
  });

  it("names the failure when the connection gave up", () => {
    const state = sessionState({ status: "error", error: "control key rejected (401)" });
    expect(statusText(state, 0)).toBe("control key rejected (401)");
    expect(statusTone(state)).toBe("error");
    expect(statusText(sessionState({ status: "idle" }), 0)).toBe("Disconnected");
    expect(statusText(sessionState({ status: "polling" }), 0)).toBe("polling (socket unavailable)");
    expect(statusText(sessionState({ status: "connecting" }), 0)).toBe("connecting…");
  });

  it("formats a heartbeat age without waiting on real time", () => {
    expect(heartbeatAge(0, null)).toBe("no heartbeat yet");
    expect(heartbeatAge(5000, 4000)).toBe("just now");
    expect(heartbeatAge(17000, 5000)).toBe("12s ago");
    expect(heartbeatAge(125000, 5000)).toBe("2m ago");
  });

  it("backs off exponentially with a ceiling, so a down Worker is not hammered", () => {
    expect(reconnectDelay(1)).toBe(1000);
    expect(reconnectDelay(2)).toBe(2000);
    expect(reconnectDelay(3, 1000, 5000)).toBe(4000);
    expect(reconnectDelay(4, 1000, 5000)).toBe(5000);
    expect(reconnectDelay(99, 1000, 30000)).toBe(30000);
    expect(reconnectDelay(0)).toBe(1000);
    expect(reconnectDelay(Number.NaN)).toBe(1000);
  });
});

describe("reconnect control", () => {
  it("offers a Reconnect button that an idle panel does not enable", () => {
    const tag = /<button[^>]*obs-btn-reconnect[^>]*>/.exec(indexHtml)?.[0] ?? "";
    expect(tag).not.toBe("");
    expect(tag).toContain("disabled");
    expect(indexHtml).toContain("obs-status");
    expect(indexHtml).toContain('aria-live="polite"');
  });
});
