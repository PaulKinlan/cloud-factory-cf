import type { Env } from "../env";
import { isRootLogin } from "./tenant";

/**
 * Who may sign in to this deployment (cloud-factory-cf-yvlp).
 *
 * `customers.allowAllGithubUsers` and `customers.allowedUsers` were saved by the admin UI
 * and echoed back by the CredentialBroker, but no authz path ever read them, so the
 * setting was decorative: every GitHub account that finished the OAuth exchange got a
 * session. These helpers are that missing read.
 *
 * Absent is allow-all: a deployment that has never opened the settings page allows every
 * GitHub user (the admin UI has always shown an unchecked-but-default-on behaviour), and
 * treating "absent" as "deny" would lock a fresh deployment out of itself. An explicit
 * `allowAllGithubUsers: false` with an empty allowlist therefore means "nobody but the
 * platform owners", which is a real choice an operator can make.
 */
export interface CustomerAccessPolicy {
  allowAll: boolean;
  allowedUsers: string[];
}

export const ALLOW_ALL_POLICY: CustomerAccessPolicy = { allowAll: true, allowedUsers: [] };

/**
 * Read the platform access policy from the reserved CredentialBroker scope.
 *
 * Fail-open on transport errors, deliberately: this is a login path, and a broker hiccup
 * must not lock every operator out of their own deployment. The value it protects is a
 * customer-side allowlist, not a capability check.
 */
export async function resolveCustomerAccess(env: Env): Promise<CustomerAccessPolicy> {
  if (!env.CREDENTIAL_BROKER) return ALLOW_ALL_POLICY;
  const headers = new Headers({ "content-type": "application/json" });
  if (env.BROKER_CONTROL_KEY) headers.set("x-factory-control-key", env.BROKER_CONTROL_KEY);
  try {
    const stub = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName("default"));
    const res = await stub.fetch("https://credential-broker.internal/settings", { headers });
    if (!res.ok) return ALLOW_ALL_POLICY;
    const body = (await res.json().catch(() => null)) as
      | { customers?: { allowAllGithubUsers?: unknown; allowedUsers?: unknown } }
      | null;
    const customers = body?.customers;
    if (!customers) return ALLOW_ALL_POLICY;
    const allowAll = customers.allowAllGithubUsers !== false;
    const allowedUsers = Array.isArray(customers.allowedUsers)
      ? customers.allowedUsers.map((u) => String(u).trim().toLowerCase()).filter(Boolean)
      : [];
    return { allowAll, allowedUsers };
  } catch {
    return ALLOW_ALL_POLICY;
  }
}

/**
 * Whether `login` may receive a session under `policy`. Platform owners and the root
 * session are always allowed: they are how an operator gets back in to change the policy.
 */
export function isLoginAllowed(
  policy: CustomerAccessPolicy,
  login: string | null | undefined,
  env: Env,
): boolean {
  if (!login) return false;
  if (policy.allowAll) return true;
  if (isRootLogin(login, env)) return true;
  return policy.allowedUsers.includes(login.trim().toLowerCase());
}

/**
 * The 403 a sign-in path returns when the customer policy does not admit `login`, or null
 * when it does. One helper so every session-minting path - the OAuth callback and the two
 * passkey paths - asks the same question, which is what rev-yvlp caught the passkey login
 * skipping (cloud-factory-cf-yvlp).
 */
export async function customerAccessDenial(env: Env, login: string): Promise<Response | null> {
  const policy = await resolveCustomerAccess(env);
  if (isLoginAllowed(policy, login, env)) return null;
  return Response.json(
    { ok: false, error: "not_allowed_on_this_deployment" },
    { status: 403 },
  );
}
