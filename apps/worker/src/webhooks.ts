/**
 * Provider-specific webhook verification and normalisation.
 *
 * Two providers are in scope for the scaffold:
 *   - GitHub: HMAC-SHA256 over the raw body in `X-Hub-Signature-256`
 *     (`sha256=<hex>`), delivery id in `X-Gitlab-*`/`X-GitHub-Delivery`.
 *   - GitLab: a shared secret token in `X-Gitlab-Token` (no body MAC),
 *     delivery id in `X-Gitlab-Event-UUID`.
 *
 * Everything here is pure: no storage, no Durable Object state, so the
 * verification rules are unit-testable and reused by the coordinator.
 */

export type Provider = "github" | "gitlab";

export const SUPPORTED_PROVIDERS: readonly Provider[] = ["github", "gitlab"];

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

/** Extracts the provider delivery id used for idempotency. */
export function deliveryIdFor(provider: Provider, headers: Headers): string | null {
  const header =
    provider === "github" ? headers.get("x-github-delivery") : headers.get("x-gitlab-event-uuid");
  const trimmed = header?.trim();
  return trimmed ? trimmed : null;
}

/** Extracts the provider event name (`pull_request`, `Merge Request Hook`, ...). */
export function eventNameFor(provider: Provider, headers: Headers): string {
  const header =
    provider === "github" ? headers.get("x-github-event") : headers.get("x-gitlab-event");
  const trimmed = header?.trim();
  return trimmed ? trimmed : "unknown";
}

/**
 * Pulls the fields the coordinator indexes out of a provider payload. Unknown
 * shapes degrade to `unknown`/null rather than throwing: enqueueing a webhook
 * must not depend on how well we parse its body.
 */
export function normaliseEvent(provider: Provider, payload: unknown): NormalisedEvent {
  const root = asRecord(payload);
  if (provider === "github") {
    const repository = asRecord(root?.["repository"])?.["full_name"];
    const action = root?.["action"];
    return {
      payloadEvent: typeof root?.["hook"] === "string" ? (root["hook"] as string) : null,
      action: typeof action === "string" ? action : null,
      repository: typeof repository === "string" ? repository : "unknown",
      actor: loginOf(root),
    };
  }

  const project = asRecord(root?.["project"])?.["path_with_namespace"];
  const attributes = asRecord(root?.["object_attributes"]);
  const kind = root?.["object_kind"];
  const action = attributes?.["action"];
  const user = asRecord(root?.["user"])?.["username"];

  return {
    payloadEvent: typeof kind === "string" ? kind : null,
    action: typeof action === "string" ? action : null,
    repository: typeof project === "string" ? project : "unknown",
    actor: typeof user === "string" ? user : null,
  };
}

function loginOf(root: Record<string, unknown> | null): string | null {
  const sender = asRecord(root?.["sender"])?.["login"];
  if (typeof sender === "string") return sender;
  const user = asRecord(root?.["user"])?.["login"];
  return typeof user === "string" ? user : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function hexToBytes(hex: string): Uint8Array | null {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    bytes[i] = byte;
  }
  return bytes;
}
