/**
 * GitHub onboarding gate (cloud-factory-cf-7gq).
 *
 * One header control answers "which repository is this canvas wired to, and is its
 * webhook actually connected?", and one dialog gets an operator there: the App
 * install link, the webhook URL GitHub should post to, and the evidence read from
 * `GET /trace/:owner/:repo/connect` (slice A).
 *
 * Everything except `mountConnectGate` is pure, so the decisions are tested without
 * a DOM or a network (see test/onboarding.test.ts).
 */

/** The evidence slice A records for a repository. Nulls mean "no evidence yet". */
export interface ConnectEvidence {
  repository: string;
  lastPingAt: string | null;
  lastEventAt: string | null;
  lastEvent: string | null;
  pings: number;
}

export type ConnectTone = "ok" | "warn" | "muted";

export interface ConnectSummary {
  label: string;
  tone: ConnectTone;
}

/** A ping older than this is worth investigating rather than calling "connected". */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface Scope {
  owner: string;
  repo: string;
}

/** Where GitHub should deliver this repository's webhooks. */
export function webhookUrl(base: string, owner: string, repo: string): string {
  const root = base.replace(/\/+$/, "");
  return `${root}/webhooks/github/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** The one-click install link for the GitHub App, carrying the scope as `state`. */
export function installUrl(slug: string, state: string): string {
  const clean = slug.trim().replace(/^\/+|\/+$/g, "");
  return `https://github.com/apps/${encodeURIComponent(clean)}/installations/new?state=${encodeURIComponent(state)}`;
}

/** `owner/repo` as typed in the dialog, or null when it is not that shape. */
export function parseRepository(value: string): Scope | null {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value.trim());
  if (match === null) return null;
  const [, owner, repo] = match;
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

