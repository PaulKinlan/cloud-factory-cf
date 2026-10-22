import type { Env } from "../env";

/**
 * Serves the built canvas from the ASSETS binding. Unknown paths stay a 404 (the
 * canvas is a single route at "/", so there is no SPA fallback to lean on) and
 * writes are refused for assets: only GET/HEAD pass through.
 */
export async function serveAsset(request: Request, env: Env): Promise<Response> {
  if (!env.ASSETS) return new Response("not found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  const url = new URL(request.url);
  const targetReq =
    url.pathname === "/"
      ? new Request(new URL("/index.html", request.url).toString(), request)
      : request;
  const asset = await env.ASSETS.fetch(targetReq);
  if (asset.status === 404) return new Response("not found", { status: 404 });
  return asset;
}
