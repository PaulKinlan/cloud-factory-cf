import type { Env } from "../env";

/**
 * Serves the built canvas from the ASSETS binding. Unknown paths stay a 404 (the
 * canvas is a single route at "/", so there is no SPA fallback to lean on) and
 * writes are refused for assets: only GET/HEAD pass through.
 *
 * Every response that leaves this route carries the deployment's security headers
 * (cloud-factory-cf-5np7). The asset layer is the one surface a browser renders as
 * markup, so it is the one that needs them: without `nosniff` and a policy, a file
 * served from this origin executes with the control plane's origin and cookies.
 */

/**
 * The policy the canvas is built to live under.
 *
 * Each allowance is a fact about `apps/web`, not a guess:
 * - `script-src 'self'`: the page has no inline `<script>` — `index.html` loads a
 *   module and the build emits `/assets/*.js`. No `'unsafe-eval'`: nothing calls
 *   `eval` or `new Function`.
 * - `style-src 'unsafe-inline'`: `index.html` sets inline `style="…"` attributes
 *   (dialog layout), and CSP treats style attributes as inline.
 * - `img-src data:`: the favicon is a `data:` SVG in the document head.
 * - `connect-src 'self' ws://<host> wss://<host>`: the observability panel streams the
 *   execution trace over a WebSocket on this origin. It names this deployment's own
 *   host rather than the `ws:` scheme because browsers do not all treat `'self'` as
 *   covering `ws` (so `'self'` alone would break the live stream in some of them), and
 *   a bare `ws:` would let an injected script reach any socket host.
 * - `frame-ancestors 'none'`: the canvas is not an embed target, so it cannot be
 *   clickjacked by one.
 */
export function assetContentSecurityPolicy(url: URL): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ws://${url.host} wss://${url.host}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Headers applied to every asset response, including the route's own 404/405. */
export function assetSecurityHeaders(url: URL): ReadonlyArray<readonly [string, string]> {
  return [
    ["content-security-policy", assetContentSecurityPolicy(url)],
    // The asset layer can serve types a browser would otherwise sniff into markup
    // (a `.txt` or a mislabelled upload), which makes this the interesting origin.
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", "strict-origin-when-cross-origin"],
    // The canvas and its API share an origin, and nothing here needs a device API.
    ["permissions-policy", "geolocation=(), microphone=(), camera=()"],
  ];
}

/** Copies a response with the security headers set, keeping the asset's own. */
function withSecurityHeaders(response: Response, url: URL): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of assetSecurityHeaders(url)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function serveAsset(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!env.ASSETS) return withSecurityHeaders(new Response("not found", { status: 404 }), url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withSecurityHeaders(new Response("method not allowed", { status: 405 }), url);
  }
  const targetReq =
    url.pathname === "/"
      ? new Request(new URL("/index.html", request.url).toString(), request)
      : request;
  const asset = await env.ASSETS.fetch(targetReq);
  if (asset.status === 404) return withSecurityHeaders(new Response("not found", { status: 404 }), url);
  return withSecurityHeaders(asset, url);
}
