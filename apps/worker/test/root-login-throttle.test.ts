import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import {
  acceptPresentedControlKey,
  CONTROL_KEY_ATTEMPT_LIMIT,
  CONTROL_KEY_ATTEMPT_LIMIT_MACHINE,
  CONTROL_KEY_WINDOW_MS,
  controlKeyThrottle,
} from "../src/auth/throttle";
import { authzDenial, authorizeControlPlane, sessionSigningKey } from "../src/auth/tenant";
import { mintSessionToken, SESSION_COOKIE } from "../src/routes/auth";

/**
 * `POST /api/auth/root-login` trades the deployment's control key for a root session and
 * is reachable from the internet, so guessing it has to cost something
 * (cloud-factory-cf-vhns). The counter is durable state in the broker, keyed by client
 * address: a wrong guess increments it, a correct key clears it, and once the streak
 * reaches the limit every attempt from that address is refused - including one that
 * carries the right key, because the gate runs before the key is looked at.
 *
 * Each case uses its own client address so the cases stay independent: the counter table
 * is shared state in the default broker, exactly as it is in production.
 */
const CONTROL_KEY = "test-control-key";

function rootLogin(identity: string, key?: string): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": identity, "content-type": "application/json" };
  if (key !== undefined) headers["x-factory-control-key"] = key;
  return SELF.fetch(
    new Request("https://example.com/api/auth/root-login", { method: "POST", headers, body: "{}" }),
  );
}

