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

export function traceUrls(base: string, owner: string, repo: string, key: string, limit = DEFAULT_LIMIT): TraceUrls {
  const root = `${base.replace(/\/+$/, "")}/trace/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const socketBase = root.replace(/^http/, "ws");
  return {
    trace: `${root}?limit=${clampLimit(limit)}`,
    usage: `${root}/usage`,
    socket: `${socketBase}/socket?key=${encodeURIComponent(key)}`,
  };
}

export type SessionStatus = "idle" | "connecting" | "live" | "polling" | "error";

export interface SessionState {
  status: SessionStatus;
  steps: TraceStep[];
  usage: Usage | null;
  selectedId: string | null;
  error: string | null;
}

export interface SocketLike {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error" | "close" | "open", listener: () => void): void;
  close(): void;
}

export interface SessionOptions {
  base: string;
  owner: string;
  repo: string;
  key: string;
  fetchImpl?: typeof fetch;
  socketFactory?: (url: string) => SocketLike;
  onUpdate?: (state: SessionState) => void;
  pollMs?: number;
  stepCap?: number;
  /** How many steps to ask the trace route for (the panel's Limit field). */
  limit?: number;
}

/**
 * Owns the panel's state and the connection. The socket is the primary source;
 * when it cannot connect (a proxy that blocks upgrades, a tab restored from a
 * background state) the session polls the same rows, so the panel degrades
 * instead of going blank.
 */
export class ObservabilitySession {
  state: SessionState = { status: "idle", steps: [], usage: null, selectedId: null, error: null };
  private socket: SocketLike | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private options: Required<Pick<SessionOptions, "pollMs" | "stepCap">> & SessionOptions;

  constructor(options: SessionOptions) {
    this.options = { pollMs: 3000, stepCap: 200, limit: DEFAULT_LIMIT, ...options };
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
    this.update({ status: "connecting", error: null });
    const urls = traceUrls(this.options.base, this.options.owner, this.options.repo, this.options.key, this.options.limit);
    const headers = { "x-factory-control-key": this.options.key };
    try {
      const [usageResponse, traceResponse] = await Promise.all([
        this.fetchImpl(urls.usage, { headers }),
        this.fetchImpl(urls.trace, { headers }),
      ]);
      if (usageResponse.status === 401 || traceResponse.status === 401) {
        this.update({ status: "error", error: "control key rejected (401)" });
        return;
      }
      if (!usageResponse.ok || !traceResponse.ok) {
        this.update({ status: "error", error: `trace request failed (${usageResponse.status}/${traceResponse.status})` });
        return;
      }
      const usage = (await usageResponse.json()) as { usage?: Usage };
      const trace = (await traceResponse.json()) as { steps?: TraceStep[] };
      this.update({
        usage: usage.usage ?? null,
        steps: (trace.steps ?? []).slice(0, this.options.stepCap),
      });
    } catch (error) {
      this.update({ status: "error", error: `could not read the trace: ${message(error)}` });
      return;
    }

    this.openSocket(urls.socket);
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
    try {
      const socket = factory(url);
      this.socket = socket;
      // Every listener checks it still owns the session: a socket that errors or
      // closes after Disconnect must not restart polling behind the user's back.
      const current = (): boolean => this.socket === socket;
      socket.addEventListener("open", () => {
        if (current()) this.update({ status: "live", error: null });
      });
      socket.addEventListener("message", (event) => {
        if (current()) this.ingest(event.data);
      });
      socket.addEventListener("error", () => {
        if (!current()) return;
        this.stopPolling();
        this.startPolling();
      });
      socket.addEventListener("close", () => {
        if (!current()) return;
        this.socket = null;
        if (this.state.status === "live") this.startPolling();
      });
    } catch {
      this.startPolling();
    }
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
    if (shape.type === "hello" && Array.isArray(shape.steps)) {
      const steps = (shape.steps as TraceStep[]).slice(0, this.options.stepCap);
      this.update({ steps, status: this.socket === null ? this.state.status : "live" });
      return;
    }
    if (shape.type === "step" && isStep(shape.step)) {
      this.update({ steps: mergeStep(this.state.steps, shape.step, this.options.stepCap), status: "live" });
      // The HUD is an aggregate of settled runs, so it would otherwise stay frozen
      // at whatever the Connect fetch saw.
      if (shape.step.step === "settled") void this.refreshUsage();
    }
  }

  /** Re-read the usage aggregates without disturbing the stream. */
  async refreshUsage(): Promise<void> {
    const urls = traceUrls(this.options.base, this.options.owner, this.options.repo, this.options.key, this.options.limit);
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
    const urls = traceUrls(this.options.base, this.options.owner, this.options.repo, this.options.key, this.options.limit);
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
      } catch (error) {
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
    this.stopPolling();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
    this.update({ status: "idle" });
  }

  /** True when a poll interval is registered (the tests assert this is cleaned up). */
  get polling(): boolean {
    return this.pollTimer !== null;
  }
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
    const text =
      state.error ??
      (state.status === "live"
        ? `live · ${state.steps.length} step(s)`
        : state.status === "polling"
          ? "polling (socket unavailable)"
          : state.status === "connecting"
            ? "connecting…"
            : state.status === "idle"
              ? "Disconnected"
              : "error");
    statusLine.textContent = text;
    statusLine.className = `obs-status obs-status--${
      state.error ? "error" : state.status === "live" ? "ok" : state.status === "polling" ? "warn" : "muted"
    }`;
    if (disconnectButton) disconnectButton.disabled = state.status === "idle" || state.status === "error";
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
    const limit = clampLimit(Number(limitInput?.value ?? DEFAULT_LIMIT));
    if (limitInput) limitInput.value = String(limit);
    // The key lives in memory for this session only: never localStorage.
    session.reconfigure({ owner, repo, key, limit });
    void session.connect().catch(() => {});
  });

  disconnectButton?.addEventListener("click", () => {
    session.disconnect();
    if (announcer) announcer.textContent = "Disconnected from the trace";
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
