import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken } from "../src/routes/auth";

/**
 * `/broker/:owner/:repo/permissions` reports policy state - whether a service/action is
 * permitted, and whether the repository narrows it - and the broker object serves it
 * with no check of its own, so this Worker route is the only place that can gate it
 * (cloud-factory-cf-1osx). Before the fix any anonymous caller could read it.
 *
 * The other broker operations are gated inside the Durable Object (`capabilities`,
 * `provisioning`, `overrides`, `audit`, `settings` verify the control key or a
 * delegation header), so they are deliberately not gated twice at the route: the
 * delegation credential is not a control-plane credential and re-gating would refuse it.
 *
 * Each case owns its repository, so the Durable Object state never crosses a test.
 */
const CONTROL_KEY = "test-control-key";
const SIGNING_KEY = "test-broker-signing-key";

function permissionsUrl(repository: string, query = "service=github&action=pr.comment"): string {
  return `https://example.com/broker/${repository}/permissions?${query}`;
}

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
    const token = await mintSessionToken(SIGNING_KEY, "octodev");
    const response = await SELF.fetch(permissionsUrl("octodev/route-authz-session"), {
      headers: { cookie: `cf_session=${token}` },
    });

    expect(response.status).toBe(200);
  });

  it("refuses a session for another account's tenant", async () => {
    const token = await mintSessionToken(SIGNING_KEY, "intruder");
    const response = await SELF.fetch(permissionsUrl("octodev/route-authz-cross"), {
      headers: { cookie: `cf_session=${token}` },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false });
  });
});
