import type { Env } from "../env";
import { brokerInternalHeaders } from "./delegation";
import { sameSecret } from "../secrets";

/**
 * Failed-control-key throttling (cloud-factory-cf-vhns, cloud-factory-cf-m5dk).
 *
 * The deployment's control key is a bearer secret: it is accepted as
 * `x-factory-control-key` by root-login, by `authorizeControlPlane` (every admin, broker,
 * audit, trace and passkey route) and by the legacy proxy. Throttling one of those routes
 * and not the others throttles nothing, so the counter lives here, keyed by client
 * address, and every control-key comparison goes through it.
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
 * Both fail CLOSED when the broker cannot answer (cloud-factory-cf-m3hx): the reading comes
 * back as `unavailable`, never as an assumption of `allowed`. A throttle that skips itself
 * whenever its own storage is unhappy is a throttle an attacker turns off by making the
 * broker busy - which is exactly when a guessing run would go unnoticed. Callers therefore
 * refuse the key comparison and say why; a browser session on the same route is unaffected,
 * so an operator who can sign in is not locked out of their deployment by a broker outage.
 * The one case still answered as `null` is a deployment with no broker binding at all: there
 * is no counter to read and never was, so the route's own key comparison is all it has.
 */
export const CONTROL_KEY_ATTEMPT_LIMIT = 5;
/**
 * The budget for machine routes, which is deliberately larger than the human one.
 *
 * A reservation is taken before the comparison (that is what bounds a parallel burst), so
 * the budget also bounds how many callers can be *in flight* at once from one address. At
 * five, a legitimate agent fleet issuing eight parallel control-plane calls was refused
 * before any of them could compare its correct key (cloud-factory-cf-r012). Twenty is still
 * far below any useful guessing rate for a 256-bit secret, and it is above the concurrency
 * a real machine caller produces from one egress address.
 */
export const CONTROL_KEY_ATTEMPT_LIMIT_MACHINE = 20;
export const CONTROL_KEY_WINDOW_MS = 15 * 60 * 1000;

export type ThrottleOutcome = {
  allowed: boolean;
  retryAfterSec: number;
  failures: number;
  /**
   * The broker is bound but could not answer, so this reading proves nothing
   * (cloud-factory-cf-m3hx). `allowed` is false so a caller that forgets to look here still
   * fails closed; a caller that does look can say "throttle unavailable" instead of
   * pretending the address ran out of attempts.
   */
  unavailable?: true;
};

/** No reading at all: the deployment has no broker binding, so it has no counter to read. */
const NO_THROTTLE_BACKEND = null;

/** The key comparison could not be assessed because the counter was unreadable. */
function throttleUnavailable(): ThrottleOutcome {
  return { allowed: false, retryAfterSec: 0, failures: 0, unavailable: true };
}

export type ThrottleOperation = "check" | "attempt" | "failure" | "success";

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
  if (!env.CREDENTIAL_BROKER) return NO_THROTTLE_BACKEND;
  const limit = options.limit ?? CONTROL_KEY_ATTEMPT_LIMIT;
  const windowMs = options.windowMs ?? CONTROL_KEY_WINDOW_MS;
  const path =
    operation === "check" || operation === "attempt" ? `/auth-throttle/${operation}` : "/auth-throttle/record";
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
    if (!res.ok) return throttleUnavailable();
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
    return throttleUnavailable();
  }
}

/**
 * The one control-key comparison for routes that accept the key directly instead of going
 * through `authorizeControlPlane` (the passkey administration routes and the repo list).
 * Without this they are uncounted oracles: the same secret, compared at full speed, with
 * nothing incrementing the counter the entry gate reads (cloud-factory-cf-96mr).
 *
 * Three answers, because two could not tell "this key is wrong" from "the counter could not
 * be read" (cloud-factory-cf-m3hx). `unavailable` refuses the key just as `refused` does - it
 * never falls through to accepting it - but lets the route say so, and lets a route that also
 * accepts a session still use it.
 */
export type ControlKeyDecision = "accepted" | "refused" | "unavailable";

export async function acceptPresentedControlKey(
  request: Request,
  env: Env,
  presented: string | null,
): Promise<ControlKeyDecision> {
  const controlKey = env.BROKER_CONTROL_KEY;
  if (!controlKey || !presented) return "refused";
  const identity = clientIdentity(request);
  // Reserve before comparing, release on a match: the slot is atomic, so concurrent
  // guesses cannot all be compared, and only rejections spend the window
  // (cloud-factory-cf-yu3v / cloud-factory-cf-96mr).
  const reservation = await controlKeyThrottle(env, identity, "attempt", {
    limit: CONTROL_KEY_ATTEMPT_LIMIT_MACHINE,
  });
  if (reservation?.unavailable) return "unavailable";
  if (reservation && !reservation.allowed) return "refused";
  if (await sameSecret(controlKey, presented)) {
    await controlKeyThrottle(env, identity, "success");
    return "accepted";
  }
  // Close the reservation and count the rejection, so the slot is not held against the next
  // caller and these routes stop being uncounted oracles (cloud-factory-cf-r012 / 96mr).
  await controlKeyThrottle(env, identity, "failure");
  return "refused";
}
