import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ALLOW_ALL_POLICY,
  customerAccessDenial,
  isLoginAllowed,
  resolveCustomerAccess,
  type CustomerAccessPolicy,
} from "../src/auth/customer-access";
import type { Env } from "../src/env";

/**
 * The customer access policy was saved and echoed but never read
 * (cloud-factory-cf-yvlp): these pin the decision the login gate now makes.
 */

const policy = (allowAll: boolean, allowedUsers: string[]): CustomerAccessPolicy => ({
  allowAll,
  allowedUsers,
});

describe("customer access policy (cloud-factory-cf-yvlp)", () => {
  it("allows any GitHub login when the deployment never turned the allowlist on", () => {
    expect(isLoginAllowed(ALLOW_ALL_POLICY, "someone-random", env)).toBe(true);
  });

  it("refuses a login that an explicit allowlist does not name", () => {
    expect(isLoginAllowed(policy(false, ["octodev"]), "intruder", env)).toBe(false);
  });

  it("matches the allowlist like a GitHub login - trimmed and case-insensitive", () => {
    const p = policy(false, ["octodev", "second-user"]);
    expect(isLoginAllowed(p, "OctoDev", env)).toBe(true);
    expect(isLoginAllowed(p, "  second-user ", env)).toBe(true);
  });

  it("refuses everyone but the platform owners when the allowlist is empty", () => {
    const withOwners = { ...env, PLATFORM_OWNERS: "ops" } as unknown as Env;
    const p = policy(false, []);
    expect(isLoginAllowed(p, "octodev", withOwners)).toBe(false);
    // the way back in: an owner can always sign in to change the policy
    expect(isLoginAllowed(p, "ops", withOwners)).toBe(true);
    expect(isLoginAllowed(p, "__root__", withOwners)).toBe(true);
  });

  it("never allows an empty or missing login, whatever the policy says", () => {
    expect(isLoginAllowed(ALLOW_ALL_POLICY, "", env)).toBe(false);
    expect(isLoginAllowed(ALLOW_ALL_POLICY, null, env)).toBe(false);
  });

  it("reads a deployment that never set the flag as allow-all, not as an empty allowlist", async () => {
    const resolved = await resolveCustomerAccess(env);
    expect(resolved.allowAll).toBe(true);
  });
});

describe("the denial every session-minting path shares (rev-yvlp)", () => {
  const CONTROL_KEY = "test-control-key"; // BROKER_CONTROL_KEY in vitest.config.ts

  async function setPolicy(body: unknown): Promise<void> {
    const broker = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName("default"));
    await broker.fetch("https://credential-broker.internal/settings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY },
      body: JSON.stringify(body),
    });
  }

  it("admits a listed login and refuses an unlisted one with a stable 403", async () => {
    await setPolicy({ customers: { allowAllGithubUsers: false, allowedUsers: ["octodev"] } });
    try {
      await expect(customerAccessDenial(env, "OctoDev")).resolves.toBeNull();
      const refused = await customerAccessDenial(env, "intruder");
      expect(refused).not.toBeNull();
      expect(refused!.status).toBe(403);
      await expect(refused!.json()).resolves.toMatchObject({
        ok: false,
        error: "not_allowed_on_this_deployment",
      });
    } finally {
      await setPolicy({ customers: { allowAllGithubUsers: true, allowedUsers: [] } });
    }
  });

  it("never admits an empty login, which is what a malformed passkey subject would be", async () => {
    const refused = await customerAccessDenial(env, "");
    expect(refused?.status).toBe(403);
  });
});
