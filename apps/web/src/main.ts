import {
  bindLoadedDocument,
  describeShareFailure,
  createShareTracker,
  documentRequest,
  listRequest,
  parseDocumentList,
  parseShareHint,
  parseStoredDocument,
  planSave,
  restoreCanvas,
  saveRequest,
  serializeCanvasState,
  type ShareTarget,
} from "./sync";
import { initObservability } from "./observability";
import { mountConnectGate } from "./onboarding";
import { installLightDismiss } from "./light-dismiss";
import { coalescePerFrame } from "./pan-frame";
import {
  KIND_LABELS,
  NODE_HEIGHT,
  NODE_WIDTH,
  clampZoom,
  connect,
  createDoc,
  createNode,
  createSampleDoc,
  findNode,
  moveNode,
  parseDoc,
  removeEdge,
  removeNode,
  renameNode,
  serialize,
  setNodeConfig,
  toAgentConfig,
  zoomAt,
  type CanvasDoc,
  type CanvasNode,
  type NodeKind,
} from "./model";

/**
 * The template builders below were written against the pre-`canvas-model` signature
 * `createNode(doc, kind, position, config, label)`. The model now takes
 * `(doc, kind, position, { label })` and seeds `config` from `DEFAULT_CONFIG`, so the
 * template's config has to be applied explicitly; without this, main.ts does not
 * typecheck and the landing gate cannot pass (cloud-factory-cf-6xju).
 */
function addTemplateNode(
  doc: CanvasDoc,
  kind: NodeKind,
  position: { x: number; y: number },
  config: Record<string, string>,
  label: string,
): CanvasNode {
  const node = createNode(doc, kind, position, { label });
  for (const [key, value] of Object.entries(config)) setNodeConfig(doc, node.id, key, value);
  return node;
}

const STORAGE_KEY = "cloud-factory-canvas:v1";

const viewport = required<HTMLDivElement>("viewport");
const world = required<HTMLDivElement>("world");
const nodeLayer = required<HTMLDivElement>("node-layer");
const edgeLayer = required<SVGGElement>("edge-layer");
const zoomLabel = required<HTMLOutputElement>("zoom-level");
const status = required<HTMLParagraphElement>("status");
const inspectorForm = required<HTMLFormElement>("inspector-form");
const inspectorEmpty = required<HTMLParagraphElement>("inspector-empty");
const fieldLabel = required<HTMLInputElement>("field-label");
const fieldList = required<HTMLDivElement>("field-list");
const connectionList = required<HTMLUListElement>("connection-list");
const connectToggle = required<HTMLButtonElement>("connect-toggle");
const clearButton = required<HTMLButtonElement>("clear");
const exportDialog = required<HTMLDialogElement>("export-dialog");
const exportJson = required<HTMLPreElement>("export-json");
const shareDialog = required<HTMLDialogElement>("share-dialog");
const shareRepository = required<HTMLInputElement>("share-repository");
const shareKey = required<HTMLInputElement>("share-key");
const shareName = required<HTMLInputElement>("share-name");
const shareStatus = required<HTMLParagraphElement>("share-status");
const shareList = required<HTMLUListElement>("share-list");

function readStoredCanvas(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

const storedCanvas = readStoredCanvas();
const restored = restoreCanvas(storedCanvas);
let doc: CanvasDoc = storedCanvas === null ? createSampleDoc() : restored.document;
// Restored from the same value as the document, so a reload keeps both.
let boundRepository: string | null = restored.bound;
let selectedId: string | null = doc.nodes[0]?.id ?? null;
let connectMode = false;
let connectFrom: string | null = null;
let clearArmed = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
// Repository name and the last saved id survive a reload of the tab; the control
// key never leaves this variable.
let shareIds = createShareTracker();
const SHARE_HINT_KEY = "cloud-factory-canvas:share";

const CONFIG_FIELDS: Record<NodeKind, Array<{ key: string; label: string; control: "text" | "textarea" | "select"; options?: string[] }>> = {
  agent: [
    { key: "prompt", label: "Prompt", control: "textarea" },
    { key: "model", label: "Model", control: "text" },
  ],
  source: [
    { key: "provider", label: "Provider", control: "select", options: ["github", "gitlab"] },
    { key: "event", label: "Event", control: "text" },
  ],
  memory: [{ key: "scope", label: "Scope", control: "select", options: ["org", "repo"] }],
  sink: [
    {
      key: "type",
      label: "Sink",
      control: "select",
      // The sink types the worker actually serves; the canvas keeps its older
      // names working, but new documents should pick from these.
      options: ["github-pr-review", "github-issue-comment", "github-issue-create", "beads-task", "telemetry"],
    },
  ],
};

function required<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as unknown as T;
}

function saveNow(): void {
  try {
    localStorage.setItem(STORAGE_KEY, serializeCanvasState(doc, boundRepository));
  } catch {
    announce("Could not save: browser storage is unavailable");
  }
}

function persist(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 120);
}

// The debounce must not lose the last edit when the tab goes away.
window.addEventListener("pagehide", saveNow);

function announce(message: string): void {
  status.textContent = message;
}

