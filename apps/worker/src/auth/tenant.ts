import type { Env } from "../env";
import { sameSecret } from "../secrets";
import { readSession } from "../routes/auth";
import { sessionSigningKey } from "./sessions";
import { CONTROL_KEY_ATTEMPT_LIMIT_MACHINE, clientIdentity, controlKeyThrottle } from "./throttle";

/**
 * Tenant-aware control-plane authorisation (cloud-factory-cf-e1ql).
 *
 * A control-plane route used to accept exactly one credential: `BROKER_CONTROL_KEY`
 * in `x-factory-control-key`. That key is a *server* secret — it names no tenant, so a
 * deployment that hands it to anyone hands them every repository — and a browser
 * cannot hold it (which is why `apps/web` had to prompt for it).
 *
 * This module makes the browser's GitHub OAuth session (`cf_session`, minted by
 * `/auth/github/callback`, see `routes/auth.ts`) a first-class control-plane
 * credential, and binds it to its own tenant:
 *
 * | Caller | Credential | May touch |
 * | --- | --- | --- |
 * | Machine (CLI, scheduler, operator) | `x-factory-control-key` | any tenant |
 * | Browser | `cf_session` cookie | only the login it was minted for |
 *
 * The binding is the tenant boundary: a valid session for `alice` reading
 * `/audit/events/bob/widgets` is a `cross-tenant` denial (403), not a retry with a
 * weaker credential. Comparison is case-insensitive because GitHub logins are.
 *
 * A deployment needs *one* of the two credentials configured: a session signing key
 * (`BROKER_SIGNING_KEY`, falling back to `BROKER_CONTROL_KEY` and nothing else) is enough
 * for browsers, so removing the master control key does not lock the UI out. A webhook
 * secret is never a session key — see `sessionSigningKey` below.
 */

/** Who called, and which credential proved it. */
export type ControlPrincipal =
  | { via: "control-key" }
  | { via: "session"; login: string };

export type ControlDenialReason =
  | "unconfigured"
  | "unauthorised"
  | "cross-tenant"
  | "throttled"
  /** The counter could not be read, so the key was not compared (cloud-factory-cf-m3hx). */
  | "throttle-unavailable";

export type ControlAuthz =
  | { ok: true; principal: ControlPrincipal }
  | { ok: false; reason: ControlDenialReason; retryAfterSec?: number };

/**
 * The key that signs and verifies `cf_session` — re-exported from `auth/sessions.ts`, the
 * one place that defines the token, so a session minted at login verifies here.
 *
 * `WEBHOOK_SECRET` is deliberately **not** in this list (cloud-factory-cf-8e7r): the mint
 * path stopped accepting it in `owqq`, and a webhook secret is not a session key. Accepting
 * it on the verification side would be dead code today and a hole the day someone mints
 * with it, so the two sides state the same rule.
 */
export { sessionSigningKey };

export interface ControlAuthzOptions {
  /**
   * The tenant the request addresses (`:owner` from the path). When set, a session may
   * only act for its own login; omit it for routes that are not scoped to one tenant.
   */
  owner?: string | undefined;
  /**
   * Provider/platform hint (`platform` query parameter). When set, a session may only
   * act for its own provider (defaults to "github").
   */
  platform?: string | null | undefined;
}

/**
 * Whether this principal may address the provider named by a `platform=` hint.
 *
 * A session speaks for one provider: a GitHub session acting for `octodev` is the tenant
 * `github:octodev/*`, and the same `owner/repo` on GitLab or Gitea is a *different*
 * tenant with a different Durable Object. The machine key names no tenant, so it may
 * address any provider, which is how non-GitHub tenants are served (ADR 005).
 *
 * Without this, an owner-only comparison plus `?platform=gitlab` reads another provider's
 * data (cloud-factory-cf-tw9d, -fcwm).
 */
export function sessionMayAddressPlatform(
  principal: ControlPrincipal,
  platform: string | null | undefined,
): boolean {
  if (principal.via === "control-key") return true;
  if (platform === null || platform === undefined) return true;
  return platform.toLowerCase() === "github";
}

export const ROOT_SESSION_LOGIN = "__root__";

/**
 * CredentialBroker addresses that are not tenants (cloud-factory-cf-htc0).
 *
 * "default" and "global" are reserved broker scopes that hold PLATFORM settings
 * (github.private_key, webhook.secret, platform.owners). A GitHub login can literally be
 * "default", and user settings used to be addressed by `idFromName(login.toLowerCase())`,
 * so that login received a delegation for `repository: "default"` and could read and
 * write the platform scope. Any route that turns a login into a broker address has to
 * refuse these names instead.
 */
export const RESERVED_BROKER_ADDRESSES: ReadonlySet<string> = new Set(["default", "global"]);

export function isReservedBrokerAddress(name: string | null | undefined): boolean {
  if (!name) return false;
  return RESERVED_BROKER_ADDRESSES.has(name.trim().toLowerCase());
}

