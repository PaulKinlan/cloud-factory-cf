import type { Env } from "../env";
import { getRepoCoordinator } from "../repo-coordinator-addressing";
import {
  authorizeControlPlane,
  authzDenial,
  isReservedBrokerAddress,
  ROOT_SESSION_LOGIN,
  isRootLogin,
} from "../auth/tenant";
import { mintDelegation } from "../auth/delegation";
import { readSession } from "./auth";

export const ADMIN_SETTINGS_PATH = /^\/api\/admin\/settings\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/;
export const ADMIN_PING_PATH = /^\/api\/admin\/test-ping\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/;
export const ADMIN_USER_SETTINGS_PATH = /^\/api\/admin\/user-settings(?:\/(?<owner>[^/]+))?$/;
export const ADMIN_SYSTEM_PATH = "/api/admin/system";
export const ADMIN_SYSTEM_PING_PATH = "/api/admin/system/test-ping";

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

  // 2. /api/admin/system (Root System Settings)
  if (url.pathname === ADMIN_SYSTEM_PATH) {
    return routeAdminSystem(request, env);
  }

  // 3. /api/admin/system/test-ping (Root System Webhook Ping)
  if (url.pathname === ADMIN_SYSTEM_PING_PATH) {
    return routeAdminSystemTestPing(request, env, url);
  }

  // 4. /api/admin/user-settings and /api/admin/user-settings/:owner
  const userSettingsMatch = ADMIN_USER_SETTINGS_PATH.exec(url.pathname);
  if (userSettingsMatch) {
    const owner = userSettingsMatch.groups?.owner ?? url.searchParams.get("owner");
    return routeAdminUserSettings(request, env, owner, url.search);
  }

  // 5. /api/admin/settings/:owner/:repo
  const settingsMatch = ADMIN_SETTINGS_PATH.exec(url.pathname);
  if (settingsMatch?.groups) {
    const { owner, repo } = settingsMatch.groups as { owner: string; repo: string };
    return routeAdminSettings(request, env, owner, repo, url.search);
  }

  // 6. /api/admin/test-ping/:owner/:repo
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
  const authz = await authorizeControlPlane(request, env, { owner });
  if (!authz.ok) {
    return authzDenial(authz, {
      unauthorised: "not authorised to manage settings",
      "cross-tenant": "not authorised to manage settings for another account",
    });
  }

  const repository = `${owner}/${repo}`;
  const stub = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(repository));

  const headers = new Headers({ "content-type": "application/json" });
  const controlKey = request.headers.get("x-factory-control-key");
  if (controlKey !== null) {
    headers.set("x-factory-control-key", controlKey);
  } else if (authz.principal.via === "session") {
    const delegation = await mintDelegation(env, { repository, login: authz.principal.login });
    if (delegation) headers.set("x-factory-delegation", delegation);
  }

  let bodyText: string | undefined = undefined;
  if (request.method === "POST" || request.method === "DELETE") {
    bodyText = await request.text();
  }

  // If saving GitHub App settings, also mirror githubApp to default broker so 1-click OAuth works
  if (request.method === "POST" && bodyText) {
    try {
      const parsed = JSON.parse(bodyText) as { githubApp?: unknown };
      if (parsed.githubApp && typeof parsed.githubApp === "object" && env.CREDENTIAL_BROKER) {
        const defaultStub = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName("default"));
        const defaultHeaders = new Headers({ "content-type": "application/json" });
        if (env.BROKER_CONTROL_KEY) {
          defaultHeaders.set("x-factory-control-key", env.BROKER_CONTROL_KEY);
        } else if (authz.principal.via === "session") {
          const defaultDelegation = await mintDelegation(env, { repository: "default", login: authz.principal.login });
          if (defaultDelegation) defaultHeaders.set("x-factory-delegation", defaultDelegation);
        }
        await defaultStub.fetch("https://credential-broker.internal/settings", {
          method: "POST",
          headers: defaultHeaders,
          body: JSON.stringify({ githubApp: parsed.githubApp }),
        }).catch(() => null);
      }
    } catch {
      // Ignore JSON parse errors for mirror; primary DO will validate
    }
  }

  const forwarded = new Request(`https://credential-broker.internal/settings${search}`, {
    method: request.method,
    headers,
    body: bodyText,
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

  const authz = await authorizeControlPlane(request, env, { owner });
  if (!authz.ok) {
    return authzDenial(authz, {
      unauthorised: "not authorised to trigger test ping",
      "cross-tenant": "not authorised to trigger test ping for another account",
    });
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

export async function routeAdminSystem(
  request: Request,
  env: Env,
): Promise<Response> {
  const authz = await authorizeControlPlane(request, env);
  let isRoot = authz.ok && authz.principal.via === "control-key";

  if (authz.ok && authz.principal.via === "session") {
    const login = authz.principal.login;
    if (login === ROOT_SESSION_LOGIN || isRootLogin(login, env)) {
      isRoot = true;
    } else if (env.CREDENTIAL_BROKER) {
      // Check if session login is in default broker's platform.owners setting
      try {
        const defaultStub = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName("default"));
        const settingRes = await defaultStub.fetch("https://credential-broker.internal/internal-setting?key=platform.owners");
        if (settingRes.ok) {
          const data = (await settingRes.json().catch(() => null)) as { ok?: boolean; value?: string | null } | null;
          const owners = (data?.value || "")
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
          if (owners.includes(login.toLowerCase())) {
            isRoot = true;
          }
        }
      } catch {
        // ignore check failure
      }
    }
  }

  if (!isRoot) {
    return authzDenial(
      { ok: false, reason: "cross-tenant" },
      { "cross-tenant": "Root administrator privileges required" },
    );
  }

  if (!env.CREDENTIAL_BROKER) {
    return Response.json({ ok: false, error: "CredentialBroker is not configured" }, { status: 503 });
  }

  const defaultStub = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName("default"));
  const headers = new Headers({ "content-type": "application/json" });
  if (env.BROKER_CONTROL_KEY) {
    headers.set("x-factory-control-key", env.BROKER_CONTROL_KEY);
  } else if (authz.ok && authz.principal.via === "session") {
    const delegation = await mintDelegation(env, { repository: "default", login: authz.principal.login });
    if (delegation) headers.set("x-factory-delegation", delegation);
  }

  let bodyText: string | undefined = undefined;
  if (request.method === "POST" || request.method === "DELETE") {
    bodyText = await request.text();
  }

  const forwarded = new Request(`https://credential-broker.internal/settings`, {
    method: request.method,
    headers,
    body: bodyText,
  });

  return defaultStub.fetch(forwarded);
}

export async function routeAdminSystemTestPing(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const authz = await authorizeControlPlane(request, env);
  let isRoot = authz.ok && authz.principal.via === "control-key";
  if (authz.ok && authz.principal.via === "session") {
    const login = authz.principal.login;
    if (login === ROOT_SESSION_LOGIN || isRootLogin(login, env)) isRoot = true;
  }

  if (!isRoot) {
    return authzDenial(
      { ok: false, reason: "cross-tenant" },
      { "cross-tenant": "Root administrator privileges required" },
    );
  }

  let secret: string | undefined = undefined;
  if (env.CREDENTIAL_BROKER) {
    try {
      const defaultStub = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName("default"));
      const res = await defaultStub.fetch("https://credential-broker.internal/effective-webhook-secret");
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { secret?: string };
        if (typeof data.secret === "string" && data.secret.length > 0) secret = data.secret;
      }
    } catch {
      // ignore
    }
  }

  if (!secret) secret = env.WEBHOOK_SECRET;

  if (!secret) {
    return Response.json(
      { ok: false, error: "System webhook secret is not configured" },
      { status: 503 },
    );
  }

  const deliveryId = `sys-ping-${crypto.randomUUID().slice(0, 8)}`;
  const payload = JSON.stringify({
    zen: "Encourage kindness and clear boundaries.",
    hook_id: 99999999,
    hook: {
      type: "App",
      id: 99999999,
      name: "system-webhook",
      active: true,
      events: ["ping", "push", "pull_request"],
      config: {
        content_type: "json",
        url: `${url.origin}/webhooks/github`,
        insecure_ssl: "0",
      },
    },
    sender: { login: "root-admin" },
  });

  const signature = await signHmacSha256(secret, payload);
  const coordinator = getRepoCoordinator(env, "system/health", "github");
  const webhookReq = new Request("https://repo-coordinator.internal/events?provider=github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-factory-repository": "system/health",
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
    message: ok ? "System webhook test ping verified by RepoCoordinator" : "System webhook test ping rejected",
  });
}

