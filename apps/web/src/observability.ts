/**
 * Observability panel (cloud-factory-cf-2ng).
 *
 * Three views over data the Worker already records:
 *   - the live thought stream (WebSocket, polling fallback),
 *   - the artifact inspector for one step,
 *   - the cost HUD (counts + token estimates).
 *
 * Everything except `mountObservability` is pure, so the panel's decisions are
 * tested without a DOM or a network (see test/observability.test.ts): the session
 * class owns state and takes its `fetch` and `WebSocket` from the caller.
 */

export type TraceStatus = "info" | "ok" | "warn" | "error";

export interface TraceStep {
  id: string;
  deliveryId: string;
  sequence: number;
  step: string;
  status: TraceStatus;
  detail: string;
  artifact: unknown;
  at: string;
  ms: number | null;
}

export interface Usage {
  runs: number;
  succeeded: number;
  failed: number;
  skipped: number;
  actions: number;
  tokensIn: number;
  tokensOut: number;
  /** Always true today: the pipeline reports character counts, not model usage. */
  estimated?: boolean;
  byAction?: Record<string, number>;
  byStep?: Record<string, number>;
  latestAt?: string | null;
}

/** The panel's default page of steps, and the range its Limit field allows. */
export const DEFAULT_LIMIT = 50;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 200;

/** Clamp a limit to what the trace route accepts, so a typo cannot 400 or flood. */
export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(limit)));
}

export interface TraceUrls {
  trace: string;
  usage: string;
  ticket?: string;
  socket: string;
}

/** Keep the newest `cap` steps, newest first, de-duplicated by id. */
export function mergeStep(steps: readonly TraceStep[], incoming: TraceStep, cap = 200): TraceStep[] {
  if (steps.some((step) => step.id === incoming.id)) return [...steps];
  const next = [incoming, ...steps];
  return next.length > cap ? next.slice(0, cap) : next;
}

/** One line of the stream: label, status, detail and how long it took. */
export function formatStep(step: TraceStep): { label: string; detail: string; meta: string } {
  const label = step.step === "" ? "step" : step.step;
  const meta = [step.status, step.ms === null ? null : `${step.ms}ms`, clockTime(step.at)]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" · ");
  return { label, detail: step.detail === "" ? "(no detail)" : step.detail, meta };
}

/** `13:23:08` in the viewer's locale, or the raw value when it cannot be parsed. */
export function clockTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * The artifact inspector's body. JSON is pretty-printed and capped so a large
 * prompt cannot lock the tab up; the cap is visible rather than silent.
 */
export function artifactPreview(artifact: unknown, cap = 4000): { text: string; truncated: boolean } {
  if (artifact === null || artifact === undefined) return { text: "no artifact for this step", truncated: false };
  let text: string;
  try {
    text = typeof artifact === "string" ? artifact : JSON.stringify(artifact, null, 2);
  } catch {
    return { text: "artifact could not be rendered", truncated: false };
  }
  if (text === undefined) return { text: "no artifact for this step", truncated: false };
  if (text.length <= cap) return { text, truncated: false };
  return { text: `${text.slice(0, cap)}\n… (${text.length - cap} more characters)`, truncated: true };
}

export interface HudRow {
  label: string;
  value: string;
  note?: string;
}

/** Cost HUD rows. Token counts are labelled as estimates because they are. */
export function usageRows(usage: Usage | null): HudRow[] {
  if (!usage) return [{ label: "Usage", value: "—", note: "not loaded yet" }];
  const rows: HudRow[] = [
    { label: "Runs", value: String(usage.runs) },
    { label: "Succeeded", value: String(usage.succeeded) },
    { label: "Failed", value: String(usage.failed) },
    { label: "Skipped", value: String(usage.skipped) },
    { label: "Actions emitted", value: String(usage.actions) },
    {
      label: "Tokens in",
      value: String(usage.tokensIn),
      note: usage.estimated === false ? "reported by the runtime" : "estimated from character counts",
    },
    {
      label: "Tokens out",
      value: String(usage.tokensOut),
      note: usage.estimated === false ? "reported by the runtime" : "estimated from character counts",
    },
  ];
  if (usage.latestAt) rows.push({ label: "Latest", value: clockTime(usage.latestAt) });
  return rows;
}

