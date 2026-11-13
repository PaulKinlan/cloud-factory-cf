import type { Env } from "../env";
import { sameSecret } from "../secrets";
import { importAppPrivateKey, mintAppJwt } from "../github-app";
import { isRootLogin, ROOT_SESSION_LOGIN } from "../auth/tenant";
import { handlePasskeyRoute } from "../auth/passkey";
import { brokerInternalHeaders } from "../auth/delegation";
import { acceptPresentedControlKey, clientIdentity, controlKeyThrottle } from "../auth/throttle";
import {
  clearSessionSetCookies,
  HOST_SESSION_COOKIE,
  plainSessionCookieAccepted,
  isSessionRevoked,
  mintSessionToken,
  revokeAllSessions,
  revokeSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionCookieNames,
  sessionSetCookie,
  sessionSigningKey,
  verifySessionToken,
} from "../auth/sessions";

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
 *
 * Minting, verification and revocation live in `auth/sessions.ts` (cloud-factory-cf-2lbm)
 * and are re-exported here, where the routes and tests have always imported them.
 */
export { SESSION_COOKIE, SESSION_TTL_SECONDS, mintSessionToken };
export { HOST_SESSION_COOKIE, sessionCookieName, sessionSetCookie, clearSessionSetCookies } from "../auth/sessions";

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

function sessionCookie(token: string, url: URL): string {
  return sessionSetCookie(token, url);
}

/**
 * The session token this browser presented, host-prefixed cookie first
 * (cloud-factory-cf-d11l).
 *
 * The plain `cf_session` name is still read so a session minted before the prefix
 * existed keeps working, but it never wins: only this exact host can set a `__Host-`
 * cookie, so a `cf_session` tossed from a sibling subdomain cannot displace a real
 * session that is present beside it.
 */
function getSessionCookie(headers: Headers): { token: string; name: string } | null {
  for (const name of [HOST_SESSION_COOKIE, SESSION_COOKIE]) {
    const token = getCookie(headers, name);
    if (token !== null) return { token, name };
  }
  return null;
}

/**
 * Every session token this request presents, one per cookie name `readSession` accepts,
 * most specific first (cloud-factory-cf-7by9). A sign-out has to answer for all of them:
 * clearing and revoking only the cookie this origin mints today leaves a plain
 * `cf_session` from before the prefix in place, still authenticated.
 */
