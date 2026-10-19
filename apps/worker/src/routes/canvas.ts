import type { Env } from "../env";
import { runCanvasDocument } from "../canvas-runs";
import { sameSecret } from "../secrets";

export const CANVAS_PATH = /^\/canvas\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/documents(?:\/(?<id>[^/]+))?$/;
export const CANVAS_RUN_PATH = /^\/canvas\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/documents\/(?<id>[^/]+)\/run$/;

/**
 * Turns a stored canvas document into runs: the layout is the agent
 * configuration, so this is control-plane work and needs the control key.
 */
export async function routeCanvasRun(
  request: Request,
  env: Env,
  owner: string,
  repo: string,
  id: string,
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

  const result = await runCanvasDocument(
    {
      repository,
      controlKey,
      coordinator,
      broker: env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(repository)),
      ...(env.TELEMETRY_ENDPOINT === undefined ? {} : { telemetryEndpoint: env.TELEMETRY_ENDPOINT }),
    },
    id,
    limit === undefined ? {} : { limit },
  );
  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 400 });
  }
  return Response.json({ ok: true, ...result.report });
}

/**
 * Canvas documents live in the repository's coordinator object. They are
 * control-plane data (a layout names agents and actions), so every method needs
 * the same control key the broker uses.
 */
export async function routeCanvas(
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

export async function handleCanvas(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  const canvasRun = CANVAS_RUN_PATH.exec(url.pathname);
  if (canvasRun?.groups) {
    const { owner, repo, id } = canvasRun.groups as { owner: string; repo: string; id: string };
    return routeCanvasRun(request, env, owner, repo, id);
  }

  const canvas = CANVAS_PATH.exec(url.pathname);
  if (canvas?.groups) {
    const { owner, repo, id } = canvas.groups as { owner: string; repo: string; id?: string };
    return routeCanvas(request, env, owner, repo, id);
  }

  return null;
}
