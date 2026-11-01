import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BROKER_INTERNAL_LOGIN, brokerInternalHeaders, mintDelegation } from "../src/auth/delegation";

const repository = "cxij-internal-auth-only";
const stub = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(repository));
const base = "https://credential-broker.internal";

function request(path: string, method = "GET", headers?: HeadersInit, body?: unknown) {
  return stub.fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("CredentialBroker internal route authorization", () => {
  it("refuses anonymous reads of settings, passkeys and effective raw secrets", async () => {
    for (const path of ["/internal-setting?key=platform.owners", "/passkeys", "/effective-webhook-secret", "/effective-github-app"]) {
      expect((await request(path)).status, path).toBe(401);
    }
    expect((await request("/passkeys", "POST", { "content-type": "application/json" }, {
      credentialId: "not-stored", subject: "__root__", publicKeySpki: "forged-key",
    })).status).toBe(401);
    expect((await request("/passkeys/touch", "POST", { "content-type": "application/json" }, {
      credentialId: "not-stored",
    })).status).toBe(401);
    expect((await request("/passkeys?id=not-stored", "DELETE")).status).toBe(401);
  });

  it("accepts the control key or a repository-bound system delegation, not a tenant delegation", async () => {
    const machine = await brokerInternalHeaders(env, repository);
    expect((await request("/internal-setting?key=platform.owners", "GET", machine)).status).toBe(200);
    expect((await request("/passkeys", "GET", machine)).status).toBe(200);
    expect((await request("/effective-github-app", "GET", machine)).status).toBe(200);

    const keyless = { ...env, BROKER_CONTROL_KEY: undefined };
    const system = await brokerInternalHeaders(keyless, repository);
    expect(system.has("x-factory-control-key")).toBe(false);
    expect(system.has("x-factory-delegation")).toBe(true);
    expect((await request("/passkeys", "GET", system)).status).toBe(200);
    expect((await request("/effective-webhook-secret", "GET", system)).status).not.toBe(401);

    const tenant = await mintDelegation(env, { repository, login: "alice" });
    expect((await request("/passkeys", "GET", { "x-factory-delegation": tenant })).status).toBe(401);
    const other = await mintDelegation(env, { repository: "some-other-repo", login: BROKER_INTERNAL_LOGIN });
    expect((await request("/internal-setting?key=platform.owners", "GET", { "x-factory-delegation": other })).status).toBe(401);
  });
});
