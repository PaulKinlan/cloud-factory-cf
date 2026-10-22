import type { Env } from "../env";
import { getRepoCoordinator } from "../repo-coordinator-addressing";
import { sameSecret } from "../secrets";
import { MAX_TREE_BYTES } from "../git-tree-store";
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

const PATH = /^\/analysis\/([^/]+)\/([^/]+)\/tree(?:\/files\/(.+))?$/;

/** Authenticated, provider-independent tree ingestion; no GitHub API/token is needed. */
export async function handleGitTree(request: Request, env: Env, url: URL): Promise<Response | null> {
  const match = PATH.exec(url.pathname);
  if (!match) return null;
  const [, owner, repo, path] = match;
  if (!owner || !repo) return new Response("not found", { status: 404 });
  if (!env.BROKER_CONTROL_KEY) return Response.json({ ok: false, error: "control key not configured" }, { status: 503 });
  if (!(await sameSecret(env.BROKER_CONTROL_KEY, request.headers.get("x-factory-control-key")))) {
    return Response.json({ ok: false, error: "not authorised" }, { status: 401 });
  }
  if (path ? request.method !== "GET" : !["GET", "POST"].includes(request.method)) {
    return new Response("method not allowed", { status: 405 });
  }
  if (request.method === "POST" && Number(request.headers.get("content-length")) > MAX_TREE_BYTES) {
    return Response.json({ ok: false, error: "tree exceeds size limit" }, { status: 413 });
  }
  const coordinator = getRepoCoordinator(env, `${owner}/${repo}`, url.searchParams.get("platform"));
  const target = path ? `/git-tree/files/${path}` : "/git-tree";
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
