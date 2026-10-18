import type { Env } from "./env";

// Durable Object classes are resolved from the Worker's main module, so the
// coordinator has to be exported here (see `durable_objects` in wrangler.jsonc).
export { RepoCoordinator } from "./repo-coordinator";

const WEBHOOK_PATH = /^\/webhooks\/(?<provider>github|gitlab)\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/;

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

    const match = WEBHOOK_PATH.exec(url.pathname);
    if (!match?.groups) {
      return new Response("not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
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
 * Copy only the headers the coordinator acts on. Replaying the inbound
 * `content-length`/`host` on a new Request with a different body is a
 * foot-gun in the Workers runtime.
 */
function forwardableHeaders(headers: Headers, repository: string): Headers {
  const forwarded = new Headers({ "x-factory-repository": repository });
  for (const name of [
    "x-hub-signature-256",
    "x-github-delivery",
    "x-github-event",
    "content-type",
  ]) {
    const value = headers.get(name);
    if (value !== null) forwarded.set(name, value);
  }
  return forwarded;
}