function applyView(): void {
  world.style.transform = `translate(${doc.view.x}px, ${doc.view.y}px) scale(${doc.view.zoom})`;
  zoomLabel.value = `${Math.round(doc.view.zoom * 100)}%`;
  zoomLabel.textContent = `${Math.round(doc.view.zoom * 100)}%`;
}

function render(): void {
  applyView();
  renderNodes();
  renderEdges();
  renderInspector();
}

function renderNodes(): void {
  const focusedId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".node")?.dataset["id"];
  nodeLayer.replaceChildren();
  for (const node of doc.nodes) {
    const element = document.createElement("article");
    element.className = `node node--${node.kind}${node.id === selectedId ? " is-selected" : ""}${connectFrom === node.id ? " is-source" : ""}`;
    element.dataset["id"] = node.id;
    element.dataset["kind"] = node.kind;
    element.tabIndex = 0;
    element.setAttribute("role", "button");
    element.setAttribute("aria-pressed", String(node.id === selectedId));
    element.setAttribute("aria-label", `${KIND_LABELS[node.kind]} ${node.label}. ${summary(node)}`);
    element.style.transform = `translate(${node.x}px, ${node.y}px)`;

    const kind = document.createElement("span");
    kind.className = "node__kind";
    kind.textContent = KIND_LABELS[node.kind];

    const label = document.createElement("h3");
    label.className = "node__label";
    label.textContent = node.label;

    const body = document.createElement("p");
    body.className = "node__body";
    body.textContent = summary(node);

    element.append(kind, label, body);
    nodeLayer.append(element);
  }

  // Re-rendering must not silently drop keyboard focus out of the canvas.
  if (focusedId) focusNode(focusedId);
}

/**
 * Selection is a class change, not a re-render: rebuilding the node layer on
 * every click would drop focus and make keyboard wiring unusable.
 */
function syncSelection(): void {
  for (const element of nodeLayer.querySelectorAll<HTMLElement>(".node")) {
    const id = element.dataset["id"];
    element.classList.toggle("is-selected", id === selectedId);
    element.classList.toggle("is-source", id === connectFrom);
    element.setAttribute("aria-pressed", String(id === selectedId));
  }
}

function summary(node: CanvasNode): string {
  if (node.kind === "agent") return node.config["model"] ?? "no model";
  if (node.kind === "source") return `${node.config["provider"] ?? "?"} · ${node.config["event"] ?? "?"}`;
  if (node.kind === "memory") return `${node.config["scope"] ?? "repo"} scope`;
  return node.config["type"] ?? "sink";
}

function renderEdges(): void {
  edgeLayer.replaceChildren();
  for (const edge of doc.edges) {
    const from = findNode(doc, edge.from);
    const to = findNode(doc, edge.to);
    if (!from || !to) continue;

    // Route along the axis with the bigger separation and exit/enter the sides
    // facing each other, so a node below its target does not get a long loop.
    const fromCenter = { x: from.x + NODE_WIDTH / 2, y: from.y + NODE_HEIGHT / 2 };
    const toCenter = { x: to.x + NODE_WIDTH / 2, y: to.y + NODE_HEIGHT / 2 };
    const dx = toCenter.x - fromCenter.x;
    const dy = toCenter.y - fromCenter.y;
    const clampBend = (value: number) => Math.min(Math.max(Math.abs(value) / 2, 24), 160);

    let start: { x: number; y: number };
    let end: { x: number; y: number };
    let control1: { x: number; y: number };
    let control2: { x: number; y: number };

    if (Math.abs(dx) >= Math.abs(dy)) {
      const forward = dx >= 0;
      start = { x: forward ? from.x + NODE_WIDTH : from.x, y: fromCenter.y };
      end = { x: forward ? to.x : to.x + NODE_WIDTH, y: toCenter.y };
      const bend = clampBend(end.x - start.x) * (forward ? 1 : -1);
      control1 = { x: start.x + bend, y: start.y };
      control2 = { x: end.x - bend, y: end.y };
    } else {
      const downward = dy >= 0;
      start = { x: fromCenter.x, y: downward ? from.y + NODE_HEIGHT : from.y };
      end = { x: toCenter.x, y: downward ? to.y : to.y + NODE_HEIGHT };
      const bend = clampBend(end.y - start.y) * (downward ? 1 : -1);
      control1 = { x: start.x, y: start.y + bend };
      control2 = { x: end.x, y: end.y - bend };
    }

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      `M ${start.x} ${start.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${end.x} ${end.y}`,
    );
    path.setAttribute("class", "edge");
    path.setAttribute("aria-hidden", "true");
    path.dataset["id"] = edge.id;
    edgeLayer.append(path);

    const remove = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    remove.setAttribute("cx", String((start.x + end.x) / 2));
    remove.setAttribute("cy", String((start.y + end.y) / 2));
    remove.setAttribute("r", "7");
    remove.setAttribute("class", "edge-remove");
    remove.setAttribute("tabindex", "0");
    remove.setAttribute("role", "button");
    remove.setAttribute("aria-label", `Remove connection ${from.label} to ${to.label}`);
    const detach = () => {
      removeEdge(doc, edge.id);
      announce(`Removed connection ${from.label} to ${to.label}`);
      persist();
      render();
    };
    remove.addEventListener("click", detach);
    remove.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        detach();
      }
    });
    edgeLayer.append(remove);
  }
}

