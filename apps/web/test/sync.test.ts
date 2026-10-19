import { describe, expect, it } from "vitest";
import { createSampleDoc } from "../src/model";
import {
  createShareTracker,
  describeShareFailure,
  documentRequest,
  isValidRepository,
  listRequest,
  parseDocumentList,
  parseShareHint,
  parseStoredDocument,
  planSave,
  saveRequest,
} from "../src/sync";

const target = { repository: "acme/widgets", controlKey: "test-control-key" };
const origin = "https://factory.example.com/";

describe("share requests", () => {
  it("builds a save request with the exported document and the control key header", () => {
    const document = createSampleDoc({ idGen: (() => { let n = 0; return () => `s${(n += 1)}`; })() });
    const request = saveRequest(origin, target, document, { name: "  PR review  " });

    expect("error" in request).toBe(false);
    if ("error" in request) return;

    expect(request.url).toBe("https://factory.example.com/canvas/acme/widgets/documents");
    expect(request.init.method).toBe("PUT");
    const headers = request.init.headers as Record<string, string>;
    expect(headers["x-factory-control-key"]).toBe("test-control-key");

    const body = JSON.parse(String(request.init.body)) as { name: string; document: { version: number; nodes: unknown[] } };
    expect(body.name).toBe("PR review");
    expect(body.document.version).toBe(1);
    expect(body.document.nodes).toHaveLength(4);
  });

  it("addresses an existing document by id", () => {
    const request = saveRequest(origin, target, createSampleDoc(), { id: "doc-1" });
    if ("error" in request) throw new Error(request.error);
    expect(request.url).toBe("https://factory.example.com/canvas/acme/widgets/documents/doc-1");
  });

  it("refuses a malformed repository or a missing key instead of calling the API", () => {
    const document = createSampleDoc();
    expect(saveRequest(origin, { repository: "acme", controlKey: "k" }, document)).toMatchObject({ error: expect.stringContaining("owner/name") });
    expect(saveRequest(origin, { repository: "acme/widgets", controlKey: "" }, document)).toMatchObject({ error: expect.stringContaining("control key") });
    expect(listRequest(origin, { repository: "acme/widgets/extra", controlKey: "k" })).toMatchObject({ error: expect.stringContaining("owner/name") });
    expect(documentRequest(origin, target, "")).toMatchObject({ error: expect.stringContaining("document id") });
    expect(isValidRepository("acme/widgets")).toBe(true);
    expect(isValidRepository("acme/widgets/extra")).toBe(false);
  });

  it("lists and fetches with the control key and no body", () => {
    const list = listRequest(origin, target);
    if ("error" in list) throw new Error(list.error);
    expect(list.url).toBe("https://factory.example.com/canvas/acme/widgets/documents");
    expect(list.init.method).toBe("GET");
    expect(list.init.body).toBeUndefined();

    const one = documentRequest(origin, target, "doc 1");
    if ("error" in one) throw new Error(one.error);
    expect(one.url).toBe("https://factory.example.com/canvas/acme/widgets/documents/doc%201");
  });
});

describe("share responses", () => {
  it("parses a document list and drops entries without an id", () => {
    const parsed = parseDocumentList({
      ok: true,
      documents: [
        { id: "a", name: "Alpha", updatedAt: "2026-10-19T00:00:00Z" },
        { id: "", name: "Broken", updatedAt: "" },
        { name: "No id", updatedAt: "" },
      ],
    });
    expect(parsed).toEqual([{ id: "a", name: "Alpha", updatedAt: "2026-10-19T00:00:00Z" }]);
    expect(parseDocumentList({ ok: true })).toBeNull();
    expect(parseDocumentList("nope")).toBeNull();
  });

  it("validates a stored document through the canvas parser", () => {
    const document = createSampleDoc({ idGen: (() => { let n = 0; return () => `p${(n += 1)}`; })() });
    const ok = parseStoredDocument({ ok: true, name: "Server copy", document: JSON.parse(JSON.stringify(document)) });
    expect(ok?.name).toBe("Server copy");
    expect(ok?.document.nodes).toHaveLength(4);

    expect(parseStoredDocument({ ok: true, document: { version: 9, nodes: [], edges: [] } })).toBeNull();
    expect(parseStoredDocument({ ok: true })).toBeNull();
    expect(parseStoredDocument(null)).toBeNull();
  });

  it("explains failures without echoing the key", () => {
    expect(describeShareFailure(401, { error: "not authorised" })).toContain("Control key rejected");
    expect(describeShareFailure(503, {})).toContain("no control key configured");
    expect(describeShareFailure(409, { error: "repository already holds 200 documents" })).toContain("document limit");
    expect(describeShareFailure(400, { error: "unsupported document version" })).toContain("unsupported document version");
    expect(describeShareFailure(502, {})).toContain("document store failed");
    expect(describeShareFailure(418, {})).toContain("418");

    // Auth failures never echo the server text, so a key leaked into an error
    // body cannot end up in the UI.
    for (const status of [401, 403, 503]) {
      expect(describeShareFailure(status, { error: "test-control-key" })).not.toContain("test-control-key");
    }
    // Other messages are bounded, so a huge server error cannot flood the status.
    expect(describeShareFailure(400, { error: "x".repeat(500) }).length).toBeLessThan(200);
  });
});

