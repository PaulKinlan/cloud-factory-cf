import type { AgentExecutionFn } from "@factory-cloud/sdk";
import type { Env } from "../env";
import { reviewRuntime } from "../review/bot";
import { drainRepository } from "../pipeline";
import { traceSink } from "../events";
import { sameSecret } from "../secrets";

export const RUN_PATH = /^\/runs\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/;

/**
 * Drains the repository's event queue through one agent run per event. This is
 * control-plane work: it issues the capabilities the run uses, so it needs the
 * control key. A scheduled handler can call the same function later.
 */
export async function routeRun(
  request: Request,
  env: Env,
  owner: string,
  repo: string,
): Promise<Response> {
  const controlKey = env.BROKER_CONTROL_KEY;
  if (!controlKey) {
    return Response.json({ ok: false, error: "control key not configured" }, { status: 503 });
  }
  if (!(await sameSecret(controlKey, request.headers.get("x-factory-control-key")))) {
    return Response.json({ ok: false, error: "not authorised to run agents" }, { status: 401 });
  }
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const repository = `${owner}/${repo}`;
  const body = (await request.json().catch(() => ({}))) as { limit?: unknown };
  const limit = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.trunc(body.limit) : undefined;

  const coordinator = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repository));
  const report = await drainRepository(
    {
      repository,
      controlKey,
      coordinator,
      broker: env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(repository)),
      onStep: traceSink(coordinator),
      // The deployment decides: with REVIEW_MODEL set the run reviews through
      // the model, otherwise the pipeline keeps its deterministic default.
      ...(reviewRuntime(env) === undefined ? {} : { executionFn: reviewRuntime(env) as AgentExecutionFn }),
      ...(env.TELEMETRY_ENDPOINT === undefined ? {} : { telemetryEndpoint: env.TELEMETRY_ENDPOINT }),
    },
    ...(limit === undefined ? [] : [{ limit }]),
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