export async function routeAdminUserSettings(
  request: Request,
  env: Env,
  ownerParam?: string | null,
  search = "",
): Promise<Response> {
  let owner = ownerParam?.trim();
  if (!owner) {
    const signingKey = env.BROKER_SIGNING_KEY ?? env.BROKER_CONTROL_KEY;
    if (signingKey) {
      const session = await readSession(request.headers, signingKey);
      if (session.ok) owner = session.login;
    }
  }

  if (!owner) {
    return Response.json({ ok: false, error: "owner / account parameter or active session required" }, { status: 400 });
  }

  const authz = await authorizeControlPlane(request, env, { owner });
  if (!authz.ok) {
    return authzDenial(authz, {
      unauthorised: "not authorised to manage user settings",
      "cross-tenant": "not authorised to manage settings for another user",
    });
  }

  if (!env.CREDENTIAL_BROKER) {
    return Response.json({ ok: false, error: "CredentialBroker is not configured" }, { status: 503 });
  }

  const targetRepo = owner.toLowerCase();

  // A login that collides with a reserved broker scope would be delegated the PLATFORM
  // settings (github.private_key, webhook.secret, platform.owners) instead of its own
  // (cloud-factory-cf-htc0), so refuse it before any stub or delegation is made.
  if (isReservedBrokerAddress(targetRepo)) {
    return Response.json(
      {
        ok: false,
        error: `"${targetRepo}" is a reserved broker scope, not a user login, and cannot hold per-user settings`,
      },
      { status: 403 },
    );
  }

  const brokerStub = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(targetRepo));
  const headers = new Headers({ "content-type": "application/json" });

  const controlKey = request.headers.get("x-factory-control-key");
  if (controlKey !== null) {
    headers.set("x-factory-control-key", controlKey);
  } else if (authz.principal.via === "session") {
    const delegation = await mintDelegation(env, { repository: targetRepo, login: authz.principal.login });
    if (delegation) headers.set("x-factory-delegation", delegation);
  }

  let bodyText: string | undefined = undefined;
  if (request.method === "POST" || request.method === "DELETE") {
    bodyText = await request.text();
  }

  // Mirror to canonical casing broker if casing differs
  if (request.method === "POST" && bodyText && targetRepo !== owner) {
    try {
      const canonicalStub = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(owner));
      await canonicalStub.fetch("https://credential-broker.internal/settings", {
        method: "POST",
        headers,
        body: bodyText,
      }).catch(() => null);
    } catch {
      // ignore
    }
  }

  const forwarded = new Request(`https://credential-broker.internal/settings${search}`, {
    method: request.method,
    headers,
    body: bodyText,
  });

  return brokerStub.fetch(forwarded);
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