/** `byAction` as sorted rows, so the table does not jump around between renders. */
export function actionRows(usage: Usage | null): HudRow[] {
  const byAction = usage?.byAction ?? {};
  return Object.entries(byAction)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([action, count]) => ({ label: action, value: String(count) }));
}

export function traceUrls(base: string, owner: string, repo: string, ticket = "", limit = DEFAULT_LIMIT): TraceUrls {
  const root = `${base.replace(/\/+$/, "")}/trace/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const socketBase = root.replace(/^http/, "ws");
  const ticketParam = ticket ? `ticket=${encodeURIComponent(ticket)}&` : "";
  return {
    trace: `${root}?limit=${clampLimit(limit)}`,
    usage: `${root}/usage`,
    ticket: `${root}/ticket`,
    socket: `${socketBase}/socket?${ticketParam}limit=${clampLimit(limit)}`,
  };
}

export type SessionStatus = "idle" | "connecting" | "live" | "polling" | "reconnecting" | "error";

/** How often an open socket is pinged. The Worker answers `ping` with `pong`. */
export const HEARTBEAT_MS = 15_000;
/** How long one ping may stay unanswered before the socket is treated as dead. */
export const PONG_TIMEOUT_MS = 15_000;
/** First reconnect delay; it doubles per attempt up to RECONNECT_MAX_MS. */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/**
 * Delay before reconnect attempt `attempt` (1-based): exponential with a hard
 * ceiling, so a Worker that is down for an hour is retried every 30s instead of
 * in a tight loop, and a tab left open overnight does not hammer it.
 */
export function reconnectDelay(attempt: number, base = RECONNECT_BASE_MS, max = RECONNECT_MAX_MS): number {
  if (!Number.isFinite(attempt) || attempt < 1) return base;
  const delay = base * 2 ** Math.min(30, Math.trunc(attempt) - 1);
  return Math.min(max, Math.max(base, delay));
}

export interface SessionState {
  status: SessionStatus;
  steps: TraceStep[];
  usage: Usage | null;
  selectedId: string | null;
  error: string | null;
  /** Epoch ms of the last message the socket delivered, or null when none has. */
  lastMessageAt: number | null;
  /** Epoch ms of the last `pong`: proof the connection is alive in both directions. */
  lastPongAt: number | null;
  /** Consecutive reconnect attempts since the last healthy socket (0 while live). */
  reconnectAttempts: number;
  /** Epoch ms when the next reconnect fires, or null when none is scheduled. */
  nextRetryAt: number | null;
}

export interface SocketLike {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error" | "close" | "open", listener: () => void): void;
  close(): void;
  /** Optional: a socket without `send` cannot be pinged, so idleness is watched instead. */
  send?(data: string): void;
  /** `1` is OPEN in the WebSocket API; absent on fakes, which are assumed usable. */
  readonly readyState?: number;
}

export interface SessionOptions {
  base: string;
  owner: string;
  repo: string;
  key: string;
  ticket?: string;
  fetchImpl?: typeof fetch;
  socketFactory?: (url: string) => SocketLike;
  onUpdate?: (state: SessionState) => void;
  pollMs?: number;
  stepCap?: number;
  /** How many steps to ask the trace route for (the panel's Limit field). */
  limit?: number;
  /** Heartbeat cadence; 0 disables the heartbeat for a session that only polls. */
  heartbeatMs?: number;
  /** How long one outstanding ping may stay unanswered. */
  pongTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Injectable clock, so staleness is testable without waiting on real time. */
  now?: () => number;
}

/**
 * Owns the panel's state and the connection. The socket is the primary source;
 * when it cannot connect (a proxy that blocks upgrades, a tab restored from a
 * background state) the session polls the same rows, so the panel degrades
 * instead of going blank.
 *
 * A socket that is open is not necessarily alive: a dropped TCP connection, a
 * hibernated Durable Object or a sleeping laptop can all leave a `readyState`
 * that still says OPEN while no step ever arrives again. So the session pings on
 * a timer, treats an unanswered ping as death, and reconnects with backoff while
 * polling keeps the rows flowing in the meantime (cloud-factory-cf-2ng.6).
 */
export class ObservabilitySession {
  state: SessionState = {
    status: "idle",
    steps: [],
    usage: null,
    selectedId: null,
    error: null,
    lastMessageAt: null,
    lastPongAt: null,
    reconnectAttempts: 0,
    nextRetryAt: null,
  };
  private socket: SocketLike | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The ping we are still waiting on; one outstanding ping at a time. */
  private pendingPingAt: number | null = null;
  /** When the current socket was created, so a hanging handshake can time out. */
  private pendingOpenAt: number | null = null;
  /** True from connect() until disconnect(): a viewer who stopped gets no retries. */
  private desired = false;
  private options: Required<
    Pick<SessionOptions, "pollMs" | "stepCap" | "heartbeatMs" | "pongTimeoutMs" | "reconnectBaseMs" | "reconnectMaxMs">
  > &
    SessionOptions;

  constructor(options: SessionOptions) {
    this.options = {
      pollMs: 3000,
      stepCap: 200,
      limit: DEFAULT_LIMIT,
      heartbeatMs: HEARTBEAT_MS,
      pongTimeoutMs: PONG_TIMEOUT_MS,
      reconnectBaseMs: RECONNECT_BASE_MS,
      reconnectMaxMs: RECONNECT_MAX_MS,
      ...options,
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private update(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onUpdate?.(this.state);
  }

  private get fetchImpl(): typeof fetch {
    const injected = this.options.fetchImpl;
    if (injected !== undefined) return injected;
    // Called as `this.fetchImpl(...)`, a bare `fetch` would be invoked with the
    // session as its receiver and throw "Illegal invocation" in a browser, so the
    // default goes through a wrapper that keeps the global receiver.
    return (input, init) => globalThis.fetch(input, init);
  }

  async connect(): Promise<void> {
    this.disconnect();
    this.desired = true;
    await this.open();
  }

  /** One connection attempt: read the seed rows, then open the socket. */
  private async open(): Promise<void> {
    if (!this.desired) return;
    this.update({
      status: this.state.reconnectAttempts === 0 ? "connecting" : "reconnecting",
      error: null,
      nextRetryAt: null,
    });
    const urls = traceUrls(this.options.base, this.options.owner, this.options.repo, this.options.ticket ?? "", this.options.limit);
    const headers = { "x-factory-control-key": this.options.key };
    try {
      const [usageResponse, traceResponse] = await Promise.all([
        this.fetchImpl(urls.usage, { headers }),
        this.fetchImpl(urls.trace, { headers }),
      ]);
      // A disconnect (or a newer connect) while the reads were in flight wins.
      if (!this.desired) return;
      if (usageResponse.status === 401 || traceResponse.status === 401) {
        // A rejected key does not fix itself, so fail closed instead of retry-looping.
        this.desired = false;
        this.stopPolling();
        this.update({ status: "error", error: "control key rejected (401)", nextRetryAt: null });
        return;
      }
      if (!usageResponse.ok || !traceResponse.ok) {
        this.retry(`trace request failed (${usageResponse.status}/${traceResponse.status})`);
        return;
      }
      const usage = (await usageResponse.json()) as { usage?: Usage };
      const trace = (await traceResponse.json()) as { steps?: TraceStep[] };
      if (!this.desired) return;
      this.update({
        usage: usage.usage ?? null,
        steps: (trace.steps ?? []).slice(0, this.options.stepCap),
      });
    } catch (error) {
      if (!this.desired) return;
      this.retry(`could not read the trace: ${message(error)}`);
      return;
    }

    let socketTicket = this.options.ticket ?? "";
    if (!socketTicket && urls.ticket && this.socketFactory() !== null) {
      try {
        const ticketResponse = await this.fetchImpl(urls.ticket, { method: "POST", headers });
        if (!this.desired) return;
        if (ticketResponse.status === 401) {
          this.desired = false;
          this.stopPolling();
          this.update({ status: "error", error: "control key rejected (401)", nextRetryAt: null });
          return;
        }
        if (ticketResponse.ok) {
          const body = (await ticketResponse.json()) as { ticket?: string };
          if (body?.ticket) {
            socketTicket = body.ticket;
          }
        }
      } catch {
        // A network error minting the ticket will let openSocket attempt or retry.
      }
    }

    const socketUrl = traceUrls(this.options.base, this.options.owner, this.options.repo, socketTicket, this.options.limit).socket;
    this.openSocket(socketUrl);
  }

  /** The injected factory, or the browser's WebSocket; null means poll instead. */
  private socketFactory(): ((url: string) => SocketLike) | null {
    if (this.options.socketFactory !== undefined) return this.options.socketFactory;
    if (typeof WebSocket === "function") return (url: string) => new WebSocket(url) as unknown as SocketLike;
    return null;
  }

  private openSocket(url: string): void {
    const factory = this.socketFactory();
    if (!factory) {
      this.startPolling();
      return;
    }
    let socket: SocketLike;
    try {
      socket = factory(url);
    } catch (error) {
      this.retry(`could not open the socket: ${message(error)}`);
      return;
    }
    this.socket = socket;
    this.pendingOpenAt = this.now();
    // Every listener checks it still owns the session: a socket that errors or
    // closes after Disconnect must not restart polling behind the user's back.
    const current = (): boolean => this.socket === socket;
    socket.addEventListener("open", () => {
      if (!current()) return;
      this.stopPolling();
      this.pendingPingAt = null;
      this.pendingOpenAt = null;
      // `lastPongAt` belongs to the socket that answered it, not to this one: a
      // fresh connection must not inherit an old heartbeat (2ng.6).
      this.update({ status: "live", error: null, nextRetryAt: null, lastPongAt: null });
      this.startHeartbeat();
    });
    socket.addEventListener("message", (event) => {
      if (current()) this.ingest(event.data);
    });
    socket.addEventListener("error", () => {
      if (!current()) return;
      this.drop(socket, "socket error");
    });
    socket.addEventListener("close", () => {
      if (!current()) return;
      this.drop(socket, "socket closed");
    });
    // Also watch a socket that never opens: a handshake that hangs would
    // otherwise leave the panel "connecting" forever with no retry.
    this.startHeartbeat();
  }

  /**
   * The socket is gone. Close it, then degrade to polling and schedule a retry:
   * the stream is the primary source, but a stale tab that still claims to be
   * live is worse than one that says it is reconnecting.
   */
  private drop(socket: SocketLike, reason: string): void {
    this.stopHeartbeat();
    this.pendingPingAt = null;
    this.pendingOpenAt = null;
    this.socket = null;
    try {
      socket.close();
    } catch {
      /* already closed */
    }
    if (!this.desired) return;
    this.retry(reason);
  }

  /** Degrade to polling now, and try the socket again after a backoff. */
  private retry(reason: string): void {
    if (!this.desired) return;
    this.stopHeartbeat();
    this.pendingPingAt = null;
    this.pendingOpenAt = null;
    const attempt = this.state.reconnectAttempts + 1;
    const delay = reconnectDelay(attempt, this.options.reconnectBaseMs, this.options.reconnectMaxMs);
    // Polling keeps the rows current while the socket is down; the status still
    // says "reconnecting", because the socket is what the panel wants back.
    this.startPolling();
    this.update({
      status: "reconnecting",
      error: reason,
      reconnectAttempts: attempt,
      nextRetryAt: this.now() + delay,
    });
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.open();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const every = this.options.heartbeatMs;
    if (every <= 0) return;
    this.heartbeatTimer = setInterval(() => this.beat(), every);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * One heartbeat tick. A socket that cannot be pinged (no `send`) is judged by
   * message idleness instead, so the panel still notices a silent stream.
   */
  private beat(): void {
    const socket = this.socket;
    if (socket === null) return;
    const now = this.now();
    if (this.pendingPingAt !== null) {
      if (now - this.pendingPingAt >= this.options.pongTimeoutMs) {
        this.drop(socket, `heartbeat lost: no pong within ${Math.round(this.options.pongTimeoutMs / 1000)}s`);
        return;
      }
      return; // Still waiting on the outstanding ping: do not stack them up.
    }
    if (typeof socket.send !== "function") {
      const last = this.state.lastMessageAt;
      if (last !== null && now - last >= this.options.pongTimeoutMs) {
        this.drop(socket, `stream idle: no message within ${Math.round(this.options.pongTimeoutMs / 1000)}s`);
      }
      return;
    }
    if (socket.readyState !== undefined && socket.readyState !== 1) {
      // A real WebSocket starts CONNECTING (0). If that never becomes OPEN the
      // handshake is hanging (a proxy swallowing the upgrade, a dead endpoint),
      // so it must time out on the same budget as a ping instead of returning
      // here forever with no retry (review cb3).
      const created = this.pendingOpenAt;
      if (created !== null && now - created >= this.options.pongTimeoutMs) {
        this.drop(socket, `handshake timed out after ${Math.round(this.options.pongTimeoutMs / 1000)}s`);
      }
      return;
    }
    try {
      socket.send("ping");
      this.pendingPingAt = now;
    } catch {
      this.drop(socket, "could not send a heartbeat");
    }
  }

  /** Retry now (the panel's Reconnect button), cancelling any scheduled wait. */
  async reconnect(): Promise<void> {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.stopHeartbeat();
    this.pendingPingAt = null;
    this.pendingOpenAt = null;
    this.stopPolling();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
    this.desired = true;
    this.update({ reconnectAttempts: 0, nextRetryAt: null });
    await this.open();
  }

  /** Re-point the session at another repository (the panel's form). */
  reconfigure(patch: Partial<Pick<SessionOptions, "owner" | "repo" | "key" | "base" | "limit">>): void {
    this.options = { ...this.options, ...patch };
  }

  /** Feed one socket message in: `{type:"hello"|"step"|"pong"}`. */
  ingest(raw: unknown): void {
    let message: unknown = raw;
    if (typeof raw === "string") {
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
    }
    if (typeof message !== "object" || message === null) return;
    const shape = message as { type?: unknown; steps?: unknown; step?: unknown };
    const at = this.now();
    if (shape.type === "hello" && Array.isArray(shape.steps)) {
      const steps = (shape.steps as TraceStep[]).slice(0, this.options.stepCap);
      this.update({ steps, status: this.socket === null ? this.state.status : "live", lastMessageAt: at });
      return;
    }
    if (shape.type === "pong") {
      // Only a pong proves the connection is alive in both directions, so it is
      // also the point where the reconnect backoff resets: an open() alone would
      // forgive a socket that accepts and then dies immediately, and the panel
      // would retry it every second forever.
      this.pendingPingAt = null;
      this.update({
        lastMessageAt: at,
        lastPongAt: at,
        error: null,
        reconnectAttempts: 0,
        nextRetryAt: null,
        status: this.socket === null ? this.state.status : "live",
      });
      return;
    }
    if (shape.type === "step" && isStep(shape.step)) {
      this.update({ steps: mergeStep(this.state.steps, shape.step, this.options.stepCap), status: "live", lastMessageAt: at });
      // The HUD is an aggregate of settled runs, so it would otherwise stay frozen
      // at whatever the Connect fetch saw.
      if (shape.step.step === "settled") void this.refreshUsage();
    }
  }

  /** Re-read the usage aggregates without disturbing the stream. */
  async refreshUsage(): Promise<void> {
    const urls = traceUrls(this.options.base, this.options.owner, this.options.repo, this.options.ticket ?? "", this.options.limit);
    try {
      const response = await this.fetchImpl(urls.usage, { headers: { "x-factory-control-key": this.options.key } });
      if (!response.ok) return;
      const body = (await response.json()) as { usage?: Usage };
      this.update({ usage: body.usage ?? null });
    } catch {
      // A stale HUD is better than an error banner over a working stream.
    }
  }

  select(id: string | null): void {
    this.update({ selectedId: id });
  }

  selected(): TraceStep | null {
    if (this.state.selectedId === null) return null;
    return this.state.steps.find((step) => step.id === this.state.selectedId) ?? null;
  }

  startPolling(): void {
    if (this.pollTimer !== null) return;
    this.update({ status: "polling" });
    const urls = traceUrls(this.options.base, this.options.owner, this.options.repo, this.options.ticket ?? "", this.options.limit);
    const headers = { "x-factory-control-key": this.options.key };
    const tick = async (): Promise<void> => {
      try {
        const [traceResponse, usageResponse] = await Promise.all([
          this.fetchImpl(urls.trace, { headers }),
          this.fetchImpl(urls.usage, { headers }),
        ]);
        if (traceResponse.ok) {
          const trace = (await traceResponse.json()) as { steps?: TraceStep[] };
          this.update({ steps: (trace.steps ?? []).slice(0, this.options.stepCap) });
        }
        if (usageResponse.ok) {
          const usage = (await usageResponse.json()) as { usage?: Usage };
          this.update({ usage: usage.usage ?? null });
        }
        // A poll that recovers clears its own error rather than leaving a banner
        // over a stream that is working again.
        if (this.state.error !== null && this.state.error.startsWith("polling failed:")) {
          this.update({ status: "polling", error: null });
        }
      } catch (error) {
        // While reconnecting, a failed poll is expected and must not hide the
        // fact that the socket is the thing being retried.
        if (this.state.status !== "polling") return;
        this.update({ status: "error", error: `polling failed: ${message(error)}` });
      }
    };
    void tick();
    this.pollTimer = setInterval(() => void tick(), this.options.pollMs);
  }

  stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  disconnect(): void {
    this.desired = false;
    this.stopPolling();
    this.stopHeartbeat();
    this.pendingPingAt = null;
    this.pendingOpenAt = null;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
    this.update({ status: "idle", error: null, reconnectAttempts: 0, nextRetryAt: null, lastMessageAt: null });
  }

  /** True when a poll interval is registered (the tests assert this is cleaned up). */
  get polling(): boolean {
    return this.pollTimer !== null;
  }

  /** True while the heartbeat interval is registered. */
  get heartbeating(): boolean {
    return this.heartbeatTimer !== null;
  }

  /** True while a reconnect is scheduled. */
  get retrying(): boolean {
    return this.retryTimer !== null;
  }
}

/** Human age of the last proof of life: "12s ago", "3m ago", "no heartbeat yet". */
export function heartbeatAge(now: number, at: number | null): string {
  if (at === null) return "no heartbeat yet";
  const seconds = Math.round((now - at) / 1000);
  if (seconds <= 1) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

/**
 * The status line's text: the connection's health, not just its intent. A live
 * socket reports when it last answered a ping (so a silently dead stream is
 * visible), and a reconnect reports its attempt and the wait before the next one.
 */
export function statusText(state: SessionState, now: number): string {
  if (state.status === "error") return state.error ?? "error";
  if (state.status === "live") {
    const beat = state.lastPongAt ?? state.lastMessageAt;
    const health = beat === null ? "no heartbeat yet" : `heartbeat ${heartbeatAge(now, beat)}`;
    return `live · ${state.steps.length} step(s) · ${health}`;
  }
  if (state.status === "reconnecting") {
    const wait = state.nextRetryAt === null ? null : Math.max(0, Math.ceil((state.nextRetryAt - now) / 1000));
    const retry = wait === null ? "retrying" : wait === 0 ? "retrying now" : `retry in ${wait}s`;
    return `reconnecting (attempt ${state.reconnectAttempts}, ${retry})${state.error === null ? "" : ` · ${state.error}`}`;
  }
  if (state.status === "polling") return "polling (socket unavailable)";
  if (state.status === "connecting") return "connecting…";
  return "Disconnected";
}

/** The status line's tone: a reconnect is a warning, not a failure. */
export function statusTone(state: SessionState): "ok" | "warn" | "info" | "error" | "muted" {
  if (state.status === "error") return "error";
  if (state.status === "live") return "ok";
  if (state.status === "reconnecting" || state.status === "polling") return "warn";
  if (state.status === "connecting") return "info";
  return "muted";
}

function isStep(value: unknown): value is TraceStep {
  if (typeof value !== "object" || value === null) return false;
  const step = value as Partial<TraceStep>;
  return typeof step.id === "string" && typeof step.step === "string" && typeof step.detail === "string";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MountOptions {
  /** The toolbar button that opens and closes the panel. */
  toggleButton?: HTMLElement | null;
  initialOwner?: string;
  initialRepo?: string;
  /** Defaults to this page's origin; a test can point the panel elsewhere. */
  base?: string;
  fetchImpl?: typeof fetch;
  socketFactory?: (url: string) => SocketLike;
}

/**
 * Mount the panel into `root` (the #observability-panel region in index.html).
 *
 * The markup owns the layout and the CSS owns the look; this function only
 * renders state and wires the controls, so the interesting logic stays in
 * `ObservabilitySession` where it is tested.
 */
export function initObservability(root: HTMLElement, options: MountOptions = {}): ObservabilitySession {
  const $ = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector);
  const form = $<HTMLFormElement>("#obs-form");
  const ownerInput = $<HTMLInputElement>(".obs-owner");
  const repoInput = $<HTMLInputElement>(".obs-repo");
  const keyInput = $<HTMLInputElement>(".obs-key");
  const limitInput = $<HTMLInputElement>(".obs-limit");
  const statusLine = $<HTMLSpanElement>(".obs-status");
  const announcer = $<HTMLSpanElement>(".obs-announcer");
  const stream = $<HTMLOListElement>(".obs-stream");
  const hudGrid = $<HTMLDivElement>(".obs-hud-grid");
  const actionBody = $<HTMLTableSectionElement>(".obs-by-action-body");
  const inspectorInfo = $<HTMLDivElement>(".obs-inspector-step-info");
  const artifact = $<HTMLPreElement>(".obs-artifact");
  const disconnectButton = $<HTMLButtonElement>(".obs-btn-disconnect");
  const reconnectButton = $<HTMLButtonElement>(".obs-btn-reconnect");

  // The panel starts from the repository the canvas is bound to, when there is one.
  if (ownerInput) ownerInput.value = options.initialOwner ?? ownerInput.value;
  if (repoInput) repoInput.value = options.initialRepo ?? repoInput.value;

  const session = new ObservabilitySession({
    base: options.base ?? window.location.origin,
    owner: ownerInput?.value.trim() ?? "",
    repo: repoInput?.value.trim() ?? "",
    key: "",
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.socketFactory === undefined ? {} : { socketFactory: options.socketFactory }),
    onUpdate: (state) => render(state),
  });

  function setStatus(state: SessionState): void {
    if (!statusLine) return;
    statusLine.textContent = statusText(state, Date.now());
    statusLine.className = `obs-status obs-status--${statusTone(state)}`;
    if (disconnectButton) disconnectButton.disabled = state.status === "idle" || state.status === "error";
    // Reconnect is a manual retry: pointless while idle or already connecting.
    if (reconnectButton) reconnectButton.disabled = state.status === "idle" || state.status === "connecting";
  }

  function renderStream(state: SessionState): void {
    if (!stream) return;
    if (state.steps.length === 0) {
      const empty = document.createElement("li");
      empty.className = "obs-empty-notice muted";
      empty.textContent = "No steps recorded yet. Click Connect to stream the execution trace.";
      stream.replaceChildren(empty);
      return;
    }
    stream.replaceChildren(
      ...state.steps.slice(0, 100).map((step) => {
        const line = formatStep(step);
        const item = document.createElement("li");
        item.className = "obs-step-item";
        const button = document.createElement("button");
        button.type = "button";
        button.className = `obs-step${step.id === state.selectedId ? " is-selected" : ""}`;
        button.dataset["id"] = step.id;
        if (step.id === state.selectedId) button.setAttribute("aria-current", "true");
        const status = document.createElement("span");
        status.className = `obs-step__status obs-step__status--${step.status}`;
        status.textContent = step.status;
        const name = document.createElement("span");
        name.className = "obs-step__name";
        name.textContent = line.label;
        const detail = document.createElement("span");
        detail.className = "obs-step__detail";
        detail.textContent = line.detail;
        button.append(status, name, detail);
        if (step.ms !== null) {
          const ms = document.createElement("span");
          ms.className = "obs-step__ms";
          ms.textContent = `${step.ms}ms`;
          button.append(ms);
        }
        button.addEventListener("click", () => session.select(step.id));
        item.append(button);
        return item;
      }),
    );
  }

  function renderHud(state: SessionState): void {
    if (hudGrid) {
      hudGrid.replaceChildren(
        ...usageRows(state.usage).map((row) => {
          const card = document.createElement("div");
          card.className = "obs-hud-card";
          const label = document.createElement("span");
          label.className = "obs-hud-label";
          label.textContent = row.label;
          const value = document.createElement("span");
          value.className = "obs-hud-value";
          value.textContent = row.value;
          card.append(label, value);
          if (row.note) {
            const note = document.createElement("span");
            note.className = "obs-hud-note";
            note.textContent = row.note;
            card.append(note);
          }
          return card;
        }),
      );
    }
    if (actionBody) {
      const rows = actionRows(state.usage);
      if (rows.length === 0) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 2;
        td.className = "muted";
        td.textContent = "No actions recorded";
        tr.append(td);
        actionBody.replaceChildren(tr);
      } else {
        actionBody.replaceChildren(
          ...rows.map((row) => {
            const tr = document.createElement("tr");
            const th = document.createElement("th");
            th.scope = "row";
            th.textContent = row.label;
            const td = document.createElement("td");
            td.textContent = row.value;
            tr.append(th, td);
            return tr;
          }),
        );
      }
    }
  }

  function render(state: SessionState): void {
    setStatus(state);
    renderStream(state);
    renderHud(state);
    const selected = session.selected();
    if (inspectorInfo) {
      inspectorInfo.textContent =
        selected === null
          ? "Select a step in the trace above to inspect its artifact."
          : `${selected.step} · ${selected.status} · ${clockTime(selected.at)}`;
    }
    if (artifact) {
      const preview = artifactPreview(selected?.artifact);
      artifact.textContent = preview.text;
    }
  }

  // Clamp as soon as the field is edited too, not only on submit: the field shows
  // what will actually be requested (cloud-factory-cf-2xp).
  const applyLimit = (): number => {
    const limit = clampLimit(Number(limitInput?.value ?? DEFAULT_LIMIT));
    if (limitInput) limitInput.value = String(limit);
    return limit;
  };
  limitInput?.addEventListener("change", () => {
    applyLimit();
  });

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const owner = ownerInput?.value.trim() ?? "";
    const repo = repoInput?.value.trim() ?? "";
    const key = keyInput?.value ?? "";
    if (owner === "" || repo === "") {
      if (statusLine) {
        statusLine.textContent = "owner and repository are required";
        statusLine.className = "obs-status obs-status--error";
      }
      return;
    }
    if (announcer) announcer.textContent = `Connecting to ${owner}/${repo}`;
    // The Limit field used to be read and dropped (cloud-factory-cf-9t2): pass it on,
    // clamped, so what the operator typed is what the trace route is asked for.
    const typed = Number(limitInput?.value ?? DEFAULT_LIMIT);
    const limit = applyLimit();
    if (announcer && typed !== limit) announcer.textContent = `Limit clamped to ${limit}`;
    // The key lives in memory for this session only: never localStorage.
    session.reconfigure({ owner, repo, key, limit });
    void session.connect().catch(() => {});
  });

  disconnectButton?.addEventListener("click", () => {
    session.disconnect();
    if (announcer) announcer.textContent = "Disconnected from the trace";
  });

  reconnectButton?.addEventListener("click", () => {
    if (announcer) announcer.textContent = "Reconnecting to the trace";
    void session.reconnect().catch(() => {});
  });

  const toggle = options.toggleButton;
  const setOpen = (open: boolean): void => {
    root.hidden = !open;
    toggle?.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) ownerInput?.focus();
  };
  toggle?.addEventListener("click", () => setOpen(root.hidden));
  $<HTMLButtonElement>(".obs-close-btn")?.addEventListener("click", () => {
    setOpen(false);
    toggle?.focus();
  });
  // Leaving the page must not leave a poll interval behind.
  window.addEventListener("pagehide", () => session.disconnect());

  render(session.state);
  return session;
}
