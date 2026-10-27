import type { Env } from "../env";
import { sameSecret } from "../secrets";
import { readSession } from "../routes/auth";

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

export type ControlDenialReason = "unconfigured" | "unauthorised" | "cross-tenant";

export type ControlAuthz =
  | { ok: true; principal: ControlPrincipal }
  | { ok: false; reason: ControlDenialReason };

/**
 * The key that signs and verifies `cf_session` — the same precedence `routes/auth.ts` mints
 * with, so a session minted at login verifies here.
 *
 * `WEBHOOK_SECRET` is deliberately **not** in this list (cloud-factory-cf-8e7r): the mint
 * path stopped accepting it in `owqq`, and a webhook secret is not a session key. Accepting
 * it on the verification side would be dead code today and a hole the day someone mints
 * with it, so the two sides state the same rule.
 */
export function sessionSigningKey(env: Env): string | undefined {
  return env.BROKER_SIGNING_KEY ?? env.BROKER_CONTROL_KEY;
}

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
  if (controlKey && presented && (await sameSecret(controlKey, presented))) {
    return { ok: true, principal: { via: "control-key" } };
  }

  const signingKey = sessionSigningKey(env);
  if (signingKey) {
    const session = await readSession(request.headers, signingKey);
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
  return { ok: false, reason: "unauthorised" };
}

const DEFAULT_MESSAGES: Record<ControlDenialReason, string> = {
  unconfigured: "control key not configured",
  unauthorised: "not authorised",
  "cross-tenant": "not authorised for another account's tenancy",
};

const STATUS: Record<ControlDenialReason, number> = {
  unconfigured: 503,
  unauthorised: 401,
  "cross-tenant": 403,
};

/**
 * The denial response for a failed authorisation. Routes keep their own wording (and
 * can add one for the tenant case) without re-deriving status codes.
 */
export function authzDenial(
  result: Extract<ControlAuthz, { ok: false }>,
  messages: Partial<Record<ControlDenialReason, string>> = {},
): Response {
  return Response.json(
    { ok: false, error: messages[result.reason] ?? DEFAULT_MESSAGES[result.reason] },
    { status: STATUS[result.reason] },
  );
}
