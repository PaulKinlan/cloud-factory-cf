import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
} from "../src/index.ts";

let counter = 0;
const idGen = () => `t${(counter += 1)}`;

describe("canvas doc", () => {
  it("adds nodes with kind defaults and a stable id prefix", () => {
    const doc = createDoc();
    const agent = createNode(doc, "agent", { x: 10.4, y: -20.6 }, { idGen });
    assert.equal(agent.id, "n-t1");
    assert.equal(agent.kind, "agent");
    assert.equal(agent.x, 10);
    assert.equal(agent.y, -21);
    assert.equal(agent.config["prompt"], "");
    assert.equal(doc.nodes.length, 1);
  });

  it("moves, renames and configures a node, refusing invalid values", () => {
    const doc = createDoc();
    const node = createNode(doc, "source", { x: 0, y: 0 }, { idGen });

    assert.equal(moveNode(doc, node.id, 40.7, 12.2), true);
    assert.equal(node.x, 41);
    assert.equal(node.y, 12);
    assert.equal(moveNode(doc, node.id, Number.NaN, 0), false);

    assert.equal(renameNode(doc, node.id, "  Push events  "), true);
    assert.equal(node.label, "Push events");
    assert.equal(renameNode(doc, node.id, "   "), false);

    assert.equal(setNodeConfig(doc, node.id, "event", "push"), true);
    assert.equal(node.config["event"], "push");
    assert.equal(setNodeConfig(doc, node.id, "unknownKey", "x"), false);
  });

  it("removes attached edges with the node", () => {
    const doc = createDoc();
    const source = createNode(doc, "source", { x: 0, y: 0 }, { idGen });
    const agent = createNode(doc, "agent", { x: 300, y: 0 }, { idGen });
    connect(doc, source.id, agent.id, { idGen });
    assert.equal(doc.edges.length, 1);

    assert.equal(removeNode(doc, source.id), true);
    assert.equal(doc.nodes.length, 1);
    assert.equal(doc.edges.length, 0);
    assert.equal(removeNode(doc, "missing"), false);
  });
});

describe("wiring rules", () => {
  it("routes sources to agents, agents to sinks/memory, memory back to agents", () => {
    const doc = createDoc();
    const source = createNode(doc, "source", { x: 0, y: 0 }, { idGen });
    const agent = createNode(doc, "agent", { x: 0, y: 200 }, { idGen });
    const memory = createNode(doc, "memory", { x: 0, y: 400 }, { idGen });
    const sink = createNode(doc, "sink", { x: 0, y: 600 }, { idGen });

    assert.equal(canConnect(doc, source.id, agent.id).ok, true);
    assert.equal(canConnect(doc, agent.id, sink.id).ok, true);
    assert.equal(canConnect(doc, agent.id, memory.id).ok, true);
    assert.equal(canConnect(doc, memory.id, agent.id).ok, true);

    assert.deepEqual(canConnect(doc, source.id, sink.id), { ok: false, reason: "not allowed" });
    assert.deepEqual(canConnect(doc, sink.id, agent.id), { ok: false, reason: "not allowed" });
    assert.deepEqual(canConnect(doc, memory.id, sink.id), { ok: false, reason: "not allowed" });
  });

  it("refuses self links, duplicates and unknown nodes", () => {
    const doc = createDoc();
    const agent = createNode(doc, "agent", { x: 0, y: 0 }, { idGen });
    const sink = createNode(doc, "sink", { x: 0, y: 200 }, { idGen });

    assert.deepEqual(canConnect(doc, agent.id, agent.id), { ok: false, reason: "self" });
    assert.deepEqual(canConnect(doc, agent.id, "nope"), { ok: false, reason: "unknown node" });

    const first = connect(doc, agent.id, sink.id, { idGen });
    assert.equal(first.ok, true);
    assert.deepEqual(connect(doc, agent.id, sink.id, { idGen }), { ok: false, reason: "duplicate" });
    assert.equal(doc.edges.length, 1);
  });
});

describe("view", () => {
  it("zooms around the cursor and clamps", () => {
    const doc = createDoc();
    doc.view = { x: 0, y: 0, zoom: 1 };

    zoomAt(doc, 2, { x: 100, y: 100 });
    assert.equal(doc.view.zoom, 2);
    // The point under the cursor stays at the same world position.
    assert.equal(doc.view.x, -100);
    assert.equal(doc.view.y, -100);

    zoomAt(doc, 100, { x: 0, y: 0 });
    assert.equal(doc.view.zoom, MAX_ZOOM);
    zoomAt(doc, 0.0001, { x: 0, y: 0 });
    assert.equal(doc.view.zoom, MIN_ZOOM);
  });
});

describe("persistence", () => {
  it("round-trips a document through serialize/parse", () => {
    counter = 0;
    const original = createSampleDoc({ idGen });
    const parsed = parseDoc(serialize(original));
    assert.notEqual(parsed, null);
    assert.equal(parsed?.nodes.length, original.nodes.length);
    assert.equal(parsed?.edges.length, original.edges.length);
    assert.deepEqual(parsed?.nodes.map((node) => node.kind).sort(), ["agent", "memory", "sink", "source"]);
  });

  it("rejects malformed or unsafe documents", () => {
    assert.equal(parseDoc("not json"), null);
    assert.equal(parseDoc(JSON.stringify({ version: 2, nodes: [], edges: [] })), null);
    assert.equal(parseDoc(JSON.stringify({ version: 1, nodes: "nope", edges: [] })), null);

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
    assert.deepEqual(cleaned?.nodes.map((node) => node.id), ["a", "c"]);
    assert.deepEqual(cleaned?.nodes[0]?.config, { prompt: "p" });
    assert.equal(cleaned?.edges.length, 1);
    assert.equal(cleaned?.view.zoom, MAX_ZOOM);
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
    assert.equal(config.agents.length, 1);
    assert.equal(config.agents[0]?.id, agent.id);
    assert.equal(config.agents[0]?.name, "Reviewer");
    assert.equal(config.agents[0]?.prompt, "Review carefully");
    assert.equal(config.agents[0]?.sources.length, 1);
    assert.equal(config.agents[0]?.sources[0]?.id, source.id);
    assert.equal(config.agents[0]?.sources[0]?.label, "PRs");
    assert.equal(config.agents[0]?.sinks.length, 1);
    assert.equal(config.agents[0]?.sinks[0]?.id, sink.id);
    assert.equal(config.agents[0]?.sinks[0]?.label, "Review sink");
    assert.deepEqual(config.agents[0]?.memory.map((entry) => entry.id), [memory.id]);
  });

  it("ignores unwired nodes", () => {
    const doc = createDoc();
    createNode(doc, "source", { x: 0, y: 0 }, { idGen });
    const config = toAgentConfig(doc);
    assert.deepEqual(config.agents, []);
  });
});