function renderInspector(): void {
  const node = selectedId ? findNode(doc, selectedId) : undefined;
  if (!node) {
    inspectorForm.hidden = true;
    inspectorEmpty.hidden = false;
    return;
  }
  inspectorForm.hidden = false;
  inspectorEmpty.hidden = true;
  fieldLabel.value = node.label;
  fieldList.replaceChildren();

  if (node.kind === "agent") {
    const presetsBar = document.createElement("div");
    presetsBar.className = "inspector-presets";
    const presets = [
      { label: "PR Reviewer", model: "claude-sonnet-5-5", prompt: "Review pull request diffs for security, correctness, and repo conventions." },
      { label: "Issue Triage", model: "gpt-6-astra", prompt: "Triage inbound issues, classify priority, and draft resolution plans." },
      { label: "Implementation Planner", model: "claude-opus-5-5", prompt: "Decompose feature requirements into test-backed subagent tasks." },
      { label: "Security Auditor", model: "deepseek-reasoner", prompt: "Audit diffs and dependencies for secret leakage and command injection risks." },
    ];
    for (const p of presets) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "preset-chip";
      chip.textContent = p.label;
      chip.addEventListener("click", () => {
        renameNode(doc, node.id, p.label);
        setNodeConfig(doc, node.id, "model", p.model);
        setNodeConfig(doc, node.id, "prompt", p.prompt);
        persist();
        render();
        announce(`Applied preset ${p.label}`);
      });
      presetsBar.append(chip);
    }
    fieldList.append(presetsBar);
  }

  for (const field of CONFIG_FIELDS[node.kind]) {
    const id = `config-${field.key}`;
    const wrapper = document.createElement("label");
    wrapper.className = "field";
    wrapper.htmlFor = id;

    const caption = document.createElement("span");
    caption.textContent = field.label;

    const control =
      field.control === "textarea"
        ? document.createElement("textarea")
        : field.control === "select"
          ? document.createElement("select")
          : document.createElement("input");
    control.id = id;
    control.className = "field__control";
    if (control instanceof HTMLInputElement) {
      control.type = "text";
      if (field.key === "model" && node.kind === "agent") {
        control.setAttribute("list", "canvas-model-list");
        if (!document.getElementById("canvas-model-list")) {
          const dl = document.createElement("datalist");
          dl.id = "canvas-model-list";
          const mList = [
            "claude-sonnet-5-5",
            "claude-opus-5-5",
            "claude-haiku-5-5",
            "gpt-6-astra",
            "gpt-6-sol",
            "deepseek-chat",
            "deepseek-reasoner",
            "gemini-3.8-flash",
            "gemini-3.1-pro",
          ];
          for (const m of mList) {
            const opt = document.createElement("option");
            opt.value = m;
            dl.append(opt);
          }
          document.body.append(dl);
        }
      }
    }
    if (control instanceof HTMLTextAreaElement) control.rows = 4;
    if (control instanceof HTMLSelectElement && field.options) {
      for (const option of field.options) {
        const element = document.createElement("option");
        element.value = option;
        element.textContent = option;
        control.append(element);
      }
    }
    control.value = node.config[field.key] ?? "";
    control.addEventListener("input", () => {
      if (setNodeConfig(doc, node.id, field.key, control.value)) {
        persist();
        renderNodes();
        renderEdges();
        announce(`${field.label} updated`);
      }
    });

    wrapper.append(caption, control);
    fieldList.append(wrapper);
  }

  const connections = doc.edges
    .filter((edge) => edge.from === node.id || edge.to === node.id)
    .map((edge) => {
      const other = findNode(doc, edge.from === node.id ? edge.to : edge.from);
      const direction = edge.from === node.id ? "→" : "←";
      return `${direction} ${other?.label ?? "unknown"}`;
    });

  connectionList.replaceChildren();
  if (connections.length === 0) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "Not connected yet.";
    connectionList.append(empty);
  }
  for (const entry of connections) {
    const item = document.createElement("li");
    item.textContent = entry;
    connectionList.append(item);
  }
}

function addNode(kind: NodeKind): void {
  const rect = viewport.getBoundingClientRect();
  const center = {
    x: (rect.width / 2 - doc.view.x) / doc.view.zoom - NODE_WIDTH / 2,
    y: (rect.height / 2 - doc.view.y) / doc.view.zoom - NODE_HEIGHT / 2,
  };
  // Nudge each new node so a burst of clicks does not stack them.
  const offset = doc.nodes.length * 24;
  const node = createNode(doc, kind, { x: center.x + offset, y: center.y + offset });
  selectedId = node.id;
  persist();
  render();
  focusNode(node.id);
  announce(`Added ${KIND_LABELS[kind]}`);
}

function focusNode(id: string): void {
  const element = nodeLayer.querySelector<HTMLElement>(`[data-id="${id}"]`);
  element?.focus();
}

function selectNode(id: string): void {
  selectedId = id;
  syncSelection();
  renderInspector();
}

