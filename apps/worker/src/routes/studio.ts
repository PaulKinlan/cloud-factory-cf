import type { Env } from "../env";
import { AgentStudio, type AgentManifest } from "@factory-cloud/sdk";
import { SERVICES } from "../credentials/policy";
import { sameSecret } from "../secrets";
import { getRepoCoordinator } from "../repo-coordinator-addressing";

export const STUDIO_PATH =
  /^\/studio\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/(?<operation>author|simulate|agents)(?:\/(?<agentName>[^/]+))?$/;

/**
 * Routes natural language prompt-to-agent requests, simulation runs, and agent listings.
 */
export async function routeStudio(
  request: Request,
  env: Env,
  owner: string,
  repo: string,
  operation: string,
  agentName?: string,
): Promise<Response> {
  const studio = new AgentStudio();
  const workerPermissions = Object.entries(SERVICES).flatMap(([service, def]) =>
    Object.keys(def.actions).map((action) => ({ service, action })),
  );

  if (operation === "author") {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    const body = (await request.json().catch(() => null)) as { prompt?: string } | null;
    if (!body?.prompt) {
      return Response.json({ ok: false, error: "missing prompt" }, { status: 400 });
    }

    try {
      const manifest = await studio.author(body.prompt, {
        repoContext: { owner, repo },
        availablePermissions: workerPermissions,
        availableSinks: ["github-pr-review", "github-issue", "beads-task", "cloud-telemetry"],
      });
      return Response.json({ ok: true, manifest });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ ok: false, error: msg }, { status: 400 });
    }
  }

  if (operation === "simulate") {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    const body = (await request.json().catch(() => null)) as {
      manifest?: AgentManifest;
      event?: Record<string, unknown>;
      promptInput?: string;
    } | null;

    if (!body?.manifest) {
      return Response.json({ ok: false, error: "missing manifest" }, { status: 400 });
    }

    try {
      const result = await studio.simulate(
        {
          manifest: body.manifest,
          event: body.event,
          promptInput: body.promptInput,
        },
        {
          allowedCapabilities: workerPermissions,
        },
      );
      return Response.json({ ok: true, result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ ok: false, error: msg }, { status: 500 });
    }
  }

  if (operation === "agents") {
    const url = new URL(request.url);
    const platform = url.searchParams.get("platform");
    const stub = getRepoCoordinator(env, `${owner}/${repo}`, platform);

    if (request.method === "GET") {
      if (agentName) {
        const res = await stub.fetch(
          new Request(
            `https://repo-coordinator.internal/memory/agents:${encodeURIComponent(agentName)}`,
          ),
        );
        return res;
      }
      const res = await stub.fetch(
        new Request("https://repo-coordinator.internal/memory?prefix=agents:"),
      );
      return res;
    }

    if (request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        manifest?: AgentManifest;
      } | null;
      const manifest = body?.manifest;
      if (!manifest || !manifest.name || typeof manifest.name !== "string") {
        return Response.json(
          { ok: false, error: "missing manifest or manifest.name" },
          { status: 400 },
        );
      }

      // Validate manifest capabilities against SERVICES policy (fail-closed)
      const allowedCaps = new Set(
        workerPermissions.map((c) => `${c.service}:${c.action}`),
      );
      for (const cap of manifest.capabilities ?? []) {
        if (!allowedCaps.has(`${cap.service}:${cap.action}`)) {
          return Response.json(
            { ok: false, error: `Unauthorized capability: ${cap.service}:${cap.action}` },
            { status: 400 },
          );
        }
      }

      // Validate manifest sinks against registered sinks (fail-closed)
      const registeredSinks = new Set([
        "github-pr-review",
        "github-issue",
        "beads-task",
        "cloud-telemetry",
      ]);
      for (const sink of manifest.sinks ?? []) {
        if (!registeredSinks.has(sink.type)) {
          return Response.json(
            { ok: false, error: `Unregistered sink: ${sink.type}` },
            { status: 400 },
          );
        }
      }

      const res = await stub.fetch(
        new Request(
          `https://repo-coordinator.internal/memory/agents:${encodeURIComponent(manifest.name)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: manifest }),
          },
        ),
      );

      // If org or both, store in OrgCoordinator memory as well
      if (
        (manifest.memoryScope === "org" || manifest.memoryScope === "both") &&
        env.ORG_COORDINATOR
      ) {
        const orgStub = env.ORG_COORDINATOR.get(env.ORG_COORDINATOR.idFromName(owner));
        await orgStub.fetch(
          new Request(
            `https://org-coordinator.internal/memory/agents:${encodeURIComponent(manifest.name)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ value: manifest }),
            },
          ),
        );
      }

      return res;
    }

    return new Response("method not allowed", { status: 405 });
  }

  return new Response("not found", { status: 404 });
}

export async function handleStudio(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  const studio = STUDIO_PATH.exec(url.pathname);
  if (!studio?.groups) return null;

  const controlKey = env.BROKER_CONTROL_KEY;
  if (!controlKey) {
    return Response.json({ ok: false, error: "control key not configured" }, { status: 503 });
  }

  const providedKey = request.headers.get("x-factory-control-key");
  if (!(await sameSecret(controlKey, providedKey))) {
    return Response.json({ ok: false, error: "not authorised to access agent studio" }, { status: 401 });
  }

  const { owner, repo, operation, agentName } = studio.groups as {
    owner: string;
    repo: string;
    operation: string;
    agentName?: string;
  };
  return routeStudio(request, env, owner, repo, operation, agentName);
}
