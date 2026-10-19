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
  if (pill === null || dialog === null) return null;

  const base = options.base ?? (typeof window === "undefined" ? "" : window.location.origin);
  const now = (): number => options.now?.() ?? Date.now();
  let scope: Scope | null = null;
  let evidence: ConnectEvidence | null = null;

  const fetchImpl = (): typeof fetch => {
    const injected = options.fetchImpl;
    // A bare `fetch` called as a method throws "Illegal invocation" in a browser.
    return injected ?? ((input, init) => globalThis.fetch(input, init));
  };

  function setStatus(label: string, tone: ConnectTone): void {
    if (statusNode !== null) {
      statusNode.textContent = label;
      statusNode.className = `connect-status connect-status--${tone}`;
    }
    if (pillLabelNode !== null) pillLabelNode.dataset["tone"] = tone;
  }

  function render(): void {
    if (pillLabelNode !== null) pillLabelNode.textContent = pillLabel(scope);
    if (urlInput !== null) {
      urlInput.value = scope === null ? "" : webhookUrl(base, scope.owner, scope.repo);
    }
    if (installLink !== null) {
      installLink.href = installUrl(options.appSlug ?? "cloud-factory", scope === null ? "" : `${scope.owner}/${scope.repo}`);
    }
    const summary = connectSummary(evidence, now());
    setStatus(summary.label, summary.tone);
  }

  function readScope(): Scope | null {
    const owner = ownerInput?.value.trim() ?? "";
    const repo = repoInput?.value.trim() ?? "";
    if (owner === "" || repo === "") return null;
    return parseRepository(`${owner}/${repo}`);
  }

  function applyScope(next: Scope | null): void {
    scope = next;
    // A different repository has different evidence; never carry it across.
    evidence = null;
    render();
    options.onScope?.(next);
  }

  async function check(): Promise<void> {
    const current = scope;
    if (current === null) {
      setStatus("Enter a repository as owner/repo first", "warn");
      return;
    }
    const key = keyInput?.value ?? "";
    if (key === "") {
      setStatus("A control key is needed to read the connection state", "warn");
      return;
    }
    setStatus("Checking…", "muted");
    try {
      const response = await fetchImpl()(
        `${base.replace(/\/+$/, "")}/trace/${encodeURIComponent(current.owner)}/${encodeURIComponent(current.repo)}/connect`,
        { headers: { "x-factory-control-key": key } },
      );
      if (response.status === 401) {
        setStatus("control key rejected (401)", "warn");
        return;
      }
      if (!response.ok) {
        setStatus(`could not read the connection state (${response.status})`, "warn");
        return;
      }
      const body = (await response.json()) as { connect?: ConnectEvidence };
      evidence = body.connect ?? null;
      render();
      if (announcer !== null) announcer.textContent = connectSummary(evidence, now()).label;
    } catch (error) {
      setStatus(`could not reach the factory: ${message(error)}`, "warn");
    }
  }

  function open(): void {
    if (ownerInput !== null && ownerInput.value === "" && scope !== null) ownerInput.value = scope.owner;
    if (repoInput !== null && repoInput.value === "" && scope !== null) repoInput.value = scope.repo;
    render();
    pill?.setAttribute("aria-expanded", "true");
    dialog?.showModal();
    ownerInput?.focus();
  }

  function close(): void {
    pill?.setAttribute("aria-expanded", "false");
    dialog?.close();
    pill?.focus();
  }

  pill.addEventListener("click", () => open());
  $<HTMLButtonElement>("#connect-close")?.addEventListener("click", () => close());
  // Escape closes a native <dialog> without firing the button handler.
  dialog.addEventListener("close", () => {
    pill.setAttribute("aria-expanded", "false");
    pill.focus();
  });
  for (const input of [ownerInput, repoInput]) {
    input?.addEventListener("input", () => applyScope(readScope()));
  }
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

  applyScope(readScope());
  return { scope: () => scope, open, close, check };
}
