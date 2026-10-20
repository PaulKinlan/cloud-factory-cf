import type { Env } from "../env";

export const BROKER_PATH =
  /^\/broker\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/(?<operation>capabilities|permissions|provisioning|overrides|proxy|audit|settings)$/;

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
