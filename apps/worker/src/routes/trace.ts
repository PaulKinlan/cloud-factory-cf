import type { Env } from "../env";
import { sameSecret } from "../secrets";
import { getRepoCoordinator } from "../repo-coordinator-addressing";
import { readSession } from "./auth";

/**
 * Public surface for the observability suite (cloud-factory-cf-2ng).
 *
 *   GET /trace/:owner/:repo            recent ordered steps (optionally ?deliveryId=)
 *   GET /trace/:owner/:repo/usage      cost HUD aggregates (tokens are estimates)
 *   GET /trace/:owner/:repo/socket     live step stream (WebSocket upgrade)
 *   GET /trace/:owner/:repo/connect    webhook connection evidence (ping/event)
 *
 * Most of these are control-plane reads requiring the broker control key (x-factory-control-key
 * or ?key= for WebSocket handshakes) because a trace carries prompts and agent output.
 * GET /trace/:owner/:repo/connect also accepts an authenticated browser session cookie (cf_session),
 * allowing logged-in dashboard users to verify their repository webhook connection without
 * needing the broker control key.
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
  let authorised = false;

  // 1. Machine callers or operators presenting control key
  const provided = request.headers.get("x-factory-control-key") ?? (operation === "socket" ? url.searchParams.get("key") : null);
  if (provided) {
    if (!controlKey) {
      return Response.json({ ok: false, error: "control key not configured" }, { status: 503 });
    }
    if (await sameSecret(controlKey, provided)) authorised = true;
  }

  // 2. Browser session auth for operation === "connect" (cloud-factory-cf-qdud)
  if (!authorised && operation === "connect") {
    const signingKey = env.BROKER_SIGNING_KEY ?? env.BROKER_CONTROL_KEY;
    if (signingKey) {
      const session = await readSession(request.headers, signingKey);
      if (session.ok) {
        if (owner && owner.toLowerCase() !== session.login.toLowerCase()) {
          return Response.json(
            { ok: false, error: "not authorised to read another account's connection status" },
            { status: 403 },
          );
        }
        authorised = true;
      }
    }
  }

  if (!authorised) {
    if (!controlKey) {
      return Response.json({ ok: false, error: "control key not configured" }, { status: 503 });
    }
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
