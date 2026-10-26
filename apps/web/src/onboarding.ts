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
  const testPingButton = $<HTMLButtonElement>("#connect-test-ping");
  const oauthLink = $<HTMLAnchorElement>("#connect-oauth");
  const statusNode = $<HTMLParagraphElement>("#connect-status");
  const announcer = $<HTMLSpanElement>("#connect-announcer");
  const repoSelect = $<HTMLSelectElement>("#connect-repo-select");
  const repoFilterInput = $<HTMLInputElement>("#connect-repo-filter");
  const passkeyButton = $<HTMLButtonElement>("#connect-passkey");
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
    ...(keyInput !== null ? { key: () => keyInput.value ?? "" } : {}),
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
    if (oauthLink !== null) {
      oauthLink.href =
        scope === null
          ? "/auth/github/login"
          : `/auth/github/login?owner=${encodeURIComponent(scope.owner)}&repo=${encodeURIComponent(scope.repo)}`;
    }
    if (installLink !== null) {
      installLink.href = options.appSlug
        ? installUrl(options.appSlug, scope === null ? "" : `${scope.owner}/${scope.repo}`)
        : `${base}/auth/github/login?flow=install${scope ? `&owner=${encodeURIComponent(scope.owner)}&repo=${encodeURIComponent(scope.repo)}` : ""}`;
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
      if (scope !== null && (keyInput === null || (keyInput.value ?? "") !== "")) {
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
    const currentOwner = ownerInput?.value.trim() ?? "";
    if (currentOwner && loadedRepos.length === 0) {
      void loadAuthorizedRepos(currentOwner);
    } else if (!currentOwner) {
      void (options.fetchImpl ?? fetch)(`${base}/api/auth/session`, { credentials: "same-origin" })
        .then((r) => (r.ok ? (r.json() as Promise<{ authenticated?: boolean; login?: string }>) : null))
        .then((s) => {
          if (s?.authenticated && s.login && s.login !== "__root__" && ownerInput && !ownerInput.value.trim()) {
            ownerInput.value = s.login;
            applyScope(readScope());
            void loadAuthorizedRepos(s.login);
          }
        })
        .catch(() => {});
    }
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
        const copyLabel = copyButton.querySelector("span");
        if (copyLabel) {
          const original = copyLabel.textContent;
          copyLabel.textContent = "Copied!";
          setTimeout(() => {
            copyLabel.textContent = original;
          }, 1500);
        }
      },
      () => {
        // Clipboard permissions can be refused; the field is selectable regardless.
        urlInput.select();
        if (announcer !== null) announcer.textContent = "Copy the selected webhook URL";
      },
    );
  });
  checkButton?.addEventListener("click", () => void check().catch(() => {}));
  testPingButton?.addEventListener("click", async () => {
    if (scope === null) {
      setStatus("Specify owner and repo to test ping", "warn");
      return;
    }
    try {
      setStatus("Sending test ping...", "muted");
      const headers: Record<string, string> = {};
      const key = keyInput?.value.trim() ?? "";
      if (key.length > 0) headers["x-factory-control-key"] = key;
      const res = await (options.fetchImpl ?? fetch)(
        `${base}/api/admin/test-ping/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}`,
        { method: "POST", headers, credentials: "same-origin" },
      );
      if (res.ok) {
        setStatus("Test ping accepted! Checking connection...", "ok");
        await check();
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus(body.error ?? `Test ping failed (HTTP ${res.status})`, "warn");
      }
    } catch (err: unknown) {
      setStatus(`Test ping error: ${err instanceof Error ? err.message : String(err)}`, "warn");
    }
  });

  // A hidden tab has no business polling; the state is re-read on return.
  if (typeof document !== "undefined") {
    wireVisibility(poller, document);
  }

  applyScope(readScope());
  setStatus("Not checked yet", "muted");

  let loadedRepos: Array<{ fullName: string; owner: string; name: string }> = [];
  // One request per owner in flight at a time. The post-OAuth bootstrap loads the list
  // and then `open()` loads it again while that first fetch is still pending, so the
  // select was rendered twice for one list and `/api/repos` was fetched twice
  // (cloud-factory-cf-xxso).
  let reposInFlight: { owner: string; promise: Promise<void> } | null = null;

  function renderRepoSelectOptions(): void {
    if (repoSelect === null) return;
    const filter = repoFilterInput?.value.trim().toLowerCase() ?? "";
    const filtered = filter
      ? loadedRepos.filter((r) => r.fullName.toLowerCase().includes(filter))
      : loadedRepos;
    repoSelect.innerHTML = '<option value="">-- Choose an authorized repository --</option>';
    const doc = (root as Document).createElement ? (root as Document) : (root.ownerDocument ?? (typeof document !== "undefined" ? document : null));
    for (const r of filtered) {
      const opt = doc ? doc.createElement("option") : document.createElement("option");
      opt.value = r.fullName;
      opt.textContent = r.fullName;
      repoSelect.appendChild(opt);
    }
    repoSelect.hidden = false;
  }

  repoFilterInput?.addEventListener("input", () => {
    renderRepoSelectOptions();
  });

  function bufferToBase64url(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64urlToBuffer(base64url: string): ArrayBuffer {
    const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
    const pad = base64.length % 4 ? "=".repeat(4 - (base64.length % 4)) : "";
    const binary = atob(base64 + pad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  passkeyButton?.addEventListener("click", async () => {
    if (typeof navigator === "undefined" || !navigator.credentials) {
      setStatus("Passkeys not supported in this browser", "warn");
      return;
    }
    try {
      setStatus("Requesting passkey assertion...", "muted");
      const login = ownerInput?.value.trim() || undefined;
      const optRes = await (options.fetchImpl ?? fetch)(`${base}/api/auth/passkey/login/options`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login }),
        credentials: "same-origin",
      });
      if (!optRes.ok) {
        setStatus(`Passkey challenge failed (${optRes.status})`, "warn");
        return;
      }
      const optData = (await optRes.json()) as {
        options?: {
          challenge: string;
          timeout?: number;
          rpId?: string;
          allowCredentials?: Array<{ id: string; type: "public-key" }>;
          userVerification?: UserVerificationRequirement;
        };
        publicKey?: {
          challenge: string;
          timeout?: number;
          rpId?: string;
          allowCredentials?: Array<{ id: string; type: "public-key" }>;
          userVerification?: UserVerificationRequirement;
        };
      };
      const rawOptions = optData.options ?? optData.publicKey;
      if (!rawOptions) {
        setStatus("Failed to get Passkey options", "warn");
        return;
      }
      const publicKey = {
        ...rawOptions,
        challenge: base64urlToBuffer(rawOptions.challenge),
        allowCredentials: rawOptions.allowCredentials?.map((c) => ({
          ...c,
          id: base64urlToBuffer(c.id),
        })),
      };
      const assertion = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
      if (!assertion) {
        setStatus("Passkey authentication canceled", "muted");
        return;
      }
      const rawResponse = assertion.response as AuthenticatorAssertionResponse;
      const verifyRes = await (options.fetchImpl ?? fetch)(`${base}/api/auth/passkey/login/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credentialId: bufferToBase64url(assertion.rawId),
          authenticatorData: bufferToBase64url(rawResponse.authenticatorData),
          clientDataJSON: bufferToBase64url(rawResponse.clientDataJSON),
          signature: bufferToBase64url(rawResponse.signature),
        }),
        credentials: "same-origin",
      });
      const verifyData = (await verifyRes.json().catch(() => ({}))) as { ok?: boolean; login?: string; error?: string };
      if (verifyRes.ok && verifyData.ok) {
        setStatus(`Signed in with Passkey (${verifyData.login})`, "ok");
        if (verifyData.login && verifyData.login !== "__root__" && ownerInput) {
          ownerInput.value = verifyData.login;
          applyScope(readScope());
          void loadAuthorizedRepos(verifyData.login);
        } else if (ownerInput?.value.trim()) {
          void loadAuthorizedRepos(ownerInput.value.trim());
        }
      } else {
        setStatus(verifyData.error ?? "Passkey verification failed", "warn");
      }
    } catch (err: unknown) {
      setStatus(`Passkey error: ${err instanceof Error ? err.message : String(err)}`, "warn");
    }
  });

  async function loadAuthorizedRepos(owner: string): Promise<void> {
    if (!owner || repoSelect === null) return;
    if (reposInFlight !== null && reposInFlight.owner === owner) return reposInFlight.promise;
    const promise = fetchAuthorizedRepos(owner);
    reposInFlight = { owner, promise };
    try {
      await promise;
    } finally {
      if (reposInFlight?.promise === promise) reposInFlight = null;
    }
  }

  async function fetchAuthorizedRepos(owner: string): Promise<void> {
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
      if (!res.ok) {
        // Silence here is what made the 1-click flow look broken without saying so
        // (cloud-factory-cf-d33): the callback redirects with `connected=1&owner=…` and
        // the list used to stay empty for an operator who had not pasted a control key.
        setStatus(
          res.status === 401
            ? "Reconnect with GitHub to load your repositories"
            : `Could not load authorized repositories (HTTP ${res.status})`,
          "warn",
        );
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        repositories?: Array<{ fullName: string; owner: string; name: string }>;
      };
      if (data.ok && Array.isArray(data.repositories)) {
        loadedRepos = data.repositories;
        renderRepoSelectOptions();
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
  key?: () => string;
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
    const hasKey = this.options.key !== undefined ? this.options.key() !== "" : true;
    return scope !== null && hasKey && !this.state.paused;
  }

  /**
   * One read. Never throws: a transport failure is reported, not propagated.
   *
   * A read that was in flight when the key or scope changed is discarded — including
   * its 401, which must not re-pause a poller the operator has just fixed.
   */
  async check(): Promise<void> {
    const scope = this.options.scope();
    const hasKeyOption = this.options.key !== undefined;
    const key = this.options.key?.() ?? "";
    if (scope === null) {
      this.update({ evidence: null, error: "No repository selected" });
      return;
    }
    if (hasKeyOption && key === "") {
      this.update({ evidence: null, error: "A control key is needed" });
      return;
    }
    if (this.state.checking) return; // one request at a time, however slow the network
    const generation = this.generation;
    const isStale = (): boolean => {
      if (generation !== this.generation || (hasKeyOption && key !== this.options.key?.())) return true;
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
      const headers: Record<string, string> = {};
      if (key !== "") {
        headers["x-factory-control-key"] = key;
      }
      const response = await this.fetchImpl(
        `${this.options.base.replace(/\/+$/, "")}/trace/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}/connect`,
        { headers, credentials: "same-origin" },
      );
      if (response.status === 401) {
        if (isStale()) {
          settle({});
          return;
        }
        this.stop();
        this.update({
          checking: false,
          evidence: null,
          error: hasKeyOption ? "control key rejected (401)" : "unauthorised (401)",
          paused: true,
        });
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
