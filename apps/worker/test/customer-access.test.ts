import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ALLOW_ALL_POLICY,
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
