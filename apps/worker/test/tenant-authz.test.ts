import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The GitHub OAuth session as a tenant-bound control-plane credential
 * (cloud-factory-cf-e1ql).
 *
 * Before this, every control-plane route accepted exactly one credential: the
 * `BROKER_CONTROL_KEY` server secret, which names no tenant. These tests pin the
 * contract that replaced it — a browser session may do what its own login may do,
 * `:owner` in the path is the tenant boundary, and the machine key keeps its
 * "any tenant" contract.
 */

const SIGNING_KEY = "test-broker-signing-key"; // BROKER_SIGNING_KEY in vitest.config.ts
const CONTROL_KEY = "test-control-key"; // BROKER_CONTROL_KEY in vitest.config.ts

async function sign(data: string, secret: string = SIGNING_KEY): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A cookie exactly the shape `/auth/github/callback` mints (`login.exp.hmac`). */
async function session(login: string, ttlSeconds = 900, secret = SIGNING_KEY): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `cf_session=${login}.${exp}.${await sign(`${login}.${exp}`, secret)}`;
}

/** Call the real Worker with the given bindings (the suite's env by default). */
async function call(
  path: string,
  init: RequestInit = {},
  bindings: unknown = env,
): Promise<Response> {
  const handler = await import("../src/index").then((m) => m.default);
  return handler.fetch(new Request(`https://factory.example${path}`, init), bindings as never);
}

const AUDIT = "/audit/events/octodev/widget-service";

