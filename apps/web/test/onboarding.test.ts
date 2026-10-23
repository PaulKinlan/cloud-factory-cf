import { afterEach, describe, expect, it, vi } from "vitest";
// The header control and the dialog are part of the contract, so assert on the markup.
import indexHtml from "../index.html?raw";
import {
  ConnectPoller,
  wireVisibility,
  DIALOG_POLL_MS,
  IDLE_POLL_MS,
  STALE_AFTER_MS,
  ageLabel,
  connectSummary,
  installUrl,
  parseRepository,
  pillLabel,
  pollIntervalMs,
  webhookUrl,
  mountConnectGate,
  type ConnectEvidence,
} from "../src/onboarding";

/**
 * GitHub onboarding gate (cloud-factory-cf-7gq.2): the decisions behind the header
 * pill and the Connect GitHub dialog, tested without a DOM or a network.
 */

function evidence(overrides: Partial<ConnectEvidence> = {}): ConnectEvidence {
  return {
    repository: "acme/widget",
    lastPingAt: null,
    lastEventAt: null,
    lastEvent: null,
    pings: 0,
    ...overrides,
  };
}

const NOW = Date.parse("2026-10-19T16:00:00.000Z");
const iso = (offsetMs: number): string => new Date(NOW - offsetMs).toISOString();

describe("webhook url", () => {
  it("points GitHub at the repository's own webhook route", () => {
    expect(webhookUrl("https://factory.example", "acme", "widget")).toBe(
      "https://factory.example/webhooks/github/acme/widget",
    );
    // A trailing slash on the origin must not produce a double slash.
    expect(webhookUrl("https://factory.example/", "acme", "widget")).toBe(
      "https://factory.example/webhooks/github/acme/widget",
    );
  });

  it("encodes a scope that is unusual but still valid", () => {
    expect(webhookUrl("https://factory.example", "acme corp", "w/g")).toBe(
      "https://factory.example/webhooks/github/acme%20corp/w%2Fg",
    );
  });
});

describe("install link", () => {
  it("builds the App install URL and carries the scope as state", () => {
    expect(installUrl("cloud-factory", "acme/widget")).toBe(
      "https://github.com/apps/cloud-factory/installations/new?state=acme%2Fwidget",
    );
    expect(installUrl("/cloud-factory/", "acme/widget")).toContain("/apps/cloud-factory/installations/new");
  });
});

describe("scope parsing", () => {
  it("accepts owner/repo and refuses anything else", () => {
    expect(parseRepository("acme/widget")).toEqual({ owner: "acme", repo: "widget" });
    expect(parseRepository("  acme/widget  ")).toEqual({ owner: "acme", repo: "widget" });
    expect(parseRepository("acme/widget/extra")).toBeNull();
    expect(parseRepository("acme")).toBeNull();
    expect(parseRepository("")).toBeNull();
    expect(parseRepository("acme/wid get")).toBeNull();
  });

  it("labels the pill with the scope, or says there is none", () => {
    expect(pillLabel({ owner: "acme", repo: "widget" })).toBe("acme/widget");
    expect(pillLabel(null)).toBe("No repository");
  });
});

describe("connection summary", () => {
  it("never turns silence into a green light", () => {
    expect(connectSummary(null, NOW)).toEqual({ label: "Not checked yet", tone: "muted" });
    expect(connectSummary(evidence(), NOW)).toEqual({ label: "Waiting for GitHub's ping", tone: "warn" });
  });

  it("calls it connected only once the ping has arrived", () => {
    expect(connectSummary(evidence({ lastPingAt: iso(0), lastEventAt: iso(0), pings: 1 }), NOW)).toEqual({
      label: "Connected · ping just now",
      tone: "ok",
    });
    expect(connectSummary(evidence({ lastPingAt: iso(5 * 60_000), pings: 1 }), NOW)).toEqual({
      label: "Connected · ping 5m ago",
      tone: "ok",
    });
  });

  it("warns when events arrive but the handshake never did", () => {
    expect(connectSummary(evidence({ lastEventAt: iso(60_000), lastEvent: "push" }), NOW)).toEqual({
      label: "Receiving events · no ping yet (1m ago)",
      tone: "warn",
    });
  });

  it("does not call a day-old ping healthy", () => {
    const stale = connectSummary(evidence({ lastPingAt: iso(STALE_AFTER_MS + 60_000), pings: 1 }), NOW);
    expect(stale.tone).toBe("warn");
    expect(stale.label).toContain("check the hook");
  });

  it("formats ages without drifting", () => {
    expect(ageLabel(NOW, null)).toBe("never");
    expect(ageLabel(NOW, iso(30_000))).toBe("just now");
    expect(ageLabel(NOW, iso(5 * 60_000))).toBe("5m ago");
    expect(ageLabel(NOW, iso(3 * 3_600_000))).toBe("3h ago");
    expect(ageLabel(NOW, iso(2 * 86_400_000))).toBe("2d ago");
    // An unparseable timestamp is shown, not turned into "never".
    expect(ageLabel(NOW, "not a date")).toBe("not a date");
  });
});