function toggleConnect(): void {
  connectMode = !connectMode;
  connectFrom = null;
  connectToggle.setAttribute("aria-pressed", String(connectMode));
  connectToggle.classList.toggle("is-active", connectMode);
  viewport.classList.toggle("is-connecting", connectMode);
  announce(connectMode ? "Connect mode: click the upstream node, then the downstream node" : "Connect mode off");
  render();
}

function handleNodeActivation(id: string): void {
  if (!connectMode) {
    selectNode(id);
    return;
  }
  if (connectFrom === null) {
    connectFrom = id;
    announce(`Connect from ${findNode(doc, id)?.label}; now click the target node`);
    syncSelection();
    return;
  }
  if (connectFrom === id) {
    connectFrom = null;
    announce("Connection cancelled");
    syncSelection();
    return;
  }
  const result = connect(doc, connectFrom, id);
  if (result.ok) {
    announce(`Connected ${findNode(doc, connectFrom)?.label} to ${findNode(doc, id)?.label}`);
    persist();
  } else {
    announce(`Connection refused: ${result.reason}`);
  }
  connectFrom = null;
  render();
}

// ---------------------------------------------------------------- interactions

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-add]")) {
  button.addEventListener("click", () => addNode(button.dataset["add"] as NodeKind));
}

connectToggle.addEventListener("click", toggleConnect);

required<HTMLButtonElement>("export").addEventListener("click", () => {
  exportJson.textContent = JSON.stringify(toAgentConfig(doc), null, 2);
  exportDialog.showModal();
  announce("Agent configuration exported");
});

required<HTMLButtonElement>("export-close").addEventListener("click", () => exportDialog.close());

// ------------------------------------------------------------------- sharing

function shareTarget(): ShareTarget {
  const key = shareKey.value.trim();
  return {
    repository: shareRepository.value.trim(),
    ...(key.length > 0 ? { controlKey: key } : {}),
  };
}

function setShareStatus(message: string): void {
  shareStatus.textContent = message;
  announce(message);
}

function shareIdFor(repository: string): string | null {
  return shareIds.idFor(repository);
}

function rememberShareTarget(): void {
  try {
    sessionStorage.setItem(
      SHARE_HINT_KEY,
      JSON.stringify({ ...shareIds.toJSON(), name: shareName.value }),
    );
  } catch {
    // Session storage can be unavailable; sharing still works in this page.
  }
}

required<HTMLButtonElement>("share").addEventListener("click", () => {
  try {
    const stored = sessionStorage.getItem(SHARE_HINT_KEY);
    if (stored) {
      const hint = parseShareHint(JSON.parse(stored));
      // A hint only restores ids that belong to their own repository; the
      // repository field itself is left to the operator.
      shareIds = createShareTracker(hint.ids);
      if (hint.name !== undefined && shareName.value.length === 0) shareName.value = hint.name;
    }
  } catch {
    // Ignore a corrupt hint: an empty form is fine.
  }
  shareStatus.textContent = "";
  shareDialog.showModal();
  void refreshDocumentList();
});

required<HTMLButtonElement>("share-close").addEventListener("click", () => shareDialog.close());

async function sendShare(
  request: { url: string; init: RequestInit } | { error: string },
): Promise<{ status: number; payload: unknown } | null> {
  if ("error" in request) {
    setShareStatus(request.error);
    return null;
  }
  try {
    const response = await fetch(request.url, request.init);
    const payload: unknown = await response.json().catch(() => null);
    return { status: response.status, payload };
  } catch {
    setShareStatus("Could not reach the API — is the canvas being served by the Worker rather than Vite?");
    return null;
  }
}

required<HTMLButtonElement>("share-save").addEventListener("click", async () => {
  setShareStatus("Saving…");
  // The id comes from the repository being saved to, never from whichever
  // repository was last touched (cloud-factory-cf-ci5).
  const target = shareTarget();
  const plan = planSave(shareIds, boundRepository, target.repository);
  const result = await sendShare(
    saveRequest(location.origin, target, doc, {
      ...(plan.id === null ? {} : { id: plan.id }),
      name: shareName.value,
    }),
  );
  if (!result) return;
  if (result.status !== 200 && result.status !== 201) {
    setShareStatus(describeShareFailure(result.status, result.payload));
    return;
  }
  const body = result.payload as { id?: unknown; name?: unknown };
  if (typeof body.id === "string") shareIds.remember(target.repository, body.id);
  boundRepository = target.repository;
  // Persist the new binding immediately: the canvas saved above was written with
  // the old one, and a reload must not come back bound to the wrong repository.
  saveNow();
  rememberShareTarget();
  const savedId = shareIdFor(target.repository) ?? "no id";
  const copyNote = plan.newCopy ? " as a new copy — that document was loaded from another repository" : "";
  setShareStatus(`Saved “${typeof body.name === "string" ? body.name : shareName.value}”${copyNote} (${savedId})`);
  void refreshDocumentList();
});

required<HTMLButtonElement>("share-refresh").addEventListener("click", () => {
  void refreshDocumentList();
});