describe("root login throttle", () => {
  it("refuses the guess after the limit, and refuses a correct key from that point too", async () => {
    const identity = "203.0.113.10";

    for (let attempt = 1; attempt <= CONTROL_KEY_ATTEMPT_LIMIT; attempt += 1) {
      const wrong = await rootLogin(identity, "not-the-control-key");
      expect(wrong.status).toBe(401);
    }

    const refused = await rootLogin(identity, "not-the-control-key");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    await expect(refused.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Too many root login attempts"),
    });

    // The gate runs before the key is checked, so a locked-out address cannot trade a
    // lucky guess for a session either.
    const correctButThrottled = await rootLogin(identity, CONTROL_KEY);
    expect(correctButThrottled.status).toBe(429);
    expect(correctButThrottled.headers.get("set-cookie")).toBeNull();
  });

  it("leaves other addresses alone", async () => {
    const exhausted = "203.0.113.20";
    for (let attempt = 0; attempt <= CONTROL_KEY_ATTEMPT_LIMIT; attempt += 1) {
      await rootLogin(exhausted, "wrong");
    }
    expect((await rootLogin(exhausted, "wrong")).status).toBe(429);

    const other = await rootLogin("203.0.113.21", CONTROL_KEY);
    expect(other.status).toBe(200);
    expect(other.headers.get("set-cookie")).toContain("cf_session=");
  });

  it("clears the streak on a successful login", async () => {
    const identity = "203.0.113.30";

    for (let attempt = 0; attempt < CONTROL_KEY_ATTEMPT_LIMIT - 2; attempt += 1) {
      expect((await rootLogin(identity, "wrong")).status).toBe(401);
    }
    expect((await rootLogin(identity, CONTROL_KEY)).status).toBe(200);

    // The counter is gone, so a fresh run of wrong guesses is judged on its own.
    for (let attempt = 0; attempt < CONTROL_KEY_ATTEMPT_LIMIT; attempt += 1) {
      expect((await rootLogin(identity, "wrong")).status).toBe(401);
    }
    expect((await rootLogin(identity, "wrong")).status).toBe(429);
  });

  it("forgets failures once the window has rolled over", async () => {
    const identity = "203.0.113.40";
    const stub = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName("default"));
    const post = (path: string, body: Record<string, unknown>) =>
      stub.fetch(`https://credential-broker.internal${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-factory-control-key": "test-control-key",
        },
        body: JSON.stringify(body),
      });

    // A one-second window driven directly: the production window is 15 minutes, and the
    // point here is the rollover, not the duration. The window has to outlast the calls
    // that fill it, or each record would find an expired window and start over at one.
    const windowMs = 1000;
    for (let attempt = 0; attempt < CONTROL_KEY_ATTEMPT_LIMIT; attempt += 1) {
      await post("/auth-throttle/record", { identity, outcome: "failure", windowMs });
    }
    const blocked = (await (
      await post("/auth-throttle/check", { identity, limit: CONTROL_KEY_ATTEMPT_LIMIT, windowMs })
    ).json()) as { allowed: boolean };
    expect(blocked.allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, windowMs + 100));
    const afterWindow = (await (
      await post("/auth-throttle/check", { identity, limit: CONTROL_KEY_ATTEMPT_LIMIT, windowMs })
    ).json()) as { allowed: boolean };
    expect(afterWindow.allowed).toBe(true);
  });

  it("bounds a parallel burst on the general control plane too (cloud-factory-cf-yu3v)", async () => {
    // The entry gate's check and the comparison's record were separate operations, so
    // forty concurrent guesses were all compared (forty 403s, no 429). The comparison now
    // reserves its slot atomically, so the limit holds here as it does on root-login.
    const identity = "203.0.113.80";
    const responses = await Promise.all(
      Array.from({ length: 40 }, () =>
        SELF.fetch(
          new Request("https://example.com/api/admin/system", {
            headers: { "cf-connecting-ip": identity, "x-factory-control-key": "not-the-control-key" },
          }),
        ),
      ),
    );
    const statuses = responses.filter((response) => response.status !== 429);
    // At most the machine budget's worth of guesses is ever compared; the rest are refused.
    // The budget is the machine one (20), not the human one, because a reservation is taken
    // before the comparison and therefore also bounds legitimate concurrency
    // (cloud-factory-cf-r012).
    expect(statuses.length).toBeLessThanOrEqual(CONTROL_KEY_ATTEMPT_LIMIT_MACHINE);
    expect(responses.length - statuses.length).toBeGreaterThanOrEqual(40 - CONTROL_KEY_ATTEMPT_LIMIT_MACHINE);
  });

  it("does not throttle a caller that holds the correct key, however parallel it is (cloud-factory-cf-r012)", async () => {
    // The reviewer's repro: the atomic reservation incremented the SHARED failures counter
    // before the comparison, so eight concurrent requests with the CORRECT key competed for
    // a five-slot budget and some were refused before they could ever compare. In-flight
    // work still counts against the budget - that is what bounds a burst - but it is not
    // charged as a failure, and a match releases its slot.
    const identity = "203.0.113.81";
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        SELF.fetch(
          new Request("https://example.com/api/admin/system", {
            headers: { "cf-connecting-ip": identity, "x-factory-control-key": "test-control-key" },
          }),
        ),
      ),
    );
    const refused = responses.filter((response) => response.status === 429);
    expect(refused).toHaveLength(0);
    for (const response of responses) expect(response.status).not.toBe(429);

    // And the address is not left with a spent window afterwards: a ninth call still works.
    const after = await SELF.fetch(
      new Request("https://example.com/api/admin/system", {
        headers: { "cf-connecting-ip": identity, "x-factory-control-key": "test-control-key" },
      }),
    );
    expect(after.status).not.toBe(429);
  });

  it("releases the reservation a rejected guess took, so the next caller is not charged for it", async () => {
    const identity = "203.0.113.82";
    const wrong = () =>
      SELF.fetch(
        new Request("https://example.com/api/admin/system", {
          headers: { "cf-connecting-ip": identity, "x-factory-control-key": "not-the-control-key" },
        }),
      );

    // One rejection, then a correct key: the in-flight slot from the rejection must be gone,
    // and the streak cleared, so the correct call is not refused.
    expect((await wrong()).status).not.toBe(429);
    const good = await SELF.fetch(
      new Request("https://example.com/api/admin/system", {
        headers: { "cf-connecting-ip": identity, "x-factory-control-key": "test-control-key" },
      }),
    );
    expect(good.status).not.toBe(429);
  });

  it("counts rejections on the routes that compare the key directly (cloud-factory-cf-96mr)", async () => {
    // The passkey administration routes and the repo list compare the header themselves
    // rather than through authorizeControlPlane, so they were uncounted oracles: the same
    // secret, guessed at full speed, with the entry gate always reading zero.
    const identity = "203.0.113.70";
    const passkeys = () =>
      SELF.fetch(
        new Request("https://example.com/api/auth/passkeys", {
          headers: { "cf-connecting-ip": identity, "x-factory-control-key": "not-the-control-key" },
        }),
      );

    for (let attempt = 0; attempt < CONTROL_KEY_ATTEMPT_LIMIT; attempt += 1) {
      expect((await passkeys()).status).toBe(401);
    }

    // Now the entry gate sees a spent window, whatever route is asked for.
    const refused = await passkeys();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);

    const deleteRoute = await SELF.fetch(
      new Request("https://example.com/api/auth/passkeys", {
        method: "DELETE",
        headers: { "cf-connecting-ip": identity, "x-factory-control-key": CONTROL_KEY },
      }),
    );
    expect(deleteRoute.status).toBe(429);

    // Another address can still administer passkeys with the right key.
    const other = await SELF.fetch(
      new Request("https://example.com/api/auth/passkeys", {
        headers: { "cf-connecting-ip": "203.0.113.71", "x-factory-control-key": CONTROL_KEY },
      }),
    );
    expect(other.status).not.toBe(429);
  });

  it("does not count a 401 that was not about the control key", async () => {
    // The counter must only move when the control key was actually rejected. Counting
    // every 401 on the control plane would lock out honest machine traffic, whose 401s
    // are about capabilities and sessions (found while this was recording from response
    // status in index.ts).
    const identity = "203.0.113.55";
    for (let attempt = 0; attempt < CONTROL_KEY_ATTEMPT_LIMIT + 3; attempt += 1) {
      const response = await SELF.fetch(
        new Request("https://example.com/broker/acme/unrelated-401/proxy", {
          method: "POST",
          headers: {
            "cf-connecting-ip": identity,
            "x-factory-control-key": CONTROL_KEY,
            "content-type": "application/json",
          },
          body: JSON.stringify({ capability: "not-a-token" }),
        }),
      );
      expect(response.status).toBe(401);
    }

    // Still able to authenticate with the right key: nothing was counted.
    const after = await SELF.fetch(
      new Request("https://example.com/api/admin/system", {
        headers: { "cf-connecting-ip": identity, "x-factory-control-key": CONTROL_KEY },
      }),
    );
    expect(after.status).not.toBe(429);
  });

  it("bounds a parallel burst, not just a sequential run (cloud-factory-cf-1f8m)", async () => {
    // Check-then-record as two calls let every guess in a burst be evaluated, because all
    // of them read a count of zero before any of them wrote. The reservation is atomic
    // inside one Durable Object call, so the limit holds under concurrency too.
    const identity = "203.0.113.50";
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => rootLogin(identity, "not-the-control-key")),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(CONTROL_KEY_ATTEMPT_LIMIT);
    expect(statuses.filter((status) => status === 429)).toHaveLength(20 - CONTROL_KEY_ATTEMPT_LIMIT);
  });

  it("locks the whole control plane, not just root login (cloud-factory-cf-m5dk)", async () => {
    // The same secret is accepted by authorizeControlPlane for every admin/broker/audit
    // route, so throttling root-login alone left it guessable at full speed there.
    const identity = "203.0.113.60";
    for (let attempt = 0; attempt < CONTROL_KEY_ATTEMPT_LIMIT; attempt += 1) {
      // Five rejections anywhere in the control plane exhaust the window.
      const response = await SELF.fetch(
        new Request("https://example.com/api/admin/system", {
          headers: { "cf-connecting-ip": identity, "x-factory-control-key": "not-the-control-key" },
        }),
      );
      expect(response.status).not.toBe(429);
    }

    const lockedWrong = await SELF.fetch(
      new Request("https://example.com/api/admin/system", {
        headers: { "cf-connecting-ip": identity, "x-factory-control-key": "not-the-control-key" },
      }),
    );
    expect(lockedWrong.status).toBe(429);
    expect(Number(lockedWrong.headers.get("retry-after"))).toBeGreaterThan(0);

    const lockedCorrect = await SELF.fetch(
      new Request("https://example.com/api/admin/system", {
        headers: { "cf-connecting-ip": identity, "x-factory-control-key": CONTROL_KEY },
      }),
    );
    expect(lockedCorrect.status).toBe(429);

    // A different address is unaffected.
    const otherAddress = await SELF.fetch(
      new Request("https://example.com/api/admin/system", {
        headers: { "cf-connecting-ip": "203.0.113.61", "x-factory-control-key": CONTROL_KEY },
      }),
    );
    expect(otherAddress.status).not.toBe(429);
  });

  it("is not bypassable by omitting the client address (one shared bucket)", async () => {
    // No cf-connecting-ip and no x-forwarded-for: every such caller shares the "unknown"
    // bucket, which makes the control stricter, never weaker.
    for (let attempt = 0; attempt <= CONTROL_KEY_ATTEMPT_LIMIT; attempt += 1) {
      await SELF.fetch(
        new Request("https://example.com/api/auth/root-login", {
          method: "POST",
          headers: { "x-factory-control-key": "wrong" },
          body: "{}",
        }),
      );
    }
    const response = await SELF.fetch(
      new Request("https://example.com/api/auth/root-login", {
        method: "POST",
        headers: { "x-factory-control-key": "wrong" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(429);
  });
});

// The exported policy is what the route uses; assert it here so a silent change to either
// constant is visible as a failing test rather than as a weaker throttle in production.
describe("root login throttle policy", () => {
  it("is expressed in attempts per window", () => {
    expect(CONTROL_KEY_ATTEMPT_LIMIT).toBeGreaterThan(0);
    expect(CONTROL_KEY_ATTEMPT_LIMIT).toBeLessThanOrEqual(10);
    expect(CONTROL_KEY_WINDOW_MS).toBeGreaterThanOrEqual(60 * 1000);
  });
});

/**
 * The counter is the only thing standing between an internet-facing key comparison and a
 * guessing run, so a broker that cannot answer must not be read as "allowed"
 * (cloud-factory-cf-m3hx). Before this, every `return null` in the throttle was an outage
 * an attacker could arrange: make the Durable Object unhappy and every comparison in the
 * window is unthrottled.
 */
describe("the throttle fails closed when the counter cannot be read (cloud-factory-cf-m3hx)", () => {
  /** A broker namespace whose one object answers however this case needs it to. */
  function brokerThat(
    answer: (request: Request) => Response | Promise<Response>,
  ): Env["CREDENTIAL_BROKER"] {
    return {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (input: Request | string, init?: RequestInit) =>
          answer(typeof input === "string" ? new Request(input, init) : input),
      }),
    } as unknown as Env["CREDENTIAL_BROKER"];
  }

  function envWith(broker: Env["CREDENTIAL_BROKER"]): Env {
    return { ...(env as unknown as Env), CREDENTIAL_BROKER: broker };
  }

  const unreadable = () => brokerThat(() => new Response("broker exploded", { status: 500 }));
  const throwing = () =>
    brokerThat(() => {
      throw new Error("broker unreachable");
    });
  /**
   * The realistic outage for this bead: the throttle route is broken while the rest of the
   * broker still answers. That is the shape a deploy skew or a handler bug takes, and it is
   * the one where the session fallback below has to keep working.
   */
  const throttleRouteDown = () =>
    brokerThat((request) =>
      new URL(request.url).pathname.startsWith("/auth-throttle")
        ? new Response("no", { status: 500 })
        : Response.json({ ok: true, revoked: false }),
    );

  it("reports an unreadable counter as unavailable, and as not allowed", async () => {
    for (const broker of [unreadable(), throwing()]) {
      const check = await controlKeyThrottle(envWith(broker), "198.51.100.10", "check");
      expect(check).toMatchObject({ allowed: false, unavailable: true });
      const attempt = await controlKeyThrottle(envWith(broker), "198.51.100.11", "attempt");
      expect(attempt).toMatchObject({ allowed: false, unavailable: true });
    }
  });

  it("refuses a correct control key rather than comparing it unthrottled", async () => {
    const request = new Request("https://example.com/api/repos", {
      headers: { "cf-connecting-ip": "198.51.100.12", "x-factory-control-key": CONTROL_KEY },
    });
    const decision = await acceptPresentedControlKey(request, envWith(unreadable()), CONTROL_KEY);
    // The key is right, and it is still not accepted: nothing here could have charged it.
    expect(decision).toBe("unavailable");
    expect(decision).not.toBe("accepted");
  });

  it("still lets a browser session authorise while the machine key cannot be judged", async () => {
    const scoped = envWith(throttleRouteDown());
    const session = await mintSessionToken(sessionSigningKey(scoped)!, "octocat");
    const request = new Request("https://example.com/api/admin/status", {
      headers: {
        "cf-connecting-ip": "198.51.100.13",
        "x-factory-control-key": CONTROL_KEY,
        cookie: `${SESSION_COOKIE}=${session}`,
      },
    });
    const authz = await authorizeControlPlane(request, scoped);
    // A broker outage must not lock an operator out of their own deployment.
    expect(authz).toEqual({ ok: true, principal: { via: "session", login: "octocat" } });
  });

  it("says the throttle was unavailable when nothing else authorises, and answers 503", async () => {
    const request = new Request("https://example.com/api/admin/status", {
      headers: { "cf-connecting-ip": "198.51.100.14", "x-factory-control-key": CONTROL_KEY },
    });
    const authz = await authorizeControlPlane(request, envWith(throwing()));
    expect(authz).toEqual({ ok: false, reason: "throttle-unavailable" });
    if (authz.ok) throw new Error("expected a denial");
    // 503, not a 429 that blames the caller or a 401 that sends them hunting for a credential.
    expect(authzDenial(authz).status).toBe(503);
  });

  it("keeps the documented no-binding case: with no broker there is no counter to read", async () => {
    const unbounded = { ...(env as unknown as Env), CREDENTIAL_BROKER: undefined } as unknown as Env;
    expect(await controlKeyThrottle(unbounded, "198.51.100.15", "check")).toBeNull();
  });
});
