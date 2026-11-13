import type { Env } from "../env";
import { authorizeControlPlane, authzDenial } from "../auth/tenant";
import { brokerInternalHeaders, mintDelegation, verifyDelegation } from "../auth/delegation";
import { resolveBrokerRepository } from "../repo-coordinator-addressing";

export const BROKER_PATH =
  /^\/broker\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/(?<operation>capabilities|permissions|provisioning|overrides|proxy|audit|settings)$/;

/**
 * `proxy` carries its own credential: a capability token in the body, which is minted
 * for exactly one repository and verified (including the repository binding) by the
 * object. An agent runner holds nothing else, so this route cannot gate it and must not
 * add a key the agent does not have.
 */
const CAPABILITY_AUTHORISED_OPERATIONS: readonly string[] = ["proxy"];

/**
 * Operations the broker object only accepts the machine control key for. A browser
 * session is a tenant credential, not the platform operator, so the route refuses it
 * with a 403 instead of letting the object answer a bare 401.
 */
const MACHINE_KEY_OPERATIONS: readonly string[] = ["provisioning", "overrides", "audit"];

/**
 * A delegation this deployment signed for exactly this repository. Worker-minted and
 * already tenant bound; the object verifies it again against its own address, so a
 * valid one is passed through unchanged.
 */
async function tenantDelegation(request: Request, env: Env, repository: string): Promise<string | undefined> {
  const token = request.headers.get("x-factory-delegation");
  const signingKey = env.BROKER_SIGNING_KEY ?? env.BROKER_CONTROL_KEY;
  if (!token || !signingKey) return undefined;
  const verified = await verifyDelegation(signingKey, token, { repository });
  return verified.ok ? token : undefined;
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

  const repository = `${owner}/${repo}`;
  const baseHeaders = new Headers({ "content-type": "application/json" });
  baseHeaders.set("x-factory-original-repository", repository);
  let headers = baseHeaders;

  // Every other operation is control-plane work on one tenant's broker, so it goes
  // through the same gate as every other control-plane route, bound to the tenant in
  // the path (`:owner`). Before this, the route forwarded whatever
  // `x-factory-control-key` the caller sent and let the object authenticate it: one
  // key reached every tenant and nothing in the Worker named the tenant at all
  // (cloud-factory-cf-8t4t).
  if (!CAPABILITY_AUTHORISED_OPERATIONS.includes(operation)) {
    const platform = new URLSearchParams(search).get("platform");
    const authz = await authorizeControlPlane(request, env, { owner, platform });
    if (!authz.ok) {
      const delegation = await tenantDelegation(request, env, repository);
      if (delegation === undefined) {
        return authzDenial(authz, {
          unauthorised: `not authorised to use ${repository}'s broker`,
          "cross-tenant": "not authorised to use another account's broker",
        });
      }
      headers.set("x-factory-delegation", delegation);
    } else if (authz.principal.via === "session") {
      if (MACHINE_KEY_OPERATIONS.includes(operation)) {
        return Response.json(
          { ok: false, error: `${operation} requires the machine control key` },
          { status: 403 },
        );
      }
      // The browser proved a login, not the master key: hand the object a delegation
      // for this repository alone, never a key that names every tenant.
      const delegation = await mintDelegation(env, { repository, login: authz.principal.login });
      if (delegation === undefined) {
        return Response.json({ ok: false, error: "broker signing key not configured" }, { status: 503 });
      }
      headers.set("x-factory-delegation", delegation);
    } else {
      // Machine principal (or the platform owner's session): present the deployment's
      // own credential. A caller-supplied header is never forwarded, so the object only
      // ever sees a key this Worker authenticated or a delegation it minted.
      headers = await brokerInternalHeaders(env, repository, baseHeaders);
    }
  }

  // Canonical lowercase broker name; the verbatim spelling rides the header the object
  // already reads for pre-canonicalisation settings (cloud-factory-cf-n23o).
  const stub = env.CREDENTIAL_BROKER.get(
    env.CREDENTIAL_BROKER.idFromName(resolveBrokerRepository(repository)),
  );
  const forwarded = new Request(
    `https://credential-broker.internal/${operation}${search}`,
    {
      method: request.method,
      headers,
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
