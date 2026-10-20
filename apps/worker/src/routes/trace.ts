import type { Env } from "../env";
import { sameSecret } from "../secrets";
import { getRepoCoordinator } from "../repo-coordinator-addressing";

/**
 * Public surface for the observability suite (cloud-factory-cf-2ng).
 *
 *   GET /trace/:owner/:repo            recent ordered steps (optionally ?deliveryId=)
 *   GET /trace/:owner/:repo/usage      cost HUD aggregates (tokens are estimates)
 *   GET /trace/:owner/:repo/socket     live step stream (WebSocket upgrade)
 *   GET /trace/:owner/:repo/connect    webhook connection evidence (ping/event)
 *
 * All of these are control-plane reads, so they require the broker control key: a
 * trace carries prompts and agent output, and the connection state says whether a
 * repository's hook is live, which must not be world-readable on a public Worker.
 */
export const TRACE_PATH =
  /^\/trace\/(?<owner>[^/]+)\/(?<repo>[^/]+)(?:\/(?<operation>usage|socket|connect))?$/;

export async function handleTrace(request: Request, env: Env, url: URL): Promise<Response | null> {
  const match = TRACE_PATH.exec(url.pathname);
  if (!match?.groups) return null;
  const { owner, repo, operation } = match.groups as {
    owner: string;
    repo: string;
    operation?: string;
  };

  const controlKey = env.BROKER_CONTROL_KEY;
  if (!controlKey) {
    return Response.json({ ok: false, error: "control key not configured" }, { status: 503 });
  }
  // A browser cannot set a header on a WebSocket handshake, so the socket accepts
  // the same key as a query parameter (over TLS) and nowhere else.
  const provided = request.headers.get("x-factory-control-key") ?? (operation === "socket" ? url.searchParams.get("key") : null);
  // Constant-time comparison, like every other control route: `!==` on a secret
  // leaks how much of a guess matched (rev-obs1, cloud-factory-cf-9t2).
  if (!(await sameSecret(controlKey, provided))) {
    return Response.json({ ok: false, error: "not authorised to read the execution trace" }, { status: 401 });
  }
  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }

  const platform = url.searchParams.get("platform");
  const stub = getRepoCoordinator(env, `${owner}/${repo}`, platform);
  if (operation === "socket") {
    // Hand the upgrade to the object and pass its 101 (and socket) straight back.
    // The object's own route is /trace/socket, so the public path is rewritten
    // rather than forwarded verbatim (a mismatch makes the handshake a 404).
    const limit = url.searchParams.get("limit");
    const forwarded = limit === null ? "" : `?limit=${encodeURIComponent(limit)}`;
    return stub.fetch(
      new Request(`https://repo-coordinator.internal/trace/socket${forwarded}`, {
        method: "GET",
        headers: request.headers,
      }),
    );
  }
  if (operation === "usage") {
    return stub.fetch("https://repo-coordinator.internal/trace/usage");
  }
  if (operation === "connect") {
    return stub.fetch("https://repo-coordinator.internal/connect");
  }
  const query = url.searchParams.toString();
  return stub.fetch(`https://repo-coordinator.internal/trace${query === "" ? "" : `?${query}`}`);
}
