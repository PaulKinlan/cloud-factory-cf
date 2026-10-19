import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  canConnect,
  connect,
  createDoc,
  createNode,
  createSampleDoc,
  moveNode,
  parseDoc,
  removeNode,
  renameNode,
  serialize,
  setNodeConfig,
  toAgentConfig,
  zoomAt,
} from "../src/model";

let counter = 0;
const idGen = () => `t${(counter += 1)}`;

describe("canvas doc", () => {
  it("adds nodes with kind defaults and a stable id prefix", () => {
    const doc = createDoc();
    const agent = createNode(doc, "agent", { x: 10.4, y: -20.6 }, { idGen });
    expect(agent).toMatchObject({ id: "n-t1", kind: "agent", x: 10, y: -21 });
    expect(agent.config["prompt"]).toBe("");
    expect(doc.nodes).toHaveLength(1);
  });

  it("moves, renames and configures a node, refusing invalid values", () => {
    const doc = createDoc();
    const node = createNode(doc, "source", { x: 0, y: 0 }, { idGen });

    expect(moveNode(doc, node.id, 40.7, 12.2)).toBe(true);
    expect(node).toMatchObject({ x: 41, y: 12 });
    expect(moveNode(doc, node.id, Number.NaN, 0)).toBe(false);

    expect(renameNode(doc, node.id, "  Push events  ")).toBe(true);
    expect(node.label).toBe("Push events");
    expect(renameNode(doc, node.id, "   ")).toBe(false);

    expect(setNodeConfig(doc, node.id, "event", "push")).toBe(true);
    expect(node.config["event"]).toBe("push");
    expect(setNodeConfig(doc, node.id, "unknownKey", "x")).toBe(false);
  });

  it("removes attached edges with the node", () => {
    const doc = createDoc();
    const source = createNode(doc, "source", { x: 0, y: 0 }, { idGen });
    const agent = createNode(doc, "agent", { x: 300, y: 0 }, { idGen });
    connect(doc, source.id, agent.id, { idGen });
    expect(doc.edges).toHaveLength(1);

    expect(removeNode(doc, source.id)).toBe(true);
    expect(doc.nodes).toHaveLength(1);
    expect(doc.edges).toHaveLength(0);
    expect(removeNode(doc, "missing")).toBe(false);
  });
});

describe("wiring rules", () => {
  it("routes sources to agents, agents to sinks/memory, memory back to agents", () => {
    const doc = createDoc();
    const source = createNode(doc, "source", { x: 0, y: 0 }, { idGen });
    const agent = createNode(doc, "agent", { x: 0, y: 200 }, { idGen });
    const memory = createNode(doc, "memory", { x: 0, y: 400 }, { idGen });
    const sink = createNode(doc, "sink", { x: 0, y: 600 }, { idGen });

    expect(canConnect(doc, source.id, agent.id).ok).toBe(true);
    expect(canConnect(doc, agent.id, sink.id).ok).toBe(true);
    expect(canConnect(doc, agent.id, memory.id).ok).toBe(true);
    expect(canConnect(doc, memory.id, agent.id).ok).toBe(true);

    expect(canConnect(doc, source.id, sink.id)).toMatchObject({ ok: false, reason: "not allowed" });
    expect(canConnect(doc, sink.id, agent.id)).toMatchObject({ ok: false, reason: "not allowed" });
    expect(canConnect(doc, memory.id, sink.id)).toMatchObject({ ok: false, reason: "not allowed" });
  });

  it("refuses self links, duplicates and unknown nodes", () => {
    const doc = createDoc();
    const agent = createNode(doc, "agent", { x: 0, y: 0 }, { idGen });
    const sink = createNode(doc, "sink", { x: 0, y: 200 }, { idGen });

    expect(canConnect(doc, agent.id, agent.id)).toMatchObject({ ok: false, reason: "self" });
    expect(canConnect(doc, agent.id, "nope")).toMatchObject({ ok: false, reason: "unknown node" });

    const first = connect(doc, agent.id, sink.id, { idGen });
    expect(first.ok).toBe(true);
    expect(connect(doc, agent.id, sink.id, { idGen })).toMatchObject({ ok: false, reason: "duplicate" });
    expect(doc.edges).toHaveLength(1);
  });
});