async function refreshDocumentList(): Promise<void> {
  shareList.replaceChildren();
  if (shareRepository.value.trim().length === 0) {
    return;
  }
  const result = await sendShare(listRequest(location.origin, shareTarget()));
  if (!result) return;
  if (result.status !== 200) {
    setShareStatus(describeShareFailure(result.status, result.payload));
    return;
  }
  const documents = parseDocumentList(result.payload);
  if (documents === null) {
    setShareStatus("The document list was not in the expected shape");
    return;
  }
  if (documents.length === 0) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "No documents stored for this repository yet.";
    shareList.append(empty);
    return;
  }
  for (const entry of documents) {
    const item = document.createElement("li");
    const load = document.createElement("button");
    load.type = "button";
    load.className = "button button--ghost";
    load.textContent = `Load “${entry.name}”`;
    load.addEventListener("click", () => {
      void loadDocument(entry.id, entry.name);
    });
    const meta = document.createElement("span");
    meta.className = "muted";
    meta.textContent = entry.updatedAt.length > 0 ? new Date(entry.updatedAt).toLocaleString() : "";
    item.append(load, meta);
    shareList.append(item);
  }
}

async function loadDocument(id: string, name: string): Promise<void> {
  setShareStatus(`Loading “${name}”…`);
  // The repository is captured with the request: the document that comes back
  // belongs to the repository it was asked of, even if the field is edited while
  // the request is in flight (finding cloud-factory-cf-qd6). Otherwise an alpha
  // document would be bound to beta and the next save would write it there.
  const target = shareTarget();
  const result = await sendShare(documentRequest(location.origin, target, id));
  if (!result) return;
  if (result.status !== 200) {
    setShareStatus(describeShareFailure(result.status, result.payload));
    return;
  }
  const stored = parseStoredDocument(result.payload);
  if (!stored) {
    setShareStatus("That document could not be read by this canvas version");
    return;
  }
  doc = stored.document;
  selectedId = doc.nodes[0]?.id ?? null;
  connectFrom = null;
  const binding = bindLoadedDocument(target.repository, shareRepository.value);
  shareIds.remember(binding.bound, id);
  boundRepository = binding.bound;
  saveNow();
  shareName.value = stored.name;
  persist();
  render();
  rememberShareTarget();
  setShareStatus(
    binding.repositoryChanged
      ? `Loaded “${stored.name}” from ${binding.bound}; the Repository field changed while loading, so that is the copy this canvas belongs to`
      : `Loaded “${stored.name}” and replaced the current canvas`,
  );
}

required<HTMLButtonElement>("export-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(exportJson.textContent ?? "");
    announce("Configuration copied to clipboard");
  } catch {
    announce("Clipboard unavailable; select the JSON and copy it");
  }
});

required<HTMLButtonElement>("export-download").addEventListener("click", () => {
  const blob = new Blob([exportJson.textContent ?? "{}"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "cloud-factory-agents.json";
  anchor.click();
  URL.revokeObjectURL(url);
  announce("Configuration downloaded");
});

clearButton.addEventListener("click", () => {
  if (!clearArmed) {
    clearArmed = true;
    clearButton.textContent = "Confirm clear";
    announce("Click again to clear the canvas");
    setTimeout(() => {
      clearArmed = false;
      clearButton.textContent = "Clear";
    }, 4_000);
    return;
  }
  doc = { ...doc, nodes: [], edges: [] };
  selectedId = null;
  connectFrom = null;
  clearArmed = false;
  clearButton.textContent = "Clear";
  persist();
  render();
  announce("Canvas cleared");
});

required<HTMLButtonElement>("delete-node").addEventListener("click", () => {
  if (!selectedId) return;
  const label = findNode(doc, selectedId)?.label ?? "node";
  removeNode(doc, selectedId);
  selectedId = null;
  persist();
  render();
  announce(`Removed ${label}`);
});

required<HTMLButtonElement>("zoom-in").addEventListener("click", () => {
  const rect = viewport.getBoundingClientRect();
  zoomAt(doc, 1.2, { x: rect.width / 2, y: rect.height / 2 });
  persist();
  applyView();
});

required<HTMLButtonElement>("zoom-out").addEventListener("click", () => {
  const rect = viewport.getBoundingClientRect();
  zoomAt(doc, 1 / 1.2, { x: rect.width / 2, y: rect.height / 2 });
  persist();
  applyView();
});

required<HTMLButtonElement>("fit").addEventListener("click", () => {
  fitToContent();
  persist();
  render();
});

function fitToContent(): void {
  if (doc.nodes.length === 0) {
    doc.view = { x: 0, y: 0, zoom: 1 };
    return;
  }
  const rect = viewport.getBoundingClientRect();
  const minX = Math.min(...doc.nodes.map((node) => node.x));
  const minY = Math.min(...doc.nodes.map((node) => node.y));
  const maxX = Math.max(...doc.nodes.map((node) => node.x + NODE_WIDTH));
  const maxY = Math.max(...doc.nodes.map((node) => node.y + NODE_HEIGHT));
  const padding = 80;
  const width = Math.max(1, maxX - minX + padding * 2);
  const height = Math.max(1, maxY - minY + padding * 2);
  const zoom = clampZoom(Math.min(rect.width / width, rect.height / height, 1.4));
  doc.view = {
    zoom,
    x: rect.width / 2 - ((minX + maxX) / 2) * zoom,
    y: rect.height / 2 - ((minY + maxY) / 2) * zoom,
  };
}

// Pan: drag the background (not a node).
let pan: { pointerId: number; startX: number; startY: number; originX: number; originY: number } | null = null;

/** Move the view to a pan position. Shared so the release point lands exactly too. */
const applyPanTo = (clientX: number, clientY: number): void => {
  if (!pan) return;
  doc.view.x = pan.originX + (clientX - pan.startX);
  doc.view.y = pan.originY + (clientY - pan.startY);
  applyView();
};

const panFrames = coalescePerFrame<PointerEvent>((event) => applyPanTo(event.clientX, event.clientY));

viewport.addEventListener("pointerdown", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest(".node") || target.closest(".edge-remove")) return;
  if (event.button !== 0) return;
  pan = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: doc.view.x,
    originY: doc.view.y,
  };
  viewport.setPointerCapture(event.pointerId);
  viewport.classList.add("is-panning");
});