describe("tenant-bound control-plane sessions (cloud-factory-cf-e1ql)", () => {
  it("reads its own tenant's audit log from the session cookie alone", async () => {
    const res = await call(AUDIT, { headers: { cookie: await session("octodev") } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; repository: string };
    expect(body.ok).toBe(true);
    expect(body.repository).toBe("octodev/widget-service");
  });

  it("treats the owner segment as case-insensitive, like a GitHub login", async () => {
    const res = await call("/audit/events/OctoDev/widget-service", {
      headers: { cookie: await session("octodev") },
    });
    expect(res.status).toBe(200);
  });

  it("refuses another tenant's audit log with 403, not a weaker credential", async () => {
    const res = await call("/audit/events/victimorg/widget-service", {
      headers: { cookie: await session("octodev") },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("another account");
  });

  it("refuses forged and expired sessions with 401", async () => {
    const exp = Math.floor(Date.now() / 1000) + 900;
    const forged = await call(AUDIT, {
      headers: { cookie: `cf_session=octodev.${exp}.${"0".repeat(64)}` },
    });
    expect(forged.status).toBe(401);

    const expired = await call(AUDIT, { headers: { cookie: await session("octodev", -10) } });
    expect(expired.status).toBe(401);

    // A correctly signed login cannot be retargeted at another owner.
    const retargeted = await call("/audit/events/victimorg/widget-service", {
      headers: { cookie: `cf_session=victimorg.${exp}.${await sign(`octodev.${exp}`)}` },
    });
    expect(retargeted.status).toBe(401);
  });

  it("keeps the machine contract: the control key still reads any tenant", async () => {
    const res = await call("/audit/events/victimorg/widget-service", {
      headers: { "x-factory-control-key": CONTROL_KEY },
    });
    expect(res.status).toBe(200);
  });

  it("serves a session when BROKER_CONTROL_KEY is unset — no master key needed", async () => {
    const bindings = { ...env, BROKER_CONTROL_KEY: undefined };
    const browser = await call(
      AUDIT,
      { headers: { cookie: await session("octodev") } },
      bindings,
    );
    expect(browser.status).toBe(200);

    // Machine callers have no credential left to present, so they get a plain 401
    // rather than a configuration error: the deployment is valid, they just are not
    // authorised.
    const machine = await call(
      AUDIT,
      { headers: { "x-factory-control-key": CONTROL_KEY } },
      bindings,
    );
    expect(machine.status).toBe(401);
  });

  it("fails closed with 503 when neither a control key nor a session key is configured", async () => {
    const bindings = {
      ...env,
      BROKER_CONTROL_KEY: undefined,
      BROKER_SIGNING_KEY: undefined,
      WEBHOOK_SECRET: undefined,
    };
    const anonymous = await call(AUDIT, {}, bindings);
    expect(anonymous.status).toBe(503);
    expect(((await anonymous.json()) as { error: string }).error).toContain("not configured");

    const browser = await call(AUDIT, { headers: { cookie: await session("octodev") } }, bindings);
    expect(browser.status).toBe(503);
  });

  it("refuses a session signed with WEBHOOK_SECRET — a webhook secret is not a session key (cloud-factory-cf-8e7r)", async () => {
    // The mint path stopped accepting WEBHOOK_SECRET in owqq; verification must state the
    // same rule, or the day someone mints with it the cookie is accepted here.
    const webhookSecret = env.WEBHOOK_SECRET as string;
    const forged = await session("octodev", 900, webhookSecret);

    const bindings = { ...env, BROKER_CONTROL_KEY: undefined };
    const res = await call(AUDIT, { headers: { cookie: forged } }, bindings);
    expect(res.status).toBe(401);

    // The legitimate session key still works in the same configuration.
    const ok = await call(AUDIT, { headers: { cookie: await session("octodev") } }, bindings);
    expect(ok.status).toBe(200);
  });

  it("refuses a session that switches provider on any tenant route (cloud-factory-cf-fcwm)", async () => {
    // Same `owner/repo` on another provider is another tenant. The trace was the reported
    // instance (tw9d); these are the other session-authorised routes that take a platform
    // hint, all of which honoured it after an owner-only check.
    const routes = [
      "/audit/events/octodev/widget-service?platform=gitlab",
      "/canvas/octodev/widget-service/documents?platform=gitlab",
      "/studio/octodev/widget-service/agents?platform=gitlab",
      "/analysis/octodev/widget-service/tree?platform=gitlab",
    ];
    for (const route of routes) {
      const cross = await call(route, { headers: { cookie: await session("octodev") } });
      expect(cross.status, `${route} must refuse a provider switch for a session`).toBe(403);

      const own = await call(route.replace("platform=gitlab", "platform=github"), {
        headers: { cookie: await session("octodev") },
      });
      expect(own.status, `${route} must still serve the session on github`).not.toBe(403);

      // The machine key names no tenant, so it keeps addressing any provider.
      const machine = await call(route, { headers: { "x-factory-control-key": CONTROL_KEY } });
      expect(machine.status, `${route} must still serve the machine key`).not.toBe(403);
    }
  });

  it("binds canvas documents to the session's own tenant", async () => {
    const own = await call("/canvas/octodev/widget-service/documents", {
      headers: { cookie: await session("octodev") },
    });
    const machine = await call("/canvas/octodev/widget-service/documents", {
      headers: { "x-factory-control-key": CONTROL_KEY },
    });
    expect(own.status).toBe(machine.status);
    expect(own.status).not.toBe(401);

    const crossTenant = await call("/canvas/victimorg/widget-service/documents", {
      headers: { cookie: await session("octodev") },
    });
    expect(crossTenant.status).toBe(403);
  });

  it("binds the agent studio and git-tree ingestion to the session's own tenant", async () => {
    const studio = await call("/studio/octodev/widget-service/agents", {
      headers: { cookie: await session("octodev") },
    });
    expect(studio.status).toBe(200);
    const crossStudio = await call("/studio/victimorg/widget-service/agents", {
      headers: { cookie: await session("octodev") },
    });
    expect(crossStudio.status).toBe(403);

    const tree = await call("/analysis/octodev/widget-service/tree", {
      headers: { cookie: await session("octodev") },
    });
    const machineTree = await call("/analysis/octodev/widget-service/tree", {
      headers: { "x-factory-control-key": CONTROL_KEY },
    });
    expect(tree.status).toBe(machineTree.status);
    expect(tree.status).not.toBe(401);

    const crossTree = await call("/analysis/victimorg/widget-service/tree", {
      headers: { cookie: await session("octodev") },
    });
    expect(crossTree.status).toBe(403);
  });
});

/**
 * A GitHub login that collides with a reserved CredentialBroker scope
 * (cloud-factory-cf-htc0).
 *
 * User settings are addressed by `idFromName(login.toLowerCase())`, and "default" /
 * "global" are the reserved scopes that hold PLATFORM settings (github.private_key,
 * webhook.secret, platform.owners). A login named "default" therefore received a
 * delegation for `repository: "default"` and could read and write the platform scope.
 */
describe("reserved broker scopes are not tenant addresses (cloud-factory-cf-htc0)", () => {
  it("refuses platform-scope names as a user-settings owner, whatever the casing", async () => {
    for (const address of ["default", "DEFAULT", "Default", "global"]) {
      const res = await call(`/api/admin/user-settings/${address}`, {
        headers: { "x-factory-control-key": CONTROL_KEY },
      });
      expect(res.status, `${address} must be refused as a tenant`).toBe(403);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("reserved broker scope");
    }
  });

  it("still forwards a real login to its own broker scope", async () => {
    const res = await call("/api/admin/user-settings/octodev", {
      headers: { "x-factory-control-key": CONTROL_KEY },
    });
    expect(res.status).not.toBe(403);
  });
});
