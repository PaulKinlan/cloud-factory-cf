import type { Env } from "../env";
import { MAX_WEBHOOK_BYTES } from "../webhooks";

export const WEBHOOK_PATH = /^\/webhooks\/(?<provider>github|gitlab)\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/;

/**
 * Copy only the headers the coordinator acts on. Replaying the inbound
 * `content-length`/`host` on a new Request with a different body is a
 * foot-gun in the Workers runtime.
 */
export function forwardableHeaders(headers: Headers, repository: string): Headers {
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

export async function routeWebhooks(
  request: Request,
  env: Env,
  provider: string,
  owner: string,
  repo: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // Refuse oversized payloads before buffering them into a string.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
    return Response.json({ ok: false, error: "payload too large" }, { status: 413 });
  }

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
}

export async function handleWebhooks(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  const match = WEBHOOK_PATH.exec(url.pathname);
  if (!match?.groups) return null;
  const { provider, owner, repo } = match.groups as {
    provider: string;
    owner: string;
    repo: string;
  };
  return routeWebhooks(request, env, provider, owner, repo);
}