/** A short, human age: "just now", "5m ago", "3d ago". */
export function ageLabel(now: number, at: string | null): string {
  if (at === null) return "never";
  const then = new Date(at).getTime();
  if (Number.isNaN(then)) return at;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * What to tell an operator about a repository's hook. The important distinction is
 * between "we have no evidence" and "we have evidence that it is connected": the
 * UI must never turn a silence into a green light.
 */
export function connectSummary(evidence: ConnectEvidence | null, now: number): ConnectSummary {
  if (evidence === null) return { label: "Not checked yet", tone: "muted" };
  if (evidence.lastPingAt !== null) {
    const age = now - new Date(evidence.lastPingAt).getTime();
    if (Number.isFinite(age) && age > STALE_AFTER_MS) {
      return { label: `Last ping ${ageLabel(now, evidence.lastPingAt)} — check the hook`, tone: "warn" };
    }
    return { label: `Connected · ping ${ageLabel(now, evidence.lastPingAt)}`, tone: "ok" };
  }
  if (evidence.lastEventAt !== null) {
    return { label: `Receiving events · no ping yet (${ageLabel(now, evidence.lastEventAt)})`, tone: "warn" };
  }
  return { label: "Waiting for GitHub's ping", tone: "warn" };
}

/** The pill's text: the scope, or a plain statement that there is none. */
export function pillLabel(scope: Scope | null): string {
  if (scope === null || scope.owner === "" || scope.repo === "") return "No repository";
  return `${scope.owner}/${scope.repo}`;
}

export interface ConnectGateOptions {
  base?: string;
  /** GitHub App slug used by the install link. */
  appSlug?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Called whenever the operator settles on a scope (the pill and other panels follow it). */
  onScope?: (scope: Scope | null) => void;
}

export interface ConnectGate {
  scope(): Scope | null;
  open(): void;
  close(): void;
  /** Re-read the connection evidence for the current scope. */
  check(): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wire the header pill and the Connect GitHub dialog. Returns null when the markup
 * is missing, so a page without the gate (a test fixture, an older shell) is not a
 * crash.
 */
export function mountConnectGate(root: Document | HTMLElement, options: ConnectGateOptions = {}): ConnectGate | null {
  const $ = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector);
  const pill = $<HTMLButtonElement>("#repo-pill");
  const pillLabelNode = $<HTMLSpanElement>(".repo-pill__label");
  const dialog = $<HTMLDialogElement>("#connect-dialog");
  const ownerInput = $<HTMLInputElement>("#connect-owner");
  const repoInput = $<HTMLInputElement>("#connect-repo");
  const keyInput = $<HTMLInputElement>("#connect-key");
  const urlInput = $<HTMLInputElement>("#connect-url");
  const copyButton = $<HTMLButtonElement>("#connect-copy");
  const installLink = $<HTMLAnchorElement>("#connect-install");
  const checkButton = $<HTMLButtonElement>("#connect-check");
  const statusNode = $<HTMLParagraphElement>("#connect-status");
  const announcer = $<HTMLSpanElement>("#connect-announcer");
  const repoSelect = $<HTMLSelectElement>("#connect-repo-select");
  if (pill === null || dialog === null) return null;

  const base = options.base ?? (typeof window === "undefined" ? "" : window.location.origin);
  const now = (): number => options.now?.() ?? Date.now();
  let scope: Scope | null = null;

  function setStatus(label: string, tone: ConnectTone): void {
    if (statusNode !== null) {
      statusNode.textContent = label;
      statusNode.className = `connect-status connect-status--${tone}`;
    }
    if (pillLabelNode !== null) pillLabelNode.dataset["tone"] = tone;
  }

  const poller = new ConnectPoller({
    base,
    scope: () => scope,
    key: () => keyInput?.value ?? "",
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    now,
    onChange: (state) => {
      if (state.error !== null) {
        setStatus(state.error, "warn");
        return;
      }
      const summary = connectSummary(state.evidence, now());
      setStatus(summary.label, summary.tone);
    },
  });

  function renderScope(): void {
    if (pillLabelNode !== null) pillLabelNode.textContent = pillLabel(scope);
    if (urlInput !== null) {
      urlInput.value = scope === null ? "" : webhookUrl(base, scope.owner, scope.repo);
    }
    if (installLink !== null) {
      installLink.href = installUrl(options.appSlug ?? "cloud-factory", scope === null ? "" : `${scope.owner}/${scope.repo}`);
    }
  }

  function readScope(): Scope | null {
    const owner = ownerInput?.value.trim() ?? "";
    const repo = repoInput?.value.trim() ?? "";
    if (owner === "" || repo === "") return null;
    return parseRepository(`${owner}/${repo}`);
  }

  /** A new scope is new evidence: drop the old reading and look again. */
  function applyScope(next: Scope | null): void {
    const changed = next?.owner !== scope?.owner || next?.repo !== scope?.repo;
    scope = next;
    renderScope();
    options.onScope?.(next);
    if (changed) {
      poller.reset();
      if (scope !== null && (keyInput?.value ?? "") !== "") {
        void poller.check().finally(() => {
          if (!poller.state.paused) poller.start();
        });
      } else {
        poller.stop();
        setStatus("Not checked yet", "muted");
      }
    }
  }

  async function check(): Promise<void> {
    poller.reset();
    await poller.check();
  }

  function open(): void {
    poller.setMode("dialog");
    renderScope();
    pill?.setAttribute("aria-expanded", "true");
    dialog?.showModal();
    ownerInput?.focus();
    // The check decides whether polling may run: a refused key must not leave a
    // timer behind, so start only once the answer is in (and it was not a 401).
    void poller.check().finally(() => {
      if (!poller.state.paused) poller.start();
    });
  }

  function close(): void {
    pill?.setAttribute("aria-expanded", "false");
    dialog?.close();
    poller.setMode("idle");
    // The pill keeps a slower watch on the connection so it is not a stale claim.
    poller.start();
    pill?.focus();
  }

  pill.addEventListener("click", () => open());
  $<HTMLButtonElement>("#connect-close")?.addEventListener("click", () => close());
  // Escape closes a native <dialog> without firing the button handler.
  dialog.addEventListener("close", () => {
    pill.setAttribute("aria-expanded", "false");
    poller.setMode("idle");
    poller.start();
    pill.focus();
  });
  for (const input of [ownerInput, repoInput]) {
    input?.addEventListener("input", () => applyScope(readScope()));
  }
  // The key is not part of the scope, but a refused key must be re-tried once the
  // operator changes it, and polling only makes sense when a key exists.
  keyInput?.addEventListener("input", () => {
    poller.reset();
    if ((keyInput.value ?? "") === "") {
      poller.stop();
      setStatus("Not checked yet", "muted");
      return;
    }
    const owner = ownerInput?.value.trim() ?? "";
    if (owner && repoSelect && repoSelect.options.length <= 1) {
      void loadAuthorizedRepos(owner);
    }
    void poller.check().finally(() => {
      if (!poller.state.paused) poller.start();
    });
  });
  copyButton?.addEventListener("click", () => {
    if (urlInput === null) return;
    const text = urlInput.value;
    if (text === "") return;
    void navigator.clipboard?.writeText(text).then(
      () => {
        if (announcer !== null) announcer.textContent = "Webhook URL copied";
      },
      () => {
        // Clipboard permissions can be refused; the field is selectable regardless.
        urlInput.select();
        if (announcer !== null) announcer.textContent = "Copy the selected webhook URL";
      },
    );
  });
  checkButton?.addEventListener("click", () => void check().catch(() => {}));

  // A hidden tab has no business polling; the state is re-read on return.
  if (typeof document !== "undefined") {
    wireVisibility(poller, document);
  }

  applyScope(readScope());
  setStatus("Not checked yet", "muted");

  async function loadAuthorizedRepos(owner: string): Promise<void> {
    if (!owner || repoSelect === null) return;
    try {
      const headers: Record<string, string> = {};
      const key = keyInput?.value.trim() ?? "";
      if (key.length > 0) {
        headers["x-factory-control-key"] = key;
      }
      const res = await (options.fetchImpl ?? fetch)(`${base}/api/repos?owner=${encodeURIComponent(owner)}`, {
        headers,
      });
      if (!res.ok) return;
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        repositories?: Array<{ fullName: string; owner: string; name: string }>;
      };
      if (data.ok && Array.isArray(data.repositories) && data.repositories.length > 0) {
        repoSelect.innerHTML = '<option value="">-- Choose an authorized repository --</option>';
        const doc = (root as Document).createElement ? (root as Document) : (root.ownerDocument ?? (typeof document !== "undefined" ? document : null));
        for (const r of data.repositories) {
          const opt = doc ? doc.createElement("option") : document.createElement("option");
          opt.value = r.fullName;
          opt.textContent = r.fullName;
          repoSelect.appendChild(opt);
        }
        repoSelect.hidden = false;
      }
    } catch {
      // Ignore network errors loading authorized repos
    }
  }

  repoSelect?.addEventListener("change", () => {
    if (repoSelect.value) {
      const parts = repoSelect.value.split("/");
      if (parts.length === 2 && parts[0] && parts[1]) {
        if (ownerInput) ownerInput.value = parts[0];
        if (repoInput) repoInput.value = parts[1];
        applyScope(readScope());
      }
    }
  });

  ownerInput?.addEventListener("change", () => {
    const owner = ownerInput.value.trim();
    if (owner) void loadAuthorizedRepos(owner);
  });

  if (typeof window !== "undefined" && window.location) {
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected") === "1") {
      const owner = params.get("owner");
      if (owner && ownerInput) {
        ownerInput.value = owner;
        void loadAuthorizedRepos(owner);
      }
      open();
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("connected");
      cleanUrl.searchParams.delete("owner");
      cleanUrl.searchParams.delete("installation_id");
      window.history.replaceState({}, "", cleanUrl.toString());
    }
  }

  return { scope: () => scope, open, close, check };
}