function getSessionCookies(headers: Headers, url: URL): string[] {
  const tokens: string[] = [];
  for (const name of sessionCookieNames(url)) {
    const token = getCookie(headers, name);
    if (token !== null && !tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

/**
 * Reads, verifies **and authorises** the session cookie: signature and expiry from the
 * token itself, then the deployment's revocation list (cloud-factory-cf-2lbm).
 *
 * A failure reason is never surfaced to the caller. Exported for `auth/tenant.ts`, which
 * uses the same session as a tenant-bound control-plane credential
 * (cloud-factory-cf-e1ql), and for the control-plane routes.
 */
export async function readSession(
  headers: Headers,
  env: Env,
  nowMs: number = Date.now(),
): Promise<{ ok: true; login: string } | { ok: false }> {
  const signingKey = sessionSigningKey(env);
  if (!signingKey) return { ok: false };
  const presented = getSessionCookie(headers);
  if (presented === null) return { ok: false };
  const claims = await verifySessionToken(presented.token, signingKey, nowMs);
  if (!claims) return { ok: false };
  // The plain name is only proof of a session when the token itself predates the
  // `__Host-` name (cloud-factory-cf-79jv): a sibling subdomain can set it whenever it
  // likes, so a freshly minted token arriving that way authenticates nothing.
  if (presented.name === SESSION_COOKIE && !plainSessionCookieAccepted(env, claims)) return { ok: false };
  if (await isSessionRevoked(env, claims)) return { ok: false };
  return { ok: true, login: claims.login };
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
  url: URL = new URL(request.url),
): Promise<Response | null> {
  if (url.pathname.startsWith("/api/auth/passkey")) {
    return handlePasskeyRoute(request, env, url);
  }

  if (url.pathname === AUTH_LOGIN_PATH) {
    return handleGithubLogin(request, env, url);
  }

  if (url.pathname === AUTH_CALLBACK_PATH) {
    return handleGithubCallback(request, env, url);
  }

  if (url.pathname === API_REPOS_PATH) {
    return handleApiRepos(request, env, url);
  }

  if (url.pathname === "/api/auth/root-login" && request.method === "POST") {
    const controlKey = env.BROKER_CONTROL_KEY;
    if (!controlKey) {
      return Response.json({ ok: false, error: "Root broker control key not configured on server" }, { status: 503 });
    }

    // This route turns the deployment's control key into a root session, and it is
    // internet-facing, so a wrong guess must cost the guesser something
    // (cloud-factory-cf-vhns). The counter lives in the broker (the only durable state
    // the Worker has) and is keyed by client address; a correct key clears the streak.
    // One atomic reservation per attempt, taken BEFORE the key is compared: check and
    // record as separate calls let a parallel burst have every guess evaluated
    // (cloud-factory-cf-1f8m), and a slot taken before the comparison is what makes the
    // limit true for concurrent callers too. A success clears the streak.
    const throttleIdentity = clientIdentity(request);
    const reservation = await controlKeyThrottle(env, throttleIdentity, "attempt");
    if (reservation && !reservation.allowed) {
      return Response.json(
        { ok: false, error: "Too many root login attempts; try again later" },
        { status: 429, headers: { "retry-after": String(reservation.retryAfterSec) } },
      );
    }
    const signingKey = env.BROKER_SIGNING_KEY ?? env.BROKER_CONTROL_KEY;
    if (!signingKey) {
      return Response.json({ ok: false, error: "Signing key not configured" }, { status: 503 });
    }

    let presented = request.headers.get("x-factory-control-key");
    if (!presented) {
      try {
        const body = (await request.json()) as { controlKey?: string; key?: string };
        presented = body.controlKey ?? body.key ?? null;
      } catch {
        // empty body
      }
    }

    if (!presented || !(await sameSecret(controlKey, presented))) {
      // The reservation now holds an in-flight slot rather than a failure, so a rejection has
      // to be recorded explicitly: it both counts the guess and releases the slot
      // (cloud-factory-cf-r012).
      await controlKeyThrottle(env, throttleIdentity, "failure");
      return Response.json({ ok: false, error: "Invalid root bootstrap password / control key" }, { status: 401 });
    }

    await controlKeyThrottle(env, throttleIdentity, "success");

    const token = await mintSessionToken(signingKey, ROOT_SESSION_LOGIN);
    const sessionCookieHeader = sessionSetCookie(token, url);

    return Response.json(
      { ok: true, login: ROOT_SESSION_LOGIN, isRootAdmin: true },
      { headers: { "set-cookie": sessionCookieHeader } },
    );
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    // Clear every name `readSession` accepts, not just the one this origin mints today
    // (cloud-factory-cf-7by9): a pre-upgrade `cf_session` in the same browser would
    // otherwise survive the sign-out and authenticate the very next request.
    const headers = new Headers();
    for (const clearSession of clearSessionSetCookies(url)) headers.append("set-cookie", clearSession);

    // Clearing the cookie only un-issues the token in *this* browser. Logging out is a
    // revocation, so every token that is being discarded is added to the deny list too
    // (cloud-factory-cf-2lbm); with `all`, every session for the login goes.
    const signingKey = sessionSigningKey(env);
    const claims_list = signingKey
      ? (
          await Promise.all(
            getSessionCookies(request.headers, url).map((token) => verifySessionToken(token, signingKey)),
          )
        ).filter((claims): claims is NonNullable<typeof claims> => claims !== null)
      : [];
    if (claims_list.length === 0) return Response.json({ ok: true, revoked: false }, { headers });

    let all = url.searchParams.get("all") === "1" || url.searchParams.get("all") === "true";
    if (!all) {
      try {
        const body = (await request.json()) as { all?: unknown } | null;
        all = body?.all === true;
      } catch {
        // no body (or not JSON): revoke just this session
      }
    }

    const results: boolean[] = [];
    const clearances = new Set<string>();
    for (const claims of claims_list) {
      const target = all ? `all:${claims.login}` : `sid:${claims.sid}`;
      if (clearances.has(target)) continue;
      clearances.add(target);
      results.push(all ? await revokeAllSessions(env, claims.login) : await revokeSession(env, claims));
    }
    const revoked = results.every(Boolean);
    return Response.json({ ok: true, revoked, all }, { headers });
  }

  if (url.pathname === "/api/auth/sessions/revoke" && request.method === "POST") {
    // The operator lever for removing an account from the allowlist: removing a login
    // from `PLATFORM_OWNERS` already drops its root rights (`isRootLogin` is re-checked
    // on every request), but the session itself still authenticates. This ends it.
    let authorised = await acceptPresentedControlKey(
      request,
      env,
      request.headers.get("x-factory-control-key"),
    );
    if (!authorised) {
      const session = await readSession(request.headers, env);
      authorised = Boolean(session.ok && (isRootLogin(session.login, env) || session.login === ROOT_SESSION_LOGIN));
    }
    if (!authorised) {
      return Response.json({ ok: false, error: "not authorised to revoke sessions" }, { status: 401 });
    }

    let login = url.searchParams.get("login")?.trim() ?? "";
    if (!login) {
      try {
        const body = (await request.json()) as { login?: unknown } | null;
        login = typeof body?.login === "string" ? body.login.trim() : "";
      } catch {
        // no body
      }
    }
    if (!login) {
      return Response.json({ ok: false, error: "missing login" }, { status: 400 });
    }

    const revoked = await revokeAllSessions(env, login);
    return Response.json({ ok: revoked, login, revoked }, { status: revoked ? 200 : 503 });
  }

  if (url.pathname === "/api/auth/session") {
    const signingKey = sessionSigningKey(env);
    const session = await readSession(request.headers, env);
    const creds = await resolveGithubCredentials(env);
    const isRootAdmin = Boolean(session.ok && (isRootLogin(session.login, env) || session.login === ROOT_SESSION_LOGIN));
    return Response.json({
      ok: true,
      authenticated: session.ok,
      login: session.ok ? session.login : null,
      isRootAdmin,
      // Whether the deployment has a GitHub App configured decides which sign-in /
      // first-run setup affordance the UI can offer, so it stays available before login
      // (the app slug is public on github.com).
      githubConfigured: Boolean(creds.clientId && creds.clientSecret),
      appSlug: creds.appSlug ?? env.GITHUB_APP_SLUG ?? null,
      // Which secrets the deployment holds is a fingerprint of its attack surface, not a
      // fact an anonymous visitor needs: only root is told (cloud-factory-cf-gqyx). Root
      // is also the only viewer these fields drive - the admin panels that use them are
      // hidden for everyone else.
      hasControlKey: isRootAdmin ? Boolean(env.BROKER_CONTROL_KEY) : undefined,
      signingConfigured: isRootAdmin ? Boolean(signingKey) : undefined,
    });
  }

  return null;
}

export interface ResolvedGithubCredentials {
  clientId?: string;
  clientSecret?: string;
  appId?: string;
  appSlug?: string;
  privateKey?: string;
}

/**
 * Resolves GitHub credentials from Worker environment, then falls back to
 * CredentialBroker (for repo/org/default) or OrgCoordinator (cloud-factory-cf-1wnf).
 */
export async function resolveGithubCredentials(
  env: Env,
  scope?: { owner?: string | null; repo?: string | null },
): Promise<ResolvedGithubCredentials> {
  const result: ResolvedGithubCredentials = {
    clientId: env.GITHUB_CLIENT_ID?.trim() || undefined,
    clientSecret: env.GITHUB_CLIENT_SECRET?.trim() || undefined,
    appId: env.GITHUB_APP_ID?.trim() || undefined,
    appSlug: env.GITHUB_APP_SLUG?.trim() || undefined,
    privateKey: (env.GITHUB_APP_PRIVATE_KEY ?? env.GITHUB_PRIVATE_KEY)?.trim() || undefined,
  };

  const owner = scope?.owner?.trim() || undefined;
  const repo = scope?.repo?.trim() || undefined;

  // 1. Check CredentialBroker candidates
  if (env.CREDENTIAL_BROKER) {
    const candidates: string[] = [];
    const addCandidate = (name: string) => {
      if (!candidates.includes(name)) candidates.push(name);
    };
    // Canonical (lowercase) spellings first - that is where writes land since addressing
    // canonicalised - then the verbatim spellings a pre-canonicalisation store was written
    // under, so existing tenants keep resolving (cloud-factory-cf-n23o).
    if (owner && repo) addCandidate(`${owner}/${repo}`);
    if (owner) addCandidate(owner);
    if (owner && repo) addCandidate(`${owner}/${repo}`.toLowerCase());
    if (owner) addCandidate(owner.toLowerCase());
    addCandidate("default");
    addCandidate("global");

    for (const name of candidates) {
      if (result.clientId && result.clientSecret && result.appId && result.privateKey) {
        break;
      }
      try {
        const broker = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(name));
        // Read effective credentials with a server-tier credential scoped to this broker.
        const res = await broker.fetch("https://credential-broker.internal/effective-github-app", {
          headers: await brokerInternalHeaders(env, name),
        });
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as {
            appId?: string | null;
            appSlug?: string | null;
            clientId?: string | null;
            clientSecret?: string | null;
            privateKey?: string | null;
          } | null;
          if (!result.clientId && data?.clientId?.trim()) result.clientId = data.clientId.trim();
          if (!result.clientSecret && data?.clientSecret?.trim()) result.clientSecret = data.clientSecret.trim();
          if (!result.appId && data?.appId?.trim()) result.appId = data.appId.trim();
          if (!result.appSlug && data?.appSlug?.trim()) result.appSlug = data.appSlug.trim();
          if (!result.privateKey && data?.privateKey?.trim()) result.privateKey = data.privateKey.trim();
        } else if (env.BROKER_CONTROL_KEY) {
          // Fallback to /settings with control key if present
          const settingsRes = await broker.fetch("https://credential-broker.internal/settings", {
            headers: { "x-factory-control-key": env.BROKER_CONTROL_KEY },
          });
          if (settingsRes.ok) {
            const data = (await settingsRes.json().catch(() => null)) as {
              githubApp?: { clientId?: string; appId?: string; appSlug?: string };
            } | null;
            if (!result.clientId && data?.githubApp?.clientId?.trim()) {
              result.clientId = data.githubApp.clientId.trim();
            }
            if (!result.appId && data?.githubApp?.appId?.trim()) {
              result.appId = data.githubApp.appId.trim();
            }
            if (!result.appSlug && data?.githubApp?.appSlug?.trim()) {
              result.appSlug = data.githubApp.appSlug.trim();
            }
          }
        }
      } catch {
        // Continue checking candidates
      }
    }
  }

  // 2. Check OrgCoordinator if owner is specified
  if ((!result.clientId || !result.clientSecret) && owner && env.ORG_COORDINATOR) {
    try {
      const org = env.ORG_COORDINATOR.get(env.ORG_COORDINATOR.idFromName(owner));
      const res = await org.fetch("https://org-coordinator.internal/memory/github.client_id");
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { value?: unknown } | null;
        const val =
          typeof data?.value === "string"
            ? data.value.trim()
            : typeof data === "string"
              ? (data as string).trim()
              : undefined;
        if (!result.clientId && val) result.clientId = val;
      }
    } catch {
      // Ignore OrgCoordinator errors
    }
  }

  return result;
}

