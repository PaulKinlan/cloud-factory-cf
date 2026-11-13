import type { Env } from "../env";
import { MAX_WEBHOOK_BYTES, verifyGithubSignature } from "../webhooks";
import { readBodyWithinLimit } from "../events/helpers";
import { resolveRepositoryKey } from "../repo-coordinator-addressing";

/**
 * Header carrying the repository spelling the caller used BEFORE canonicalisation
 * (cloud-factory-cf-n23o). The coordinator probes it as a migration candidate, so
 * history stored under a pre-canonicalisation spelling (GitHub's own casing, or an
 * un-prefixed legacy object) stays reachable from the canonical object.
 */
export const LEGACY_REPOSITORY_HEADER = "x-factory-legacy-repository";

export const WEBHOOK_PATH = /^\/webhooks\/(?<provider>github|gitlab|gitea)\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/;
export const GLOBAL_GITHUB_WEBHOOK_PATH = "/webhooks/github";

/**
 * Copy only the headers the coordinator acts on. Replaying the inbound
 * `content-length`/`host` on a new Request with a different body is a
 * foot-gun in the Workers runtime.
 */
export function forwardableHeaders(
  headers: Headers,
  repository: string,
  repositoryAsSpelled?: string,
): Headers {
  const forwarded = new Headers({ "x-factory-repository": repository });
  if (repositoryAsSpelled) {
    forwarded.set(LEGACY_REPOSITORY_HEADER, repositoryAsSpelled);
  }
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

  // Refuse oversized payloads before buffering them into a string - and enforce the
  // same cap while reading, because a chunked request declares no length at all
  // (cloud-factory-cf-v0xd / cloud-factory-cf-vtmf).
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
    return Response.json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const bodyText = await readBodyWithinLimit(request, MAX_WEBHOOK_BYTES);
  if (bodyText === null) {
    return Response.json({ ok: false, error: "payload too large" }, { status: 413 });
  }

  // One Durable Object per repository: the coordinator serialises every
  // event for a repo, which is what makes dedupe cheap and ordering real.
  //
  // The platform here comes from the PATH, so it is the authority on which provider this
  // delivery belongs to - and the repository text must not be able to contradict it.
  // `resolveRepositoryKey` returns an already-prefixed key unchanged, which is right for
  // `?platform=` and for internal callers but wrong at the edge: `/webhooks/gitlab/github:acme
  // /widgets` builds the string `github:acme/widgets`, which parses as a prefixed key, so a
  // GITLAB delivery was addressed to the GITHUB coordinator for acme/widgets - cross-provider
  // key spoofing from URL text alone (cloud-factory-cf-6eqm). A colon is the key separator, so
  // an owner or repository segment may not contain one at all. The colon refusal below is
  // what makes the resolver's prefix handling inert here, so resolving through it (rather
  // than building the key directly) costs nothing and keeps ONE canonicaliser for every
  // ingress branch - the path branch and the payload branch must never fork (n23o).
  const repository = `${owner}/${repo}`;
  if (repository.includes(":")) {
    return Response.json({ ok: false, error: "invalid repository" }, { status: 400 });
  }
  const repoKey = resolveRepositoryKey(repository, provider);
  const stub = env.REPO_COORDINATOR.get(
    env.REPO_COORDINATOR.idFromName(repoKey),
  );

  const forwarded = new Request(
    `https://repo-coordinator.internal/events?provider=${encodeURIComponent(provider)}`,
    {
      method: "POST",
      headers: forwardableHeaders(request.headers, repoKey, repository),
      body: bodyText,
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

  // A chunked request declares no length, so the cap must also hold while reading: this
  // delivery is unauthenticated until the signature check below (cloud-factory-cf-v0xd).
  const bodyText = await readBodyWithinLimit(request, MAX_WEBHOOK_BYTES);
  if (bodyText === null) {
    return Response.json({ ok: false, error: "payload too large" }, { status: 413 });
  }

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
  //
  // The name comes from the BODY, and it is shaped like the path segments: one owner, one
  // repository, no separators of our own inside either half. A `full_name` of
  // `github:acme/widgets` would otherwise build a key whose repository part still carries a
  // prefix, addressing a coordinator that is not the repository the event names - the same
  // class as cloud-factory-cf-6eqm, at the other entry point. The signature check above is
  // what authenticates the caller; this is what stops the key drifting from what it names.
  const repoFullName = payload.repository?.full_name;
  if (typeof repoFullName === "string" && /^[^/:\s]+\/[^/:\s]+$/.test(repoFullName)) {
    const repoKey = resolveRepositoryKey(repoFullName, "github");
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repoKey));
    // The payload casing is GitHub's own canonical spelling - exactly how pre-canonicalisation
    // objects were named, so it is the strongest migration hint this request can carry.
    const forwarded = new Request(
      `https://repo-coordinator.internal/events?provider=github`,
      {
        method: "POST",
        headers: forwardableHeaders(request.headers, repoKey, repoFullName),
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