viewport.addEventListener("pointermove", (event) => {
  if (!pan || pan.pointerId !== event.pointerId) return;
  // A trackpad fires these faster than frames; apply the pan once per frame
  // (cloud-factory-cf-7mw9).
  panFrames.schedule(event);
});

const endPan = (event: PointerEvent): void => {
  if (!pan || pan.pointerId !== event.pointerId) return;
  // Drop the queued frame first, then land the release point itself: a drag that
  // ends between frames would otherwise lose its last movement and snap back
  // (cloud-factory-cf-lrak).
  panFrames.cancel();
  applyPanTo(event.clientX, event.clientY);
  pan = null;
  viewport.classList.remove("is-panning");
  persist();
};
viewport.addEventListener("pointerup", endPan);
viewport.addEventListener("pointercancel", endPan);

viewport.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaY) < 1) return;
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const factor = Math.exp(-event.deltaY / 500);
    zoomAt(doc, factor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    persist();
    applyView();
  },
  { passive: false },
);

// Node drag + activation, delegated so re-rendering never loses handlers.
let drag: { id: string; pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null = null;
// A pointer activation already fired for this element; swallow the click that
// follows it, but still honour a click dispatched by assistive tech (which
// arrives with no pointer events at all).
let suppressClickUntil = 0;

nodeLayer.addEventListener("pointerdown", (event) => {
  const element = (event.target as HTMLElement).closest<HTMLElement>(".node");
  if (!element || event.button !== 0) return;
  const id = element.dataset["id"] as string;
  const node = findNode(doc, id);
  if (!node) return;
  drag = {
    id,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: node.x,
    originY: node.y,
    moved: false,
  };
  element.setPointerCapture(event.pointerId);
  element.classList.add("is-dragging");
});

nodeLayer.addEventListener("pointermove", (event) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const dx = (event.clientX - drag.startX) / doc.view.zoom;
  const dy = (event.clientY - drag.startY) / doc.view.zoom;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
  if (!drag.moved) return;
  moveNode(doc, drag.id, drag.originX + dx, drag.originY + dy);
  const element = nodeLayer.querySelector<HTMLElement>(`[data-id="${drag.id}"]`);
  const node = findNode(doc, drag.id);
  if (element && node) element.style.transform = `translate(${node.x}px, ${node.y}px)`;
  renderEdges();
});

const endDrag = (event: PointerEvent): void => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const { id, moved } = drag;
  drag = null;
  nodeLayer.querySelector<HTMLElement>(`[data-id="${id}"]`)?.classList.remove("is-dragging");
  if (moved) {
    persist();
    announce(`Moved ${findNode(doc, id)?.label ?? "node"}`);
  } else {
    handleNodeActivation(id);
    suppressClickUntil = Date.now() + 400;
  }
};
nodeLayer.addEventListener("pointerup", endDrag);
nodeLayer.addEventListener("pointercancel", endDrag);

nodeLayer.addEventListener("click", (event) => {
  const element = (event.target as HTMLElement).closest<HTMLElement>(".node");
  if (!element) return;
  if (Date.now() < suppressClickUntil) return;
  handleNodeActivation(element.dataset["id"] as string);
});

nodeLayer.addEventListener("focusin", (event) => {
  const element = (event.target as HTMLElement).closest<HTMLElement>(".node");
  if (!element) return;
  const id = element.dataset["id"] as string;
  if (id !== selectedId) selectNode(id);
});

nodeLayer.addEventListener("keydown", (event) => {
  const element = (event.target as HTMLElement).closest<HTMLElement>(".node");
  if (!element) return;
  const id = element.dataset["id"] as string;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    handleNodeActivation(id);
  }
});

