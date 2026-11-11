import type { Env } from "../env";
import { createDefaultExecutionFn, drainRepository } from "../pipeline";
import { reviewRuntime } from "../review/model";
import { traceSink } from "../events";
import { getRepoCoordinator } from "../repo-coordinator-addressing";
import { authorizeControlPlane, authzDenial } from "../auth/tenant";
import { mintDelegation } from "../auth/delegation";

export const RUN_PATH = /^\/runs\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/;

/**
 * Drains the repository's event queue through one agent run per event. This is
 * control-plane work for one tenant: it issues the capabilities the run uses.
 * The machine key keeps its any-tenant contract; a browser session may run its
 * own repository, and presents a short-lived delegation to the broker instead
 * of a key that names every tenant (cloud-factory-cf-ec98).
 */
/**
 * Hands the pipeline one delegation per broker request rather than one for the whole run
 * (cloud-factory-cf-tkfb): a delegation's `jti` is single-use in the broker, and a run
 * mints a capability for every (service, action) it touches, so reusing one token would be
 * refused on the second sink.
 *
 * `first` is the token the caller already minted to prove the deployment can mint at all;
 * it becomes the first one handed out instead of being thrown away.
 */
function delegationMinter(
  env: Env,
  repository: string,
  login: string,
  first?: string,
): () => Promise<string | undefined> {
  let next = first;
  return async () => {
    if (next !== undefined) {
      const token = next;
      next = undefined;
      return token;
    }
    return mintDelegation(env, { repository, login });
  };
}

export async function routeRun(
  request: Request,
  env: Env,
  owner: string,
  repo: string,
): Promise<Response> {
  const url = new URL(request.url);
  const platform = url.searchParams.get("platform");
  const authz = await authorizeControlPlane(request, env, { owner, platform });
  if (!authz.ok) {
    return authzDenial(authz, { unauthorised: "not authorised to run agents" });
  }
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const repository = `${owner}/${repo}`;
  const sessionLogin = authz.principal.via === "session" ? authz.principal.login : undefined;
  const firstDelegation =
    sessionLogin === undefined ? undefined : await mintDelegation(env, { repository, login: sessionLogin });
  if (sessionLogin !== undefined && firstDelegation === undefined) {
    return Response.json({ ok: false, error: "control key not configured" }, { status: 503 });
  }
  const delegation =
    sessionLogin === undefined
      ? undefined
      : delegationMinter(env, repository, sessionLogin, firstDelegation);
  const body = (await request.json().catch(() => ({}))) as {
    limit?: unknown;
    reviewer?: unknown;
    agentId?: unknown;
    agentPrompt?: unknown;
  };
  const limit = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.trunc(body.limit) : undefined;
  const agentPrompt = typeof body.agentPrompt === "string" ? body.agentPrompt : undefined;
  const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
  const reviewerParam = url.searchParams.get("reviewer");
  const useCoreReviewer =
    body.reviewer === "llm" ||
    body.reviewer === "core" ||
    body.agentId === "pr-reviewer" ||
    reviewerParam === "llm" ||
    reviewerParam === "core" ||
    // A deployment that configured a model reviews with it by default, so the alarm
    // and the manual lever behave the same way (cloud-factory-cf-7or graft).
    reviewRuntime(env) !== undefined;

  const coordinator = getRepoCoordinator(env, repository, platform);
  const report = await drainRepository(
    {
      repository,
      ...(delegation === undefined
        ? { controlKey: env.BROKER_CONTROL_KEY as string }
        : { delegation }),
      coordinator,
      broker: env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(repository)),
      onStep: traceSink(coordinator),
      ...(useCoreReviewer ? { executionFn: createDefaultExecutionFn(env) } : {}),
      ...(env.TELEMETRY_ENDPOINT === undefined ? {} : { telemetryEndpoint: env.TELEMETRY_ENDPOINT }),
    },
    {
      ...(limit === undefined ? {} : { limit }),
      ...(agentPrompt === undefined ? {} : { agentPrompt }),
      ...(agentId === undefined ? {} : { agentId }),
    },
  );

  return Response.json({ ok: true, ...report });
}

export async function handleRuns(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  const run = RUN_PATH.exec(url.pathname);
  if (!run?.groups) return null;
  const { owner, repo } = run.groups as { owner: string; repo: string };
  return routeRun(request, env, owner, repo);
}
