import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken } from "../src/routes/auth";
import { BROKER_PATH } from "../src/routes/broker";

/**
 * Every `/broker/:owner/:repo/:operation` route is control-plane work on one tenant's
 * broker, so it goes through the same gate as every other control-plane route, bound to
 * the tenant in the path (cloud-factory-cf-8t4t, -1osx).
 *
 * What this pins:
 *
 * - Anonymous callers are refused at the Worker. The route used to forward whatever
 *   `x-factory-control-key` arrived and leave authentication to the Durable Object.
 * - A browser session is a *tenant* credential: it reaches its own login's broker and
 *   another login's is a 403 `cross-tenant` refusal, not a weaker retry.
 * - A session's request is forwarded as a delegation scoped to that one repository, so
 *   the object never needs the master key for a browser (the master key names every
 *   tenant, which is exactly what a browser must not be given).
 * - The platform owner's session keeps the documented "any tenant" contract, but as a
 *   session: a delegation naming its login, never the deployment key (cloud-factory-cf-l6ya).
 * - The machine-key operations (`provisioning`, `overrides`, `audit`) refuse every browser
 *   session, the platform owner's included; only machine callers reach the deployment's key.
 * - `proxy` is left to the object: it authorises a capability token in the body, which
 *   is minted for one repository, and that is all an agent runner holds.
 *
 * Each case owns its repository, so Durable Object state never crosses a test.
 */
const CONTROL_KEY = "test-control-key";
const SIGNING_KEY = "test-broker-signing-key";

function brokerUrl(repository: string, operation: string, query = ""): string {
  return `https://example.com/broker/${repository}/${operation}${query ? `?${query}` : ""}`;
}

function permissionsUrl(repository: string, query = "service=github&action=pr.comment"): string {
  return brokerUrl(repository, "permissions", query);
}

async function session(login: string): Promise<string> {
  return `cf_session=${await mintSessionToken(SIGNING_KEY, login)}`;
}

