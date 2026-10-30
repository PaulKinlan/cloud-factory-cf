import type { Env } from "../env";
import { authorizeControlPlane, authzDenial } from "../auth/tenant";

export const BROKER_PATH =
  /^\/broker\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/(?<operation>capabilities|permissions|provisioning|overrides|proxy|audit|settings)$/;

/**
 * Operations the broker object authorises itself, so this route must not re-gate them:
 * `capabilities`, `settings` and `proxy` accept a delegation header (which is not a
 * control-plane credential), and `provisioning`, `overrides` and `audit` verify the
 * control key inside the object. `permissions` is the one the object serves with no
 * check of its own, which is why it is gated here (cloud-factory-cf-1osx).
 */
const SELF_AUTHORISED_OPERATIONS: readonly string[] = [
  "capabilities",
  "provisioning",
  "overrides",
  "proxy",
  "audit",
  "settings",
];

export function brokerHeaders(headers: Headers): Headers {
  const forwarded = new Headers({ "content-type": "application/json" });
  const controlKey = headers.get("x-factory-control-key");
  if (controlKey !== null) forwarded.set("x-factory-control-key", controlKey);
  return forwarded;
}

export async function routeBroker(
  request: Request,
  env: Env,
  owner: string,
  repo: string,
  operation: string,
  search: string,
): Promise<Response> {
  if (operation === "permissions" || operation === "audit") {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
  } else if (operation === "provisioning" || operation === "overrides" || operation === "settings") {
    if (!["GET", "POST", "DELETE"].includes(request.method)) {
      return new Response("method not allowed", { status: 405 });
    }
  } else if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // Policy state is tenant data: an unauthenticated caller used to read whether a
  // service/action is permitted, and whether the repository narrows it
  // (cloud-factory-cf-1osx). Same gate as every other control-plane route, bound to
  // the tenant in the path so a browser session cannot read another account's policy.
  if (!SELF_AUTHORISED_OPERATIONS.includes(operation)) {
    const platform = new URLSearchParams(search).get("platform");
    const authz = await authorizeControlPlane(request, env, { owner, platform });
    if (!authz.ok) {
      return authzDenial(authz, {
        unauthorised: `not authorised to read ${owner}/${repo} permissions`,
        "cross-tenant": `not authorised to read another account's permissions`,
      });
    }
  }

  const stub = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(`${owner}/${repo}`));
  const forwarded = new Request(
    `https://credential-broker.internal/${operation}${search}`,
    {
      method: request.method,
      headers: brokerHeaders(request.headers),
      body: request.method === "POST" || request.method === "DELETE" ? await request.text() : undefined,
    },
  );
  return stub.fetch(forwarded);
}

export async function handleBroker(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  const broker = BROKER_PATH.exec(url.pathname);
  if (!broker?.groups) return null;
  const { owner, repo, operation } = broker.groups as {
    owner: string;
    repo: string;
    operation: string;
  };
  return routeBroker(request, env, owner, repo, operation, url.search);
}
