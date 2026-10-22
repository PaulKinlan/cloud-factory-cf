import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const endpoint = "https://example.com/git-tree/acme/off-github-example?platform=gitlab";
const key = "test-control-key";
const tree = {
  source: "isomorphic-git",
  revision: "b7c20f0",
  files: [
    { path: "src/index.ts", size: 16, content: "export const x=1" },
    { path: "README.md", size: 6, content: "Hello!" },
  ],
};

function call(url = endpoint, method = "GET", body?: unknown, controlKey: string | null = key) {
  return SELF.fetch(url, {
    method,
    headers: controlKey === null ? {} : { "x-factory-control-key": controlKey },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("provider-independent git tree snapshot", () => {
  it("ingests a snapshot from isomorphic-git and lists paths with file content", async () => {
    const saved = await call(endpoint, "PUT", tree);
    expect(saved.status).toBe(201);
    await expect(saved.json()).resolves.toMatchObject({ ok: true, source: "isomorphic-git", count: 2 });

    const listed = await call(endpoint);
    await expect(listed.json()).resolves.toMatchObject({ ok: true, revision: tree.revision, count: 2, files: [
      { path: "README.md", size: 6 }, { path: "src/index.ts", size: 16 },
    ] });
    const filtered = await call(`${endpoint}&prefix=src/`);
    await expect(filtered.json()).resolves.toMatchObject({ count: 1, files: [{ path: "src/index.ts" }] });
    const file = await call("https://example.com/git-tree/acme/off-github-example/files/src%2Findex.ts?platform=gitlab");
    await expect(file.json()).resolves.toMatchObject({ ok: true, content: "export const x=1" });
  });

  it("rejects unauthorised ingestion and reads", async () => {
    expect((await call(endpoint, "PUT", tree, null)).status).toBe(401);
    expect((await call(endpoint, "GET", undefined, "bad")).status).toBe(401);
  });

  it("preserves the old snapshot when replacement validation fails", async () => {
    expect((await call(endpoint, "PUT", tree)).status).toBe(201);
    const invalid = { source: "tarball", revision: "v2", files: [{ path: "../secret", size: 0 }] };
    expect((await call(endpoint, "PUT", invalid)).status).toBe(400);
    await expect((await call(endpoint)).json()).resolves.toMatchObject({ revision: tree.revision, count: 2 });
  });

  it("ingests a raw tarball with no provider credentials", async () => {
    const bytes = new Uint8Array(2048);
    const header = bytes.subarray(0, 512);
    const encoder = new TextEncoder();
    header.set(encoder.encode("docs/hello.txt"));
    header.set(encoder.encode("00000000005\0"), 124);
    header.fill(32, 148, 156);
    header[156] = 48;
    const sum = header.reduce((value, byte) => value + byte, 0);
    header.set(encoder.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    bytes.set(encoder.encode("hello"), 512);
    const response = await SELF.fetch(`${endpoint}&revision=archive-1`, {
      method: "PUT", headers: { "x-factory-control-key": key, "content-type": "application/x-tar" }, body: bytes,
    });
    expect(response.status).toBe(201);
    await expect((await call(endpoint)).json()).resolves.toMatchObject({ source: "tarball", revision: "archive-1", count: 1, files: [{ path: "docs/hello.txt", size: 5 }] });
    expect((await SELF.fetch(`${endpoint}&revision=archive-2`, { method: "PUT", headers: { "x-factory-control-key": key, "content-type": "application/x-tar" }, body: new Uint8Array(512) })).status).toBe(400);
  });

  it("replaces the old snapshot with tarball-derived entries, without mixing paths", async () => {
    expect((await call(endpoint, "PUT", tree)).status).toBe(201);
    const tarballTree = { source: "tarball", revision: "release-1", files: [{ path: "new.txt", size: 3, content: "new" }] };
    expect((await call(endpoint, "PUT", tarballTree)).status).toBe(201);
    await expect((await call(endpoint)).json()).resolves.toMatchObject({ source: "tarball", revision: "release-1", count: 1, files: [{ path: "new.txt" }] });
    expect((await call("https://example.com/git-tree/acme/off-github-example/files/README.md?platform=gitlab")).status).toBe(404);
  });
});
