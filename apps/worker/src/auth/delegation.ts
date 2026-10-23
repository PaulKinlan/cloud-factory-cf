/**
 * Tenant delegations: how a Worker that authorised a *browser session* obtains a
 * capability from the credential broker without the shared control key
 * (cloud-factory-cf-ec98).
 *
 * The broker Durable Object is addressed per repository, and it used to verify only
 * `x-factory-control-key`. That made every capability-issuing route require a key that
 * names every tenant. A delegation is a short-lived, single-purpose statement the DO can
 * verify on its own:
 *
 *     x-factory-delegation: <b64url(claims)>.<hmac>
 *     claims = { repo, login, exp, jti }
 *
 * The DO accepts a delegation only when its signature verifies with `BROKER_SIGNING_KEY`
 * *and* its `repo` is the repository this object is (case-insensitively). The control key
 * remains accepted, so the machine path (CI, alarms, the CLI) is unchanged and a Worker
 * and DO from different deploys never disagree about what is allowed.
 *
 * The TTL is deliberately short: this is a bearer credential for one request, and the
 * capability it produces is itself short-lived.
 */

import type { Env } from "../env";
import { signSegment, verifySegment } from "../credentials/capability";

export interface DelegationClaims {
  /** Repository scope, `owner/name`, exactly as the broker object is addressed. */
  repo: string;
  /** The session login the delegation acts for. */
  login: string;
  /** Expiry, seconds since epoch. */
  exp: number;
  /** Unique id, for audit correlation. */
  jti: string;
}

export type DelegationResult =
  | { ok: true; claims: DelegationClaims }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "wrong-repository" };

/** A delegation is valid for one request; nothing long enough to be worth replaying. */
export const DEFAULT_DELEGATION_TTL_SECONDS = 60;
export const MAX_DELEGATION_TTL_SECONDS = 300;

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(segment: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function signingKeyFor(env: Env): string | undefined {
  return env.BROKER_SIGNING_KEY ?? env.BROKER_CONTROL_KEY;
}

/**
 * Mints a delegation for `repository` on behalf of `login`, or returns `undefined` when
 * the deployment has no signing key (the caller then has nothing to present and must say
 * so rather than silently falling back to a key it does not have).
 */
export async function mintDelegation(
  env: Env,
  input: { repository: string; login: string },
  options: { ttlSeconds?: number; now?: number } = {},
): Promise<string | undefined> {
  const signingKey = signingKeyFor(env);
  if (!signingKey) return undefined;

  const now = Math.floor(options.now ?? Date.now() / 1000);
  const requested = options.ttlSeconds ?? DEFAULT_DELEGATION_TTL_SECONDS;
  const ttl = Math.min(Math.max(Math.trunc(requested), 1), MAX_DELEGATION_TTL_SECONDS);
  const claims: DelegationClaims = {
    repo: input.repository,
    login: input.login,
    exp: now + ttl,
    jti: crypto.randomUUID(),
  };

  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  return `${payload}.${await signSegment(signingKey, payload)}`;
}

/**
 * Verifies a delegation for the repository this verifier serves. `repository` is required:
 * a delegation that verifies cryptographically but names another repository is exactly the
 * confused-deputy case this exists to stop, so it is a typed refusal, not a fallthrough.
 */
export async function verifyDelegation(
  signingKey: string,
  token: string | null | undefined,
  options: { repository: string; now?: number },
): Promise<DelegationResult> {
  if (!token) return { ok: false, reason: "malformed" };
  const [payloadSegment, signatureSegment, ...rest] = token.split(".");
  if (!payloadSegment || !signatureSegment || rest.length > 0) {
    return { ok: false, reason: "malformed" };
  }

  const bytes = base64UrlDecode(payloadSegment);
  if (!bytes) return { ok: false, reason: "malformed" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const claims = parsed as Partial<DelegationClaims>;
  if (
    typeof claims.repo !== "string" ||
    typeof claims.login !== "string" ||
    typeof claims.exp !== "number" ||
    typeof claims.jti !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }

  if (!(await verifySegment(signingKey, payloadSegment, signatureSegment))) {
    return { ok: false, reason: "signature" };
  }

  const now = Math.floor(options.now ?? Date.now() / 1000);
  if (claims.exp <= now) return { ok: false, reason: "expired" };

  // Case-insensitive because GitHub logins are, and because the same repository can be
  // addressed with different casing by different callers.
  if (claims.repo.toLowerCase() !== options.repository.toLowerCase()) {
    return { ok: false, reason: "wrong-repository" };
  }

  return {
    ok: true,
    claims: {
      repo: claims.repo,
      login: claims.login,
      exp: claims.exp,
      jti: claims.jti,
    },
  };
}
