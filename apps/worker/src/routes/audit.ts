import type { Env } from "../env";
import { authorizeControlPlane, authzDenial, sessionMayAddressPlatform } from "../auth/tenant";
import { getRepoCoordinator } from "../repo-coordinator-addressing";

export const AUDIT_PATH =
  /^\/audit\/(?<domain>events|runs)\/(?<owner>[^/]+)\/(?<repo>[^/]+)(?:\/(?<id>[^/]+))?$/;

/**
 * Public control-plane route handler for Durable Object event audit logs and
 * historical run audit records (cloud-factory-cf-2ng.3).
 *
 *   GET /audit/events/:owner/:repo               historical event list (with stats)
 *   GET /audit/events/:owner/:repo/stats         status breakdown counts (pass ?counts=1 to force counts if delivery ID 'stats' exists)
 *   GET /audit/events/:owner/:repo/:deliveryId   detailed single-event audit with payload & deliveries
 *   GET /audit/runs/:owner/:repo                 canvas runs audit records
 *
 * Control-plane reads carry sensitive event payloads, prompts and actor metadata, so
 * every route needs the control key (machine callers) or a browser session bound to
 * the `:owner` it asks about (cloud-factory-cf-e1ql, see `auth/tenant.ts`).
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

  const authz = await authorizeControlPlane(request, env, { owner });
  if (!authz.ok) {
    return authzDenial(authz, {
      unauthorised: "not authorised to read audit logs",
      "cross-tenant": "not authorised to read another account's audit logs",
    });
  }

  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }

  const repository = `${owner}/${repo}`;
  const platform = url.searchParams.get("platform");
  // A platform hint addresses another provider, which is another tenant: a
  // session may not switch (cloud-factory-cf-fcwm), the machine key may.
  if (!sessionMayAddressPlatform(authz.principal, platform)) {
    return authzDenial(
      { ok: false, reason: "cross-tenant" },
      { "cross-tenant": "not authorised to read another provider's audit logs" },
    );
  }
  const coordinator = getRepoCoordinator(env, repository, platform);

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
    // If not explicitly requesting counts via ?counts=1, check if an event with deliveryId "stats" exists:
    if (url.searchParams.get("counts") !== "1") {
      const detailRes = await coordinator.fetch("https://repo-coordinator.internal/events/stats?detail=1");
      if (detailRes.ok) {
        const body = (await detailRes.json()) as Record<string, unknown>;
        return Response.json(body, { status: 200 });
      }
    }

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
    let deliveryId: string;
    try {
      deliveryId = decodeURIComponent(id);
    } catch {
      deliveryId = id;
    }
    const target = `https://repo-coordinator.internal/events/${encodeURIComponent(deliveryId)}`;
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
