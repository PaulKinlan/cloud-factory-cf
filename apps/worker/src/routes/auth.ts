import type { Env } from "../env";
import { sameSecret } from "../secrets";

export const AUTH_LOGIN_PATH = "/auth/github/login";
export const AUTH_CALLBACK_PATH = "/auth/github/callback";
export const API_REPOS_PATH = "/api/repos";

async function signHmacSha256(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getCookie(headers: Headers, name: string): string | null {
  const cookie = headers.get("cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Ensures return_to / redirect_uri is strictly a relative path on the same origin.
 * Rejects off-origin targets, protocol-relative URLs (//...), and backslashes,
 * falling back to "/" on any mismatch or malformed target.
 */
export function sanitizeReturnTo(target: string | null | undefined, origin: string): string {
  if (!target || typeof target !== "string") {
    return "/";
  }

  const trimmed = target.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("/\\") || trimmed.includes("\\")) {
    return "/";
  }

  let candidate: string | null = null;
  if (trimmed.startsWith("/")) {
    try {
      const parsed = new URL(trimmed, origin);
      if (parsed.origin === origin) {
        candidate = parsed.pathname + parsed.search + parsed.hash;
      }
    } catch {
      return "/";
    }
  } else {
    try {
      const parsed = new URL(trimmed);
      if (parsed.origin === origin) {
        candidate = parsed.pathname + parsed.search + parsed.hash;
      }
    } catch {
      return "/";
    }
  }

  if (!candidate) return "/";

  // Ensure candidate never starts with '//' or '/\' or contains backslashes
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.startsWith("/\\") || candidate.includes("\\")) {
    return "/";
  }

  try {
    const check = new URL(candidate, origin);
    if (check.origin !== origin) return "/";
  } catch {
    return "/";
  }

  return candidate;
}

export async function handleAuth(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === AUTH_LOGIN_PATH) {
    return handleGithubLogin(request, env, url);
  }

  if (url.pathname === AUTH_CALLBACK_PATH) {
    return handleGithubCallback(request, env, url);
  }

  if (url.pathname === API_REPOS_PATH) {
    return handleApiRepos(request, env, url);
  }

  return null;
}

export async function handleGithubLogin(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const signingKey = env.BROKER_SIGNING_KEY ?? env.BROKER_CONTROL_KEY ?? env.WEBHOOK_SECRET;
  if (!signingKey) {
    return Response.json({ ok: false, error: "broker signing key not configured" }, { status: 503 });
  }

  const clientId = url.searchParams.get("client_id") ?? env.GITHUB_CLIENT_ID;
  const appSlug = url.searchParams.get("app_slug") ?? env.GITHUB_APP_SLUG;
  const stateNonce = crypto.randomUUID().replace(/-/g, "");
  const redirectUri = url.searchParams.get("redirect_uri");

  const exp = Math.floor(Date.now() / 1000) + 600; // 10 minutes
  const dataToSign = `${stateNonce}.${exp}`;
  const sig = await signHmacSha256(signingKey, dataToSign);
  const cookieVal = `${dataToSign}.${sig}`;

  const isSecure = url.protocol === "https:";
  const stateCookie = `cf_oauth_state=${encodeURIComponent(cookieVal)}; HttpOnly; ${isSecure ? "Secure; " : ""}SameSite=Lax; Path=/auth/github; Max-Age=600`;

  const callbackUrl = new URL(AUTH_CALLBACK_PATH, url.origin);
  if (redirectUri) {
    const safeReturnTo = sanitizeReturnTo(redirectUri, url.origin);
    callbackUrl.searchParams.set("return_to", safeReturnTo);
  }

  // 1. If App installation flow is requested and slug is known, route to GitHub App install
  const flow = url.searchParams.get("flow");
  if (flow === "install" && appSlug) {
    const installUrl = `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new?state=${encodeURIComponent(stateNonce)}`;
    return new Response(null, {
      status: 302,
      headers: {
        location: installUrl,
        "set-cookie": stateCookie,
      },
    });
  }

  // 2. Standard OAuth authorization flow
  if (!clientId) {
    return Response.json(
      {
        ok: false,
        error: "GitHub Client ID is not configured (set GITHUB_CLIENT_ID or supply ?client_id=...)",
      },
      { status: 503 },
    );
  }

  const oauthUrl = new URL("https://github.com/login/oauth/authorize");
  oauthUrl.searchParams.set("client_id", clientId);
  oauthUrl.searchParams.set("redirect_uri", callbackUrl.toString());
  oauthUrl.searchParams.set("scope", "repo,read:org");
  oauthUrl.searchParams.set("state", stateNonce);

  return new Response(null, {
    status: 302,
    headers: {
      location: oauthUrl.toString(),
      "set-cookie": stateCookie,
    },
  });
}

export async function handleGithubCallback(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const signingKey = env.BROKER_SIGNING_KEY ?? env.BROKER_CONTROL_KEY ?? env.WEBHOOK_SECRET;
  if (!signingKey) {
    return Response.json({ ok: false, error: "broker signing key not configured" }, { status: 503 });
  }

  const isSecure = url.protocol === "https:";
  const clearCookie = `cf_oauth_state=; HttpOnly; ${isSecure ? "Secure; " : ""}SameSite=Lax; Path=/auth/github; Max-Age=0`;

  const code = url.searchParams.get("code");
  const installationId = url.searchParams.get("installation_id");
  const state = url.searchParams.get("state");
  const returnTo = sanitizeReturnTo(url.searchParams.get("return_to"), url.origin);

  // If no code and no installationId, user cancelled or error
  if (!code && !installationId) {
    const errorDesc = url.searchParams.get("error_description") ?? "No authorization code provided";
    return Response.json({ ok: false, error: errorDesc }, { status: 400, headers: { "set-cookie": clearCookie } });
  }

  // OAuth code exchange requires strict CSRF verification via state parameter + signed cookie.
  // When code is present, or when a state cookie is attached, enforce state verification.
  const cookieVal = getCookie(request.headers, "cf_oauth_state");
  if (code || cookieVal) {
    if (!state) {
      return Response.json(
        { ok: false, error: "Missing required OAuth state parameter" },
        { status: 400, headers: { "set-cookie": clearCookie } },
      );
    }

    if (!cookieVal) {
      return Response.json(
        { ok: false, error: "Missing OAuth state cookie" },
        { status: 400, headers: { "set-cookie": clearCookie } },
      );
    }

    const parts = cookieVal.split(".");
    if (parts.length !== 3) {
      return Response.json(
        { ok: false, error: "Malformed OAuth state cookie" },
        { status: 400, headers: { "set-cookie": clearCookie } },
      );
    }

    const [cookieNonce, expStr, sig] = parts as [string, string, string];
    const dataToSign = `${cookieNonce}.${expStr}`;
    const expectedSig = await signHmacSha256(signingKey, dataToSign);

    if (!(await sameSecret(expectedSig, sig))) {
      return Response.json(
        { ok: false, error: "Invalid OAuth state signature" },
        { status: 400, headers: { "set-cookie": clearCookie } },
      );
    }

    const exp = parseInt(expStr, 10);
    if (isNaN(exp) || Math.floor(Date.now() / 1000) > exp) {
      return Response.json(
        { ok: false, error: "OAuth state expired" },
        { status: 400, headers: { "set-cookie": clearCookie } },
      );
    }

    if (!(await sameSecret(cookieNonce, state))) {
      return Response.json(
        { ok: false, error: "OAuth state mismatch (CSRF detected)" },
        { status: 400, headers: { "set-cookie": clearCookie } },
      );
    }
  }

  const clientId = url.searchParams.get("client_id") ?? env.GITHUB_CLIENT_ID ?? "github_app_client_id";
  const clientSecret = url.searchParams.get("client_secret") ?? env.GITHUB_CLIENT_SECRET ?? "github_app_client_secret";
  let accessToken: string | null = null;

  // 1. Exchange code for user access token if code is present
  if (code && clientId && clientSecret) {
    try {
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "CloudFactory-Auth",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
        }),
      });

      if (tokenRes.ok) {
        const tokenData = (await tokenRes.json().catch(() => ({}))) as Record<string, unknown>;
        if (typeof tokenData["access_token"] === "string") {
          accessToken = tokenData["access_token"];
        }
      }
    } catch {
      // Token exchange failed; proceed if installationId is present
    }
  }

  let accountLogin = "unknown";
  let accountType = "User";
  const discoveredRepos: Array<{ fullName: string; owner: string; name: string; private: boolean; defaultBranch: string }> = [];

  // 2. If access token available, query GitHub API for user & repos
  if (accessToken) {
    try {
      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "CloudFactory-Auth",
        },
      });

      if (userRes.ok) {
        const userData = (await userRes.json()) as any;
        accountLogin = userData.login ?? "unknown";
        accountType = userData.type ?? "User";
      }

      const reposRes = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "CloudFactory-Auth",
        },
      });

      if (reposRes.ok) {
        const reposData = (await reposRes.json()) as any[];
        if (Array.isArray(reposData)) {
          for (const r of reposData) {
            if (r.full_name) {
              discoveredRepos.push({
                fullName: r.full_name,
                owner: r.owner?.login ?? accountLogin,
                name: r.name,
                private: Boolean(r.private),
                defaultBranch: r.default_branch ?? "main",
              });
            }
          }
        }
      }
    } catch {
      // Upstream GitHub fetch error
    }
  }

  // 3. Persist authorized repositories into OrgCoordinator DO
  if (accountLogin !== "unknown" && env.ORG_COORDINATOR) {
    const orgCoordinator = env.ORG_COORDINATOR.get(env.ORG_COORDINATOR.idFromName(accountLogin));
    await orgCoordinator.fetch("https://org-coordinator.internal/installations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installationId: installationId || undefined,
        accountLogin,
        accountType,
        repos: discoveredRepos,
      }),
    });
  }

  // 4. Redirect user back to the application canvas
  const redirectUrl = new URL(returnTo, url.origin);
  if (redirectUrl.origin !== url.origin) {
    redirectUrl.href = new URL("/", url.origin).href;
  }
  redirectUrl.searchParams.set("connected", "1");
  if (accountLogin !== "unknown") {
    redirectUrl.searchParams.set("owner", accountLogin);
  }
  if (installationId) {
    redirectUrl.searchParams.set("installation_id", installationId);
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: redirectUrl.toString(),
      "set-cookie": clearCookie,
    },
  });
}

export async function handleApiRepos(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const controlKey = env.BROKER_CONTROL_KEY;
  if (!controlKey) {
    return Response.json({ ok: false, error: "control key not configured" }, { status: 503 });
  }

  const presented = request.headers.get("x-factory-control-key");
  if (!(await sameSecret(controlKey, presented))) {
    return Response.json({ ok: false, error: "not authorised to access repository metadata" }, { status: 401 });
  }

  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }

  const owner = url.searchParams.get("owner");
  if (!owner) {
    return Response.json(
      { ok: false, error: "Missing required query parameter ?owner=<login>" },
      { status: 400 },
    );
  }

  if (!env.ORG_COORDINATOR) {
    return Response.json({ ok: false, error: "OrgCoordinator is not configured" }, { status: 503 });
  }

  const orgCoordinator = env.ORG_COORDINATOR.get(env.ORG_COORDINATOR.idFromName(owner));
  const reposRes = await orgCoordinator.fetch("https://org-coordinator.internal/repos");
  const data = await reposRes.json();

  return Response.json(data, { status: reposRes.status });
}
