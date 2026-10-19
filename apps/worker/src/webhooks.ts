/**
 * Webhook verification and normalisation for every supported platform (ADR 003).
 *
 * Verification stays here, beside the route that receives the request, because it
 * needs the deployment's secrets and the Workers crypto surface. Normalisation is
 * NOT reimplemented: it comes from the platform adapters in `@factory-cloud/sdk`,
 * so this file and the rest of the factory cannot drift apart.
 *
 * The schemes:
 *   - GitHub: HMAC-SHA256 over the raw body in `X-Hub-Signature-256` (`sha256=<hex>`),
 *     delivery id in `X-GitHub-Delivery`.
 *   - GitLab: a shared secret token in `X-Gitlab-Token` (no body MAC), delivery id in
 *     `X-Gitlab-Event-UUID`.
 *   - Gitea/Forgejo: the hook secret as HMAC-SHA256 in `X-Gitea-Signature` (bare hex,
 *     `sha256=` also accepted), or verbatim in `X-Gitea-Token`; delivery id in
 *     `X-Gitea-Delivery` / `X-Forgejo-Delivery`.
 *
 * Everything here is pure: no storage, no Durable Object state, so the verification
 * rules are unit-testable and reused by the coordinator.
 */

import { adapterFor, devPlatformAdapters, type DevPlatform, type HeaderReader } from "@factory-cloud/sdk";
import { asRecord } from "./events/helpers";

export type Provider = DevPlatform;

export const SUPPORTED_PROVIDERS: readonly Provider[] = Object.keys(devPlatformAdapters) as Provider[];

/** Largest webhook body the coordinator will accept (GitHub caps payloads at 25 MB). */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;

export interface NormalisedEvent {
  /** Event name carried inside the payload, if any (the header wins when present). */
  payloadEvent: string | null;
  /** Provider action verb when the payload carries one, e.g. `opened`. */
  action: string | null;
  /** Repository the payload talks about, in `owner/repo` form. */
  repository: string;
  /** Login of whoever triggered the event, when the payload names one. */
  actor: string | null;
}

export function isProvider(value: string): value is Provider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

/**
 * GitHub signs `sha256=<hex>` over the exact bytes received. Verification goes
 * through WebCrypto `verify`, so the comparison is constant time.
 */
export async function verifyGithubSignature(
  secret: string,
  body: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader) return false;

  const separator = signatureHeader.indexOf("=");
  if (separator === -1) return false;

  const scheme = signatureHeader.slice(0, separator).trim().toLowerCase();
  const hex = signatureHeader.slice(separator + 1).trim();
  if (scheme !== "sha256" || hex.length !== 64) return false;
  return verifyHmacHex(secret, body, hex);
}

/**
 * Gitea and Forgejo sign the raw body with the hook secret: bare hex in
 * `X-Gitea-Signature`, and some versions spell it `sha256=<hex>` like GitHub.
 * The header is optional whitespace-tolerant so a proxy that pads it still works.
 */
export async function verifyGiteaSignature(
  secret: string,
  body: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const trimmed = signatureHeader.trim();
  const hex = trimmed.includes("=") ? trimmed.slice(trimmed.indexOf("=") + 1).trim() : trimmed;
  if (hex.length !== 64) return false;
  return verifyHmacHex(secret, body, hex);
}

/** Shared HMAC-SHA256 verification over the exact bytes received. */
async function verifyHmacHex(secret: string, body: string, hex: string): Promise<boolean> {
  const signature = hexToBytes(hex);
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(body));
}

/**
 * GitLab sends the shared secret verbatim, so there is no MAC to verify.
 * Both sides are digested first and the digests compared without an early
 * exit, which keeps the comparison independent of how many leading bytes match.
 */
export async function verifyGitlabToken(
  expected: string,
  tokenHeader: string | null,
): Promise<boolean> {
  if (!tokenHeader || tokenHeader.length === 0) return false;

  const encoder = new TextEncoder();
  const [expectedDigest, providedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(tokenHeader)),
  ]);

  const a = new Uint8Array(expectedDigest);
  const b = new Uint8Array(providedDigest);
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= (a[i] as number) ^ (b[i] as number);
  }
  return difference === 0;
}

/** Extracts the provider delivery id used for idempotency (adapter-owned). */
export function deliveryIdFor(provider: Provider, headers: Headers): string | null {
  const trimmed = adapterFor(provider)?.deliveryId(headers)?.trim();
  return trimmed ? trimmed : null;
}

/** Extracts the provider event name (`pull_request`, `Merge Request Hook`, ...). */
export function eventNameFor(provider: Provider, headers: Headers): string {
  const trimmed = adapterFor(provider)?.rawEvent(headers).trim();
  return trimmed ? trimmed : "unknown";
}

/**
 * Pulls the fields the coordinator indexes out of a provider payload. The work is
 * the platform adapter's (ADR 003), so GitHub, GitLab and Gitea deliveries produce
 * the same shape and one normaliser cannot drift from the others. Unknown shapes
 * degrade to `unknown`/null rather than throwing: enqueueing a webhook must not
 * depend on how well we parse its body.
 */
export function normaliseEvent(provider: Provider, payload: unknown, headers: HeaderReader): NormalisedEvent {
  const event = adapterFor(provider)?.normalise(payload, headers) ?? null;
  if (event === null) {
    return { payloadEvent: null, action: null, repository: "unknown", actor: null };
  }
  return {
    payloadEvent: event.rawEvent === "unknown" ? null : event.rawEvent,
    action: event.action,
    repository: event.repository,
    actor: event.actor,
  };
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  // Backed by a real ArrayBuffer (not ArrayBufferLike) so the result is a valid
  // BufferSource for `crypto.subtle.verify` under both the Workers and DOM libs
  // (the repo-wide tsconfig gains DOM once packages/sdk lands).
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    bytes[i] = byte;
  }
  return bytes;
}
