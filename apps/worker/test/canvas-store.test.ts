import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_DOCUMENT_BYTES, MAX_NODES } from "../src/canvas-store";

/**
 * Canvas documents are stored in the repository's coordinator object and served
 * through `/canvas/:owner/:repo/documents`, on the control key. The document is
 * the same JSON the canvas exports, so a stored layout can be loaded again.
 */
const CONTROL_KEY = "test-control-key";
const REPOSITORY = "acme/canvas-docs";

const document = {
  version: 1,
  nodes: [
    { id: "n-1", kind: "source", label: "Pull requests", x: -360, y: -40, config: { provider: "github", event: "pull_request" } },
    { id: "n-2", kind: "agent", label: "PR reviewer", x: -40, y: -40, config: { prompt: "review", model: "deepseek/deepseek-flash" } },
  ],
  edges: [{ id: "e-1", from: "n-1", to: "n-2" }],
  view: { x: 0, y: 0, zoom: 1 },
};

async function canvasFetch(
  path: string,
  init: { method?: string; body?: unknown; controlKey?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.controlKey !== null) headers["x-factory-control-key"] = init.controlKey ?? CONTROL_KEY;
  return SELF.fetch(`https://example.com/canvas/${REPOSITORY}/documents${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

describe("canvas document store", () => {
  it("round-trips a document with its layout", async () => {
    const created = await canvasFetch("", {
      method: "PUT",
      body: { name: "PR review layout", document },
    });
    expect(created.status).toBe(201);
    const createdPayload = (await created.json()) as { ok: boolean; id: string; name: string; created: boolean };
    expect(createdPayload).toMatchObject({ ok: true, name: "PR review layout", created: true });
    expect(createdPayload.id).toBeTypeOf("string");

    const fetched = await canvasFetch(`/${createdPayload.id}`);
    expect(fetched.status).toBe(200);
    await expect(fetched.json()).resolves.toMatchObject({
      ok: true,
      id: createdPayload.id,
      name: "PR review layout",
      document,
    });

    // A second PUT to the same id updates in place instead of duplicating.
    const updated = await canvasFetch(`/${createdPayload.id}`, {
      method: "PUT",
      body: { name: "PR review layout v2", document: { ...document, nodes: [...document.nodes] } },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ created: false, name: "PR review layout v2" });

    const listed = await canvasFetch("");
    const listPayload = (await listed.json()) as { count: number; documents: Array<{ id: string; name: string }> };
    expect(listPayload.count).toBe(1);
    expect(listPayload.documents[0]).toMatchObject({ id: createdPayload.id, name: "PR review layout v2" });
  });

  it("requires the control key for reads and writes", async () => {
    for (const init of [
      { controlKey: null },
      { controlKey: "wrong" },
      { controlKey: null, method: "PUT", body: { document } },
      { controlKey: "wrong", method: "DELETE" },
    ]) {
      const response = await canvasFetch("", init as { method?: string; body?: unknown; controlKey?: string | null });
      expect(response.status).toBe(401);
    }
  });

  it("refuses a document the canvas could not load", async () => {
    const cases: Array<[unknown, string]> = [
      [undefined, "document must be an object"],
      [{ version: 2, nodes: [], edges: [] }, "unsupported document version"],
      [{ version: 1, nodes: "nope", edges: [] }, "document needs nodes and edges arrays"],
      [{ version: 1, nodes: [], edges: {} }, "document needs nodes and edges arrays"],
      [{ version: 1, nodes: Array.from({ length: MAX_NODES + 1 }, () => ({})), edges: [] }, `document has more than ${MAX_NODES} nodes`],
      [{ version: 1, nodes: [], edges: [], pad: "x".repeat(MAX_DOCUMENT_BYTES) }, `document is larger than ${MAX_DOCUMENT_BYTES} bytes`],
    ];
    for (const [candidate, error] of cases) {
      const response = await canvasFetch("", { method: "PUT", body: { document: candidate } });
      expect(response.status, `PUT ${JSON.stringify(candidate)?.slice(0, 60)}`).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ ok: false, error });
    }

    const longName = await canvasFetch("", { method: "PUT", body: { name: "n".repeat(200), document } });
    expect(longName.status).toBe(400);
  });

  it("404s an unknown document and a second delete", async () => {
    expect((await canvasFetch("/nope")).status).toBe(404);

    const created = (await (
      await canvasFetch("", { method: "PUT", body: { name: "Temporary", document } })
    ).json()) as { id: string };

    const deleted = await canvasFetch(`/${created.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ ok: true, id: created.id });

    expect((await canvasFetch(`/${created.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await canvasFetch(`/${created.id}`)).status).toBe(404);
  });

  it("rejects methods it does not implement", async () => {
    const response = await canvasFetch("", { method: "POST", body: { document } });
    expect(response.status).toBe(405);
  });

  it("stores and retrieves documents with percent characters in the id without double-encoding (cloud-factory-cf-r8gn)", async () => {
    const customId = "a%2Fb";
    const encodedId = encodeURIComponent(customId); // "a%252Fb"

    const created = await canvasFetch(`/${encodedId}`, {
      method: "PUT",
      body: { name: "Percent ID doc", document },
    });
    expect(created.status).toBe(201);
    const createdPayload = (await created.json()) as any;
    expect(createdPayload.ok).toBe(true);
    expect(createdPayload.id).toBe(customId);

    const fetched = await canvasFetch(`/${encodedId}`);
    expect(fetched.status).toBe(200);
    const fetchedPayload = (await fetched.json()) as any;
    expect(fetchedPayload.ok).toBe(true);
    expect(fetchedPayload.id).toBe(customId);

    const listed = await canvasFetch("");
    const listPayload = (await listed.json()) as any;
    const item = listPayload.documents.find((d: any) => d.id === customId);
    expect(item).toBeDefined();
    expect(item.id).toBe(customId);
  });
});
