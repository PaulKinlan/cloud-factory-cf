import type { Env } from "../env";
import { sameSecret } from "../secrets";
import { importAppPrivateKey, mintAppJwt } from "../github-app";

export const AUTH_LOGIN_PATH = "/auth/github/login";
export const AUTH_CALLBACK_PATH = "/auth/github/callback";
export const API_REPOS_PATH = "/api/repos";

/**
 * The browser's credential after a successful connect (cloud-factory-cf-d33).
 *
 * `/api/repos` used to be readable only with `x-factory-control-key`, which is a
 * server secret: the canvas cannot hold it, so the 1-click flow landed on an empty
 * repository list unless an operator pasted the key into the dialog. The callback now
 * mints a signed, HttpOnly session for the connected login and `/api/repos` accepts
 * either that session (for its own login only) or the control key (machine callers).
 */
export const SESSION_COOKIE = "cf_session";
export const SESSION_TTL_SECONDS = 8 * 3600;

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

function cookieAttrs(url: URL, path: string): string {
  const secure = url.protocol === "https:" ? "Secure; " : "";
  return `HttpOnly; ${secure}SameSite=Lax; Path=${path}`;
}

/** `<login>.<exp>.<hmac>`, signed over the login and its expiry. */
export async function mintSessionToken(
  signingKey: string,
  login: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
  const data = `${login}.${exp}`;
  return `${data}.${await signHmacSha256(signingKey, data)}`;
}

