/**
 * Signed capability tokens for the credential broker.
 *
 * A capability is `<payload>.<signature>`, both base64url, where `payload` is
 * JSON and `signature` is HMAC-SHA256 over the exact payload segment. The token
 * names *what the agent may do* (service + action + repository) and *until
 * when*; it never contains a credential.
 */

export interface CapabilityClaims {
  /** Agent/lane identity the capability was issued to. */
  sub: string;
  /** Repository scope, `owner/name`. */
  repo: string;
  service: string;
  action: string;
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Expiry, seconds since epoch. */
  exp: number;
  /** Unique id, for audit correlation. */
  jti: string;
  /**
   * The human the capability was issued for, when a browser session asked for it
   * (cloud-factory-cf-ec98). Absent for machine callers, so tokens minted before this
   * existed still verify inside their TTL.
   */
  login?: string;
}

export type CapabilityInput = Pick<CapabilityClaims, "sub" | "repo" | "service" | "action"> & {
  login?: string;
};

export type VerifyResult =
  | { ok: true; claims: CapabilityClaims }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "not-yet-valid" };

export const DEFAULT_CAPABILITY_TTL_SECONDS = 120;
export const MAX_CAPABILITY_TTL_SECONDS = 900;

const encoder = new TextEncoder();

export async function issueCapability(
  signingKey: string,
  input: CapabilityInput,
  options: { ttlSeconds?: number; now?: number } = {},
): Promise<string> {
  const now = Math.floor(options.now ?? Date.now() / 1000);
  const ttl = clampTtl(options.ttlSeconds);
  const claims: CapabilityClaims = {
    sub: input.sub,
    repo: input.repo,
    service: input.service,
    action: input.action,
    iat: now,
    exp: now + ttl,
    jti: crypto.randomUUID(),
    ...(input.login === undefined ? {} : { login: input.login }),
  };

  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signature = await signSegment(signingKey, payload);
  return `${payload}.${signature}`;
}

export async function verifyCapability(
  signingKey: string,
  token: string,
  options: { now?: number } = {},
): Promise<VerifyResult> {
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return { ok: false, reason: "malformed" };

  const payloadSegment = token.slice(0, separator);
  const signatureSegment = token.slice(separator + 1);

  const valid = await verifySegment(signingKey, payloadSegment, signatureSegment);
  if (!valid) return { ok: false, reason: "signature" };

  const payloadBytes = base64UrlDecode(payloadSegment);
  if (!payloadBytes) return { ok: false, reason: "malformed" };

  let claims: CapabilityClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(payloadBytes)) as CapabilityClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (
    typeof claims.sub !== "string" ||
    typeof claims.repo !== "string" ||
    typeof claims.service !== "string" ||
    typeof claims.action !== "string" ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }

  const now = Math.floor(options.now ?? Date.now() / 1000);
  if (claims.exp <= now) return { ok: false, reason: "expired" };
  // A small skew allowance keeps a capability usable across clock drift, while
  // a token minted far in the future is a forgery signal, not a clock skew.
  if (claims.iat > now + 60) return { ok: false, reason: "not-yet-valid" };

  return { ok: true, claims };
}

function clampTtl(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined || !Number.isFinite(ttlSeconds)) return DEFAULT_CAPABILITY_TTL_SECONDS;
  return Math.min(Math.max(Math.trunc(ttlSeconds), 1), MAX_CAPABILITY_TTL_SECONDS);
}

/** HMAC-SHA256 over a payload segment, base64url. Shared with session delegations. */
export async function signSegment(signingKey: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

/** Constant-time-ish comparison of a payload segment's signature. Shared with delegations. */
export async function verifySegment(
  signingKey: string,
  payload: string,
  signatureSegment: string,
): Promise<boolean> {
  const signature = base64UrlDecode(signatureSegment);
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(payload));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
