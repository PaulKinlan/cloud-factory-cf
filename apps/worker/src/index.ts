import type { Env } from "./env";
import { sameSecret } from "./secrets";
import { MAX_WEBHOOK_BYTES } from "./webhooks";

// Durable Object classes are resolved from the Worker's main module, so they
// have to be exported here (see `durable_objects` in wrangler.jsonc).
export { CredentialBroker } from "./credential-broker-object";
export { OrgCoordinator } from "./org-coordinator";
export { RepoCoordinator } from "./repo-coordinator";

const WEBHOOK_PATH = /^\/webhooks\/(?<provider>github|gitlab)\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/;
const CANVAS_PATH = /^\/canvas\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/documents(?:\/(?<id>[^/]+))?$/;
const BROKER_PATH =
  /^\/broker\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/(?<operation>capabilities|permissions|proxy|audit)$/;

/**
 * Serves the built canvas from the ASSETS binding. Unknown paths stay a 404 (the
 * canvas is a single route at "/", so there is no SPA fallback to lean on) and
 * writes are refused for assets: only GET/HEAD pass through.
 */
async function serveAsset(request: Request, env: Env): Promise<Response> {
  if (!env.ASSETS) return new Response("not found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 404) return new Response("not found", { status: 404 });
  return asset;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "cloud-factory-cf",
        environment: env.ENVIRONMENT ?? "unknown",
      });
    }

    const broker = BROKER_PATH.exec(url.pathname);
    if (broker?.groups) {
      const { owner, repo, operation } = broker.groups as {
        owner: string;
        repo: string;
        operation: string;
      };
      return routeBroker(request, env, owner, repo, operation, url.search);
    }

    const canvas = CANVAS_PATH.exec(url.pathname);
    if (canvas?.groups) {
      const { owner, repo, id } = canvas.groups as { owner: string; repo: string; id?: string };
      return routeCanvas(request, env, owner, repo, id);
    }

    const match = WEBHOOK_PATH.exec(url.pathname);
    if (!match?.groups) {
      return serveAsset(request, env);
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    // Refuse oversized payloads before buffering them into a string.
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
      return Response.json({ ok: false, error: "payload too large" }, { status: 413 });
    }

    const { provider, owner, repo } = match.groups as {
      provider: string;
      owner: string;
      repo: string;
    };

    // One Durable Object per repository: the coordinator serialises every
    // event for a repo, which is what makes dedupe cheap and ordering real.
    const stub = env.REPO_COORDINATOR.get(
      env.REPO_COORDINATOR.idFromName(`${owner}/${repo}`),
    );

    const forwarded = new Request(
      `https://repo-coordinator.internal/events?provider=${encodeURIComponent(provider)}`,
      {
        method: "POST",
        headers: forwardableHeaders(request.headers, `${owner}/${repo}`),
        body: await request.text(),
      },
    );

    return stub.fetch(forwarded);
  },
} satisfies ExportedHandler<Env>;

/**
 * Routes to the per-repository credential broker. The agent's request carries a
 * capability, never a credential; the object in front of the secrets decides.
 */
/**
 * Canvas documents live in the repository's coordinator object. They are
 * control-plane data (a layout names agents and actions), so every method needs
 * the same control key the broker uses.
 */
async function routeCanvas(
  request: Request,
  env: Env,
  owner: string,
  repo: string,
  id: string | undefined,
): Promise<Response> {
  const controlKey = env.BROKER_CONTROL_KEY;
  if (!controlKey) {
    return Response.json({ ok: false, error: "control key not configured" }, { status: 503 });
  }
  if (!(await sameSecret(controlKey, request.headers.get("x-factory-control-key")))) {
    return Response.json({ ok: false, error: "not authorised to read or write canvas documents" }, { status: 401 });
  }
  if (!["GET", "PUT", "DELETE"].includes(request.method)) {
    return new Response("method not allowed", { status: 405 });
  }

  const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`${owner}/${repo}`));
  const target = id === undefined ? "/canvas" : `/canvas/${encodeURIComponent(id)}`;
  return stub.fetch(
    new Request(`https://repo-coordinator.internal${target}`, {
      method: request.method,
      headers: { "content-type": "application/json" },
      body: request.method === "PUT" ? await request.text() : undefined,
    }),
  );
}

async function routeBroker(
  request: Request,
  env: Env,
  owner: string,
  repo: string,
  operation: string,
  search: string,
): Promise<Response> {
  if (operation !== "permissions" && operation !== "audit" && request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  if ((operation === "permissions" || operation === "audit") && request.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }

  const stub = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(`${owner}/${repo}`));
  const forwarded = new Request(
    `https://credential-broker.internal/${operation}${search}`,
    {
      method: request.method,
      headers: brokerHeaders(request.headers),
      body: request.method === "POST" ? await request.text() : undefined,
    },
  );
  return stub.fetch(forwarded);
}

function brokerHeaders(headers: Headers): Headers {
  const forwarded = new Headers({ "content-type": "application/json" });
  const controlKey = headers.get("x-factory-control-key");
  if (controlKey !== null) forwarded.set("x-factory-control-key", controlKey);
  return forwarded;
}

/**
 * Copy only the headers the coordinator acts on. Replaying the inbound
 * `content-length`/`host` on a new Request with a different body is a
 * foot-gun in the Workers runtime.
 */
function forwardableHeaders(headers: Headers, repository: string): Headers {
  const forwarded = new Headers({ "x-factory-repository": repository });
  for (const name of [
    // GitHub
    "x-hub-signature-256",
    "x-github-delivery",
    "x-github-event",
    // GitLab
    "x-gitlab-token",
    "x-gitlab-event-uuid",
    "x-gitlab-event",
    "content-type",
  ]) {
    const value = headers.get(name);
    if (value !== null) forwarded.set(name, value);
  }
  return forwarded;
}
