import type { Env } from "./env";
import { runCanvasDocument } from "./canvas-runs";
import { drainRepository } from "./pipeline";
import { sameSecret } from "./secrets";
import { MAX_WEBHOOK_BYTES } from "./webhooks";
import { AgentStudio, type AgentManifest } from "@factory-cloud/sdk";
import { SERVICES } from "./credentials/policy";

// Durable Object classes are resolved from the Worker's main module, so they
// have to be exported here (see `durable_objects` in wrangler.jsonc).
export { CredentialBroker } from "./credential-broker-object";
export { OrgCoordinator } from "./org-coordinator";
export { RepoCoordinator } from "./repo-coordinator";

const WEBHOOK_PATH = /^\/webhooks\/(?<provider>github|gitlab)\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/;
const CANVAS_PATH = /^\/canvas\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/documents(?:\/(?<id>[^/]+))?$/;
const CANVAS_RUN_PATH = /^\/canvas\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/documents\/(?<id>[^/]+)\/run$/;
const RUN_PATH = /^\/runs\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/;
const BROKER_PATH =
  /^\/broker\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/(?<operation>capabilities|permissions|provisioning|overrides|proxy|audit)$/;
const STUDIO_PATH =
  /^\/studio\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/(?<operation>author|simulate|agents)(?:\/(?<agentName>[^/]+))?$/;

/**
 * Serves the built canvas from the ASSETS binding. Unknown paths stay a 404 (the
 * canvas is a single route at "/", so there is no SPA fallback to lean on) and
 * writes are refused for assets: only GET/HEAD pass through.
 */
async function serveAsset(request: Request, env: Env): Promise<Response> {
  if (!env.ASSETS) return new Response("not found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 404) return new Response("not found", { status: 404 });
  return asset;
}

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

    const broker = BROKER_PATH.exec(url.pathname);
    if (broker?.groups) {
      const { owner, repo, operation } = broker.groups as {
        owner: string;
        repo: string;
        operation: string;
      };
      return routeBroker(request, env, owner, repo, operation, url.search);
    }

    const studio = STUDIO_PATH.exec(url.pathname);
    if (studio?.groups) {
      const { owner, repo, operation, agentName } = studio.groups as {
        owner: string;
        repo: string;
        operation: string;
        agentName?: string;
      };
      return routeStudio(request, env, owner, repo, operation, agentName);
    }

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


    const run = RUN_PATH.exec(url.pathname);
    if (run?.groups) {
      const { owner, repo } = run.groups as { owner: string; repo: string };
      return routeRun(request, env, owner, repo);
    }

    const match = WEBHOOK_PATH.exec(url.pathname);
    if (!match?.groups) {
      return serveAsset(request, env);
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    // Refuse oversized payloads before buffering them into a string.
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
      return Response.json({ ok: false, error: "payload too large" }, { status: 413 });
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
 * Drains the repository's event queue through one agent run per event. This is
 * control-plane work: it issues the capabilities the run uses, so it needs the
 * control key. A scheduled handler can call the same function later.
 */
async function routeRun(request: Request, env: Env, owner: string, repo: string): Promise<Response> {
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

  const report = await drainRepository(
    {
      repository,
      controlKey,
      coordinator: env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repository)),
      broker: env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(repository)),
    },
    ...(limit === undefined ? [] : [{ limit }]),
  );

  return Response.json({ ok: true, ...report });
}

/**
 * Turns a stored canvas document into runs: the layout is the agent
 * configuration, so this is control-plane work and needs the control key.
 */
async function routeCanvasRun(
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
async function routeCanvas(
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

async function routeBroker(
  request: Request,
  env: Env,
  owner: string,
  repo: string,
  operation: string,
  search: string,
): Promise<Response> {
  if (operation === "permissions" || operation === "audit") {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
  } else if (operation === "provisioning" || operation === "overrides") {
    if (!["GET", "POST", "DELETE"].includes(request.method)) {
      return new Response("method not allowed", { status: 405 });
    }
  } else if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const stub = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(`${owner}/${repo}`));
  const forwarded = new Request(
    `https://credential-broker.internal/${operation}${search}`,
    {
      method: request.method,
      headers: brokerHeaders(request.headers),
      body: request.method === "POST" || request.method === "DELETE" ? await request.text() : undefined,
    },
  );
  return stub.fetch(forwarded);
}

function brokerHeaders(headers: Headers): Headers {
  const forwarded = new Headers({ "content-type": "application/json" });
  const controlKey = headers.get("x-factory-control-key");
  if (controlKey !== null) forwarded.set("x-factory-control-key", controlKey);
  return forwarded;
}

/**
 * Routes natural language prompt-to-agent requests, simulation runs, and agent listings.
 */
async function routeStudio(
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
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`${owner}/${repo}`));

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

/**
 * Copy only the headers the coordinator acts on. Replaying the inbound
 * `content-length`/`host` on a new Request with a different body is a
 * foot-gun in the Workers runtime.
 */
function forwardableHeaders(headers: Headers, repository: string): Headers {
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
