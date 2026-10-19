import type { Env } from "../env";
import { sameSecret } from "../secrets";

export const AUDIT_PATH =
  /^\/audit\/(?<domain>events|runs)\/(?<owner>[^/]+)\/(?<repo>[^/]+)(?:\/(?<id>[^/]+))?$/;

/**
 * Public control-plane route handler for Durable Object event audit logs and
 * historical run audit records (cloud-factory-cf-2ng.3).
 *
 *   GET /audit/events/:owner/:repo               historical event list (with stats)
 *   GET /audit/events/:owner/:repo/stats         status breakdown counts
 *   GET /audit/events/:owner/:repo/:deliveryId   detailed single-event audit with payload & deliveries
 *   GET /audit/runs/:owner/:repo                 canvas runs audit records
 *
 * Control-plane reads carry sensitive event payloads, prompts and actor metadata,
 * so every route is protected by BROKER_CONTROL_KEY (header x-factory-control-key).
 */
export async function handleAudit(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  const match = AUDIT_PATH.exec(url.pathname);
  if (!match?.groups) return null;

  const { domain, owner, repo, id } = match.groups as {
    domain: "events" | "runs";
    owner: string;
    repo: string;
    id?: string;
  };

  const controlKey = env.BROKER_CONTROL_KEY;
  if (!controlKey) {
    return Response.json({ ok: false, error: "control key not configured" }, { status: 503 });
  }

  const providedKey = request.headers.get("x-factory-control-key");
  if (!(await sameSecret(controlKey, providedKey))) {
    return Response.json({ ok: false, error: "not authorised to read audit logs" }, { status: 401 });
  }

  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }

  const repository = `${owner}/${repo}`;
  const coordinator = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repository));

  if (domain === "runs") {
    if (id !== undefined) {
      return new Response("not found", { status: 404 });
    }
    const query = url.searchParams.toString();
    const target = `https://repo-coordinator.internal/runs/audit${query ? `?${query}` : ""}`;
    const res = await coordinator.fetch(target);
    const body = (await res.json()) as Record<string, unknown>;
    return Response.json(
      {
        repository,
        ...body,
      },
      { status: res.status },
    );
  }

  // domain === "events"
  if (id === "stats") {
    const res = await coordinator.fetch("https://repo-coordinator.internal/events/stats");
    const body = (await res.json()) as { ok?: boolean; counts?: Record<string, number> };
    return Response.json(
      {
        ok: true,
        repository,
        stats: body?.counts ?? {},
      },
      { status: res.status },
    );
  }

  if (id !== undefined && id.length > 0) {
    const target = `https://repo-coordinator.internal/events/${encodeURIComponent(id)}`;
    const res = await coordinator.fetch(target);
    const body = (await res.json()) as Record<string, unknown>;
    return Response.json(body, { status: res.status });
  }

  // Event list with optional query params (limit, status, deliveryId, event)
  const query = url.searchParams.toString();
  const target = `https://repo-coordinator.internal/events${query ? `?${query}` : ""}`;
  const [eventsRes, statsRes] = await Promise.all([
    coordinator.fetch(target),
    coordinator.fetch("https://repo-coordinator.internal/events/stats"),
  ]);

  if (!eventsRes.ok) {
    return eventsRes;
  }

  const eventsBody = (await eventsRes.json()) as { ok: boolean; count: number; events: unknown[] };
  const statsBody = statsRes.ok ? ((await statsRes.json()) as { counts?: Record<string, number> }) : null;

  return Response.json({
    ok: true,
    repository,
    count: eventsBody.count,
    stats: statsBody?.counts ?? {},
    events: eventsBody.events,
  });
}
