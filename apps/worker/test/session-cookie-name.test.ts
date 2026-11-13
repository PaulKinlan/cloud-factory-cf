import { describe, expect, it } from "vitest";
import { handleAuth, mintSessionToken, readSession } from "../src/routes/auth";
import { HOST_SESSION_COOKIE, LEGACY_PLAIN_COOKIE_UNTIL_MS, SESSION_COOKIE } from "../src/auth/sessions";

/**
 * The session cookie's name and attributes (cloud-factory-cf-d11l).
 *
 * A plain `cf_session` can be set for a parent domain by any sibling subdomain, so a
 * tossed cookie can displace a real session. The `__Host-` prefix removes that: the
 * browser only accepts it from this exact host, and only with `Secure`, `Path=/` and no
 * `Domain`. The name therefore has to follow the origin (a `__Host-` cookie is rejected
 * outright on plain http), and the read side has to prefer the prefixed name while still
 * honouring a session minted before it existed.
 *
 * These cases import the route module directly (no Durable Object): throttle and
 * revocation both fall back to "no state" without the broker binding, which is what makes
 * the cookie logic testable without the Workers pool.
 */
const SIGNING_KEY = "test-session-signing-key";
const CONTROL_KEY = "test-control-key";

function testEnv(overrides: Record<string, unknown> = {}): never {
  return { BROKER_SIGNING_KEY: SIGNING_KEY, BROKER_CONTROL_KEY: CONTROL_KEY, ENVIRONMENT: "development", ...overrides } as never;
}

/**
 * The login a cookie authenticates as at `nowMs`, or null when it is refused. Goes through
 * `readSession` rather than the route so a case can place the clock on either side of the
 * migration cutoff; the route always uses the real clock.
 */
async function sessionLoginAt(
  env: never,
  cookie: string,
  nowMs: number = Date.now(),
): Promise<unknown> {
  const session = await readSession(new Headers({ cookie }), env, nowMs);
  return session.ok ? session.login : null;
}

async function rootLogin(origin: string): Promise<string> {
  const url = new URL("/api/auth/root-login", origin);
  const response = await handleAuth(
    new Request(url.toString(), {
      method: "POST",
      headers: { "x-factory-control-key": CONTROL_KEY, "content-type": "application/json" },
      body: "{}",
    }),
    testEnv(),
    url,
  );
  expect(response?.status).toBe(200);
  const cookie = response!.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  return cookie!;
}