export async function resolveGithubClientId(
  env: Env,
  url: URL,
): Promise<string | undefined> {
  const owner = url.searchParams.get("owner") ?? url.searchParams.get("org");
  const repo = url.searchParams.get("repo");
  const creds = await resolveGithubCredentials(env, { owner, repo });
  return creds.clientId;
}

export async function handleGithubLogin(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const signingKey = env.BROKER_SIGNING_KEY ?? env.BROKER_CONTROL_KEY;
  if (!signingKey) {
    return Response.json({ ok: false, error: "broker signing key not configured" }, { status: 503 });
  }

  const owner = url.searchParams.get("owner") ?? url.searchParams.get("org");
  const repo = url.searchParams.get("repo");
  const creds = await resolveGithubCredentials(env, { owner, repo });
  const clientId = creds.clientId;
  const appSlug = url.searchParams.get("app_slug") ?? env.GITHUB_APP_SLUG;
  const stateNonce = crypto.randomUUID().replace(/-/g, "");
  const redirectUri = url.searchParams.get("redirect_uri");

  const exp = Math.floor(Date.now() / 1000) + 600; // 10 minutes
  const scopeObj = owner || repo ? { owner: owner ?? undefined, repo: repo ?? undefined } : null;
  const scopeSegment = scopeObj
    ? btoa(JSON.stringify(scopeObj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    : "";
  const dataToSign = scopeSegment ? `${stateNonce}.${exp}.${scopeSegment}` : `${stateNonce}.${exp}`;
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
): Promise<{ ok: true; scope?: { owner?: string; repo?: string } } | { ok: false; reason: StateFailure }> {
  if (!state) return { ok: false, reason: "missing-state" };

  const cookieVal = getCookie(request.headers, "cf_oauth_state");
  if (!cookieVal) return { ok: false, reason: "missing-cookie" };

  const parts = cookieVal.split(".");
  if (parts.length !== 3 && parts.length !== 4) return { ok: false, reason: "malformed-cookie" };

  let cookieNonce: string;
  let expStr: string;
  let sig: string;
  let scope: { owner?: string; repo?: string } | undefined;

  if (parts.length === 3) {
    [cookieNonce, expStr, sig] = parts as [string, string, string];
    const expectedSig = await signHmacSha256(signingKey, `${cookieNonce}.${expStr}`);
    if (!(await sameSecret(expectedSig, sig))) return { ok: false, reason: "bad-signature" };
  } else {
    const [noncePart, expPart, scopePart, sigPart] = parts as [string, string, string, string];
    cookieNonce = noncePart;
    expStr = expPart;
    sig = sigPart;
    const expectedSig = await signHmacSha256(signingKey, `${noncePart}.${expPart}.${scopePart}`);
    if (!(await sameSecret(expectedSig, sig))) return { ok: false, reason: "bad-signature" };
    try {
      const decoded = atob(scopePart.replace(/-/g, "+").replace(/_/g, "/"));
      scope = JSON.parse(decoded) as { owner?: string; repo?: string };
    } catch {
      // Ignore scope decoding error
    }
  }

  const exp = parseInt(expStr, 10);
  if (isNaN(exp) || Math.floor(Date.now() / 1000) > exp) return { ok: false, reason: "expired" };

  if (!(await sameSecret(cookieNonce, state))) return { ok: false, reason: "mismatch" };
  return { ok: true, scope };
}

export async function handleGithubCallback(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const signingKey = env.BROKER_SIGNING_KEY ?? env.BROKER_CONTROL_KEY;
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

  const scope = (stateCheck.ok ? stateCheck.scope : undefined) ?? {
    owner: url.searchParams.get("owner") ?? url.searchParams.get("org"),
    repo: url.searchParams.get("repo"),
  };
  const resolvedCreds = await resolveGithubCredentials(env, scope);
  const clientId = resolvedCreds.clientId;
  const clientSecret = resolvedCreds.clientSecret;
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

    const effectiveAppId = resolvedCreds.appId ?? env.GITHUB_APP_ID;
    const effectivePrivateKey =
      resolvedCreds.privateKey ?? env.GITHUB_APP_PRIVATE_KEY ?? env.GITHUB_PRIVATE_KEY;
    if (effectiveAppId && effectivePrivateKey) {
      try {
        const key = await importAppPrivateKey(effectivePrivateKey);
        appJwt = await mintAppJwt(effectiveAppId, key);
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

/**
 * A token that can read `ownerLogin`'s repositories (cloud-factory-cf-15ao).
 *
 * The installation token for that account's GitHub App installation, or the deployment's PAT
 * when it uses one. `null` means we cannot ask GitHub anything, which is a refusal rather than
 * a reason to believe the caller.
 */
async function resolveRepositoryReadToken(env: Env, ownerLogin: string): Promise<string | null> {
  if (env.GITHUB_TOKEN?.trim()) return env.GITHUB_TOKEN.trim();

  const creds = await resolveGithubCredentials(env, { owner: ownerLogin });
  const appId = creds.appId ?? env.GITHUB_APP_ID?.trim();
  const privateKey = creds.privateKey ?? env.GITHUB_APP_PRIVATE_KEY ?? env.GITHUB_PRIVATE_KEY;
  if (!appId || !privateKey) return null;

  let appJwt: string;
  try {
    appJwt = await mintAppJwt(appId, await importAppPrivateKey(privateKey));
  } catch {
    return null;
  }
  const appHeaders = {
    authorization: `Bearer ${appJwt}`,
    accept: "application/vnd.github+json",
    "user-agent": "CloudFactory-Auth",
  };

  // The installation is found by account, because this caller named a repository rather than
  // presenting an installation id - a token is only ever minted for an installation GitHub
  // already says exists for that account.
  let installations: Array<{ id?: number; account?: { login?: string } }> = [];
  try {
    const listRes = await fetch("https://api.github.com/app/installations?per_page=100", { headers: appHeaders });
    if (!listRes.ok) return null;
    installations = (await listRes.json()) as typeof installations;
  } catch {
    return null;
  }
  const wanted = ownerLogin.toLowerCase();
  const installation = installations.find((entry) => entry.account?.login?.toLowerCase() === wanted);
  if (!installation?.id) return null;

  try {
    const tokenRes = await fetch(`https://api.github.com/app/installations/${installation.id}/access_tokens`, {
      method: "POST",
      headers: appHeaders,
    });
    if (!tokenRes.ok) return null;
    const data = (await tokenRes.json()) as { token?: string };
    return data.token ?? null;
  } catch {
    return null;
  }
}

interface VerifiedRepository {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
}

/**
 * Asks GitHub whether this repository exists and is visible to us, and returns GitHub's OWN
 * description of it (cloud-factory-cf-15ao).
 *
 * The POST below used to write whatever the caller asserted: any fullName, any `private`, any
 * `defaultBranch`. That record is what later decides whether a repository is public, which
 * default branch the pipeline reads and which org's coordinator owns it, so a caller could
 * describe a repository they have no access to and have the fleet act on that description. The
 * fix is not to sanity-check the claims but to replace them with the answer GitHub gives.
 */
async function verifyRepositoryWithGithub(
  env: Env,
  requestedFullName: string,
): Promise<{ ok: true; repo: VerifiedRepository } | { ok: false; status: number; error: string }> {
  const parts = requestedFullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, status: 400, error: "fullName must be owner/repo" };
  }
  const [owner, name] = parts as [string, string];

  const token = await resolveRepositoryReadToken(env, owner);
  if (!token) {
    return {
      ok: false,
      status: 503,
      error: "GitHub credentials are not configured, so a repository cannot be verified",
    };
  }

  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "CloudFactory-Auth",
      },
    });
  } catch (err) {
    return { ok: false, status: 502, error: `Failed to reach GitHub: ${String(err)}` };
  }

  // 404 and 403 are the same answer to the caller: we cannot see it, so it cannot be registered.
  // Distinguishing them would turn this endpoint into an existence oracle for private repos.
  if (res.status === 404 || res.status === 403) {
    return { ok: false, status: 403, error: "repository could not be verified through GitHub" };
  }
  if (!res.ok) {
    return { ok: false, status: 502, error: `GitHub returned HTTP ${res.status} for this repository` };
  }

  const data = (await res.json().catch(() => ({}))) as {
    full_name?: string;
    name?: string;
    private?: boolean;
    default_branch?: string;
    owner?: { login?: string };
  };
  if (!data.full_name || !data.full_name.includes("/")) {
    return { ok: false, status: 502, error: "GitHub returned no repository identity" };
  }
  const [ghOwner, ghName] = data.full_name.split("/") as [string, string];
  if (ghOwner.toLowerCase() !== owner.toLowerCase() || ghName.toLowerCase() !== name.toLowerCase()) {
    // A rename between the caller's request and the lookup: refuse rather than register a
    // record whose name does not match the identifier we verified.
    return { ok: false, status: 403, error: "repository could not be verified through GitHub" };
  }

  return {
    ok: true,
    repo: {
      fullName: data.full_name,
      owner: data.owner?.login ?? ghOwner,
      name: data.name ?? ghName,
      private: Boolean(data.private),
      defaultBranch: data.default_branch || "main",
    },
  };
}

