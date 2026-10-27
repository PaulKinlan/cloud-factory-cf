/**
 * Canvas document model for the Isocan-style configuration surface.
 *
 * Pure data + rules: the UI renders this and the control plane will consume
 * `toAgentConfig()`. Nothing here touches the DOM, so the model is unit-tested
 * in Node and the same rules hold in the browser.
 */

export type NodeKind = "agent" | "source" | "memory" | "sink";

export interface CanvasNode {
  id: string;
  kind: NodeKind;
  label: string;
  x: number;
  y: number;
  config: Record<string, string>;
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
}

export interface CanvasView {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasDoc {
  version: 1;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  view: CanvasView;
}

export const NODE_KINDS: readonly NodeKind[] = ["agent", "source", "memory", "sink"];

export const KIND_LABELS: Record<NodeKind, string> = {
  agent: "Agent",
  source: "Event source",
  memory: "Memory hub",
  sink: "Action sink",
};

export const DEFAULT_CONFIG: Record<NodeKind, Record<string, string>> = {
  agent: { prompt: "", model: "deepseek/deepseek-flash" },
  source: { provider: "github", event: "pull_request" },
  memory: { scope: "repo" },
  sink: { type: "github-pr-review" },
};

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2.5;

/** Node box geometry shared by the renderer and the edge router. */
export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 128;

export interface IdGenerator {
  (): string;
}

export const defaultIdGenerator: IdGenerator = () => crypto.randomUUID().slice(0, 8);

export function createDoc(): CanvasDoc {
  return { version: 1, nodes: [], edges: [], view: { x: 0, y: 0, zoom: 1 } };
}

export interface CreateNodeOptions {
  idGen?: IdGenerator;
  label?: string;
  /** Node-specific settings merged over DEFAULT_CONFIG[kind] (cloud-factory-cf-6xju). */
  config?: Record<string, string>;
}

export function createNode(
  doc: CanvasDoc,
  kind: NodeKind,
  position: { x: number; y: number },
  options: CreateNodeOptions = {},
): CanvasNode {
  const idGen = options.idGen ?? defaultIdGenerator;
  const node: CanvasNode = {
    id: `n-${idGen()}`,
    kind,
    label: options.label ?? KIND_LABELS[kind],
    x: Math.round(position.x),
    y: Math.round(position.y),
    config: { ...DEFAULT_CONFIG[kind], ...(options.config ?? {}) },
  };
  doc.nodes.push(node);
  return node;
}

export function findNode(doc: CanvasDoc, id: string): CanvasNode | undefined {
  return doc.nodes.find((node) => node.id === id);
}

export function moveNode(doc: CanvasDoc, id: string, x: number, y: number): boolean {
  const node = findNode(doc, id);
  if (!node || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  node.x = Math.round(x);
  node.y = Math.round(y);
  return true;
}

export function renameNode(doc: CanvasDoc, id: string, label: string): boolean {
  const node = findNode(doc, id);
  const trimmed = label.trim();
  if (!node || trimmed.length === 0 || trimmed.length > 80) return false;
  node.label = trimmed;
  return true;
}

export function setNodeConfig(doc: CanvasDoc, id: string, key: string, value: string): boolean {
  const node = findNode(doc, id);
  if (!node || !Object.hasOwn(node.config, key)) return false;
  if (value.length > 2_000) return false;
  node.config[key] = value;
  return true;
}

/** Removing a node also removes every edge that touched it. */
export function removeNode(doc: CanvasDoc, id: string): boolean {
  const index = doc.nodes.findIndex((node) => node.id === id);
  if (index === -1) return false;
  doc.nodes.splice(index, 1);
  doc.edges = doc.edges.filter((edge) => edge.from !== id && edge.to !== id);
  return true;
}

export type ConnectResult =
  | { ok: true; edge: CanvasEdge }
  | { ok: false; reason: "unknown node" | "self" | "duplicate" | "not allowed" };

/**
 * Wiring rules: sources feed agents, agents act through sinks and read/write
 * memory, sinks are terminal and memory never feeds a sink directly.
 */
export function canConnect(doc: CanvasDoc, from: string, to: string): ConnectResult {
  const source = findNode(doc, from);
  const target = findNode(doc, to);
  if (!source || !target) return { ok: false, reason: "unknown node" };
  if (from === to) return { ok: false, reason: "self" };
  if (doc.edges.some((edge) => edge.from === from && edge.to === to)) {
    return { ok: false, reason: "duplicate" };
  }

  const allowed = (s: NodeKind, t: NodeKind): boolean => {
    if (s === "source") return t === "agent";
    if (s === "agent") return t === "sink" || t === "memory";
    if (s === "memory") return t === "agent";
    return false; // sinks are terminal
  };

  return allowed(source.kind, target.kind) ? { ok: true, edge: { id: "", from, to } } : { ok: false, reason: "not allowed" };
}

export function connect(
  doc: CanvasDoc,
  from: string,
  to: string,
  options: { idGen?: IdGenerator } = {},
): ConnectResult {
  const check = canConnect(doc, from, to);
  if (!check.ok) return check;
  const idGen = options.idGen ?? defaultIdGenerator;
  const edge: CanvasEdge = { id: `e-${idGen()}`, from, to };
  doc.edges.push(edge);
  return { ok: true, edge };
}

export function removeEdge(doc: CanvasDoc, id: string): boolean {
  const index = doc.edges.findIndex((edge) => edge.id === id);
  if (index === -1) return false;
  doc.edges.splice(index, 1);
  return true;
}

export function setView(doc: CanvasDoc, view: CanvasView): void {
  doc.view = {
    x: Number.isFinite(view.x) ? view.x : 0,
    y: Number.isFinite(view.y) ? view.y : 0,
    zoom: clampZoom(view.zoom),
  };
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
}

/** Zoom around a viewport point so the point under the cursor stays put. */
export function zoomAt(doc: CanvasDoc, factor: number, point: { x: number; y: number }): void {
  const previous = doc.view.zoom;
  const next = clampZoom(previous * factor);
  if (next === previous) return;
  const ratio = next / previous;
  doc.view = {
    zoom: next,
    x: point.x - (point.x - doc.view.x) * ratio,
    y: point.y - (point.y - doc.view.y) * ratio,
  };
}

export interface AgentConfig {
  agents: Array<{
    id: string;
    name: string;
    prompt: string;
    model: string;
    sources: Array<{ id: string; label: string; config: Record<string, string> }>;
    memory: Array<{ id: string; label: string; config: Record<string, string> }>;
    sinks: Array<{ id: string; label: string; config: Record<string, string> }>;
  }>;
}

/**
 * The artifact the control plane consumes: one entry per agent with the nodes
 * wired to it. Edges are collapsed into the agent they belong to, so the canvas
 * layout does not leak into the runtime configuration.
 */
export function toAgentConfig(doc: CanvasDoc): AgentConfig {
  const agents = doc.nodes
    .filter((node) => node.kind === "agent")
    .map((agent) => {
      const incoming = doc.edges.filter((edge) => edge.to === agent.id);
      const outgoing = doc.edges.filter((edge) => edge.from === agent.id);
      const describe = (id: string) => {
        const node = findNode(doc, id);
        return node ? { id: node.id, label: node.label, config: { ...node.config } } : null;
      };

      const sources = incoming
        .map((edge) => describe(edge.from))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null && findNode(doc, entry.id)?.kind === "source");
      const memory = [
        ...incoming
          .map((edge) => describe(edge.from))
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null && findNode(doc, entry.id)?.kind === "memory"),
        ...outgoing
          .map((edge) => describe(edge.to))
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null && findNode(doc, entry.id)?.kind === "memory"),
      ];
      const sinks = outgoing
        .map((edge) => describe(edge.to))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null && findNode(doc, entry.id)?.kind === "sink");

