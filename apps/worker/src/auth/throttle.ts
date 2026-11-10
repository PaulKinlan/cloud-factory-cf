import type { Env } from "../env";
import { brokerInternalHeaders } from "./delegation";

/**
 * Failed-root-login throttling (cloud-factory-cf-vhns).
 *
 * `POST /api/auth/root-login` trades the deployment's control key for a root session and
 * is reachable from the internet, so a wrong guess has to cost the guesser something. The
 * counter lives here, keyed by client address, in the broker's durable storage.
 *
 * SCOPE: this throttles root-login only. The same secret is also accepted by
 * `authorizeControlPlane` and by routes that compare the header themselves; those are
 * followed up separately (see cloud-factory-cf-yu3v), and until that lands this must not
 * be described as protecting the whole control plane.
 *
 * The counter is durable state in the default CredentialBroker - the Worker's only
 * storage - and the two operations the caller can choose between have different
 * semantics on purpose:
 *
 *  * `attempt` reserves a slot and answers whether the caller may try at all. It is
 *    atomic inside one Durable Object call, which is what makes a parallel burst bounded:
 *    twenty concurrent guesses cannot all read a count of zero before any of them writes.
 *    Used by root-login, where a human types the key and five tries per window is plenty.
 *  * `failure` records a rejection without reserving anything, and `check` reads the
 *    counter. Used by `authorizeControlPlane`, where a machine may legitimately make many
 *    successful calls and must not be locked out by its own concurrency: only rejections
 *    count there.
 *
 * Both fail open (return null) when the broker cannot answer. A throttle that cannot read
 * its own state must not lock an operator out of their own deployment; the key comparison
 * that follows is still what decides the request.
 */
export const CONTROL_KEY_ATTEMPT_LIMIT = 5;
export const CONTROL_KEY_WINDOW_MS = 15 * 60 * 1000;

export type ThrottleOutcome = { allowed: boolean; retryAfterSec: number; failures: number };

export type ThrottleOperation = "attempt" | "failure" | "success";

/**
 * Who is making this request, as far as a throttle is concerned. `cf-connecting-ip` is set
 * by the edge and cannot be spoofed through it; the forwarded header is the fallback for a
 * proxied deployment without the Cloudflare header, and "unknown" (a single shared bucket)
 * is the last resort, so the control degrades to strict rather than to nothing.
 */
export function clientIdentity(request: Request): string {
  const direct = request.headers.get("cf-connecting-ip")?.trim();
  if (direct) return direct;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return "unknown";
}

export async function controlKeyThrottle(
  env: Env,
  identity: string,
  operation: ThrottleOperation,
  options: { limit?: number; windowMs?: number } = {},
): Promise<ThrottleOutcome | null> {
  if (!env.CREDENTIAL_BROKER) return null;
  const limit = options.limit ?? CONTROL_KEY_ATTEMPT_LIMIT;
  const windowMs = options.windowMs ?? CONTROL_KEY_WINDOW_MS;
  const path = operation === "attempt" ? "/auth-throttle/attempt" : "/auth-throttle/record";
  try {
    const stub = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName("default"));
    const res = await stub.fetch(`https://credential-broker.internal${path}`, {
      method: "POST",
      headers: await brokerInternalHeaders(env, "default", { "content-type": "application/json" }),
      body: JSON.stringify({
        identity,
        limit,
        windowMs,
        outcome: operation,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as
      | { allowed?: boolean; retryAfterSec?: number; failures?: number }
      | null;
    if (operation === "failure" || operation === "success") return null;
    return {
      allowed: data?.allowed !== false,
      retryAfterSec: Number(data?.retryAfterSec ?? 0) || 0,
      failures: Number(data?.failures ?? 0) || 0,
    };
  } catch {
    return null;
  }
}
