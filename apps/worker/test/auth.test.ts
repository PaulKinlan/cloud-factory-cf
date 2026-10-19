import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub OAuth & App Install Flow", () => {
  it("/auth/github/login: redirects to GitHub OAuth authorize endpoint", async () => {
    const res = await SELF.fetch("https://example.com/auth/github/login?client_id=gh_test_client_id&redirect_uri=https://example.com/onboard", {
      method: "GET",
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeDefined();
    expect(location).toContain("https://github.com/login/oauth/authorize");
    expect(location).toContain("client_id=gh_test_client_id");
    expect(location).toContain("scope=repo%2Cread%3Aorg");
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("cf_oauth_state=");
  });

  it("/auth/github/login?flow=install: redirects to GitHub App installation", async () => {
    const res = await SELF.fetch("https://example.com/auth/github/login?flow=install&app_slug=cloud-factory-dev", {
      method: "GET",
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeDefined();
    expect(location).toContain("https://github.com/apps/cloud-factory-dev/installations/new");
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("cf_oauth_state=");
  });

  it("/auth/github/callback: exchanges code, queries GitHub, persists repos in OrgCoordinator, and redirects", async () => {
    const testUser = "octodev";
    const testRepos = [
      { id: 1, full_name: "octodev/widget-service", name: "widget-service", private: false, default_branch: "main" },
      { id: 2, full_name: "octodev/secret-project", name: "secret-project", private: true, default_branch: "trunk" },
    ];

    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://github.com/login/oauth/access_token") {
          return new Response(JSON.stringify({ access_token: "gho_test_user_token_123" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: testUser, type: "User" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/user/repos")) {
          return new Response(JSON.stringify(testRepos), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

    // 1. Initiate login to obtain CSRF state and signed cookie
    const loginRes = await SELF.fetch(
      "https://example.com/auth/github/login?client_id=gh_test_client_id&redirect_uri=/",
      {
        method: "GET",
        redirect: "manual",
      },
    );
    expect(loginRes.status).toBe(302);
    const loginLocation = loginRes.headers.get("location")!;
    const state = new URL(loginLocation).searchParams.get("state")!;
    expect(state).toBeDefined();
    const setCookie = loginRes.headers.get("set-cookie")!;
    expect(setCookie).toBeDefined();
    const cookieHeader = setCookie.split(";")[0]!;

    // 2. Reject callback without state parameter (missing state)
    const missingStateRes = await SELF.fetch(
      "https://example.com/auth/github/callback?code=mock_code_123&installation_id=inst_456&return_to=/",
      {
        method: "GET",
        headers: { cookie: cookieHeader },
      },
    );
    expect(missingStateRes.status).toBe(400);

    // 3. Reject callback without state cookie (missing cookie)
    const missingCookieRes = await SELF.fetch(
      `https://example.com/auth/github/callback?code=mock_code_123&installation_id=inst_456&return_to=/&state=${state}`,
      {
        method: "GET",
      },
    );
    expect(missingCookieRes.status).toBe(400);

    // 4. Reject callback with mismatched state (CSRF attack)
    const mismatchRes = await SELF.fetch(
      `https://example.com/auth/github/callback?code=mock_code_123&installation_id=inst_456&return_to=/&state=attacker_state_123`,
      {
        method: "GET",
        headers: { cookie: cookieHeader },
      },
    );
    expect(mismatchRes.status).toBe(400);

    // 4b. Reject callback with malformed or tampered state cookie
    const malformedRes = await SELF.fetch(
      `https://example.com/auth/github/callback?code=mock_code_123&installation_id=inst_456&return_to=/&state=${state}`,
      {
        method: "GET",
        headers: { cookie: "cf_oauth_state=not-a-valid-token" },
      },
    );
    expect(malformedRes.status).toBe(400);

    const tamperedRes = await SELF.fetch(
      `https://example.com/auth/github/callback?code=mock_code_123&installation_id=inst_456&return_to=/&state=${state}`,
      {
        method: "GET",
        headers: { cookie: `cf_oauth_state=${state}.1700000000.badf00d` },
      },
    );
    expect(tamperedRes.status).toBe(400);

    // 5. Successful callback with matching state and valid signed cookie
    const callbackRes = await SELF.fetch(
      `https://example.com/auth/github/callback?code=mock_code_123&installation_id=inst_456&return_to=/&state=${state}`,
      {
        method: "GET",
        headers: { cookie: cookieHeader },
        redirect: "manual",
      },
    );

    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get("location");
    expect(location).toBeDefined();
    expect(location).toContain("connected=1");
    expect(location).toContain(`owner=${testUser}`);
    expect(location).toContain("installation_id=inst_456");
    const clearCookie = callbackRes.headers.get("set-cookie");
    expect(clearCookie).toContain("cf_oauth_state=;");

    // 6. Verify /api/repos requires control-key authentication
    const unauthRes = await SELF.fetch(`https://example.com/api/repos?owner=${testUser}`);
    expect(unauthRes.status).toBe(401);
    const unauthData = (await unauthRes.json()) as any;
    expect(unauthData.ok).toBe(false);
    expect(unauthData.error).toContain("not authorised");

    const wrongKeyRes = await SELF.fetch(`https://example.com/api/repos?owner=${testUser}`, {
      headers: { "x-factory-control-key": "invalid-secret" },
    });
    expect(wrongKeyRes.status).toBe(401);

    // 5. Query /api/repos with valid control key to verify repos are persisted in OrgCoordinator
    const reposRes = await SELF.fetch(`https://example.com/api/repos?owner=${testUser}`, {
      headers: { "x-factory-control-key": "test-control-key" },
    });
    expect(reposRes.status).toBe(200);
    const reposData = (await reposRes.json()) as any;
    expect(reposData.ok).toBe(true);
    expect(reposData.count).toBe(2);
    expect(reposData.repositories).toHaveLength(2);
    expect(reposData.repositories[0].fullName).toBe("octodev/widget-service");
    expect(reposData.repositories[1].isPrivate).toBe(true);
  });

  it("/api/repos: rejects unauthenticated requests, bad methods, and missing parameters", async () => {
    // 1. Unauthenticated request without control key is rejected with 401
    const noAuth = await SELF.fetch("https://example.com/api/repos?owner=octodev");
    expect(noAuth.status).toBe(401);
    const noAuthJson = (await noAuth.json()) as any;
    expect(noAuthJson.ok).toBe(false);
    expect(noAuthJson.error).toContain("not authorised");

    // 2. Request with invalid control key is rejected with 401
    const badKey = await SELF.fetch("https://example.com/api/repos?owner=octodev", {
      headers: { "x-factory-control-key": "bad-key-guess" },
    });
    expect(badKey.status).toBe(401);

    // 3. Disallowed HTTP methods return 405
    const postReq = await SELF.fetch("https://example.com/api/repos?owner=octodev", {
      method: "POST",
      headers: { "x-factory-control-key": "test-control-key" },
    });
    expect(postReq.status).toBe(405);

    // 4. Missing ?owner returns 400
    const missingOwner = await SELF.fetch("https://example.com/api/repos", {
      headers: { "x-factory-control-key": "test-control-key" },
    });
    expect(missingOwner.status).toBe(400);
    const missingOwnerJson = (await missingOwner.json()) as any;
    expect(missingOwnerJson.ok).toBe(false);
    expect(missingOwnerJson.error).toContain("Missing required query parameter ?owner");
  });
});
