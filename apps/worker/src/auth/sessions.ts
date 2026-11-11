import type { Env } from "../env";
import { sameSecret } from "../secrets";
import { brokerInternalHeaders } from "./delegation";

/**
 * The browser's session credential, and the *revocation* of it
 * (cloud-factory-cf-2lbm).
 *
 * A `cf_session` cookie is a stateless HMAC token: it carries its own expiry, so
 * before this module nothing could unissue one. Logout only cleared the cookie in
 * the caller's browser, which left a captured or shared token valid for the full
 * 8 hours, and deleting a passkey — the "I lost the device" lever — revoked nothing
 * at all.
 *
 * Two halves, deliberately separate:
 *
 * | Half | What it proves | Cost |
 * | --- | --- | --- |
 * | `verifySessionToken` | the token was minted by this deployment and has not expired | local HMAC only |
 * | `isSessionRevoked` | the deployment has not un-issued it since | one Durable Object read |
 *
 * The store is a **deny list**, not a session table: only revocations are written,
 * so issuing a session costs nothing and the table is bounded by the revocations
 * actually in flight (see the pruning in `credential-broker-object.ts`). A session
 * that is not listed is valid for its full TTL, which is the honest trade: revocation
 * is checked on every read, so the window between a revocation and its effect is one
 * request, not one TTL.
 *
 * Revocation lives in the `default` `CredentialBroker` — the Durable Object that
 * already holds root passkeys — so this needs no new binding and no `wrangler.jsonc`
 * migration.
 */

export const SESSION_COOKIE = "cf_session";
export const SESSION_TTL_SECONDS = 8 * 3600;

/**
 * The session cookie's host-prefixed name (cloud-factory-cf-d11l).
 *
 * The `__Host-` prefix is enforced by the browser, not by this code: a cookie that
 * carries it must be `Secure`, must carry `Path=/`, and must not carry `Domain`. That is
 * what a plain `cf_session` cannot promise — any sibling subdomain can set
 * `cf_session=…; Domain=<parent>` and have the browser send it here, so a toss can
 * displace a real session. A `__Host-` cookie can only be set by this exact host.
 */
export const HOST_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;

/**
 * The name a session cookie must use at this origin. A browser rejects a `__Host-` cookie
 * that is not `Secure`, so plain-http local development keeps the unprefixed name; every
 * https deployment (i.e. every real one) gets the prefixed name.
 */
export function sessionCookieName(url: URL): string {
  return url.protocol === "https:" ? HOST_SESSION_COOKIE : SESSION_COOKIE;
}