async function logout(origin: string, cookie: string): Promise<string> {
  const url = new URL("/api/auth/logout", origin);
  const response = await handleAuth(
    new Request(url.toString(), { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" }),
    testEnv(),
    url,
  );
  expect(response?.status).toBe(200);
  return response!.headers.get("set-cookie") ?? "";
}

/** The login a cookie set authenticates as, read back through `/api/auth/session`. */
async function sessionLogin(cookie: string): Promise<unknown> {
  const url = new URL("/api/auth/session", "https://example.com");
  const response = await handleAuth(new Request(url.toString(), { headers: { cookie } }), testEnv(), url);
  const body = (await response!.json()) as { authenticated: boolean; login: string | null };
  return body.authenticated ? body.login : null;
}

describe("session cookie name", () => {
  it("uses the __Host- prefix with the attributes the prefix requires on https", async () => {
    const cookie = await rootLogin("https://example.com");
    expect(cookie.startsWith(`${HOST_SESSION_COOKIE}=`)).toBe(true);
    expect(HOST_SESSION_COOKIE).toBe("__Host-cf_session");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Domain=");
  });

  it("keeps the plain name on http, where a browser rejects a non-Secure __Host- cookie", async () => {
    const cookie = await rootLogin("http://localhost:8787");
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(cookie).not.toContain("__Host-");
    expect(cookie).not.toContain("Secure");
  });

  it("prefers the host-prefixed cookie over a tossed plain one beside it", async () => {
    const real = await mintSessionToken(SIGNING_KEY, "real-owner");
    const tossed = await mintSessionToken(SIGNING_KEY, "tossed-owner");

    // Both orders: preference is by name, never by which cookie the header lists first.
    expect(await sessionLogin(`${HOST_SESSION_COOKIE}=${real}; ${SESSION_COOKIE}=${tossed}`)).toBe("real-owner");
    expect(await sessionLogin(`${SESSION_COOKIE}=${tossed}; ${HOST_SESSION_COOKIE}=${real}`)).toBe("real-owner");
  });

  it("still reads a session minted before the prefix existed", async () => {
    const preUpgrade = await mintSessionToken(SIGNING_KEY, "legacy-owner");
    expect(await sessionLogin(`${SESSION_COOKIE}=${preUpgrade}`)).toBe("legacy-owner");
  });

  it("stops accepting a freshly minted plain cookie on a production deployment (cloud-factory-cf-79jv)", async () => {
    // The exploit: a sibling subdomain sets cf_session for the parent domain, carrying a
    // token the attacker obtained legitimately at this origin. Nothing about that cookie
    // proves where it came from, so after the migration cutoff it must authenticate
    // nothing — while a token minted BEFORE the cutoff stays valid for its TTL.
    const afterCutoff = LEGACY_PLAIN_COOKIE_UNTIL_MS + 60 * 60 * 1000;
    const beforeCutoff = LEGACY_PLAIN_COOKIE_UNTIL_MS - 60 * 60 * 1000;
    const production = testEnv({ ENVIRONMENT: "production" });

    const fresh = await mintSessionToken(SIGNING_KEY, "tossed-owner", afterCutoff);
    expect(await sessionLoginAt(production, `${SESSION_COOKIE}=${fresh}`, afterCutoff)).toBeNull();
    // ...and the same token is fine under the host-prefixed name, which only this host can
    // set: the refusal is about the name, not about the token.
    expect(await sessionLoginAt(production, `${HOST_SESSION_COOKIE}=${fresh}`, afterCutoff)).toBe("tossed-owner");

    const preUpgrade = await mintSessionToken(SIGNING_KEY, "legacy-owner", beforeCutoff);
    expect(await sessionLoginAt(production, `${SESSION_COOKIE}=${preUpgrade}`, beforeCutoff)).toBe(
      "legacy-owner",
    );

    // A development deployment mints the plain name itself (plain http cannot hold a
    // __Host- cookie), so there it is the session whatever its age.
    expect(await sessionLoginAt(testEnv(), `${SESSION_COOKIE}=${fresh}`, afterCutoff)).toBe("tossed-owner");
  });

  it("treats an unset ENVIRONMENT like production, never like local (cloud-factory-cf-nmjd)", async () => {
    // A deployment that carries no ENVIRONMENT at all — the state this repo's wrangler
    // configs now ship — must get the strict policy. The committed `development` default
    // used to flip exactly this branch and re-open 79jv on every public URL that did not
    // override it.
    const unset = testEnv({ ENVIRONMENT: undefined });
    const now = LEGACY_PLAIN_COOKIE_UNTIL_MS + 60 * 60 * 1000;

    const fresh = await mintSessionToken(SIGNING_KEY, "tossed-owner", now);
    expect(await sessionLoginAt(unset, `${SESSION_COOKIE}=${fresh}`, now)).toBeNull();

    const preUpgrade = await mintSessionToken(
      SIGNING_KEY,
      "legacy-owner",
      LEGACY_PLAIN_COOKIE_UNTIL_MS - 60 * 60 * 1000,
    );
    expect(
      await sessionLoginAt(unset, `${SESSION_COOKIE}=${preUpgrade}`, LEGACY_PLAIN_COOKIE_UNTIL_MS - 60 * 60 * 1000),
    ).toBe("legacy-owner");
  });

  it("clears every accepted cookie name on logout", async () => {
    const token = await mintSessionToken(SIGNING_KEY, "real-owner");
    const cleared = await logout("https://example.com", `${HOST_SESSION_COOKIE}=${token}`);
    // Both names, because readSession accepts both: clearing only the one this origin
    // mints today would leave a pre-upgrade cookie signing the browser back in
    // (cloud-factory-cf-7by9). The deny-list half of that is pinned with the real broker
    // binding in test/session-revocation.test.ts.
    expect(cleared).toContain(`${HOST_SESSION_COOKIE}=;`);
    expect(cleared).toContain(`${SESSION_COOKIE}=;`);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Secure");
  });
});