describe("markup contract", () => {
  it("puts a real dialog behind the header pill", () => {
    const pill = /<button[^>]*id="repo-pill"[^>]*>/.exec(indexHtml)?.[0] ?? "";
    expect(pill).not.toBe("");
    expect(pill).toContain('aria-haspopup="dialog"');
    expect(pill).toContain('aria-controls="connect-dialog"');
    expect(indexHtml).toContain('<dialog id="connect-dialog"');
    // Native modal behaviour (focus trapping, Escape) comes from <dialog>.
    expect(indexHtml).toMatch(/<dialog[^>]*id="connect-dialog"/);
  });

  it("shows the webhook URL read-only and styles input controls with field__control", () => {
    const url = /<input[^>]*id="connect-url"[^>]*>/.exec(indexHtml)?.[0] ?? "";
    expect(url).toContain("readonly");
    expect(url).toContain("field__control");
    expect(url).toContain('aria-label="Webhook URL (payload URL)"');
    expect(indexHtml).toContain('<label class="field" for="connect-url">');

    const owner = /<input[^>]*id="connect-owner"[^>]*>/.exec(indexHtml)?.[0] ?? "";
    expect(owner).toContain("field__control");

    const repo = /<input[^>]*id="connect-repo"[^>]*>/.exec(indexHtml)?.[0] ?? "";
    expect(repo).toContain("field__control");

    // Repo select also has field__control
    const repoSelect = /<select[^>]*id="connect-repo-select"[^>]*>/.exec(indexHtml)?.[0] ?? "";
    expect(repoSelect).toContain("field__control");

    // Control key is removed entirely from connect dialog
    expect(indexHtml).not.toContain('id="connect-key"');
    expect(indexHtml).not.toContain("localStorage");
  });

  it("offers install, copy and check controls", () => {
    expect(indexHtml).toContain('id="connect-install"');
    expect(indexHtml).toContain('id="connect-copy"');
    expect(indexHtml).toContain('id="connect-check"');
    expect(indexHtml).toContain('id="connect-status"');
    expect(indexHtml).toContain('aria-live="polite"');
    expect(indexHtml).toContain('id="connect-oauth"');
    expect(indexHtml).toContain('href="/auth/github/login"');
    expect(indexHtml).toContain('id="connect-repo-select"');
  });
});