function post(repository: string, operation: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(brokerUrl(repository, operation), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("/broker route pattern", () => {
  // A static import of the route module, so the gate's changed-file selection maps
  // apps/worker/src/routes/broker.ts to this suite instead of reporting it unmapped:
  // the test drives the route through the Worker's dynamic import of src/index, which
  // no static dependency graph can attribute to this file.
  it("covers every operation these tests exercise", () => {
    for (const operation of [
      "capabilities",
      "permissions",
      "provisioning",
      "overrides",
      "proxy",
      "audit",
      "settings",
    ]) {
      expect(BROKER_PATH.test(`/broker/acme/widgets/${operation}`)).toBe(true);
    }
  });
});

describe("/broker/:owner/:repo/permissions authorisation", () => {
  it("refuses an anonymous caller", async () => {
    const response = await SELF.fetch(permissionsUrl("acme/route-authz-anon"));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it("refuses a caller presenting the wrong control key", async () => {
    const response = await SELF.fetch(permissionsUrl("acme/route-authz-wrong"), {
      headers: { "x-factory-control-key": "not-the-control-key" },
    });

    expect(response.status).toBe(401);
  });

  it("answers the control plane", async () => {
    const response = await SELF.fetch(permissionsUrl("acme/route-authz-key"), {
      headers: { "x-factory-control-key": CONTROL_KEY },
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; permitted: boolean };
    expect(payload.ok).toBe(true);
    expect(typeof payload.permitted).toBe("boolean");
  });

  it("lets a browser session read its own tenant's policy", async () => {
    const response = await SELF.fetch(permissionsUrl("octodev/route-authz-session"), {
      headers: { cookie: await session("octodev") },
    });

    expect(response.status).toBe(200);
  });

  it("refuses a session for another account's tenant", async () => {
    const response = await SELF.fetch(permissionsUrl("octodev/route-authz-cross"), {
      headers: { cookie: await session("intruder") },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.stringContaining("another account") });
  });
});

describe("/broker/:owner/:repo other operations go through the same tenant gate", () => {
  it("refuses an anonymous provisioning write at the Worker, not at the object", async () => {
    const response = await post("acme/route-authz-provision-anon", "provisioning", {
      agent: "anon",
      service: "github",
      action: "pr.comment",
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.stringContaining("not authorised") });
  });

  it("refuses a forged delegation instead of forwarding it", async () => {
    const response = await post(
      "acme/route-authz-forged-delegation",
      "capabilities",
      { agent: "forged", service: "github", action: "pr.comment" },
      { "x-factory-delegation": "not.a.delegation" },
    );

    expect(response.status).toBe(401);
  });

  it("binds a session's settings write to its own tenant, as a delegation", async () => {
    const repository = "octodev/route-authz-settings";
    const write = await post(
      repository,
      "settings",
      { githubApp: { appId: "4242", appSlug: "octodev-app", clientId: "client", clientSecret: "secret" } },
      { cookie: await session("octodev") },
    );
    expect(write.status).toBe(200);

    // The write landed in that repository's object, read back with the machine key.
    const read = await SELF.fetch(brokerUrl(repository, "settings"), {
      headers: { "x-factory-control-key": CONTROL_KEY },
    });
    expect(read.status).toBe(200);
    const payload = (await read.json()) as { githubApp: { appId: string; appSlug: string } };
    expect(payload.githubApp.appId).toBe("4242");
    expect(payload.githubApp.appSlug).toBe("octodev-app");
  });

  it("refuses that same session on another tenant's settings", async () => {
    const response = await post(
      "victimorg/route-authz-settings",
      "settings",
      { githubApp: { appId: "1", appSlug: "x", clientId: "c", clientSecret: "s" } },
      { cookie: await session("octodev") },
    );

    expect(response.status).toBe(403);
  });

  it("refuses a session the machine-key operations with a 403 that names the requirement", async () => {
    const response = await post(
      "octodev/route-authz-provision-session",
      "provisioning",
      { agent: "runner", service: "github", action: "pr.comment" },
      { cookie: await session("octodev") },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("machine control key"),
    });
  });

  it("refuses the platform owner's browser session the machine-key operations too (cloud-factory-cf-l6ya)", async () => {
    // The platform owner's tenant scope is the whole deployment (ADR 006), but provisioning
    // is a machine action: the route must never hand a browser cookie the deployment's
    // control key. Before this, `authorizeControlPlane` rewrote the session to
    // `via: "control-key"` and this write succeeded.
    const repository = "octodev/route-authz-provision-root";
    const write = await post(
      repository,
      "provisioning",
      { agent: "runner", service: "github", action: "pr.comment" },
      { cookie: await session("__root__") },
    );
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("machine control key"),
    });

    // The same refusal for an owner named by the deployment allowlist rather than the
    // synthetic root subject.
    const bindings = { ...env, PLATFORM_OWNERS: "octodev" };
    const handler = await import("../src/index").then((module) => module.default);
    const allowlisted = await handler.fetch(
      new Request(brokerUrl("octodev/route-authz-provision-owner", "provisioning"), {
        method: "POST",
        headers: { "content-type": "application/json", cookie: await session("octodev") },
        body: JSON.stringify({ agent: "runner", service: "github", action: "pr.comment" }),
      }),
      bindings as never,
    );
    expect(allowlisted.status).toBe(403);
  });

  it("keeps the platform owner's any-tenant reach, as a delegation naming its login", async () => {
    const repository = "victimorg/route-authz-owner-settings";
    const bindings = { ...env, PLATFORM_OWNERS: "octodev" };
    const handler = await import("../src/index").then((module) => module.default);
    const write = await handler.fetch(
      new Request(brokerUrl(repository, "settings"), {
        method: "POST",
        headers: { "content-type": "application/json", cookie: await session("octodev") },
        body: JSON.stringify({
          githubApp: { appId: "9911", appSlug: "owner-app", clientId: "client", clientSecret: "secret" },
        }),
      }),
      bindings as never,
    );
    expect(write.status).toBe(200);

    // The object minted no master-key path: the write is visible only through the
    // tenant's own broker, read back here with the machine key.
    const read = await SELF.fetch(brokerUrl(repository, "settings"), {
      headers: { "x-factory-control-key": CONTROL_KEY },
    });
    expect(read.status).toBe(200);
    const payload = (await read.json()) as { githubApp: { appId: string } };
    expect(payload.githubApp.appId).toBe("9911");
  });

  it("keeps the machine contract: the control key reaches any tenant", async () => {
    const response = await post(
      "victimorg/route-authz-machine",
      "provisioning",
      { agent: "ci", service: "github", action: "pr.comment" },
      { "x-factory-control-key": CONTROL_KEY },
    );

    expect(response.status).toBe(200);
  });

  it("still serves a session when BROKER_CONTROL_KEY is unset", async () => {
    const bindings = { ...env, BROKER_CONTROL_KEY: undefined };
    const handler = await import("../src/index").then((module) => module.default);
    const response = await handler.fetch(
      new Request(brokerUrl("octodev/route-authz-keyless", "permissions", "service=github&action=pr.comment"), {
        headers: { cookie: await session("octodev") },
      }),
      bindings as never,
    );

    expect(response.status).toBe(200);
  });
});
