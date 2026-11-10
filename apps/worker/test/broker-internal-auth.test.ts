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
    // A system delegation is single-use (cloud-factory-cf-sd6u), so every case mints its own
    // - exactly what `brokerInternalHeaders` does per request in the Worker.
    const machine = () => brokerInternalHeaders(env, repository);
    expect((await request("/internal-setting?key=platform.owners", "GET", await machine())).status).toBe(200);
    expect((await request("/passkeys", "GET", await machine())).status).toBe(200);
    expect((await request("/effective-github-app", "GET", await machine())).status).toBe(200);

    const keyless = { ...env, BROKER_CONTROL_KEY: undefined };
    const system = await brokerInternalHeaders(keyless, repository);
    expect(system.has("x-factory-control-key")).toBe(false);
    expect(system.has("x-factory-delegation")).toBe(true);
    expect((await request("/passkeys", "GET", system)).status).toBe(200);
    expect((await request("/effective-webhook-secret", "GET", await brokerInternalHeaders(keyless, repository))).status).toBe(200);

    // mintDelegation returns undefined when the deployment has no signing key, and the point
    // of these cases is that a TENANT-scoped token is refused - so a missing token would make
    // them pass for the wrong reason. Fail loudly instead (found by the worker typecheck gate,
    // cloud-factory-cf-ar12).
    const delegationOrFail = async (input: Parameters<typeof mintDelegation>[1]): Promise<string> => {
      const token = await mintDelegation(env, input);
      if (!token) throw new Error("mintDelegation returned no token for this test's environment");
      return token;
    };
    const tenant = await delegationOrFail({ repository, login: "alice" });
    for (const path of ["/passkeys", "/internal-setting?key=platform.owners", "/effective-github-app", "/effective-webhook-secret"]) {
      expect((await request(path, "GET", { "x-factory-delegation": tenant })).status, path).toBe(401);
    }
    const other = await delegationOrFail({ repository: "some-other-repo", login: BROKER_INTERNAL_LOGIN });
    expect((await request("/internal-setting?key=platform.owners", "GET", { "x-factory-delegation": other })).status).toBe(401);
  });

  /**
   * `jti` is spent, not decorative (cloud-factory-cf-sd6u). A system delegation is minted
   * per request, so accepting the same one twice would make it a 60s bearer credential for
   * settings, passkeys and the effective raw secrets.
   */
  it("refuses a second use of the same system delegation, and keeps the control key repeatable", async () => {
    const keyless = { ...env, BROKER_CONTROL_KEY: undefined };
    const once = await brokerInternalHeaders(keyless, repository);
    expect((await request("/passkeys", "GET", once)).status).toBe(200);
    expect((await request("/passkeys", "GET", once)).status).toBe(401);
    // The replay is refused, not merged into the first answer: nothing sensitive is returned
    // a second time.
    const replay = await request("/effective-webhook-secret", "GET", once);
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { secret?: string }).secret).toBeUndefined();

    // A fresh delegation for the same repository still works, and the machine key is not
    // affected at all - it is a key, not a token.
    expect((await request("/passkeys", "GET", await brokerInternalHeaders(keyless, repository))).status).toBe(200);
    const key = await brokerInternalHeaders(env, repository);
    expect((await request("/passkeys", "GET", key)).status).toBe(200);
    expect((await request("/passkeys", "GET", key)).status).toBe(200);
  });

  it("refuses a second use of the same tenant delegation too", async () => {
    // Tenant delegations became single-use when the pipeline started minting one per broker
    // request (cloud-factory-cf-tkfb), so `/settings` and `/capabilities` spend the `jti`
    // exactly as the internal routes do.
    const first = await mintDelegation(env, { repository, login: "alice" });
    if (!first) throw new Error("mintDelegation returned no token for this test's environment");
    const headers = { "x-factory-delegation": first };
    expect((await request("/settings", "GET", headers)).status).toBe(200);
    expect((await request("/settings", "GET", headers)).status).toBe(401);

    // A fresh delegation for the same login still reads: single-use is per token, not a ban.
    const second = await mintDelegation(env, { repository, login: "alice" });
    if (!second) throw new Error("mintDelegation returned no token for this test's environment");
    expect((await request("/settings", "GET", { "x-factory-delegation": second })).status).toBe(200);
  });
});
