import { describe, expect, it } from "vitest";
import { routeAdminSettings, routeAdminTestPing, routeAdminUserSettings } from "../src/routes/admin";
import { mintSessionToken } from "../src/routes/auth";
import type { Env } from "../src/env";

/**
 * `?platform=` is part of the tenant identity, not a cosmetic hint (ADR 003:
 * `github:acme/x` and `gitlab:acme/x` are different repositories held by different
 * tenants), while the CredentialBroker object is keyed by `owner/repo` alone - the same
 * object serves every provider. So the *authorisation* is the only place that can keep
 * providers apart, and it has to be told which provider the request names
 * (cloud-factory-cf-9xc0, same class as -fcwm and -tw9d for the audit/trace routes).
 *
 * The stub env records every broker fetch, so a refusal is proven by "nothing was
 * forwarded" rather than by the status code alone.
 */
const SIGNING_KEY = "tenant-session-signing-key";
const CONTROL_KEY = "platform-control-key";

function testEnv(): { env: Env; calls: Array<{ repository: string; request: Request }> } {
  const calls: Array<{ repository: string; request: Request }> = [];
  const env = {
    BROKER_SIGNING_KEY: SIGNING_KEY,
    BROKER_CONTROL_KEY: CONTROL_KEY,
    CREDENTIAL_BROKER: {
      idFromName: (name: string) => name,
      get: (repository: string) => ({
        fetch: async (request: Request) => {
          calls.push({ repository, request });
          return Response.json({ ok: true });
        },
      }),
    },
  } as unknown as Env;
  return { env, calls };
}

async function sessionCookie(login: string): Promise<string> {
  return `cf_session=${await mintSessionToken(SIGNING_KEY, login)}`;
}

const SETTINGS_BODY = JSON.stringify({ githubApp: { clientId: "tenant-client", clientSecret: "tenant-secret" } });

describe("admin settings authorisation is bound to the provider (cloud-factory-cf-9xc0)", () => {
  it("refuses a GitHub session that names another provider, without forwarding anything", async () => {
    const { env, calls } = testEnv();
    const request = new Request("https://factory.example/api/admin/settings/alice/widget?platform=gitlab", {
      method: "POST",
      headers: { cookie: await sessionCookie("alice"), "content-type": "application/json" },
      body: SETTINGS_BODY,
    });

    const response = await routeAdminSettings(request, env, "alice", "widget", "?platform=gitlab");

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it("still answers the same session for its own provider", async () => {
    const { env, calls } = testEnv();
    const request = new Request("https://factory.example/api/admin/settings/alice/widget?platform=github", {
      method: "POST",
      headers: { cookie: await sessionCookie("alice"), "content-type": "application/json" },
      body: SETTINGS_BODY,
    });

    const response = await routeAdminSettings(request, env, "alice", "widget", "?platform=github");

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.headers.get("x-factory-delegation")).toBeTruthy();
  });

  it("keeps the machine contract: the control key may name any provider", async () => {
    const { env, calls } = testEnv();
    const request = new Request("https://factory.example/api/admin/settings/alice/widget?platform=gitlab", {
      method: "POST",
      headers: { "x-factory-control-key": CONTROL_KEY, "content-type": "application/json" },
      body: SETTINGS_BODY,
    });

    const response = await routeAdminSettings(request, env, "alice", "widget", "?platform=gitlab");

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("refuses a GitHub session naming another provider on user settings too", async () => {
    const { env, calls } = testEnv();
    const request = new Request("https://factory.example/api/admin/user-settings?owner=alice&platform=gitea", {
      method: "POST",
      headers: { cookie: await sessionCookie("alice"), "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-sol" }),
    });

    const response = await routeAdminUserSettings(request, env, "alice", "?owner=alice&platform=gitea");

    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses a GitHub session naming another provider on a repository test ping", async () => {
    const { env, calls } = testEnv();
    const request = new Request("https://factory.example/api/admin/test-ping/alice/widget?platform=gitlab", {
      method: "POST",
      headers: { cookie: await sessionCookie("alice") },
    });

    const response = await routeAdminTestPing(request, env, "alice", "widget");

    expect(response.status).toBe(403);
    // The ping reads the webhook secret from the broker before dispatching: a refusal
    // must happen before that read, not after it.
    expect(calls).toEqual([]);
  });
});
