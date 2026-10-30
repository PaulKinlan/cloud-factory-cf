import type { Env } from "../env";
import { MAX_WEBHOOK_BYTES, verifyGithubSignature } from "../webhooks";
import { resolveRepositoryKey } from "../repo-coordinator-addressing";

export const WEBHOOK_PATH = /^\/webhooks\/(?<provider>github|gitlab|gitea)\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/;
export const GLOBAL_GITHUB_WEBHOOK_PATH = "/webhooks/github";

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
    // Gitea / Forgejo (both header families: Forgejo keeps Gitea's names)
    "x-gitea-signature",
    "x-gitea-token",
    "x-gitea-delivery",
    "x-gitea-event",
    "x-forgejo-signature",
    "x-forgejo-token",
    "x-forgejo-delivery",
    "x-forgejo-event",
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
  const repoKey = resolveRepositoryKey(`${owner}/${repo}`, provider);
  const stub = env.REPO_COORDINATOR.get(
    env.REPO_COORDINATOR.idFromName(repoKey),
  );

  const forwarded = new Request(
    `https://repo-coordinator.internal/events?provider=${encodeURIComponent(provider)}`,
    {
      method: "POST",
      headers: forwardableHeaders(request.headers, repoKey),
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
  if (url.pathname === GLOBAL_GITHUB_WEBHOOK_PATH) {
    return handleGlobalGithubWebhook(request, env);
  }

  const match = WEBHOOK_PATH.exec(url.pathname);
  if (!match?.groups) return null;
  const { provider, owner, repo } = match.groups as {
    provider: string;
    owner: string;
    repo: string;
  };
  return routeWebhooks(request, env, provider, owner, repo);
}

export async function handleGlobalGithubWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
    return Response.json({ ok: false, error: "payload too large" }, { status: 413 });
  }

  const bodyText = await request.text();

  // Verify BEFORE anything is read out of the body or recorded (cloud-factory-cf-r5ns).
  // This endpoint has no repository in its path, so it never reaches the per-repository
  // secret the RepoCoordinator resolves through the broker: the deployment's own app
  // webhook secret is the only credential that can authenticate an app-level delivery
  // (docs/deploy.md §6 - unset means 503, fail closed).
  //
  // The installation branch below writes repositories straight into the OrgCoordinator,
  // with no second verifier behind it, so an unauthenticated delivery there could seed
  // installation repositories (including their `private` flag) for any account login it
  // named. The repository branch is verified again by the coordinator it forwards to;
  // this check refuses the forgery at the edge instead of spending a DO invocation on it.
  const secret = env.WEBHOOK_SECRET;
  if (!secret) {
    return Response.json(
      { ok: false, error: "webhook secret not configured" },
      { status: 503 },
    );
  }
  const signed = await verifyGithubSignature(
    secret,
    bodyText,
    request.headers.get("x-hub-signature-256"),
  );
  if (!signed) {
    return Response.json({ ok: false, error: "invalid signature" }, { status: 401 });
  }

  let payload: Record<string, any> = {};
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  // 1. If payload contains repository.full_name, forward to that repository's RepoCoordinator
  const repoFullName = payload.repository?.full_name;
  if (typeof repoFullName === "string" && repoFullName.includes("/")) {
    const [owner, repo] = repoFullName.split("/") as [string, string];
    const repoKey = resolveRepositoryKey(`${owner}/${repo}`, "github");
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repoKey));
    const forwarded = new Request(
      `https://repo-coordinator.internal/events?provider=github`,
      {
        method: "POST",
        headers: forwardableHeaders(request.headers, repoKey),
        body: bodyText,
      },
    );
    return stub.fetch(forwarded);
  }

  // 2. If it is an app installation event, record it in OrgCoordinator
  const event = request.headers.get("x-github-event");
  if (event === "installation" || event === "installation_repositories") {
    const accountLogin = payload.installation?.account?.login;
    if (accountLogin && env.ORG_COORDINATOR) {
      const orgStub = env.ORG_COORDINATOR.get(env.ORG_COORDINATOR.idFromName(accountLogin));
      const repos = Array.isArray(payload.repositories_added)
        ? payload.repositories_added
        : Array.isArray(payload.repositories)
          ? payload.repositories
          : [];
      await orgStub.fetch("https://org-coordinator.internal/installations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          installationId: payload.installation?.id,
          accountLogin,
          accountType: payload.installation?.account?.type ?? "User",
          repos: repos.map((r: any) => ({
            fullName: r.full_name,
            owner: accountLogin,
            name: r.name,
            private: Boolean(r.private),
          })),
        }),
      }).catch(() => null);
    }
    return Response.json({ ok: true, event, status: 202 }, { status: 202 });
  }

  // 3. If it is a root system ping event, return 202
  if (event === "ping") {
    return Response.json({ ok: true, event: "ping", scope: "system" }, { status: 202 });
  }

  return Response.json({ ok: true, message: "Webhook accepted by system" }, { status: 202 });
}