function connectResponse(evidenceBody: ConnectEvidence | null, status = 200): Response {
  return new Response(JSON.stringify(evidenceBody === null ? { ok: false } : { ok: true, connect: evidenceBody }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("live indicator poller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the route and reports the evidence", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      seen.push(String(input));
      return connectResponse(evidence({ lastPingAt: iso(0), lastEventAt: iso(0), pings: 1 }));
    });
    const poller = new ConnectPoller({
      base: "https://factory.example/",
      scope: () => ({ owner: "acme", repo: "widget" }),
      key: () => "sekret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    await poller.check();
    expect(seen).toEqual(["https://factory.example/trace/acme/widget/connect"]);
    expect(poller.state.evidence?.pings).toBe(1);
    expect(poller.state.error).toBeNull();
    // The key travels in a header, never in the URL.
    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.["x-factory-control-key"]).toBe("sekret");
    expect(seen[0]).not.toContain("sekret");
  });

  it("polls on the dialog cadence, then the slower idle cadence", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => connectResponse(evidence({ lastPingAt: iso(0), pings: 1 })));
    const poller = new ConnectPoller({
      base: "https://factory.example",
      scope: () => ({ owner: "acme", repo: "widget" }),
      key: () => "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    poller.setMode("dialog");
    poller.start();
    expect(pollIntervalMs("dialog")).toBe(DIALOG_POLL_MS);
    expect(pollIntervalMs("idle")).toBe(IDLE_POLL_MS);
    await vi.advanceTimersByTimeAsync(DIALOG_POLL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DIALOG_POLL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    poller.setMode("idle");
    await vi.advanceTimersByTimeAsync(DIALOG_POLL_MS);
    // The dialog's cadence was left behind with the dialog.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    poller.stop();
    expect(poller.active).toBe(false);
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("discards a read that was in flight when the key changed", async () => {
    // A slow answer to the OLD key must not overwrite the state the operator is now
    // looking at — including its 401, which would re-pause a fixed poller (7gq.4).
    let key = "wrong";
    // A property, not a `let`: assignments inside a Promise executor are invisible to
    // control-flow narrowing, so a captured `let` reads as null at the call site.
    const pending: { release: (() => void) | null } = { release: null };
    const fetchImpl = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          pending.release = () => resolve(connectResponse(null, 401));
        }),
    );
    const poller = new ConnectPoller({
      base: "https://factory.example",
      scope: () => ({ owner: "acme", repo: "widget" }),
      key: () => key,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });

    const slow = poller.check();
    key = "right";
    poller.reset();
    pending.release?.();
    await slow;

    expect(poller.state.paused).toBe(false);
    expect(poller.state.error).toBeNull();
    expect(poller.state.checking).toBe(false);
  });

  it("reads a stale error into nothing when the scope changed mid-flight", async () => {
    let scope = { owner: "acme", repo: "widget" };
    const pending: { release: (() => void) | null } = { release: null };
    const poller = new ConnectPoller({
      base: "https://factory.example",
      scope: () => scope,
      key: () => "k",
      fetchImpl: (async () =>
        new Promise<Response>((resolve) => {
          pending.release = () => resolve(new Response("boom", { status: 500 }));
        })) as unknown as typeof fetch,
      now: () => NOW,
    });

    const slow = poller.check();
    scope = { owner: "acme", repo: "gadget" };
    pending.release?.();
    await slow;

    // The 500 belonged to the repository the operator has navigated away from.
    expect(poller.state.error).toBeNull();
    expect(poller.state.checking).toBe(false);
  });

  it("reads immediately when the tab comes back, instead of waiting an interval", () => {
    const calls: string[] = [];
    const slot: { listener: (() => void) | null } = { listener: null };
    const doc = {
      hidden: true,
      addEventListener: (_type: "visibilitychange", fn: () => void) => {
        slot.listener = fn;
      },
    };
    const poller = { start: () => calls.push("start"), stop: () => calls.push("stop"), check: async () => void calls.push("check") };
    wireVisibility(poller, doc);

    slot.listener?.();
    expect(calls).toEqual(["stop"]);

    doc.hidden = false;
    slot.listener?.();
    // start() first so the interval is running, then the immediate read.
    expect(calls).toEqual(["stop", "start", "check"]);
  });

  it("stops hammering a refused key until it changes", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => connectResponse(null, 401));
    const poller = new ConnectPoller({
      base: "https://factory.example",
      scope: () => ({ owner: "acme", repo: "widget" }),
      key: () => "wrong",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      dialogMs: 100,
    });
    poller.setMode("dialog");
    poller.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(poller.state.paused).toBe(true);
    expect(poller.state.error).toBe("control key rejected (401)");
    expect(poller.active).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The operator edits the key: polling is allowed again.
    poller.reset();
    expect(poller.state.paused).toBe(false);
    poller.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("reports a transport failure instead of throwing, and keeps polling", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const poller = new ConnectPoller({
      base: "https://factory.example",
      scope: () => ({ owner: "acme", repo: "widget" }),
      key: () => "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      idleMs: 100,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(poller.state.error).toContain("offline");
    expect(poller.active).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("does not read without a scope or a key, and never overlaps requests", async () => {
    let resolve: ((value: Response) => void) | null = null;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const poller = new ConnectPoller({
      base: "https://factory.example",
      scope: () => null,
      key: () => "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    await poller.check();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(poller.state.error).toBe("No repository selected");

    const scoped = new ConnectPoller({
      base: "https://factory.example",
      scope: () => ({ owner: "acme", repo: "widget" }),
      key: () => "",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    await scoped.check();
    expect(scoped.state.error).toBe("A control key is needed");

    const busy = new ConnectPoller({
      base: "https://factory.example",
      scope: () => ({ owner: "acme", repo: "widget" }),
      key: () => "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    const first = busy.check();
    await busy.check(); // second call while the first is in flight is a no-op
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolve!(connectResponse(evidence({ lastPingAt: iso(0) })));
    await first;
    expect(busy.state.evidence?.repository).toBe("acme/widget");
  });
});

describe("mountConnectGate and repo selector population (cloud-factory-cf-7gm)", () => {
  function createMockElement(tag = "div") {
    const listeners: Record<string, ((e?: any) => void)[]> = {};
    const children: any[] = [];
    const attrs: Record<string, string> = {};
    return {
      tag,
      value: "",
      textContent: "",
      className: "",
      hidden: true,
      innerHTML: "",
      href: "",
      dataset: {} as Record<string, string>,
      options: children,
      children,
      open: false,
      focus: vi.fn(),
      select: vi.fn(),
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
      getAttribute: (k: string) => attrs[k] ?? null,
      showModal: function () {
        this.open = true;
      },
      close: function () {
        this.open = false;
      },
      appendChild: function (child: any) {
        children.push(child);
      },
      addEventListener: function (event: string, fn: (e?: any) => void) {
        listeners[event] = listeners[event] || [];
        listeners[event]!.push(fn);
      },
      dispatchEvent: function (event: string, data?: any) {
        if (listeners[event]) {
          for (const fn of listeners[event]!) {
            fn(data);
          }
        }
      },
    };
  }

  function createMockDom() {
    const pill = createMockElement("button");
    const pillLabel = createMockElement("span");
    const dialog = createMockElement("dialog");
    const ownerInput = createMockElement("input");
    const repoInput = createMockElement("input");
    const keyInput = createMockElement("input");
    const urlInput = createMockElement("input");
    const copyButton = createMockElement("button");
    const installLink = createMockElement("a");
    const checkButton = createMockElement("button");
    const statusNode = createMockElement("p");
    const announcer = createMockElement("span");
    const repoSelect = createMockElement("select");

    const elements: Record<string, any> = {
      "#repo-pill": pill,
      ".repo-pill__label": pillLabel,
      "#connect-dialog": dialog,
      "#connect-owner": ownerInput,
      "#connect-repo": repoInput,
      "#connect-key": keyInput,
      "#connect-url": urlInput,
      "#connect-copy": copyButton,
      "#connect-install": installLink,
      "#connect-check": checkButton,
      "#connect-status": statusNode,
      "#connect-announcer": announcer,
      "#connect-repo-select": repoSelect,
    };

    const doc = {
      createElement: (tag: string) => createMockElement(tag),
      querySelector: (selector: string) => elements[selector] ?? null,
    };

    return { doc, elements };
  }

  it("populates repo select dropdown from /api/repos and updates inputs on selection", async () => {
    const { doc, elements } = createMockDom();
    const testRepos = [
      { fullName: "octodev/widget-service", owner: "octodev", name: "widget-service" },
      { fullName: "octodev/secret-project", owner: "octodev", name: "secret-project" },
    ];

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/repos")) {
        return new Response(JSON.stringify({ ok: true, count: 2, repositories: testRepos }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    let selectedScope: { owner: string; repo: string } | null = null;
    const gate = mountConnectGate(doc as any, {
      base: "https://factory.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onScope: (s) => {
        selectedScope = s;
      },
    });

    expect(gate).toBeDefined();

    // 1. Enter key and owner: triggers loadAuthorizedRepos
    elements["#connect-key"].value = "test-control-key";
    elements["#connect-owner"].value = "octodev";
    elements["#connect-key"].dispatchEvent("input");

    // Allow fetch promise in loadAuthorizedRepos to resolve and unhide select
    await vi.waitFor(() => {
      expect(elements["#connect-repo-select"].hidden).toBe(false);
    });

    // Verify /api/repos was called with x-factory-control-key
    const apiCall = fetchImpl.mock.calls.find((call) => String(call[0]).includes("/api/repos"));
    expect(apiCall).toBeDefined();
    expect(String(apiCall![0])).toBe("https://factory.example/api/repos?owner=octodev");
    expect((apiCall![1] as any)?.headers?.["x-factory-control-key"]).toBe("test-control-key");

    // 2. Verify repo select is unhidden and populated with options
    expect(elements["#connect-repo-select"].hidden).toBe(false);
    expect(elements["#connect-repo-select"].children.length).toBe(2);
    expect(elements["#connect-repo-select"].children[0].value).toBe("octodev/widget-service");
    expect(elements["#connect-repo-select"].children[1].value).toBe("octodev/secret-project");

    // 3. User chooses 'octodev/secret-project' from the dropdown
    elements["#connect-repo-select"].value = "octodev/secret-project";
    elements["#connect-repo-select"].dispatchEvent("change");

    // 4. Assert inputs and scope are updated
    expect(elements["#connect-owner"].value).toBe("octodev");
    expect(elements["#connect-repo"].value).toBe("secret-project");
    expect(selectedScope).toEqual({ owner: "octodev", repo: "secret-project" });
    expect(gate?.scope()).toEqual({ owner: "octodev", repo: "secret-project" });
  });

  it("handles connected=1 post-OAuth bootstrap to open dialog and populate dropdown", async () => {
    const { doc, elements } = createMockDom();
    const testRepos = [
      { fullName: "octodev/widget-service", owner: "octodev", name: "widget-service" },
    ];

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/repos")) {
        return new Response(JSON.stringify({ ok: true, count: 1, repositories: testRepos }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    // Mock window.location with connected=1
    const originalLocation = globalThis.window?.location;
    const mockHref = "https://factory.example/?connected=1&owner=octodev&installation_id=inst_456";
    const mockWindow = {
      location: new URL(mockHref),
      history: {
        replaceState: vi.fn(),
      },
    };
    vi.stubGlobal("window", mockWindow);

    try {
      elements["#connect-key"].value = "test-control-key";
      const gate = mountConnectGate(doc as any, {
        base: "https://factory.example",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(gate).toBeDefined();
      expect(elements["#connect-owner"].value).toBe("octodev");
      expect(elements["#connect-dialog"].open).toBe(true);

      await vi.waitFor(() => {
        expect(elements["#connect-repo-select"].hidden).toBe(false);
      });

      expect(elements["#connect-repo-select"].hidden).toBe(false);
      expect(elements["#connect-repo-select"].children.length).toBe(1);
      expect(elements["#connect-repo-select"].children[0].value).toBe("octodev/widget-service");

      // Verify URL clean-up occurred
      expect(mockWindow.history.replaceState).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("populates the repo select from the session cookie after a 1-click connect, with no control key typed (cloud-factory-cf-d33)", async () => {
    const { doc, elements } = createMockDom();
    const testRepos = [{ fullName: "octodev/widget-service", owner: "octodev", name: "widget-service" }];

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/repos")) {
        return new Response(JSON.stringify({ ok: true, count: 1, repositories: testRepos }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const mockWindow = {
      location: new URL("https://factory.example/?connected=1&owner=octodev"),
      history: { replaceState: vi.fn() },
    };
    vi.stubGlobal("window", mockWindow);

    try {
      // The browser holds a session cookie for this account; it never holds the key.
      expect(elements["#connect-key"].value).toBe("");
      const gate = mountConnectGate(doc as any, {
        base: "https://factory.example",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(gate).toBeDefined();

      await vi.waitFor(() => {
        expect(elements["#connect-repo-select"].hidden).toBe(false);
      });

      expect(elements["#connect-repo-select"].children[0].value).toBe("octodev/widget-service");

      const apiCall = fetchImpl.mock.calls.find((call) => String(call[0]).includes("/api/repos"));
      expect(apiCall).toBeDefined();
      expect((apiCall![1] as any)?.headers?.["x-factory-control-key"]).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("says why the repository list is empty when /api/repos refuses the browser (cloud-factory-cf-d33)", async () => {
    const { doc, elements } = createMockDom();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/repos")) {
        return new Response(JSON.stringify({ ok: false, error: "not authorised to access repository metadata" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const mockWindow = {
      location: new URL("https://factory.example/?connected=1&owner=octodev"),
      history: { replaceState: vi.fn() },
    };
    vi.stubGlobal("window", mockWindow);

    try {
      mountConnectGate(doc as any, {
        base: "https://factory.example",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await vi.waitFor(() => {
        expect(elements["#connect-status"].textContent).toContain("Reconnect with GitHub");
      });
      expect(elements["#connect-status"].className).toContain("connect-status--warn");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