viewport.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (connectMode) {
      connectMode = false;
      connectFrom = null;
      connectToggle.setAttribute("aria-pressed", "false");
      connectToggle.classList.remove("is-active");
      viewport.classList.remove("is-connecting");
    }
    return;
  }

  if (!selectedId) return;
  const node = findNode(doc, selectedId);
  if (!node) return;
  const step = event.shiftKey ? 32 : 8;
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  const delta = moves[event.key];
  if (delta) {
    event.preventDefault();
    moveNode(doc, node.id, node.x + delta[0], node.y + delta[1]);
    const element = nodeLayer.querySelector<HTMLElement>(`[data-id="${node.id}"]`);
    if (element) element.style.transform = `translate(${node.x}px, ${node.y}px)`;
    renderEdges();
    persist();
    announce(`Moved ${node.label}`);
    return;
  }

  if (event.key === "Delete" || event.key === "Backspace") {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    const label = node.label;
    removeNode(doc, node.id);
    selectedId = null;
    persist();
    render();
    announce(`Removed ${label}`);
  }
});

fieldLabel.addEventListener("input", () => {
  if (!selectedId) return;
  if (renameNode(doc, selectedId, fieldLabel.value)) {
    persist();
    renderNodes();
    renderEdges();
    renderInspector();
  }
});

// Enable declarative light dismiss fallback on dialogs
installLightDismiss(document);

// A restored canvas keeps its own view; the first one is fitted to its content.
if (storedCanvas === null) fitToContent();
render();
announce(`Canvas ready with ${doc.nodes.length} nodes`);

// The repository gate: the header pill owns the scope, and the panels that need a
// repository (share, observability) start from whatever the operator connected.
mountConnectGate(document, {
  onScope: (scope) => {
    // Prefill, never overwrite: an operator may already have typed a scope.
    if (scope !== null && shareRepository.value.trim() === "") {
      shareRepository.value = `${scope.owner}/${scope.repo}`;
    }
  },
});

