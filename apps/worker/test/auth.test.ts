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

    // 4c. Reject callback with invalid URI-encoded cookie without throwing 500
    const uriErrorCookieRes = await SELF.fetch(
      `https://example.com/auth/github/callback?code=mock_code_123&installation_id=inst_456&return_to=/&state=${state}`,
      {
        method: "GET",
        headers: { cookie: "cf_oauth_state=%zz" },
      },
    );
    expect(uriErrorCookieRes.status).toBe(400);
    const uriErrorJson = (await uriErrorCookieRes.json()) as any;
    expect(uriErrorJson.error).toContain("Malformed OAuth state cookie");

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

  it("/auth/github/login & callback: sanitizes redirect_uri and return_to to prevent open redirects", async () => {
    // 1. Off-origin redirect_uri in login is neutralized to return_to=/
    const evilLogin = await SELF.fetch(
      "https://example.com/auth/github/login?client_id=gh_test_client_id&redirect_uri=https://evil.example/steal",
      { method: "GET", redirect: "manual" },
    );
    expect(evilLogin.status).toBe(302);
    const evilLocation = evilLogin.headers.get("location")!;
    expect(evilLocation).toContain("redirect_uri=");
    const parsedRedirectUri = new URL(new URL(evilLocation).searchParams.get("redirect_uri")!);
    expect(parsedRedirectUri.searchParams.get("return_to")).toBe("/");

    // 2. Protocol-relative URL is neutralized
    const protoLogin = await SELF.fetch(
      "https://example.com/auth/github/login?client_id=gh_test_client_id&redirect_uri=//evil.example/steal",
      { method: "GET", redirect: "manual" },
    );
    expect(protoLogin.status).toBe(302);
    const protoLocation = protoLogin.headers.get("location")!;
    const parsedProtoUri = new URL(new URL(protoLocation).searchParams.get("redirect_uri")!);
    expect(parsedProtoUri.searchParams.get("return_to")).toBe("/");

    // 2b. Same-origin URL with protocol-relative double-slash path is neutralized (cloud-factory-cf-zmm)
    const doubleSlashLogin = await SELF.fetch(
      "https://example.com/auth/github/login?client_id=gh_test_client_id&redirect_uri=https://example.com//evil.example/steal",
      { method: "GET", redirect: "manual" },
    );
    expect(doubleSlashLogin.status).toBe(302);
    const doubleSlashLocation = doubleSlashLogin.headers.get("location")!;
    const parsedDoubleSlash = new URL(new URL(doubleSlashLocation).searchParams.get("redirect_uri")!);
    expect(parsedDoubleSlash.searchParams.get("return_to")).toBe("/");

    // 3. Off-origin return_to in callback is neutralized and never redirects off-site
    const validLogin = await SELF.fetch(
      "https://example.com/auth/github/login?client_id=gh_test_client_id",
      { method: "GET", redirect: "manual" },
    );
    const validLocation = validLogin.headers.get("location")!;
    const validState = new URL(validLocation).searchParams.get("state")!;
    const cookieHeader = validLogin.headers.get("set-cookie")!.split(";")[0]!;

    const evilCallback = await SELF.fetch(
      `https://example.com/auth/github/callback?installation_id=inst_456&setup_action=install&state=${validState}&return_to=https://evil.example/steal`,
      { method: "GET", headers: { cookie: cookieHeader }, redirect: "manual" },
    );
    expect(evilCallback.status).toBe(302);
    const callbackTarget = evilCallback.headers.get("location")!;
    const parsedTarget = new URL(callbackTarget);
    expect(parsedTarget.origin).toBe("https://example.com");
    expect(parsedTarget.pathname).toBe("/");
    expect(parsedTarget.searchParams.get("connected")).toBe("1");

    // 4. Protocol-relative and backslash direct injection in callback
    const protoCallback = await SELF.fetch(
      `https://example.com/auth/github/callback?installation_id=inst_456&setup_action=install&state=${validState}&return_to=//evil.example/steal`,
      { method: "GET", headers: { cookie: cookieHeader }, redirect: "manual" },
    );
    expect(protoCallback.status).toBe(302);
    const protoTarget = new URL(protoCallback.headers.get("location")!);
    expect(protoTarget.origin).toBe("https://example.com");
    expect(protoTarget.pathname).toBe("/");

    const backslashCallback = await SELF.fetch(
      `https://example.com/auth/github/callback?installation_id=inst_456&setup_action=install&state=${validState}&return_to=/\\\\evil.example/steal`,
      { method: "GET", headers: { cookie: cookieHeader }, redirect: "manual" },
    );
    expect(backslashCallback.status).toBe(302);
    const backslashTarget = new URL(backslashCallback.headers.get("location")!);
    expect(backslashTarget.origin).toBe("https://example.com");
    expect(backslashTarget.pathname).toBe("/");
  });

  it("/auth/github/callback: accepts external App install callbacks without code exchange", async () => {
    // 1. Direct install setup URL with state=owner/repo (from onboarding installUrl)
    const installWithState = await SELF.fetch(
      "https://example.com/auth/github/callback?installation_id=inst_789&setup_action=install&state=acme%2Fwidget",
      {
        method: "GET",
        redirect: "manual",
      },
    );
    expect(installWithState.status).toBe(302);
    const loc1 = installWithState.headers.get("location")!;
    expect(loc1).toContain("connected=1");
    expect(loc1).toContain("installation_id=inst_789");

    // 2. Direct install setup URL from GitHub App page (no state param, no cookie)
    const installWithoutState = await SELF.fetch(
      "https://example.com/auth/github/callback?installation_id=inst_789&setup_action=install",
      {
        method: "GET",
        redirect: "manual",
      },
    );
    expect(installWithoutState.status).toBe(302);
    const loc2 = installWithoutState.headers.get("location")!;
    expect(loc2).toContain("connected=1");
    expect(loc2).toContain("installation_id=inst_789");

    // 3. Direct install callback with leftover cf_oauth_state cookie and state=owner/repo (cloud-factory-cf-0jg)
    const loginRes = await SELF.fetch("https://example.com/auth/github/login?client_id=gh_test_client_id", {
      method: "GET",
      redirect: "manual",
    });
    const leftoverCookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;

    const installWithLeftoverCookie = await SELF.fetch(
      "https://example.com/auth/github/callback?installation_id=inst_789&setup_action=install&state=acme%2Fwidget",
      {
        method: "GET",
        headers: { cookie: leftoverCookie },
        redirect: "manual",
      },
    );
    expect(installWithLeftoverCookie.status).toBe(302);
    const loc3 = installWithLeftoverCookie.headers.get("location")!;
    expect(loc3).toContain("connected=1");
    expect(loc3).toContain("installation_id=inst_789");
    expect(installWithLeftoverCookie.headers.get("set-cookie")).toContain("cf_oauth_state=;");

    // 4. Direct install callback with leftover cookie and no state param (cloud-factory-cf-0jg)
    const installWithLeftoverNoState = await SELF.fetch(
      "https://example.com/auth/github/callback?installation_id=inst_789&setup_action=install",
      {
        method: "GET",
        headers: { cookie: leftoverCookie },
        redirect: "manual",
      },
    );
    expect(installWithLeftoverNoState.status).toBe(302);
    const loc4 = installWithLeftoverNoState.headers.get("location")!;
    expect(loc4).toContain("connected=1");
    expect(loc4).toContain("installation_id=inst_789");
    expect(installWithLeftoverNoState.headers.get("set-cookie")).toContain("cf_oauth_state=;");
  });

  it("/auth/github/callback: surfaces distinct errors when token exchange or upstream APIs fail (cloud-factory-cf-b1a)", async () => {
    // Obtain valid state and cookie
    const loginRes = await SELF.fetch("https://example.com/auth/github/login?client_id=gh_test_client_id", {
      method: "GET",
      redirect: "manual",
    });
    const state = new URL(loginRes.headers.get("location")!).searchParams.get("state")!;
    const cookieHeader = loginRes.headers.get("set-cookie")!.split(";")[0]!;

    // 1. GitHub returns OAuth error (e.g. bad_verification_code) -> 400
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://github.com/login/oauth/access_token") {
          return new Response(JSON.stringify({ error: "bad_verification_code", error_description: "The code passed is incorrect or has expired." }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

    const badCodeRes = await SELF.fetch(
      `https://example.com/auth/github/callback?code=expired_code&state=${state}`,
      { method: "GET", headers: { cookie: cookieHeader } },
    );
    expect(badCodeRes.status).toBe(400);
    const badCodeJson = (await badCodeRes.json()) as any;
    expect(badCodeJson.ok).toBe(false);
    expect(badCodeJson.error).toContain("GitHub OAuth error");

    // 2. GitHub token endpoint returns 500 -> 502
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://github.com/login/oauth/access_token") {
          return new Response("Internal Server Error", { status: 500 });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

    const serverErrRes = await SELF.fetch(
      `https://example.com/auth/github/callback?code=bad_code&state=${state}`,
      { method: "GET", headers: { cookie: cookieHeader } },
    );
    expect(serverErrRes.status).toBe(502);

    // 3. GitHub /user fails with 500 -> 502
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://github.com/login/oauth/access_token") {
          return new Response(JSON.stringify({ access_token: "gho_valid_token" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url === "https://api.github.com/user") {
          return new Response("Service Unavailable", { status: 503 });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

    const userErrRes = await SELF.fetch(
      `https://example.com/auth/github/callback?code=valid_code&state=${state}`,
      { method: "GET", headers: { cookie: cookieHeader } },
    );
    expect(userErrRes.status).toBe(502);
    const userErrJson = (await userErrRes.json()) as any;
    expect(userErrJson.ok).toBe(false);
    expect(userErrJson.error).toContain("GitHub /user failed");
  });

  it("flow=install: App install callback queries GitHub App installation/repos and persists to OrgCoordinator (cloud-factory-cf-tvg)", async () => {
    const installOwner = "orgdev";
    const installRepos = [
      { id: 101, full_name: "orgdev/service-a", name: "service-a", private: true, default_branch: "main", owner: { login: installOwner } },
      { id: 102, full_name: "orgdev/service-b", name: "service-b", private: false, default_branch: "main", owner: { login: installOwner } },
    ];

    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/app/installations/inst_app_888")) {
          return new Response(JSON.stringify({ id: 888, account: { login: installOwner, type: "Organization" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/installation/repositories")) {
          return new Response(JSON.stringify({ total_count: 2, repositories: installRepos }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

    const installCallbackRes = await SELF.fetch(
      "https://example.com/auth/github/callback?installation_id=inst_app_888&setup_action=install&return_to=/",
      {
        method: "GET",
        redirect: "manual",
      },
    );

    expect(installCallbackRes.status).toBe(302);
    const loc = installCallbackRes.headers.get("location")!;
    expect(loc).toContain("connected=1");
    expect(loc).toContain(`owner=${installOwner}`);
    expect(loc).toContain("installation_id=inst_app_888");
    expect(loc).toContain("count=2");

    // Verify repositories are stored in OrgCoordinator
    const orgReposRes = await SELF.fetch(`https://example.com/api/repos?owner=${installOwner}`, {
      headers: { "x-factory-control-key": "test-control-key" },
    });
    expect(orgReposRes.status).toBe(200);
    const orgReposData = (await orgReposRes.json()) as any;
    expect(orgReposData.ok).toBe(true);
    expect(orgReposData.count).toBe(2);
    expect(orgReposData.repositories[0].fullName).toBe("orgdev/service-a");
    expect(orgReposData.repositories[0].isPrivate).toBe(true);
  });
});