describe("view", () => {
  it("zooms around the cursor and clamps", () => {
    const doc = createDoc();
    doc.view = { x: 0, y: 0, zoom: 1 };

    zoomAt(doc, 2, { x: 100, y: 100 });
    expect(doc.view.zoom).toBe(2);
    // The point under the cursor stays at the same world position.
    expect(doc.view.x).toBe(-100);
    expect(doc.view.y).toBe(-100);

    zoomAt(doc, 100, { x: 0, y: 0 });
    expect(doc.view.zoom).toBe(MAX_ZOOM);
    zoomAt(doc, 0.0001, { x: 0, y: 0 });
    expect(doc.view.zoom).toBe(MIN_ZOOM);
  });
});

describe("persistence", () => {
  it("round-trips a document through serialize/parse", () => {
    counter = 0;
    const original = createSampleDoc({ idGen });
    const parsed = parseDoc(serialize(original));
    expect(parsed).not.toBeNull();
    expect(parsed?.nodes).toHaveLength(original.nodes.length);
    expect(parsed?.edges).toHaveLength(original.edges.length);
    expect(parsed?.nodes.map((node) => node.kind).sort()).toEqual(["agent", "memory", "sink", "source"]);
  });

  it("rejects malformed or unsafe documents", () => {
    expect(parseDoc("not json")).toBeNull();
    expect(parseDoc(JSON.stringify({ version: 2, nodes: [], edges: [] }))).toBeNull();
    expect(parseDoc(JSON.stringify({ version: 1, nodes: "nope", edges: [] }))).toBeNull();

    const cleaned = parseDoc(JSON.stringify({
      version: 1,
      nodes: [
        { id: "a", kind: "agent", label: "A", x: 0, y: 0, config: { prompt: "p", bad: 5 } },
        { id: "b", kind: "nonsense", x: 0, y: 0 },
        { id: "c", kind: "sink", x: 5, y: 5 },
      ],
      edges: [
        { id: "e1", from: "a", to: "c" },
        { id: "e2", from: "a", to: "missing" },
        { id: "e3", from: "a", to: "a" },
        { id: "e4", from: "a", to: "c" },
      ],
      view: { x: 12, y: -4, zoom: 99 },
    }));
    expect(cleaned?.nodes.map((node) => node.id)).toEqual(["a", "c"]);
    expect(cleaned?.nodes[0]?.config).toEqual({ prompt: "p" });
    expect(cleaned?.edges).toHaveLength(1);
    expect(cleaned?.view.zoom).toBe(MAX_ZOOM);
  });
});

describe("agent configuration export", () => {
  it("collapses edges into per-agent sources, memory and sinks", () => {
    counter = 0;
    const doc = createDoc();
    const source = createNode(doc, "source", { x: 0, y: 0 }, { idGen, label: "PRs" });
    const agent = createNode(doc, "agent", { x: 0, y: 200 }, { idGen, label: "Reviewer" });
    const memory = createNode(doc, "memory", { x: 0, y: 400 }, { idGen, label: "Memory" });
    const sink = createNode(doc, "sink", { x: 0, y: 600 }, { idGen, label: "Review sink" });
    setNodeConfig(doc, agent.id, "prompt", "Review carefully");
    connect(doc, source.id, agent.id, { idGen });
    connect(doc, agent.id, memory.id, { idGen });
    connect(doc, agent.id, sink.id, { idGen });

    const config = toAgentConfig(doc);
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0]).toMatchObject({
      id: agent.id,
      name: "Reviewer",
      prompt: "Review carefully",
      sources: [{ id: source.id, label: "PRs" }],
      sinks: [{ id: sink.id, label: "Review sink" }],
    });
    expect(config.agents[0]?.memory.map((entry) => entry.id)).toEqual([memory.id]);
  });

  it("ignores unwired nodes", () => {
    const doc = createDoc();
    createNode(doc, "source", { x: 0, y: 0 }, { idGen });
    const config = toAgentConfig(doc);
    expect(config.agents).toEqual([]);
  });
});