function sessionCookie(token: string, url: URL): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttrs(url, "/")}; Max-Age=${SESSION_TTL_SECONDS}`;
}

/** Reads and verifies the session cookie; a failure reason is never surfaced to the caller. */
export async function readSession(
  headers: Headers,
  signingKey: string,
  nowMs: number = Date.now(),
): Promise<{ ok: true; login: string } | { ok: false }> {
  const raw = getCookie(headers, SESSION_COOKIE);
  if (!raw) return { ok: false };
  const parts = raw.split(".");
  if (parts.length !== 3) return { ok: false };
  const [login, expStr, sig] = parts as [string, string, string];
  if (!login || !expStr || !sig) return { ok: false };
  const expected = await signHmacSha256(signingKey, `${login}.${expStr}`);
  if (!(await sameSecret(expected, sig))) return { ok: false };
  const exp = Number.parseInt(expStr, 10);
  if (Number.isNaN(exp) || Math.floor(nowMs / 1000) > exp) return { ok: false };
  return { ok: true, login };
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

  const clientId = env.GITHUB_CLIENT_ID;
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
        error: "GitHub Client ID is not configured (set GITHUB_CLIENT_ID)",
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

/** Why a callback's `state` did not match its signed `cf_oauth_state` cookie. */
type StateFailure =
  | "missing-state"
  | "missing-cookie"
  | "malformed-cookie"
  | "bad-signature"
  | "expired"
  | "mismatch";

const STATE_FAILURE_MESSAGES: Record<StateFailure, string> = {
  "missing-state": "Missing required OAuth state parameter",
  "missing-cookie": "Missing OAuth state cookie",
  "malformed-cookie": "Malformed OAuth state cookie",
  "bad-signature": "Invalid OAuth state signature",
  expired: "OAuth state expired",
  mismatch: "OAuth state mismatch (CSRF detected)",
};

/**
 * Did this browser really start the flow that this callback answers? The `cf_oauth_state`
 * cookie is signed over `<nonce>.<expiry>`, and the callback must echo that nonce as
 * `state` — the standard OAuth CSRF check, shared by the code flow (which rejects a
 * failure) and the install flow (which treats it as "unproven caller", see
 * handleGithubCallback).
 */
async function verifyOAuthState(
  request: Request,
  state: string | null,
  signingKey: string,
): Promise<{ ok: true } | { ok: false; reason: StateFailure }> {
  if (!state) return { ok: false, reason: "missing-state" };

  const cookieVal = getCookie(request.headers, "cf_oauth_state");
  if (!cookieVal) return { ok: false, reason: "missing-cookie" };

  const parts = cookieVal.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed-cookie" };

  const [cookieNonce, expStr, sig] = parts as [string, string, string];
  const expectedSig = await signHmacSha256(signingKey, `${cookieNonce}.${expStr}`);
  if (!(await sameSecret(expectedSig, sig))) return { ok: false, reason: "bad-signature" };

  const exp = parseInt(expStr, 10);
  if (isNaN(exp) || Math.floor(Date.now() / 1000) > exp) return { ok: false, reason: "expired" };

  if (!(await sameSecret(cookieNonce, state))) return { ok: false, reason: "mismatch" };
  return { ok: true };
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
  // When code is present, enforce state verification before exchanging code for tokens.
  const stateCheck = await verifyOAuthState(request, state, signingKey);
  if (code && !stateCheck.ok) {
    return Response.json(
      { ok: false, error: STATE_FAILURE_MESSAGES[stateCheck.reason] },
      { status: 400, headers: { "set-cookie": clearCookie } },
    );
  }

  // An install callback this browser did not start (no valid signed state) proves that an
  // installation exists, never who is asking: the App JWT resolves *any* installation of
  // the app, so `installation_id` is caller-supplied. Running the install branch for such
  // a caller wrote another org's `authorized_repos` (a cross-tenant write) and handed back
  // a session for that org's login. So an unproven install callback now does no GitHub
  // work and writes nothing; it sends the operator back to complete the OAuth login, which
  // keeps the state gate and mints a session only for the login GitHub confirms
  // (cloud-factory-cf-dnrm).
  if (!code && !stateCheck.ok) {
    const pendingUrl = new URL(returnTo, url.origin);
    if (pendingUrl.origin !== url.origin) {
      pendingUrl.href = new URL("/", url.origin).href;
    }
    pendingUrl.searchParams.set("connected", "1");
    pendingUrl.searchParams.set("count", "0");
    // The canvas opens its connect dialog on `connected=1`; an empty repository list and
    // this flag are the operator's prompt to run the OAuth flow that yields a session.
    pendingUrl.searchParams.set("needs_oauth", "1");
    if (installationId) {
      pendingUrl.searchParams.set("installation_id", installationId);
    }
    return new Response(null, {
      status: 302,
      headers: await successHeaders(pendingUrl, url, signingKey, null),
    });
  }

  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  let accessToken: string | null = null;

  // 1. Exchange code for user access token if code is present
  if (code) {
    if (!clientId || !clientSecret) {
      return Response.json(
        { ok: false, error: "GitHub OAuth credentials are not configured in environment" },
        { status: 503, headers: { "set-cookie": clearCookie } },
      );
    }

    let tokenRes: Response;
    try {
      tokenRes = await fetch("https://github.com/login/oauth/access_token", {
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
    } catch (err) {
      return Response.json(
        { ok: false, error: `Failed to reach GitHub token endpoint: ${String(err)}` },
        { status: 502, headers: { "set-cookie": clearCookie } },
      );
    }

    if (!tokenRes.ok) {
      return Response.json(
        { ok: false, error: `GitHub token exchange failed with HTTP ${tokenRes.status}` },
        { status: 502, headers: { "set-cookie": clearCookie } },
      );
    }

    const tokenData = (await tokenRes.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof tokenData["error"] === "string") {
      const errorDesc = typeof tokenData["error_description"] === "string" ? tokenData["error_description"] : tokenData["error"];
      return Response.json(
        { ok: false, error: `GitHub OAuth error: ${errorDesc}` },
        { status: 400, headers: { "set-cookie": clearCookie } },
      );
    }

    if (typeof tokenData["access_token"] !== "string" || !tokenData["access_token"]) {
      return Response.json(
        { ok: false, error: "GitHub token exchange returned no access token" },
        { status: 502, headers: { "set-cookie": clearCookie } },
      );
    }

    accessToken = tokenData["access_token"];
  }

  let accountLogin = "unknown";
  let accountType = "User";
  const discoveredRepos: Array<{ fullName: string; owner: string; name: string; private: boolean; defaultBranch: string }> = [];

  // 2a. If access token available, query GitHub API for user & repos
  if (accessToken) {
    let userRes: Response;
    try {
      userRes = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "CloudFactory-Auth",
        },
      });
    } catch (err) {
      return Response.json(
        { ok: false, error: `Failed to reach GitHub /user endpoint: ${String(err)}` },
        { status: 502, headers: { "set-cookie": clearCookie } },
      );
    }

    if (!userRes.ok) {
      return Response.json(
        { ok: false, error: `GitHub /user failed with HTTP ${userRes.status}` },
        { status: 502, headers: { "set-cookie": clearCookie } },
      );
    }

    const userData = (await userRes.json()) as any;
    accountLogin = userData.login ?? "unknown";
    accountType = userData.type ?? "User";

    let reposRes: Response;
    try {
      reposRes = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "CloudFactory-Auth",
        },
      });
    } catch (err) {
      return Response.json(
        { ok: false, error: `Failed to reach GitHub /user/repos endpoint: ${String(err)}` },
        { status: 502, headers: { "set-cookie": clearCookie } },
      );
    }

    if (!reposRes.ok) {
      return Response.json(
        { ok: false, error: `GitHub /user/repos failed with HTTP ${reposRes.status}` },
        { status: 502, headers: { "set-cookie": clearCookie } },
      );
    }

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
  } else if (installationId) {
    // 2b. Install-only callback without OAuth code: query installation details & repos
    let appJwt: string | null = null;
    let installationToken: string | null = null;

    if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
      try {
        const key = await importAppPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
        appJwt = await mintAppJwt(env.GITHUB_APP_ID, key);
      } catch (err) {
        return Response.json(
          { ok: false, error: `Failed to sign GitHub App JWT: ${String(err)}` },
          { status: 502, headers: { "set-cookie": clearCookie } },
        );
      }
    } else if (env.GITHUB_TOKEN) {
      installationToken = env.GITHUB_TOKEN;
    }

    if (appJwt) {
      let instRes: Response;
      try {
        instRes = await fetch(`https://api.github.com/app/installations/${installationId}`, {
          headers: {
            authorization: `Bearer ${appJwt}`,
            accept: "application/vnd.github+json",
            "user-agent": "CloudFactory-Auth",
          },
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: `Failed to reach GitHub App installation endpoint: ${String(err)}` },
          { status: 502, headers: { "set-cookie": clearCookie } },
        );
      }

      if (!instRes.ok) {
        return Response.json(
          { ok: false, error: `GitHub /app/installations failed with HTTP ${instRes.status}` },
          { status: 502, headers: { "set-cookie": clearCookie } },
        );
      }

      const instData = (await instRes.json().catch(() => ({}))) as any;
      const account = instData.account ?? instData.installation?.account;
      if (!account?.login) {
        return Response.json(
          { ok: false, error: "GitHub App installation response contains no valid account login" },
          { status: 502, headers: { "set-cookie": clearCookie } },
        );
      }
      accountLogin = account.login;
      accountType = account.type ?? "User";

      let tokenRes: Response;
      try {
        tokenRes = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${appJwt}`,
            accept: "application/vnd.github+json",
            "user-agent": "CloudFactory-Auth",
          },
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: `Failed to reach GitHub installation access token endpoint: ${String(err)}` },
          { status: 502, headers: { "set-cookie": clearCookie } },
        );
      }

      if (!tokenRes.ok) {
        return Response.json(
          { ok: false, error: `GitHub /app/installations/${installationId}/access_tokens failed with HTTP ${tokenRes.status}` },
          { status: 502, headers: { "set-cookie": clearCookie } },
        );
      }

      const tokenData = (await tokenRes.json().catch(() => ({}))) as any;
      if (!tokenData?.token) {
        return Response.json(
          { ok: false, error: "GitHub installation access token response missing token" },
          { status: 502, headers: { "set-cookie": clearCookie } },
        );
      }
      installationToken = tokenData.token;
    } else if (installationToken) {
      let instRes: Response;
      try {
        instRes = await fetch(`https://api.github.com/app/installations/${installationId}`, {
          headers: {
            authorization: `Bearer ${installationToken}`,
            accept: "application/vnd.github+json",
            "user-agent": "CloudFactory-Auth",
          },
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: `Failed to reach GitHub App installation endpoint: ${String(err)}` },
          { status: 502, headers: { "set-cookie": clearCookie } },
        );
      }

      if (!instRes.ok) {
        const errText =
          instRes.status === 401
            ? "GitHub App installation endpoint requires an App JWT; personal access tokens (ghp_) are not accepted by GitHub"
            : `GitHub /app/installations failed with HTTP ${instRes.status}`;
        return Response.json(
          { ok: false, error: errText },
          { status: 502, headers: { "set-cookie": clearCookie } },
        );
      }

      const instData = (await instRes.json().catch(() => ({}))) as any;
      const account = instData.account ?? instData.installation?.account;
      if (!account?.login) {
        return Response.json(
          { ok: false, error: "GitHub App installation response contains no valid account login" },
          { status: 502, headers: { "set-cookie": clearCookie } },
        );
      }
      accountLogin = account.login;
      accountType = account.type ?? "User";
    } else {
      return Response.json(
        { ok: false, error: "GitHub App credentials (GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY) or GITHUB_TOKEN are not configured" },
        { status: 503, headers: { "set-cookie": clearCookie } },
      );
    }

    let instReposRes: Response;
    try {
      instReposRes = await fetch(`https://api.github.com/installation/repositories?per_page=100`, {
        headers: {
          authorization: `Bearer ${installationToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "CloudFactory-Auth",
        },
      });
    } catch (err) {
      return Response.json(
        { ok: false, error: `Failed to reach GitHub installation repositories endpoint: ${String(err)}` },
        { status: 502, headers: { "set-cookie": clearCookie } },
      );
    }

    if (!instReposRes.ok) {
      const errText =
        instReposRes.status === 401
          ? "GitHub installation repositories endpoint requires an installation access token; personal access tokens (ghp_) are not accepted by GitHub"
          : `GitHub /installation/repositories failed with HTTP ${instReposRes.status}`;
      return Response.json(
        { ok: false, error: errText },
        { status: 502, headers: { "set-cookie": clearCookie } },
      );
    }

    const instReposData = (await instReposRes.json().catch(() => ({}))) as any;
    const list = Array.isArray(instReposData?.repositories) ? instReposData.repositories : (Array.isArray(instReposData) ? instReposData : []);
    for (const r of list) {
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
  } else {
    return Response.json(
      { ok: false, error: "Missing required authorization code or installation_id" },
      { status: 400, headers: { "set-cookie": clearCookie } },
    );
  }

  // 3. Persist authorized repositories into OrgCoordinator DO
  if (accountLogin !== "unknown" && env.ORG_COORDINATOR) {
    const orgCoordinator = env.ORG_COORDINATOR.get(env.ORG_COORDINATOR.idFromName(accountLogin));
    let persistRes: Response;
    try {
      persistRes = await orgCoordinator.fetch("https://org-coordinator.internal/installations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          installationId: installationId || undefined,
          accountLogin,
          accountType,
          repos: discoveredRepos,
        }),
      });
    } catch (err) {
      return Response.json(
        { ok: false, error: `Failed to reach OrgCoordinator: ${String(err)}` },
        { status: 502, headers: { "set-cookie": clearCookie } },
      );
    }

    if (!persistRes.ok) {
      return Response.json(
        { ok: false, error: `OrgCoordinator persistence failed with HTTP ${persistRes.status}` },
        { status: 502, headers: { "set-cookie": clearCookie } },
      );
    }
  }

  // 4. Redirect user back to the application canvas
  const redirectUrl = new URL(returnTo, url.origin);
  if (redirectUrl.origin !== url.origin) {
    redirectUrl.href = new URL("/", url.origin).href;
  }
  redirectUrl.searchParams.set("connected", "1");
  redirectUrl.searchParams.set("count", String(discoveredRepos.length));
  if (accountLogin !== "unknown") {
    redirectUrl.searchParams.set("owner", accountLogin);
  }
  if (installationId) {
    redirectUrl.searchParams.set("installation_id", installationId);
  }

  // A session is the browser's credential for reading one account's repositories
  // (`/api/repos`), so it may only be minted for a caller whose identity GitHub has
  // actually confirmed. An OAuth `code` exchange does that: GitHub returns a token for
  // the presenting user and `/user` names them. An install-only callback carries a
  // caller-supplied `installation_id` and no identity at all — GitHub's App JWT can
  // resolve any installation of the app — so minting a session there handed any caller
  // a credential for another org's login and its private repository metadata
  // (cloud-factory-cf-dnrm). Install-only callbacks still register the installation
  // (section 3) and redirect, they just do not authenticate the browser.
  const authenticatedLogin = accessToken ? accountLogin : null;

  return new Response(null, {
    status: 302,
    headers: await successHeaders(redirectUrl, url, signingKey, authenticatedLogin),
  });
}

/**
 * Success is a redirect plus the cookies the browser needs afterwards: the state cookie
 * goes away, and — when the caller has been authenticated by an OAuth code exchange — a
 * session for that login is minted so the canvas can load its own repositories (see
 * SESSION_COOKIE). `sessionLogin` is `null` for install-only callbacks, which prove an
 * installation exists but not who is asking.
 */
async function successHeaders(
  redirectUrl: URL,
  url: URL,
  signingKey: string,
  sessionLogin: string | null,
): Promise<Headers> {
  const headers = new Headers({ location: redirectUrl.toString() });
  headers.append("set-cookie", `cf_oauth_state=; ${cookieAttrs(url, "/auth/github")}; Max-Age=0`);
  if (sessionLogin && sessionLogin !== "unknown") {
    headers.append("set-cookie", sessionCookie(await mintSessionToken(signingKey, sessionLogin), url));
  }
  return headers;
}

export async function handleApiRepos(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const controlKey = env.BROKER_CONTROL_KEY;
  const signingKey = env.BROKER_SIGNING_KEY ?? env.BROKER_CONTROL_KEY ?? env.WEBHOOK_SECRET;

  let owner = url.searchParams.get("owner");
  let authorised = false;

  // Machine callers present the control key (unchanged contract).
  const presented = request.headers.get("x-factory-control-key");
  if (presented) {
    if (!controlKey) {
      return Response.json({ ok: false, error: "control key not configured" }, { status: 503 });
    }
    if (await sameSecret(controlKey, presented)) authorised = true;
  }

  if (!authorised && signingKey) {
    const session = await readSession(request.headers, signingKey);
    if (session.ok) {
      // A browser session speaks for its own login and nobody else's: asking for another
      // account's list is refused rather than silently answered, and an omitted owner
      // means "my repositories" — which is the 1-click path after an OAuth return.
      if (owner && owner !== session.login) {
        return Response.json(
          { ok: false, error: "not authorised to read another account's repositories" },
          { status: 403 },
        );
      }
      owner = session.login;
      authorised = true;
    }
  }

  if (!authorised) {
    return Response.json({ ok: false, error: "not authorised to access repository metadata" }, { status: 401 });
  }

  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }

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
