import { describe, expect, it } from "vitest";
import { routeAdminSettings, routeAdminSystem } from "../src/routes/admin";
import { mintSessionToken } from "../src/routes/auth";
import type { Env } from "../src/env";

describe("repository GitHub App settings isolation", () => {
  it("does not promote a tenant session's GitHub App to the platform default broker", async () => {
    const writes: Array<{ repository: string; request: Request }> = [];
    const env = {
      BROKER_SIGNING_KEY: "tenant-session-signing-key",
      BROKER_CONTROL_KEY: "platform-control-key",
      CREDENTIAL_BROKER: {
        idFromName: (name: string) => name,
        get: (repository: string) => ({
          fetch: async (request: Request) => {
            writes.push({ repository, request });
            return Response.json({ ok: true });
          },
        }),
      },
    } as unknown as Env;
    const cookie = `cf_session=${await mintSessionToken(env.BROKER_SIGNING_KEY!, "alice")}`;
    const githubApp = { clientId: "tenant-client-id", clientSecret: "tenant-secret" };
    const request = new Request("https://factory.example/api/admin/settings/alice/widget", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ githubApp }),
    });

    const result = await routeAdminSettings(request, env, "alice", "widget");
    expect(result.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.repository).toBe("alice/widget");
    expect(await writes[0]?.request.json()).toEqual({ githubApp });
    expect(writes[0]?.request.headers.has("x-factory-control-key")).toBe(false);
    expect(writes[0]?.request.headers.has("x-factory-delegation")).toBe(true);

    // The root-only endpoint still manages default independently of tenant settings.
    const rootRequest = new Request("https://factory.example/api/admin/system", {
      method: "POST",
      headers: { "x-factory-control-key": env.BROKER_CONTROL_KEY!, "content-type": "application/json" },
      body: JSON.stringify({ githubApp: { clientId: "platform-client-id" } }),
    });
    expect((await routeAdminSystem(rootRequest, env)).status).toBe(200);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.repository).toBe("default");
  });
});