export function isRootLogin(login: string, env: Env): boolean {
  if (login.toLowerCase() === ROOT_SESSION_LOGIN) return true;
  const rawOwners = env.PLATFORM_OWNERS ?? env.ROOT_ADMIN_LOGINS;
  if (!rawOwners) return false;
  const owners = rawOwners
    .split(",")
    .map((entry: string) => entry.trim().toLowerCase())
    .filter(Boolean);
  return owners.includes(login.toLowerCase());
}

/**
 * Authorises a control-plane request. The machine key is checked first so its contract
 * (any tenant) is unchanged; a session is only consulted when that fails.
 */
export async function authorizeControlPlane(
  request: Request,
  env: Env,
  options: ControlAuthzOptions = {},
): Promise<ControlAuthz> {
  const controlKey = env.BROKER_CONTROL_KEY;
  const presented = request.headers.get("x-factory-control-key");
  let throttleUnavailable = false;
  if (controlKey && presented) {
    // This is where every machine-key comparison happens (admin, broker, audit, trace,
    // passkey, the legacy proxy). The slot is taken atomically BEFORE the comparison, so a
    // parallel burst cannot have every guess compared (cloud-factory-cf-yu3v), and a
    // matching key releases it again - only rejections spend the window. Reserving here
    // rather than at the entry point matters: a caller that presents a key to a route
    // which never compares it must not burn its own budget.
    const identity = clientIdentity(request);
    const reservation = await controlKeyThrottle(env, identity, "attempt", {
      limit: CONTROL_KEY_ATTEMPT_LIMIT_MACHINE,
    });
    if (reservation?.unavailable) {
      // The machine key cannot be judged, so it is not compared and not accepted
      // (cloud-factory-cf-m3hx). A session below still authorises the caller - a broker
      // outage must not lock an operator out of their own deployment - and only when
      // nothing else authorises does the reason surface, as a 503 rather than a 401 nobody
      // could act on.
      throttleUnavailable = true;
    } else if (reservation && !reservation.allowed) {
      return { ok: false, reason: "throttled", retryAfterSec: reservation.retryAfterSec };
    } else if (await sameSecret(controlKey, presented)) {
      await controlKeyThrottle(env, identity, "success");
      return { ok: true, principal: { via: "control-key" } };
    } else {
      // The reservation this attempt took has to be closed either way: a slot left in flight
      // would be held against the next caller from this address, and a rejected guess that is
      // not recorded is the oracle this throttle exists to close (cloud-factory-cf-r012 would
      // otherwise have made valid callers pay for it).
      await controlKeyThrottle(env, identity, "failure");
    }
  }

  const signingKey = sessionSigningKey(env);
  if (signingKey) {
    const session = await readSession(request.headers, env);
    if (session.ok) {
      if (isRootLogin(session.login, env)) {
        return { ok: true, principal: { via: "control-key" } };
      }
      const owner = options.owner;
      if (owner !== undefined && owner.toLowerCase() !== session.login.toLowerCase()) {
        return { ok: false, reason: "cross-tenant" };
      }
      const principal: ControlPrincipal = { via: "session", login: session.login };
      if (!sessionMayAddressPlatform(principal, options.platform)) {
        return { ok: false, reason: "cross-tenant" };
      }
      return { ok: true, principal };
    }
  }

  // Nothing that could authorise anyone: fail closed, but as a configuration error so
  // an operator sees it instead of a caller-side 401 they cannot fix.
  if (!controlKey && !signingKey) {
    return { ok: false, reason: "unconfigured" };
  }
  if (throttleUnavailable) return { ok: false, reason: "throttle-unavailable" };
  return { ok: false, reason: "unauthorised" };
}

const DEFAULT_MESSAGES: Record<ControlDenialReason, string> = {
  unconfigured: "control key not configured",
  unauthorised: "not authorised",
  "cross-tenant": "not authorised for another account's tenancy",
  throttled: "too many control key attempts; try again later",
  "throttle-unavailable": "control key throttle unavailable; try again shortly",
};

const STATUS: Record<ControlDenialReason, number> = {
  unconfigured: 503,
  unauthorised: 401,
  "cross-tenant": 403,
  throttled: 429,
  "throttle-unavailable": 503,
};

/**
 * The denial response for a failed authorisation. Routes keep their own wording (and
 * can add one for the tenant case) without re-deriving status codes.
 */
export function authzDenial(
  result: Extract<ControlAuthz, { ok: false }>,
  messages: Partial<Record<ControlDenialReason, string>> = {},
): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (result.reason === "throttled" && result.retryAfterSec !== undefined) {
    headers.set("retry-after", String(result.retryAfterSec));
  }
  return new Response(
    JSON.stringify({ ok: false, error: messages[result.reason] ?? DEFAULT_MESSAGES[result.reason] }),
    { status: STATUS[result.reason], headers },
  );
}
