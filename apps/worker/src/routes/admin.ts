import type { Env } from "../env";
import { sameSecret } from "../secrets";
import { getRepoCoordinator } from "../repo-coordinator-addressing";

export const ADMIN_SETTINGS_PATH = /^\/api\/admin\/settings\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/;
export const ADMIN_PING_PATH = /^\/api\/admin\/test-ping\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/;

export async function handleAdmin(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  // 1. Serve admin dashboard via ASSETS at /admin by fetching /admin/index.html (avoiding 307 redirect)
  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    if (!env.ASSETS) return new Response("not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    const assetUrl = new URL("/admin/index.html", request.url);
    const assetReq = new Request(assetUrl.toString(), request);
    return env.ASSETS.fetch(assetReq);
  }

  // 2. /api/admin/settings/:owner/:repo
  const settingsMatch = ADMIN_SETTINGS_PATH.exec(url.pathname);
  if (settingsMatch?.groups) {
    const { owner, repo } = settingsMatch.groups as { owner: string; repo: string };
    return routeAdminSettings(request, env, owner, repo, url.search);
  }

  // 3. /api/admin/test-ping/:owner/:repo
  const pingMatch = ADMIN_PING_PATH.exec(url.pathname);
  if (pingMatch?.groups) {
    const { owner, repo } = pingMatch.groups as { owner: string; repo: string };
    return routeAdminTestPing(request, env, owner, repo);
  }

  return null;
}

export async function routeAdminSettings(
  request: Request,
  env: Env,
  owner: string,
  repo: string,
  search = "",
): Promise<Response> {
  const repository = `${owner}/${repo}`;
  const stub = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(repository));

  const headers = new Headers({ "content-type": "application/json" });
  const controlKey = request.headers.get("x-factory-control-key");
  if (controlKey !== null) headers.set("x-factory-control-key", controlKey);

  const forwarded = new Request(`https://credential-broker.internal/settings${search}`, {
    method: request.method,
    headers,
    body: request.method === "POST" || request.method === "DELETE" ? await request.text() : undefined,
  });

  return stub.fetch(forwarded);
}

export async function routeAdminTestPing(
  request: Request,
  env: Env,
  owner: string,
  repo: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const controlKey = env.BROKER_CONTROL_KEY;
  if (!controlKey) {
    return Response.json({ ok: false, error: "broker control key not configured" }, { status: 503 });
  }
  const presented = request.headers.get("x-factory-control-key");
  if (!(await sameSecret(controlKey, presented))) {
    return Response.json({ ok: false, error: "not authorised to trigger test ping" }, { status: 401 });
  }

  const repository = `${owner}/${repo}`;
  let secret: string | undefined = undefined;

  const broker = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(repository));
  try {
    const secretRes = await broker.fetch("https://credential-broker.internal/effective-webhook-secret");
    if (secretRes.ok) {
      const data = (await secretRes.json().catch(() => ({}))) as { secret?: string };
      if (typeof data.secret === "string" && data.secret.length > 0) {
        secret = data.secret;
      }
    }
  } catch {
    // Fall back to env.WEBHOOK_SECRET
  }

  if (!secret) {
    secret = env.WEBHOOK_SECRET;
  }

  if (!secret) {
    return Response.json(
      { ok: false, error: "webhook secret not configured for this repository or deployment" },
      { status: 503 },
    );
  }

  const deliveryId = `test-ping-${crypto.randomUUID().slice(0, 8)}`;
  const payload = JSON.stringify({
    zen: "Keep it logically awesome.",
    hook_id: 12345678,
    hook: {
      type: "Repository",
      id: 12345678,
      name: "web",
      active: true,
      events: ["push", "pull_request"],
      config: {
        content_type: "json",
        url: `https://example.com/webhooks/github/${repository}`,
        insecure_ssl: "0",
      },
    },
    repository: {
      full_name: repository,
      owner: { login: owner },
      name: repo,
    },
    sender: { login: "admin-dashboard" },
  });

  const signature = await signHmacSha256(secret, payload);

  const url = new URL(request.url);
  const platform = url.searchParams.get("platform");
  const coordinator = getRepoCoordinator(env, repository, platform);
  const webhookReq = new Request("https://repo-coordinator.internal/events?provider=github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-factory-repository": repository,
      "x-github-event": "ping",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
    },
    body: payload,
  });

  const webhookRes = await coordinator.fetch(webhookReq);
  const ok = webhookRes.ok || webhookRes.status === 202;

  return Response.json({
    ok,
    status: webhookRes.status,
    deliveryId,
    repository,
    message: ok ? "Test ping delivered and verified by RepoCoordinator" : "Test ping rejected by RepoCoordinator",
  });
}

async function signHmacSha256(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return `sha256=${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