export async function handleApiRepos(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const controlKey = env.BROKER_CONTROL_KEY;
  const signingKey = sessionSigningKey(env);

  if (!controlKey && !signingKey) {
    return Response.json({ ok: false, error: "control key not configured" }, { status: 503 });
  }

  let owner = url.searchParams.get("owner");
  let authorised = false;

  // Machine callers present the control key (unchanged contract).
  const presented = request.headers.get("x-factory-control-key");
  // Counted, like every other control-key comparison (cloud-factory-cf-96mr).
  if (presented && (await acceptPresentedControlKey(request, env, presented))) {
    authorised = true;
  }

  if (!authorised && signingKey) {
    const session = await readSession(request.headers, env);
    if (session.ok) {
      const isRoot = isRootLogin(session.login, env) || session.login === ROOT_SESSION_LOGIN;
      if (isRoot) {
        if (!owner) owner = ROOT_SESSION_LOGIN;
        authorised = true;
      } else {
        // A browser session speaks for its own login and nobody else's: asking for another
        // account's list is refused rather than silently answered, and an omitted owner
        // means "my repositories" — which is the 1-click path after an OAuth return.
        if (owner && owner.toLowerCase() !== session.login.toLowerCase()) {
          return Response.json(
            { ok: false, error: "not authorised to read another account's repositories" },
            { status: 403 },
          );
        }
        owner = session.login;
        authorised = true;
      }
    }
  }

  if (!authorised) {
    if (presented && !controlKey) {
      return Response.json({ ok: false, error: "control key not configured" }, { status: 503 });
    }
    return Response.json({ ok: false, error: "not authorised to access repository metadata" }, { status: 401 });
  }

  if (request.method === "POST") {
    let body: Record<string, any> = {};
    try {
      body = (await request.json()) as Record<string, any>;
    } catch {
      return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
    }
    const fullName = String(body.fullName || (body.name ? `${owner}/${body.name}` : "")).trim();
    if (!fullName || !fullName.includes("/")) {
      return Response.json({ ok: false, error: "fullName or name is required (e.g. owner/repo)" }, { status: 400 });
    }
    const [repoOwner] = fullName.split("/") as [string];
    const targetOrg = owner === ROOT_SESSION_LOGIN ? repoOwner : (owner || repoOwner);
    // A caller only ever registers repositories for the account it is acting for. Without this,
    // a session for one login could file another account's repository under its own org, and
    // every later decision about that repository would be made from the wrong org's record.
    if (targetOrg.toLowerCase() !== repoOwner.toLowerCase()) {
      return Response.json(
        { ok: false, error: "repositories must belong to the account you are acting for" },
        { status: 403 },
      );
    }
    if (!env.ORG_COORDINATOR) {
      return Response.json({ ok: false, error: "OrgCoordinator is not configured" }, { status: 503 });
    }

    // Everything stored comes from GitHub, never from the request body: the caller chooses WHICH
    // repository to register (subject to being allowed to see it), and nothing else.
    const verified = await verifyRepositoryWithGithub(env, fullName);
    if (!verified.ok) {
      return Response.json({ ok: false, error: verified.error }, { status: verified.status });
    }

    const org = env.ORG_COORDINATOR.get(env.ORG_COORDINATOR.idFromName(targetOrg));
    const addRes = await org.fetch("https://org-coordinator.internal/installations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountLogin: targetOrg,
        repos: [verified.repo],
      }),
    });
    const addData = await addRes.json();
    return Response.json(addData, { status: addRes.status });
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

  if (owner === ROOT_SESSION_LOGIN) {
    return Response.json({ ok: true, org: ROOT_SESSION_LOGIN, count: 0, repositories: [] });
  }

  if (!env.ORG_COORDINATOR) {
    return Response.json({ ok: false, error: "OrgCoordinator is not configured" }, { status: 503 });
  }

  const orgCoordinator = env.ORG_COORDINATOR.get(env.ORG_COORDINATOR.idFromName(owner));
  const reposRes = await orgCoordinator.fetch("https://org-coordinator.internal/repos");
  const data = (await reposRes.json().catch(() => ({}))) as { ok?: boolean; count?: number; repositories?: unknown[] };

  if ((!data.repositories || data.repositories.length === 0) && owner !== owner.toLowerCase()) {
    const lowerOrgCoordinator = env.ORG_COORDINATOR.get(env.ORG_COORDINATOR.idFromName(owner.toLowerCase()));
    const lowerRes = await lowerOrgCoordinator.fetch("https://org-coordinator.internal/repos");
    const lowerData = (await lowerRes.json().catch(() => ({}))) as { ok?: boolean; count?: number; repositories?: unknown[] };
    if (lowerData.repositories && lowerData.repositories.length > 0) {
      return Response.json(lowerData, { status: lowerRes.status });
    }
  }

  return Response.json(data, { status: reposRes.status });
}