/**
 * Keeps the indicator honest across tab switches: stop while hidden (no point polling
 * a page nobody is looking at), and read once *immediately* on return, because the
 * pill was frozen for however long the tab was away and waiting up to a full idle
 * interval leaves a lie on screen (cloud-factory-cf-7gq.4).
 */
export function wireVisibility(
  poller: Pick<ConnectPoller, "start" | "stop" | "check">,
  doc: {
    hidden: boolean;
    addEventListener(type: "visibilitychange", listener: () => void): void;
  },
): void {
  doc.addEventListener("visibilitychange", () => {
    if (doc.hidden) {
      poller.stop();
      return;
    }
    poller.start();
    void poller.check();
  });
}

/** How often the indicator re-reads: brisk while the dialog is open, slow behind it. */
export const DIALOG_POLL_MS = 5000;
export const IDLE_POLL_MS = 30_000;

export type PollMode = "dialog" | "idle";

export function pollIntervalMs(mode: PollMode): number {
  return mode === "dialog" ? DIALOG_POLL_MS : IDLE_POLL_MS;
}

export interface PollerState {
  evidence: ConnectEvidence | null;
  error: string | null;
  checking: boolean;
  /** True once the control key was refused: polling stops until the key changes. */
  paused: boolean;
}

export interface ConnectPollerOptions {
  base: string;
  scope: () => Scope | null;
  key: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onChange?: (state: PollerState) => void;
  dialogMs?: number;
  idleMs?: number;
}

