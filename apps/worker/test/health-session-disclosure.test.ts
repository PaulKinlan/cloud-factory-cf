import { describe, expect, it } from "vitest";
import { handleHealth } from "../src/routes/health";
import { handleAuth, mintSessionToken } from "../src/routes/auth";

/**
 * Two unauthenticated surfaces used to fingerprint the deployment (cloud-factory-cf-gqyx):
 * `/health` reported the environment, a build commit, a build timestamp and a version,
 * and `/api/auth/session` answered `hasControlKey` and `signingConfigured` - i.e. which
 * secrets this deployment holds - to any anonymous caller.
 *
 * A liveness probe answers liveness; the secret-presence flags are root-only. The GitHub
 * configuration and app slug stay public because they decide which sign-in / first-run
 * affordance the UI can offer before anyone is logged in, and the slug is public anyway.
 *
 * These cases import the route modules directly (no Durable Object), so they run without
 * the Workers pool.
 */
const SIGNING_KEY = "test-session-signing-key";
const CONTROL_KEY = "test-control-key";

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    // This stub models a local deployment reached over plain http, where the plain
    // `cf_session` name is what the mint path itself sets; without an explicit
    // environment it is treated as a public deployment and the pre-upgrade cutoff
    // rejects the token (cloud-factory-cf-tp22).
    ENVIRONMENT: "test",
    BROKER_SIGNING_KEY: SIGNING_KEY,
    BROKER_CONTROL_KEY: CONTROL_KEY,
    GITHUB_CLIENT_ID: "gh_test_client_id",
    GITHUB_CLIENT_SECRET: "gh_test_client_secret",
    GITHUB_APP_SLUG: "cloud-factory-dev",
    ...overrides,
  } as never;
}

async function session(env: never, cookie?: string): Promise<Record<string, unknown>> {
  const request = new Request("https://example.com/api/auth/session", {
    headers: cookie ? { cookie } : {},
  });
  const response = await handleAuth(request, env, new URL("https://example.com/api/auth/session"));
  expect(response?.status).toBe(200);
  return (await response!.json()) as Record<string, unknown>;
}

describe("/health discloses liveness and nothing else", () => {
  it("answers only ok and service", async () => {
    const response = handleHealth(new URL("https://example.com/health"), "GET");
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, service: "cloud-factory-cf" });
  });

  it("no longer names the environment, commit, build time or version", async () => {
    const response = handleHealth(new URL("https://example.com/health"), "GET");
    const body = (await response!.json()) as Record<string, unknown>;
    for (const field of ["environment", "commit", "build_timestamp", "version"]) {
      expect(body, `${field} must not be disclosed`).not.toHaveProperty(field);
    }
  });

  it("still refuses unsupported methods and ignores other paths", () => {
    expect(handleHealth(new URL("https://example.com/health"), "POST")?.status).toBe(405);
    expect(handleHealth(new URL("https://example.com/nope"), "GET")).toBeNull();
  });
});

describe("/api/auth/session discloses secret presence to root only", () => {
  it("tells an anonymous caller nothing about which secrets exist", async () => {
    const body = await session(testEnv());
    expect(body).toMatchObject({ ok: true, authenticated: false, login: null, isRootAdmin: false });
    expect(body).not.toHaveProperty("hasControlKey");
    expect(body).not.toHaveProperty("signingConfigured");
    // The sign-in affordance still needs to know whether GitHub can be used at all.
    expect(body.githubConfigured).toBe(true);
    expect(body.appSlug).toBe("cloud-factory-dev");
  });

  it("tells an ordinary session nothing about them either", async () => {
    const token = await mintSessionToken(SIGNING_KEY, "octodev");
    const body = await session(testEnv(), `cf_session=${token}`);
    expect(body).toMatchObject({ authenticated: true, login: "octodev", isRootAdmin: false });
    expect(body).not.toHaveProperty("hasControlKey");
    expect(body).not.toHaveProperty("signingConfigured");
  });

  it("tells root which secrets the deployment holds", async () => {
    const token = await mintSessionToken(SIGNING_KEY, "__root__");
    const body = await session(testEnv(), `cf_session=${token}`);
    expect(body).toMatchObject({
      authenticated: true,
      isRootAdmin: true,
      hasControlKey: true,
      signingConfigured: true,
    });
  });
});
