import {
  KIND_LABELS,
  NODE_HEIGHT,
  NODE_WIDTH,
  clampZoom,
  connect,
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

const storedDoc = loadDoc();
let doc: CanvasDoc = storedDoc ?? createSampleDoc();
let selectedId: string | null = doc.nodes[0]?.id ?? null;
let connectMode = false;
let connectFrom: string | null = null;
let clearArmed = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

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
      options: ["github-pr-review", "github-issue", "beads", "telemetry"],
    },
  ],
};

function required<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as unknown as T;
}

function loadDoc(): CanvasDoc | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    return parseDoc(stored);
  } catch {
    return null;
  }
}

function saveNow(): void {
  try {
    localStorage.setItem(STORAGE_KEY, serialize(doc));
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
    if (control instanceof HTMLInputElement) control.type = "text";
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
  doc.view.x = pan.originX + (event.clientX - pan.startX);
  doc.view.y = pan.originY + (event.clientY - pan.startY);
  applyView();
});

const endPan = (event: PointerEvent): void => {
  if (!pan || pan.pointerId !== event.pointerId) return;
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

if (!storedDoc) fitToContent();
render();
announce(`Canvas ready with ${doc.nodes.length} nodes`);