/**
 * The live indicator's engine: re-reads the connection evidence on a cadence and
 * reports what it found. Kept out of the DOM so the cadence, the pause and the
 * failure handling are tested directly.
 *
 * A refused key is a stop condition, not something to retry every few seconds: the
 * operator has to change the key, and `reset()` is how the UI says they did.
 */
export class ConnectPoller {
  state: PollerState = { evidence: null, error: null, checking: false, paused: false };
  private timer: ReturnType<typeof setInterval> | null = null;
  private mode: PollMode = "idle";
  /**
   * Bumped whenever the key or scope is replaced. A read that started before the
   * change has an answer to a question nobody is asking any more, so it is dropped
   * rather than written over the newer state (cloud-factory-cf-7gq.4).
   */
  private generation = 0;
  private options: Required<Pick<ConnectPollerOptions, "dialogMs" | "idleMs">> & ConnectPollerOptions;

  constructor(options: ConnectPollerOptions) {
    this.options = { dialogMs: DIALOG_POLL_MS, idleMs: IDLE_POLL_MS, ...options };
  }

  private update(patch: Partial<PollerState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onChange?.(this.state);
  }

  private get fetchImpl(): typeof fetch {
    const injected = this.options.fetchImpl;
    return injected ?? ((input, init) => globalThis.fetch(input, init));
  }

  private intervalMs(): number {
    if (this.mode === "dialog") return this.options.dialogMs;
    return this.options.idleMs;
  }

  /** Switch cadence (the dialog opening or closing), restarting the timer if running. */
  setMode(mode: PollMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.timer !== null) this.start();
  }

  /** The key or scope changed: whatever was refused might now be right. */
  reset(): void {
    this.generation += 1;
    this.update({ paused: false, error: null });
  }

  start(): void {
    this.stop();
    if (!this.eligible()) return;
    this.timer = setInterval(() => void this.check(), this.intervalMs());
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get active(): boolean {
    return this.timer !== null;
  }

  private eligible(): boolean {
    const scope = this.options.scope();
    return scope !== null && this.options.key() !== "" && !this.state.paused;
  }

  /**
   * One read. Never throws: a transport failure is reported, not propagated.
   *
   * A read that was in flight when the key or scope changed is discarded — including
   * its 401, which must not re-pause a poller the operator has just fixed.
   */
  async check(): Promise<void> {
    const scope = this.options.scope();
    const key = this.options.key();
    if (scope === null || key === "") {
      this.update({ evidence: null, error: scope === null ? "No repository selected" : "A control key is needed" });
      return;
    }
    if (this.state.checking) return; // one request at a time, however slow the network
    const generation = this.generation;
    const isStale = (): boolean => {
      if (generation !== this.generation || key !== this.options.key()) return true;
      const current = this.options.scope();
      return current === null || current.owner !== scope.owner || current.repo !== scope.repo;
    };
    // Our own request has finished even if its answer is stale, so `checking` is
    // always cleared; only the answer is withheld.
    const settle = (patch: Partial<PollerState>): void => {
      if (isStale()) {
        this.update({ checking: false });
        return;
      }
      this.update({ checking: false, ...patch });
    };
    this.update({ checking: true });
    try {
      const response = await this.fetchImpl(
        `${this.options.base.replace(/\/+$/, "")}/trace/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}/connect`,
        { headers: { "x-factory-control-key": key } },
      );
      if (response.status === 401) {
        if (isStale()) {
          settle({});
          return;
        }
        this.stop();
        this.update({ checking: false, evidence: null, error: "control key rejected (401)", paused: true });
        return;
      }
      if (!response.ok) {
        settle({ error: `could not read the connection state (${response.status})` });
        return;
      }
      const body = (await response.json()) as { connect?: ConnectEvidence };
      settle({ evidence: body.connect ?? null, error: null });
    } catch (error) {
      settle({ error: `could not reach the factory: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
}