/** The `set-cookie` value that issues `token` as this origin's session cookie. */
export function sessionSetCookie(token: string, url: URL): string {
  const secure = url.protocol === "https:" ? "Secure; " : "";
  return `${sessionCookieName(url)}=${encodeURIComponent(token)}; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

/** The `set-cookie` value that clears this origin's session cookie. */
export function clearSessionSetCookie(url: URL): string {
  const secure = url.protocol === "https:" ? "Secure; " : "";
  return `${sessionCookieName(url)}=; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=0`;
}

/**
 * Every cookie name a session can arrive in, most specific first — what
 * `readSession` accepts, and therefore what a sign-out has to clear and revoke
 * (cloud-factory-cf-7by9). A browser can hold both at once: the plain one from before
 * the `__Host-` prefix existed, the prefixed one from after. Clearing only the name this
 * origin would mint today left the other one signing the browser straight back in.
 */
export function sessionCookieNames(url: URL): readonly string[] {
  return url.protocol === "https:" ? [HOST_SESSION_COOKIE, SESSION_COOKIE] : [SESSION_COOKIE];
}

/** The `set-cookie` values that clear every session cookie this origin could have set. */
export function clearSessionSetCookies(url: URL): string[] {
  return sessionCookieNames(url).map((name) => {
    const secure = url.protocol === "https:" ? "Secure; " : "";
    return `${name}=; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=0`;
  });
}

/**
 * The instant the plain `cf_session` name stops being accepted on a **production**
 * deployment (cloud-factory-cf-79jv).
 *
 * A token minted before this name was replaced could only ever have been issued as
 * `cf_session`, so those keep working for the rest of their 8-hour TTL — a bounded
 * migration. After it, a plain cookie carries no proof of where it came from: a sibling
 * subdomain can set `cf_session` for the parent domain at any time, including with a
 * freshly minted token, so it must not authenticate anything.
 */
export const LEGACY_PLAIN_COOKIE_UNTIL_MS = Date.UTC(2026, 10, 12);

/**
 * Whether a session presented as the plain `cf_session` name may authenticate.
 *
 * Only a genuinely pre-upgrade token, and only on a deployment that is not explicitly
 * local. A development or test deployment mints the plain name itself (plain http cannot
 * hold a `__Host-` cookie), so there the name is the session and it stays accepted.
 */
export function plainSessionCookieAccepted(env: Env, claims: SessionClaims): boolean {
  // Only deployments that are explicitly local may accept the plain name without a
  // cutoff: they mint it themselves over plain http. Anything else — production, staging,
  // a value nobody expected — is treated as a public deployment that must not.
  const environment = String(env.ENVIRONMENT ?? "").toLowerCase();
  if (environment === "development" || environment === "dev" || environment === "test" || environment === "local") {
    return true;
  }
  return claims.iat * 1000 < LEGACY_PLAIN_COOKIE_UNTIL_MS;
}

/** The Durable Object instance that holds deployment-wide auth material. */
const AUTH_BROKER_NAME = "default";
const BROKER_ORIGIN = "https://credential-broker.internal";

/**
 * How far in the future an `iat` may be before the token is rejected. Tokens travel
 * inside one browser, so this only absorbs clock skew, not a timezone mistake.
 */
const CLOCK_SKEW_SECONDS = 300;

/** The claims a `cf_session` cookie carries. */
export interface SessionClaims {
  login: string;
  /** Issued-at, epoch **seconds**. Revocation is "everything issued before T". */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Random per-session id — the unit a logout revokes. */
  sid: string;
}

/**
 * The key that signs and verifies `cf_session` — the same precedence every mint and
 * every verification uses, so a session minted at login verifies here.
 *
 * `WEBHOOK_SECRET` is deliberately **not** in this list (cloud-factory-cf-8e7r): the
 * mint path stopped accepting it in `owqq`, and a webhook secret is not a session key.
 */
export function sessionSigningKey(env: Env): string | undefined {
  return env.BROKER_SIGNING_KEY ?? env.BROKER_CONTROL_KEY;
}

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

/** 128 bits of randomness, hex. The token is the only copy of it. */
function randomSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function payload(claims: SessionClaims): string {
  return `${claims.login}.${claims.iat}.${claims.exp}.${claims.sid}`;
}

/**
 * Mints `<login>.<iat>.<exp>.<sid>.<hmac>`, signed over everything but the signature.
 *
 * The format is versionless on purpose: a cookie minted before revocation existed
 * (`<login>.<exp>.<hmac>`) has no `sid` to revoke, so `verifySessionToken` rejects it.
 * That means deploying this invalidates sessions issued by the previous build — one
 * forced re-login, in exchange for every session in the wild being revocable. The
 * alternative (accepting unrecoverable tokens for 8 hours) is the bug this fixes.
 */
export async function mintSessionToken(
  signingKey: string,
  login: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const claims: SessionClaims = { login, iat, exp: iat + SESSION_TTL_SECONDS, sid: randomSessionId() };
  return `${payload(claims)}.${await signHmacSha256(signingKey, payload(claims))}`;
}

/**
 * Verifies signature, format and expiry. **Does not** consult revocation — use
 * `readSession` for that. Exported so a caller that must act on its own token (logout
 * revokes a token it is about to discard) can do so without a store round-trip.
 */
export async function verifySessionToken(
  raw: string | null | undefined,
  signingKey: string,
  nowMs: number = Date.now(),
): Promise<SessionClaims | null> {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 5) return null;
  const [login, iatStr, expStr, sid, sig] = parts as [string, string, string, string, string];
  if (!login || !iatStr || !expStr || !sid || !sig) return null;
  // GitHub logins never contain a dot; the sid is hex. Reject anything else before it
  // can reach the store as a key.
  if (login.includes(".") || !/^[0-9a-f]{32}$/.test(sid)) return null;

  const expected = await signHmacSha256(signingKey, `${login}.${iatStr}.${expStr}.${sid}`);
  if (!(await sameSecret(expected, sig))) return null;

  const iat = Number.parseInt(iatStr, 10);
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return null;

  const now = Math.floor(nowMs / 1000);
  if (now > exp) return null;
  if (iat > now + CLOCK_SKEW_SECONDS) return null;
  return { login, iat, exp, sid };
}

function authBroker(env: Env): DurableObjectStub<import("../credential-broker-object").CredentialBroker> | null {
  if (!env.CREDENTIAL_BROKER) return null;
  return env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(AUTH_BROKER_NAME));
}

/**
 * Whether the deployment has revoked this session (or every session for its login).
 *
 * **Fails closed.** A broker error answers "revoked": a revocation list that cannot be
 * read cannot be trusted, and the rest of the control plane is unreachable in that
 * state anyway. A deployment with no broker binding has nowhere to record revocations,
 * so nothing is revoked there — that is the documented cost of running without the
 * binding, not a silent hole in a configured deployment.
 */
export async function isSessionRevoked(env: Env, claims: SessionClaims): Promise<boolean> {
  const query = new URLSearchParams({ login: claims.login, sid: claims.sid, iat: String(claims.iat) });
  try {
    const broker = authBroker(env);
    if (!broker) return false;
    // Broker internal routes answer only an internal caller (the guard in
    // `credential-broker-object.ts`), so present the same control key or delegation the
    // passkey routes present.
    const headers = await brokerInternalHeaders(env, AUTH_BROKER_NAME);
    const res = await broker.fetch(
      new Request(`${BROKER_ORIGIN}/sessions/revoked?${query.toString()}`, { headers }),
    );
    if (!res.ok) return true;
    const data = (await res.json().catch(() => null)) as { revoked?: unknown } | null;
    return data?.revoked !== false;
  } catch {
    return true;
  }
}

/** Revokes one session. Returns whether the store recorded it. */
export async function revokeSession(env: Env, claims: Pick<SessionClaims, "login" | "sid">): Promise<boolean> {
  return postRevocation(env, { login: claims.login, sid: claims.sid });
}

/**
 * Revokes every session for a login, including any minted later in the same second.
 * Returns whether the store recorded it.
 */
export async function revokeAllSessions(env: Env, login: string): Promise<boolean> {
  return postRevocation(env, { login });
}

async function postRevocation(env: Env, body: { login: string; sid?: string }): Promise<boolean> {
  try {
    const broker = authBroker(env);
    if (!broker) return false;
    const res = await broker.fetch(
      new Request(`${BROKER_ORIGIN}/sessions/revoke`, {
        method: "POST",
        headers: await brokerInternalHeaders(env, AUTH_BROKER_NAME, { "content-type": "application/json" }),
        body: JSON.stringify(body),
      }),
    );
    return res.ok;
  } catch {
    return false;
  }
}
