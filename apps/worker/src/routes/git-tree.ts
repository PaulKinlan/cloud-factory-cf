import type { Env } from "../env";
import { getRepoCoordinator } from "../repo-coordinator-addressing";
import { authorizeControlPlane, authzDenial, sessionMayAddressPlatform } from "../auth/tenant";
import { MAX_PATH_BYTES, MAX_TREE_BYTES } from "../git-tree-store";
import { tarballFiles } from "../git-tarball";

async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!body) throw new Error("missing body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("payload exceeds size limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/**
 * Normalise the file path taken from the URL, or refuse it.
 *
 * The coordinator's store validates the path it is handed (git-tree-store.ts validPath), so a
 * traversal does not currently get through - but the edge is the security boundary and must
 * not forward a traversal-shaped path in the hope that the other side catches it, which is
 * cloud-factory-cf-r9eu. Decoding here also turns a malformed escape (`%zz`) into a 400
 * instead of an exception thrown inside the Durable Object, and re-encoding makes the
 * forwarded URL unambiguous (a `?` in a file name stays a file name, not a query).
 */
function safeRelativePath(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.length === 0 || new TextEncoder().encode(decoded).length > MAX_PATH_BYTES) return null;
  if (decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")) return null;
  if (decoded.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return decoded;
}

const PATH = /^\/analysis\/([^/]+)\/([^/]+)\/tree(?:\/files\/(.+))?$/;

/**
 * Authenticated, provider-independent tree ingestion; no GitHub API/token is needed.
 *
 * Ingestion writes into one repository's coordinator, so the caller needs the control
 * key (machine) or a browser session for that repository's owner
 * (cloud-factory-cf-e1ql).
 */
export async function handleGitTree(request: Request, env: Env, url: URL): Promise<Response | null> {
  const match = PATH.exec(url.pathname);
  if (!match) return null;
  const [, owner, repo, path] = match;
  if (!owner || !repo) return new Response("not found", { status: 404 });
  const authz = await authorizeControlPlane(request, env, { owner });
  if (!authz.ok) {
    return authzDenial(authz, {
      "cross-tenant": "not authorised to ingest another account's repository tree",
    });
  }
  if (path ? request.method !== "GET" : !["GET", "POST"].includes(request.method)) {
    return new Response("method not allowed", { status: 405 });
  }
  if (request.method === "POST" && Number(request.headers.get("content-length")) > MAX_TREE_BYTES) {
    return Response.json({ ok: false, error: "tree exceeds size limit" }, { status: 413 });
  }
  const platform = url.searchParams.get("platform");
  // A platform hint addresses another provider, which is another tenant: a session may not
  // switch (cloud-factory-cf-fcwm), the machine key may.
  if (!sessionMayAddressPlatform(authz.principal, platform)) {
    return authzDenial(
      { ok: false, reason: "cross-tenant" },
      { "cross-tenant": "not authorised for another provider's tenancy" },
    );
  }
  const filePath = path === undefined ? null : safeRelativePath(path);
  if (path !== undefined && filePath === null) {
    return Response.json({ ok: false, error: "invalid path" }, { status: 400 });
  }
  const coordinator = getRepoCoordinator(env, `${owner}/${repo}`, platform);
  const target =
    filePath === null
      ? "/git-tree"
      : // Per segment: encodeURI would leave "?" and "#" alone, and they are exactly the
        // characters that would change the meaning of the forwarded URL.
        `/git-tree/files/${filePath.split("/").map(encodeURIComponent).join("/")}`;
  const query = path ? "" : url.search;
  let body: BodyInit | undefined;
  if (request.method === "POST") {
    let bytes: Uint8Array;
    try { bytes = await readBounded(request.body, MAX_TREE_BYTES); }
    catch { return Response.json({ ok: false, error: "payload exceeds size limit" }, { status: 413 }); }
    const contentType = request.headers.get("content-type")?.split(";")[0];
    if (contentType === "application/x-tar" || contentType === "application/gzip") {
      const revision = url.searchParams.get("revision");
      if (!revision) return Response.json({ ok: false, error: "tarball revision required" }, { status: 400 });
      try {
        if (contentType === "application/gzip") {
          bytes = await readBounded(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("gzip")), MAX_TREE_BYTES);
        }
        body = JSON.stringify({ source: "tarball", revision, files: tarballFiles(bytes) });
      } catch (error) { return Response.json({ ok: false, error: (error as Error).message }, { status: 400 }); }
    } else {
      body = new TextDecoder().decode(bytes);
    }
  }
  return coordinator.fetch(new Request(`https://repo-coordinator.internal${target}${query}`, {
    method: request.method === "POST" ? "PUT" : request.method,
    body,
  }));
}