describe("share tracker (cloud-factory-cf-ci5)", () => {
  it("keeps one document id per repository", () => {
    const tracker = createShareTracker();
    tracker.remember("owner/alpha", "alpha-1");
    expect(tracker.idFor("owner/alpha")).toBe("alpha-1");
    // A repository that has never been saved gets a fresh document, so Save
    // cannot update another repository's copy.
    expect(tracker.idFor("owner/beta")).toBeNull();
    tracker.remember("owner/beta", "beta-1");
    expect(tracker.idFor("owner/alpha")).toBe("alpha-1");
    expect(tracker.idFor("owner/beta")).toBe("beta-1");
  });

  it("normalises whitespace and ignores empty values", () => {
    const tracker = createShareTracker({ " owner/alpha ": "alpha-1", "owner/beta": "" });
    expect(tracker.idFor("owner/alpha")).toBe("alpha-1");
    expect(tracker.idFor("  owner/alpha  ")).toBe("alpha-1");
    expect(tracker.idFor("owner/beta")).toBeNull();
    tracker.remember("", "ignored");
    expect(tracker.idFor("")).toBeNull();
    expect(tracker.toJSON()).toEqual({ ids: { "owner/alpha": "alpha-1" } });
  });

  it("forgets a repository without touching the others", () => {
    const tracker = createShareTracker({ "owner/alpha": "a", "owner/beta": "b" });
    tracker.forget("owner/alpha");
    expect(tracker.idFor("owner/alpha")).toBeNull();
    expect(tracker.idFor("owner/beta")).toBe("b");
  });

  it("reads the hint, and migrates the old single-repository shape", () => {
    expect(parseShareHint({ ids: { "owner/alpha": "a" }, name: "Layout" })).toEqual({
      ids: { "owner/alpha": "a" },
      name: "Layout",
    });
    expect(parseShareHint({ repository: "owner/alpha", id: "a" })).toEqual({ ids: { "owner/alpha": "a" } });
    expect(parseShareHint(null)).toEqual({ ids: {} });
    expect(parseShareHint({ ids: { "owner/alpha": 7 } })).toEqual({ ids: {} });
  });

  it("replays the reported repro: a second repository never reuses, or overwrites, the first id", () => {
    const tracker = createShareTracker();
    const doc = createSampleDoc();
    const target = (repository: string) => ({ repository, controlKey: "k" });
    const save = (repository: string, bound: string | null) => {
      const plan = planSave(tracker, bound, repository);
      return {
        plan,
        request: saveRequest("https://canvas.test", target(repository), doc, {
          ...(plan.id === null ? {} : { id: plan.id }),
          name: "Layout",
        }),
      };
    };

    // Save in alpha: no id yet, so the server assigns one.
    const first = save("owner/alpha", null);
    expect(first.plan).toEqual({ id: null, newCopy: false });
    expect("url" in first.request && first.request.url).toBe("https://canvas.test/canvas/owner/alpha/documents");
    tracker.remember("owner/alpha", "alpha-1");

    // Switch the repository field to beta and save: beta gets its own document.
    const second = save("owner/beta", "owner/alpha");
    expect(second.plan).toEqual({ id: null, newCopy: false });
    expect("url" in second.request && second.request.url).toBe("https://canvas.test/canvas/owner/beta/documents");
    tracker.remember("owner/beta", "beta-1");

    // Back to alpha while the canvas is still beta's: do not overwrite alpha.
    const third = save("owner/alpha", "owner/beta");
    expect(third.plan).toEqual({ id: null, newCopy: true });
    expect("url" in third.request && third.request.url).toBe("https://canvas.test/canvas/owner/alpha/documents");

    // Once a document is loaded from alpha, saving updates it in place.
    const fourth = save("owner/alpha", "owner/alpha");
    expect(fourth.plan).toEqual({ id: "alpha-1", newCopy: false });
    expect("url" in fourth.request && fourth.request.url).toBe(
      "https://canvas.test/canvas/owner/alpha/documents/alpha-1",
    );

    // A restored hint with no canvas binding still updates that repository's own id.
    expect(planSave(tracker, null, "owner/beta")).toEqual({ id: "beta-1", newCopy: false });
  });
});
