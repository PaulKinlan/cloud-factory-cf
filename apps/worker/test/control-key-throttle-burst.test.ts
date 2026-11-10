import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  CONTROL_KEY_ATTEMPT_LIMIT,
  CONTROL_KEY_ATTEMPT_LIMIT_MACHINE,
} from "../src/auth/throttle";

/**
 * The throttle has to bound a *parallel* burst, not just a patient one
 * (cloud-factory-cf-1f8m, -yu3v).
 *
 * `check` then `record` as two Durable Object calls lets every request in a burst read a
 * count of zero before any of them writes, so an attacker firing N guesses in parallel used
 * to get all N evaluated. Both entry points now reserve the slot atomically *before* the key
 * is compared: root-login through its own reservation, and every control-plane route through
 * `authorizeControlPlane`. Only rejections spend the window, so a machine caller with the
 * right key is not locked out by its own concurrency.
 *
 * Each case uses its own client address: the counter is durable state in the default broker.
 */
const CONTROL_KEY = "test-control-key";

function guess(url: string, identity: string, key: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(
    new Request(`https://example.com${url}`, {
      method: init.method ?? "POST",
      headers: { "cf-connecting-ip": identity, "x-factory-control-key": key, "content-type": "application/json" },
      body: init.body,
    }),
  );
}

async function burst(
  url: string,
  identity: string,
  count: number,
  init: RequestInit = {},
): Promise<{ evaluated: number; throttled: number; statuses: number[] }> {
  const responses = await Promise.all(
    Array.from({ length: count }, (_, index) => guess(url, identity, `wrong-key-${index}`, init)),
  );
  const statuses = responses.map((response) => response.status);
  return {
    evaluated: statuses.filter((status) => status !== 429).length,
    throttled: statuses.filter((status) => status === 429).length,
    statuses,
  };
}

describe("a parallel burst cannot outrun the control-key throttle", () => {
  it("evaluates at most the human limit of parallel root-login guesses", async () => {
    const result = await burst("/api/auth/root-login", "203.0.113.201", 20);
    expect(result.evaluated).toBeLessThanOrEqual(CONTROL_KEY_ATTEMPT_LIMIT);
    expect(result.throttled).toBeGreaterThan(0);
  });

  it("evaluates at most the machine limit of parallel control-plane guesses", async () => {
    // /api/admin/system is behind `authorizeControlPlane`, i.e. the machine budget.
    const result = await burst("/api/admin/system", "203.0.113.202", 40, { method: "GET" });
    expect(result.evaluated).toBeLessThanOrEqual(CONTROL_KEY_ATTEMPT_LIMIT_MACHINE);
    expect(result.throttled).toBeGreaterThan(0);
  });

  it("counts the passkey routes' comparisons, so their correct key is refused once the budget is spent", async () => {
    // `/api/auth/passkeys` compares the key itself rather than through `authorizeControlPlane`,
    // so it needs the same reservation - otherwise it is an uncounted oracle
    // (cloud-factory-cf-96mr). The discriminator is the CORRECT key: without the counter it
    // would answer 200 after any number of wrong ones.
    const identity = "203.0.113.205";
    await burst("/api/auth/passkeys", identity, CONTROL_KEY_ATTEMPT_LIMIT_MACHINE + 1, { method: "GET" });
    const correctAfterBurst = await SELF.fetch(
      new Request("https://example.com/api/auth/passkeys", {
        method: "GET",
        headers: { "cf-connecting-ip": identity, "x-factory-control-key": CONTROL_KEY },
      }),
    );
    // 401 (the comparison refused it) or 429 (the gate answered first) - either way the
    // route is no longer an uncounted oracle, which is the property this bead is about.
    expect([401, 429]).toContain(correctAfterBurst.status);

    // Same request, unspent address: the key still opens the route.
    const fresh = await SELF.fetch(
      new Request("https://example.com/api/auth/passkeys", {
        method: "GET",
        headers: { "cf-connecting-ip": "203.0.113.206", "x-factory-control-key": CONTROL_KEY },
      }),
    );
    expect(fresh.status).toBe(200);
  });

  it("shares one counter between routes, so spending it on one throttles the others", async () => {
    // Throttling one route and not the rest throttles nothing (cloud-factory-cf-m5dk):
    // budget spent through `authorizeControlPlane` must also gate the passkey comparison.
    const identity = "203.0.113.207";
    await burst("/api/admin/system", identity, CONTROL_KEY_ATTEMPT_LIMIT_MACHINE, { method: "GET" });
    const correctElsewhere = await SELF.fetch(
      new Request("https://example.com/api/auth/passkeys", {
        method: "GET",
        headers: { "cf-connecting-ip": identity, "x-factory-control-key": CONTROL_KEY },
      }),
    );
    expect([401, 429]).toContain(correctElsewhere.status);
  });

  it("keeps the correct key working from another address during a burst", async () => {
    // The reservation is per client address: one attacker's burst must not spend, or hold,
    // another caller's budget.
    const [correct] = await Promise.all([
      guess("/api/admin/system", "203.0.113.203", CONTROL_KEY, { method: "GET" }),
      burst("/api/admin/system", "203.0.113.204", 20, { method: "GET" }),
    ]);
    expect(correct.status).not.toBe(401);
    expect(correct.status).not.toBe(429);
  });
});