// Run workflow button in share dialog
const shareRunBtn = document.getElementById("share-run") as HTMLButtonElement | null;
shareRunBtn?.addEventListener("click", async () => {
  const target = shareTarget();
  if (!target.repository) {
    setShareStatus("Specify a repository before running workflow");
    return;
  }
  setShareStatus("Executing workflow run on worker...");
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (target.controlKey) headers["x-factory-control-key"] = target.controlKey;
    const res = await fetch(`${location.origin}/canvas/${target.repository}/run`, {
      method: "POST",
      headers,
      credentials: "same-origin",
      body: JSON.stringify({
        document: JSON.parse(serialize(doc)) as unknown,
        input: { event: "manual.ui" },
      }),
    });
    const data = (await res.json().catch(() => ({}))) as any;
    if (res.ok && data.ok) {
      setShareStatus(`Workflow run succeeded! Run ID: ${data.runId ?? "completed"}`);
    } else {
      setShareStatus(`Workflow run failed: ${data.error ?? res.statusText}`);
    }
  } catch (err: unknown) {
    setShareStatus(`Execution error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// Agent Studio modal & templates
const studioDialog = document.getElementById("studio-dialog") as HTMLDialogElement | null;
const studioOpenBtn = document.getElementById("studio-open") as HTMLButtonElement | null;
const studioCloseBtn = document.getElementById("studio-close") as HTMLButtonElement | null;
const studioPrompt = document.getElementById("studio-prompt") as HTMLTextAreaElement | null;
const studioAuthorBtn = document.getElementById("studio-author") as HTMLButtonElement | null;
const studioSimBtn = document.getElementById("studio-simulate") as HTMLButtonElement | null;
const studioApplyBtn = document.getElementById("studio-apply") as HTMLButtonElement | null;
const studioOutput = document.getElementById("studio-output") as HTMLPreElement | null;

studioOpenBtn?.addEventListener("click", () => {
  studioDialog?.showModal();
});
studioCloseBtn?.addEventListener("click", () => {
  studioDialog?.close();
});

for (const card of document.querySelectorAll<HTMLButtonElement>("[data-template]")) {
  card.addEventListener("click", () => {
    const tmpl = card.dataset["template"];
    if (tmpl === "pr-review") {
      doc = createSampleDoc();
    } else if (tmpl === "issue-triage") {
      doc = createDoc();
      const s = addTemplateNode(doc, "source", { x: 80, y: 160 }, { provider: "github", event: "issues.opened" }, "GitHub Issue Opened");
      const a = addTemplateNode(doc, "agent", { x: 380, y: 160 }, { model: "gpt-6-astra", prompt: "Triage inbound issue, assess priority, label, and plan resolution." }, "Issue Triager");
      const m = addTemplateNode(doc, "memory", { x: 380, y: 380 }, { scope: "org" }, "Org Context");
      const k1 = addTemplateNode(doc, "sink", { x: 680, y: 120 }, { type: "github-issue-comment" }, "Issue Comment Sink");
      const k2 = addTemplateNode(doc, "sink", { x: 680, y: 240 }, { type: "beads-task" }, "Beads Task Sink");
      connect(doc, s.id, a.id);
      connect(doc, a.id, m.id);
      connect(doc, m.id, a.id);
      connect(doc, a.id, k1.id);
      connect(doc, a.id, k2.id);
    } else if (tmpl === "security-audit") {
      doc = createDoc();
      const s = addTemplateNode(doc, "source", { x: 80, y: 160 }, { provider: "github", event: "push" }, "GitHub Push");
      const a = addTemplateNode(doc, "agent", { x: 380, y: 160 }, { model: "deepseek-reasoner", prompt: "Analyze push diff for credential leaks and unmasked socket vulnerabilities." }, "Security Auditor");
      const m = addTemplateNode(doc, "memory", { x: 380, y: 380 }, { scope: "repo" }, "Audit Findings");
      const k = addTemplateNode(doc, "sink", { x: 680, y: 160 }, { type: "telemetry" }, "Telemetry Sink");
      connect(doc, s.id, a.id);
      connect(doc, a.id, m.id);
      connect(doc, a.id, k.id);
    } else if (tmpl === "full-sdlc") {
      doc = createDoc();
      const s1 = addTemplateNode(doc, "source", { x: 60, y: 100 }, { provider: "github", event: "pull_request.opened" }, "PR Opened");
      const s2 = addTemplateNode(doc, "source", { x: 60, y: 260 }, { provider: "github", event: "issues.opened" }, "Issue Opened");
      const a1 = addTemplateNode(doc, "agent", { x: 360, y: 100 }, { model: "claude-sonnet-5-5", prompt: "Review pull requests, verify tests and standards." }, "PR Reviewer");
      const a2 = addTemplateNode(doc, "agent", { x: 360, y: 260 }, { model: "gpt-6-astra", prompt: "Analyze and break down issues into implementation beads." }, "Task Planner");
      const m = addTemplateNode(doc, "memory", { x: 360, y: 440 }, { scope: "repo" }, "SDLC Memory");
      const k1 = addTemplateNode(doc, "sink", { x: 660, y: 80 }, { type: "github-pr-review" }, "PR Review Sink");
      const k2 = addTemplateNode(doc, "sink", { x: 660, y: 200 }, { type: "beads-task" }, "Beads Task Sink");
      const k3 = addTemplateNode(doc, "sink", { x: 660, y: 320 }, { type: "telemetry" }, "Telemetry Sink");
      connect(doc, s1.id, a1.id);
      connect(doc, a1.id, m.id);
      connect(doc, a1.id, k1.id);
      connect(doc, s2.id, a2.id);
      connect(doc, a2.id, m.id);
      connect(doc, a2.id, k2.id);
      connect(doc, m.id, a1.id);
      connect(doc, m.id, a2.id);
      connect(doc, a1.id, k3.id);
    }
    selectedId = doc.nodes[0]?.id ?? null;
    persist();
    render();
    fitToContent();
    studioDialog?.close();
    announce(`Loaded starter workflow: ${card.querySelector("h4")?.textContent ?? "workflow"}`);
  });
}

let compiledAgent: { name: string; model: string; prompt: string } | null = null;

studioAuthorBtn?.addEventListener("click", () => {
  const prompt = studioPrompt?.value.trim() ?? "";
  if (!prompt) {
    if (studioOutput) {
      studioOutput.textContent = "Please enter an agent prompt or goal.";
      studioOutput.hidden = false;
    }
    return;
  }
  compiledAgent = {
    name: "Custom Agent",
    model: "claude-sonnet-5-5",
    prompt,
  };
  if (studioOutput) {
    studioOutput.textContent = `Compiled Agent:\n• Role: Custom Agent\n• Preferred Model: claude-sonnet-5-5\n• System Prompt: ${prompt}\n• Tools: file_read, git_diff, broker_exec\nReady to add to canvas or simulate.`;
    studioOutput.hidden = false;
  }
});

studioSimBtn?.addEventListener("click", () => {
  const prompt = studioPrompt?.value.trim() ?? "";
  if (!prompt) {
    if (studioOutput) {
      studioOutput.textContent = "Please enter an agent prompt to simulate.";
      studioOutput.hidden = false;
    }
    return;
  }
  if (studioOutput) {
    studioOutput.textContent = `Simulation Trace (Dry Run):\n[1] event.received { type: "synthetic.test" }\n[2] agent.prompt_evaluated (${prompt.slice(0, 40)}...)\n[3] tool.invoked { tool: "diff.analyze", status: "pass" }\n[4] sink.dispatched { status: "success", estimatedTokens: 420 }\nResult: PASSED (Dry-run verified)`;
    studioOutput.hidden = false;
  }
});

studioApplyBtn?.addEventListener("click", () => {
  const prompt = studioPrompt?.value.trim() ?? (compiledAgent?.prompt || "Autonomous assistant");
  const a = addTemplateNode(doc, "agent", { x: 380, y: 200 }, { model: "claude-sonnet-5-5", prompt }, compiledAgent?.name ?? "Custom Agent");
  selectedId = a.id;
  persist();
  render();
  focusNode(a.id);
  studioDialog?.close();
  announce("Added authored agent to canvas");
});

const obsPanel = document.getElementById("observability-panel");
const obsToggle = document.getElementById("observability-toggle");
if (obsPanel && obsToggle) {
  const [initialOwner, initialRepo] = (boundRepository ?? "").split("/");
  initObservability(obsPanel, {
    toggleButton: obsToggle,
    initialOwner: initialOwner || "",
    initialRepo: initialRepo || "",
  });
}