      return {
        id: agent.id,
        name: agent.label,
        prompt: agent.config["prompt"] ?? "",
        model: agent.config["model"] ?? "",
        sources,
        memory,
        sinks,
      };
    });

  return { agents };
}

export function serialize(doc: CanvasDoc): string {
  return JSON.stringify(doc, null, 2);
}

/** Parses a stored/imported document, rejecting anything malformed. */
export function parseDoc(json: string): CanvasDoc | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<CanvasDoc>;
  if (candidate.version !== 1 || !Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) {
    return null;
  }

  const nodes: CanvasNode[] = [];
  for (const item of candidate.nodes) {
    if (typeof item !== "object" || item === null) continue;
    const node = item as Partial<CanvasNode>;
    if (typeof node.id !== "string" || !NODE_KINDS.includes(node.kind as NodeKind)) continue;
    if (typeof node.x !== "number" || !Number.isFinite(node.x)) continue;
    if (typeof node.y !== "number" || !Number.isFinite(node.y)) continue;
    const config: Record<string, string> = {};
    if (typeof node.config === "object" && node.config !== null) {
      for (const [key, value] of Object.entries(node.config)) {
        if (typeof value === "string") config[key] = value;
      }
    }
    nodes.push({
      id: node.id,
      kind: node.kind as NodeKind,
      label: typeof node.label === "string" && node.label.length > 0 ? node.label.slice(0, 80) : KIND_LABELS[node.kind as NodeKind],
      x: node.x,
      y: node.y,
      config,
    });
  }

  const ids = new Set(nodes.map((node) => node.id));
  const edges: CanvasEdge[] = [];
  const seen = new Set<string>();
  for (const item of candidate.edges) {
    if (typeof item !== "object" || item === null) continue;
    const edge = item as Partial<CanvasEdge>;
    if (typeof edge.id !== "string" || typeof edge.from !== "string" || typeof edge.to !== "string") continue;
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;
    const key = `${edge.from}->${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ id: edge.id, from: edge.from, to: edge.to });
  }

  const doc: CanvasDoc = {
    version: 1,
    nodes,
    edges,
    view: { x: 0, y: 0, zoom: 1 },
  };
  if (candidate.view) setView(doc, candidate.view);
  return doc;
}

/** Seeds a small example so a first visit is not a blank page. */
export function createSampleDoc(options: { idGen?: IdGenerator } = {}): CanvasDoc {
  const doc = createDoc();
  const idGen = options.idGen;
  const source = createNode(doc, "source", { x: -360, y: -40 }, { idGen, label: "Pull requests" });
  const agent = createNode(doc, "agent", { x: -40, y: -40 }, { idGen, label: "PR reviewer" });
  const memory = createNode(doc, "memory", { x: -40, y: 170 }, { idGen, label: "Repo memory" });
  const sink = createNode(doc, "sink", { x: 280, y: -40 }, { idGen, label: "GitHub review" });
  agent.config["prompt"] = "Review the pull request and call out correctness risks first.";
  connect(doc, source.id, agent.id, { idGen });
  connect(doc, agent.id, memory.id, { idGen });
  connect(doc, agent.id, sink.id, { idGen });
  return doc;
}
