import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApiRepos } from "../src/routes/auth";

function setupDefaultFetch() {
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
        return new Response(JSON.stringify({ login: "octodev", type: "User" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api.github.com/user/repos")) {
        return new Response(
          JSON.stringify([
            { id: 1, full_name: "octodev/widget-service", name: "widget-service", private: false, default_branch: "main", owner: { login: "octodev" } },
            { id: 2, full_name: "octodev/secret-project", name: "secret-project", private: true, default_branch: "trunk", owner: { login: "octodev" } },
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.includes("/api.github.com/app/installations/")) {
        return new Response(JSON.stringify({ id: 789, account: { login: "acme", type: "Organization" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api.github.com/installation/repositories")) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            repositories: [
              { id: 10, full_name: "acme/widget", name: "widget", private: false, default_branch: "main", owner: { login: "acme" } },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch,
  );
}

beforeEach(() => {
  setupDefaultFetch();
});

/**
 * Start a login/install flow so a callback can prove this browser began it: the login
 * sets the signed `cf_oauth_state` cookie and hands the nonce to GitHub as `state`.
 * An install callback without one is an unproven caller (cloud-factory-cf-dnrm).
 */
async function beginOAuthIntent(): Promise<{ state: string; cookie: string }> {
  const login = await SELF.fetch("https://example.com/auth/github/login?client_id=gh_test_client_id", {
    method: "GET",
    redirect: "manual",
  });
  expect(login.status).toBe(302);
  const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  return { state, cookie };
}

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

    // 3. Unsupported HTTP methods return 405. POST is NOT one of them: it installs a
    // repository through the OrgCoordinator (routes/auth.ts handleApiRepos), so the old
    // assertion here was stale and has been red on main since that path was added.
    const deleteReq = await SELF.fetch("https://example.com/api/repos?owner=octodev", {
      method: "DELETE",
      headers: { "x-factory-control-key": "test-control-key" },
    });
    expect(deleteReq.status).toBe(405);

    // 3b. A supported POST with no body is a body-validation failure (400), which is what
    // the stale assertion was actually observing.
    const emptyPost = await SELF.fetch("https://example.com/api/repos?owner=octodev", {
      method: "POST",
      headers: { "x-factory-control-key": "test-control-key" },
    });
    expect(emptyPost.status).toBe(400);
    await expect(emptyPost.json()).resolves.toMatchObject({ ok: false, error: "invalid json" });

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
    // A dedicated org, so "did an unproven install write anything?" is answerable even when
    // earlier tests in this file left rows in the shared Durable Object storage.
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/app/installations/inst_789/access_tokens")) {
          return new Response(JSON.stringify({ token: "ghs_oauthprobe_token" }), { status: 201 });
        }
        if (url.includes("/app/installations/inst_789")) {
          return new Response(JSON.stringify({ id: 789, account: { login: "oauthprobe", type: "Organization" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/installation/repositories")) {
          return new Response(JSON.stringify({ total_count: 0, repositories: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

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

    // 5. None of the four above proved this browser began the install, so none of them may
    //    mint a session or register repositories (cloud-factory-cf-dnrm): the stub resolves
    //    installation 789 to `oauthprobe`, and only a proven caller may touch it.
    for (const [label, res, location] of [
      ["state=owner/repo", installWithState, loc1],
      ["no state", installWithoutState, loc2],
      ["leftover cookie", installWithLeftoverCookie, loc3],
      ["leftover cookie, no state", installWithLeftoverNoState, loc4],
    ] as const) {
      expect(res.headers.get("set-cookie") ?? "", `${label}: no cf_session`).not.toContain("cf_session=");
      expect(new URL(location).searchParams.get("needs_oauth"), `${label}: asks for OAuth`).toBe("1");
    }
    const notRegistered = await SELF.fetch("https://example.com/api/repos?owner=oauthprobe", {
      headers: { "x-factory-control-key": "test-control-key" },
    });
    expect(notRegistered.status).toBe(200);
    expect(((await notRegistered.json()) as any).count, "unproven install must not write repos").toBe(0);
  });

  it("/auth/github/callback: install-only callbacks never mint a browser session (cloud-factory-cf-dnrm)", async () => {
    // An install callback proves an installation exists, never who is asking: the App JWT
    // resolves any installation of the app, so `installation_id` is caller-supplied. The
    // session cookie is the credential that reads that account's repositories through
    // `/api/repos`, so minting it here let any caller read another org's private repo
    // metadata. Only an OAuth code exchange (identity from GitHub's /user) may mint one.
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/app/installations/inst_victim_4242/access_tokens")) {
          return new Response(JSON.stringify({ token: "ghs_victim_installation_token" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/app/installations/inst_victim_4242")) {
          return new Response(JSON.stringify({ id: 4242, account: { login: "victimcorp", type: "Organization" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/installation/repositories")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              repositories: [
                { id: 4243, full_name: "victimcorp/payroll", name: "payroll", private: true, default_branch: "main", owner: { login: "victimcorp" } },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

    // The attacker's own login flow gives them a genuine signed state cookie — which is
    // continuity of *their* browser, not ownership of the installation they name.
    const loginRes = await SELF.fetch("https://example.com/auth/github/login?client_id=gh_test_client_id", {
      method: "GET",
      redirect: "manual",
    });
    const attackerState = new URL(loginRes.headers.get("location")!).searchParams.get("state")!;
    const attackerCookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;

    const callback = await SELF.fetch(
      `https://example.com/auth/github/callback?installation_id=inst_victim_4242&setup_action=install&state=${attackerState}&return_to=/`,
      { method: "GET", headers: { cookie: attackerCookie }, redirect: "manual" },
    );
    expect(callback.status).toBe(302);
    const callbackCookies = callback.headers.get("set-cookie") ?? "";
    expect(callbackCookies).toContain("cf_oauth_state=;");
    expect(callbackCookies, "install-only callbacks must not mint cf_session").not.toContain("cf_session=");

    // The installation is still registered for machine callers…
    const machine = await SELF.fetch("https://example.com/api/repos?owner=victimcorp", {
      headers: { "x-factory-control-key": "test-control-key" },
    });
    expect(machine.status).toBe(200);
    expect(((await machine.json()) as any).count).toBe(1);

    // …but the caller leaves with nothing that reads victim metadata back.
    expect(/cf_session=/.test(callbackCookies)).toBe(false);
    const viaStateOnly = await SELF.fetch("https://example.com/api/repos?owner=victimcorp", {
      headers: { cookie: attackerCookie },
    });
    expect(viaStateOnly.status).toBe(401);
  });

  it("/auth/github/callback: an install callback with no signed state does no GitHub work at all (cloud-factory-cf-dnrm)", async () => {
    const githubCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        githubCalls.push(String(input));
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

    const res = await SELF.fetch(
      "https://example.com/auth/github/callback?installation_id=12345678&setup_action=install",
      { method: "GET", redirect: "manual" },
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("needs_oauth")).toBe("1");
    expect(location.searchParams.get("installation_id")).toBe("12345678");
    expect(res.headers.get("set-cookie") ?? "").not.toContain("cf_session=");
    // The App JWT could resolve any installation, so an unproven caller must not even reach
    // GitHub: an installation id is a small integer and appears in every public install URL.
    expect(githubCalls, "an unproven install callback must not call GitHub at all").toEqual([]);
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

    const intent = await beginOAuthIntent();
    const installCallbackRes = await SELF.fetch(
      `https://example.com/auth/github/callback?installation_id=inst_app_888&setup_action=install&state=${intent.state}&return_to=/`,
      {
        method: "GET",
        headers: { cookie: intent.cookie },
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

  it("install callback: rejects unauthenticated state injection and fails visibly on API failure (cloud-factory-cf-lpmz, cloud-factory-cf-jmlv)", async () => {
    const intent = await beginOAuthIntent();
    // 1. Unauthenticated request with state=victimorg/evil-repo where GitHub API 401s
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/installations") || url.includes("/installation/repositories")) {
          return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

    const evilInstallRes = await SELF.fetch(
      "https://example.com/auth/github/callback?installation_id=inst_attacker&setup_action=install&state=victimorg/evil-repo",
      { method: "GET", redirect: "manual" },
    );
    // An install callback with no signed state of this browser's own is an unproven caller:
    // it must not run the install branch at all (no GitHub calls, no writes, no session) and
    // must send the operator to the OAuth login instead (cloud-factory-cf-dnrm).
    expect(evilInstallRes.status).toBe(302);
    const evilLocation = new URL(evilInstallRes.headers.get("location")!);
    expect(evilLocation.searchParams.get("needs_oauth")).toBe("1");
    expect(evilInstallRes.headers.get("set-cookie") ?? "").not.toContain("cf_session=");

    // Ensure victimorg's authorized_repos remained empty / untouched
    const victimReposRes = await SELF.fetch("https://example.com/api/repos?owner=victimorg", {
      headers: { "x-factory-control-key": "test-control-key" },
    });
    expect(victimReposRes.status).toBe(200);
    const victimReposData = (await victimReposRes.json()) as any;
    expect(victimReposData.count).toBe(0);
    expect(victimReposData.repositories).toEqual([]);

    // 2. Install-only callback when installation repositories API 500s -> returns 502
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/installations/")) {
          if (url.includes("/repositories")) {
            return new Response("Internal Server Error", { status: 500 });
          }
          return new Response(JSON.stringify({ id: 999, account: { login: "legitorg", type: "Organization" } }), { status: 200 });
        }
        if (url.includes("/installation/repositories")) {
          return new Response("Internal Server Error", { status: 500 });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

    const failReposRes = await SELF.fetch(
      `https://example.com/auth/github/callback?installation_id=inst_999&setup_action=install&state=${intent.state}`,
      { method: "GET", headers: { cookie: intent.cookie }, redirect: "manual" },
    );
    expect(failReposRes.status).toBe(502);
    const failJson = (await failReposRes.json()) as any;
    expect(failJson.ok).toBe(false);
    expect(failJson.error).toContain("GitHub /installation/repositories failed with HTTP 500");
  });

  it("OAuth failure branches: covers /user/repos failure, persistence failure, and query credential override rejection (cloud-factory-cf-yp07)", async () => {
    const loginRes = await SELF.fetch("https://example.com/auth/github/login?client_id=gh_test_client_id", {
      method: "GET",
      redirect: "manual",
    });
    const state = new URL(loginRes.headers.get("location")!).searchParams.get("state")!;
    const cookieHeader = loginRes.headers.get("set-cookie")!.split(";")[0]!;

    // 1. /user/repos fails with 500 -> returns 502
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://github.com/login/oauth/access_token") {
          return new Response(JSON.stringify({ access_token: "gho_valid_token" }), { status: 200 });
        }
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "octodev", type: "User" }), { status: 200 });
        }
        if (url.includes("/api.github.com/user/repos")) {
          return new Response("Service Unavailable", { status: 503 });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

    const reposFailRes = await SELF.fetch(
      `https://example.com/auth/github/callback?code=valid_code&state=${state}`,
      { method: "GET", headers: { cookie: cookieHeader } },
    );
    expect(reposFailRes.status).toBe(502);
    const reposFailJson = (await reposFailRes.json()) as any;
    expect(reposFailJson.ok).toBe(false);
    expect(reposFailJson.error).toContain("GitHub /user/repos failed with HTTP 503");

    // 2. Query string client_secret override is ignored: post body to GitHub uses env secrets
    let capturedBody: any = null;
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://github.com/login/oauth/access_token") {
          capturedBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ access_token: "gho_valid_token" }), { status: 200 });
        }
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "octodev", type: "User" }), { status: 200 });
        }
        if (url.includes("/api.github.com/user/repos")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

    const overrideAttemptRes = await SELF.fetch(
      `https://example.com/auth/github/callback?code=valid_code&state=${state}&client_secret=attacker_controlled_secret&client_id=attacker_id`,
      { method: "GET", headers: { cookie: cookieHeader }, redirect: "manual" },
    );
    expect(overrideAttemptRes.status).toBe(302);
    expect(capturedBody).toBeDefined();
    // Must use env credentials, NOT query params
    expect(capturedBody.client_id).toBe("gh_test_client_id");
    expect(capturedBody.client_secret).toBe("gh_test_client_secret");

    // 3. OrgCoordinator persistence returns 500 -> 502 (cloud-factory-cf-yp07)
    const getSpy = vi.spyOn(env.ORG_COORDINATOR!, "get").mockReturnValue({
      fetch: vi.fn().mockResolvedValue(new Response("Internal Error", { status: 500 })),
    } as any);

    const persistFailRes = await SELF.fetch(
      `https://example.com/auth/github/callback?code=valid_code&state=${state}`,
      { method: "GET", headers: { cookie: cookieHeader } },
    );
    expect(persistFailRes.status).toBe(502);
    const persistFailJson = (await persistFailRes.json()) as any;
    expect(persistFailJson.ok).toBe(false);
    expect(persistFailJson.error).toContain("OrgCoordinator persistence failed with HTTP 500");

    // OrgCoordinator fetch rejection -> 502
    getSpy.mockReturnValue({
      fetch: vi.fn().mockRejectedValue(new Error("DO connection lost")),
    } as any);

    const netFailRes = await SELF.fetch(
      `https://example.com/auth/github/callback?code=valid_code&state=${state}`,
      { method: "GET", headers: { cookie: cookieHeader } },
    );
    expect(netFailRes.status).toBe(502);
    const netFailJson = (await netFailRes.json()) as any;
    expect(netFailJson.ok).toBe(false);
    expect(netFailJson.error).toContain("Failed to reach OrgCoordinator: Error: DO connection lost");

    getSpy.mockRestore();

    // 4. Unset credentials returns 503 (cloud-factory-cf-yp07)
    const origId = env.GITHUB_CLIENT_ID;
    const origSecret = env.GITHUB_CLIENT_SECRET;
    try {
      (env as any).GITHUB_CLIENT_ID = "";
      const noIdLoginRes = await SELF.fetch("https://example.com/auth/github/login");
      expect(noIdLoginRes.status).toBe(503);
      const noIdLoginJson = (await noIdLoginRes.json()) as any;
      expect(noIdLoginJson.error).toContain("GitHub Client ID is not configured (set GITHUB_CLIENT_ID)");

      const noIdCallbackRes = await SELF.fetch(
        `https://example.com/auth/github/callback?code=valid_code&state=${state}`,
        { method: "GET", headers: { cookie: cookieHeader } },
      );
      expect(noIdCallbackRes.status).toBe(503);
      const noIdCallbackJson = (await noIdCallbackRes.json()) as any;
      expect(noIdCallbackJson.error).toContain("GitHub OAuth credentials are not configured in environment");

      // Blank GITHUB_CLIENT_SECRET alone with GITHUB_CLIENT_ID restored (cloud-factory-cf-mesa)
      (env as any).GITHUB_CLIENT_ID = origId;
      (env as any).GITHUB_CLIENT_SECRET = "";

      const noSecretCallbackRes = await SELF.fetch(
        `https://example.com/auth/github/callback?code=valid_code&state=${state}`,
        { method: "GET", headers: { cookie: cookieHeader } },
      );
      expect(noSecretCallbackRes.status).toBe(503);
      const noSecretCallbackJson = (await noSecretCallbackRes.json()) as any;
      expect(noSecretCallbackJson.error).toContain("GitHub OAuth credentials are not configured in environment");
    } finally {
      (env as any).GITHUB_CLIENT_ID = origId;
      (env as any).GITHUB_CLIENT_SECRET = origSecret;
    }
  });

  it("/auth/github/login: falls back to CredentialBroker or OrgCoordinator when env.GITHUB_CLIENT_ID is unset (cloud-factory-cf-1wnf)", async () => {
    const origId = env.GITHUB_CLIENT_ID;
    try {
      (env as any).GITHUB_CLIENT_ID = "";

      // 1. Fall back to CredentialBroker for ?owner=acme&repo=widget
      const controlKey = env.BROKER_CONTROL_KEY ?? "test-broker-control-key";
      const brokerStub = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName("acme/widget"));
      await brokerStub.fetch("https://credential-broker.internal/settings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-factory-control-key": controlKey,
        },
        body: JSON.stringify({
          githubApp: { clientId: "broker-saved-client-id-123" },
        }),
      });

      const brokerLoginRes = await SELF.fetch(
        "https://example.com/auth/github/login?owner=acme&repo=widget",
        { redirect: "manual" },
      );
      expect(brokerLoginRes.status).toBe(302);
      const brokerLocation = brokerLoginRes.headers.get("location");
      expect(brokerLocation).toContain("client_id=broker-saved-client-id-123");

      // 2. Fall back to default broker when no owner/org is in URL
      const defaultBrokerStub = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName("default"));
      await defaultBrokerStub.fetch("https://credential-broker.internal/settings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-factory-control-key": controlKey,
        },
        body: JSON.stringify({
          githubApp: { clientId: "default-broker-client-id-456" },
        }),
      });

      const defaultLoginRes = await SELF.fetch(
        "https://example.com/auth/github/login",
        { redirect: "manual" },
      );
      expect(defaultLoginRes.status).toBe(302);
      const defaultLocation = defaultLoginRes.headers.get("location");
      expect(defaultLocation).toContain("client_id=default-broker-client-id-456");

      // 3. Fall back to OrgCoordinator for ?org=octo-org when repo broker has no key
      if (env.ORG_COORDINATOR) {
        const orgStub = env.ORG_COORDINATOR.get(env.ORG_COORDINATOR.idFromName("octo-org"));
        await orgStub.fetch("https://org-coordinator.internal/memory", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "github.client_id", value: "org-saved-client-id-789" }),
        });

        const orgLoginRes = await SELF.fetch(
          "https://example.com/auth/github/login?org=octo-org",
          { redirect: "manual" },
        );
        expect(orgLoginRes.status).toBe(302);
        const orgLocation = orgLoginRes.headers.get("location");
        expect(orgLocation).toContain("client_id=org-saved-client-id-789");
      }
    } finally {
      (env as any).GITHUB_CLIENT_ID = origId;
    }
  });

  it("flow=install: rejects PAT with explicit error on App installation endpoints (cloud-factory-cf-egp6, cloud-factory-cf-kgr3)", async () => {
    const installId = 555;
    const intent = await beginOAuthIntent();

    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        // GitHub rejects PAT tokens with 401 on /app/installations/
        if (url.includes("/app/installations/")) {
          return new Response(JSON.stringify({ message: "A regular PAT cannot access /app/installations" }), { status: 401 });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

    const installRes = await SELF.fetch(
      `https://example.com/auth/github/callback?installation_id=${installId}&setup_action=install&state=${intent.state}&return_to=/`,
      { method: "GET", headers: { cookie: intent.cookie }, redirect: "manual" },
    );

    expect(installRes.status).toBe(502);
    const installJson = (await installRes.json()) as any;
    expect(installJson.ok).toBe(false);
    expect(installJson.error).toContain("GitHub App installation endpoint requires an App JWT; personal access tokens (ghp_) are not accepted by GitHub");
  });

  it("flow=install: rejects 401 on /installation/repositories with installation access token error (cloud-factory-cf-c8qj)", async () => {
    const installId = 777;
    const intent = await beginOAuthIntent();

    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`/app/installations/${installId}`)) {
          return new Response(JSON.stringify({ id: installId, account: { login: "testorg", type: "Organization" } }), { status: 200 });
        }
        if (url.includes("/installation/repositories")) {
          return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

    const installRes = await SELF.fetch(
      `https://example.com/auth/github/callback?installation_id=${installId}&setup_action=install&state=${intent.state}&return_to=/`,
      { method: "GET", headers: { cookie: intent.cookie }, redirect: "manual" },
    );

    expect(installRes.status).toBe(502);
    const installJson = (await installRes.json()) as any;
    expect(installJson.ok).toBe(false);
    expect(installJson.error).toBe(
      "GitHub installation repositories endpoint requires an installation access token; personal access tokens (ghp_) are not accepted by GitHub",
    );
  });

  it("flow=install: mints RS256 App JWT, exchanges for installation access token, and queries repos (cloud-factory-cf-uqnu)", async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const pkcs8Der = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8Der)));
    const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;

    const installId = 987;
    const intent = await beginOAuthIntent();
    const appId = "app_12345";
    let capturedJwt: string | null = null;
    let capturedInstToken: string | null = null;

    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const auth = (init?.headers as any)?.authorization ?? "";
        if (url.includes(`/app/installations/${installId}/access_tokens`)) {
          if (!auth.startsWith("Bearer ") || auth.includes("ghp_") || auth.split(".").length !== 3) {
            return new Response(JSON.stringify({ message: "A valid JWT is required" }), { status: 401 });
          }
          capturedJwt = auth.replace("Bearer ", "");
          return new Response(JSON.stringify({ token: "ghs_installation_access_token_xyz" }), { status: 200 });
        }
        if (url.includes(`/app/installations/${installId}`)) {
          if (!auth.startsWith("Bearer ") || auth.includes("ghp_") || auth.split(".").length !== 3) {
            return new Response(JSON.stringify({ message: "A valid JWT is required" }), { status: 401 });
          }
          capturedJwt = auth.replace("Bearer ", "");
          return new Response(JSON.stringify({ id: installId, account: { login: "apporg", type: "Organization" } }), { status: 200 });
        }
        if (url.includes("/installation/repositories")) {
          capturedInstToken = auth.replace("Bearer ", "");
          return new Response(
            JSON.stringify({
              total_count: 1,
              repositories: [
                { id: 202, full_name: "apporg/agent-shelf", name: "agent-shelf", private: false, default_branch: "main", owner: { login: "apporg" } },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch,
    );

    const origAppId = env.GITHUB_APP_ID;
    const origAppKey = env.GITHUB_APP_PRIVATE_KEY;
    try {
      (env as any).GITHUB_APP_ID = appId;
      (env as any).GITHUB_APP_PRIVATE_KEY = pem;

      const installRes = await SELF.fetch(
        `https://example.com/auth/github/callback?installation_id=${installId}&setup_action=install&state=${intent.state}&return_to=/`,
        { method: "GET", headers: { cookie: intent.cookie }, redirect: "manual" },
      );

      expect(installRes.status).toBe(302);
      expect(capturedJwt).toBeDefined();
      expect(capturedInstToken).toBe("ghs_installation_access_token_xyz");

      // Verify JWT payload
      const [, payloadB64] = capturedJwt!.split(".");
      expect(payloadB64).toBeDefined();
      const payload = JSON.parse(atob(payloadB64!.replace(/-/g, "+").replace(/_/g, "/")));
      expect(payload.iss).toBe(appId);

      // Verify JWT signature against keyPair.publicKey (cloud-factory-cf-5vat)
      const jwtParts = capturedJwt!.split(".");
      expect(jwtParts.length).toBe(3);
      const b64UrlToBytes = (s: string) => {
        const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice((2 - (s.length & 3)) & 3);
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr;
      };
      const signedMessage = new TextEncoder().encode(`${jwtParts[0]}.${jwtParts[1]}`);
      expect(jwtParts[2]).toBeDefined();
      const signatureBytes = b64UrlToBytes(jwtParts[2]!);
      const isVerified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keyPair.publicKey, signatureBytes, signedMessage);
      expect(isVerified).toBe(true);

      // Verify repos persisted in OrgCoordinator
      const orgReposRes = await SELF.fetch("https://example.com/api/repos?owner=apporg", {
        headers: { "x-factory-control-key": "test-control-key" },
      });
      expect(orgReposRes.status).toBe(200);
      const orgReposData = (await orgReposRes.json()) as any;
      expect(orgReposData.ok).toBe(true);
      expect(orgReposData.count).toBe(1);
      expect(orgReposData.repositories[0].fullName).toBe("apporg/agent-shelf");
    } finally {
      (env as any).GITHUB_APP_ID = origAppId;
      (env as any).GITHUB_APP_PRIVATE_KEY = origAppKey;
    }
  });
});

describe("/api/repos: the browser session minted by the connect callback (cloud-factory-cf-d33)", () => {
  const SESSION_SIGNING_KEY = "test-broker-signing-key"; // BROKER_SIGNING_KEY in vitest.config.ts
  const hex = (buffer: ArrayBuffer): string =>
    Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  async function sign(data: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(SESSION_SIGNING_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return hex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  }

  /** Run the real login → callback hop and return the cookies the browser would keep. */
  async function connect(): Promise<string> {
    const loginRes = await SELF.fetch("https://example.com/auth/github/login?redirect_uri=/", {
      redirect: "manual",
    });
    expect(loginRes.status).toBe(302);
    const state = new URL(loginRes.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;

    const callback = await SELF.fetch(
      `https://example.com/auth/github/callback?code=mock_code_123&return_to=/&state=${state}`,
      { headers: { cookie: stateCookie }, redirect: "manual" },
    );
    expect(callback.status).toBe(302);
    const cookies = callback.headers.get("set-cookie") ?? "";
    expect(cookies, "the state cookie must be cleared").toContain("cf_oauth_state=;");
    const session = /cf_session=([^;]+)/.exec(cookies)?.[1];
    expect(session, "the callback must mint a session for the connected account").toBeDefined();
    return `cf_session=${session}`;
  }

  it("reads the connected account's repositories from the session cookie alone, without the control key", async () => {
    const cookie = await connect();

    const own = await SELF.fetch("https://example.com/api/repos?owner=octodev", { headers: { cookie } });
    expect(own.status).toBe(200);
    const data = (await own.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.repositories.map((repo: any) => repo.fullName)).toEqual([
      "octodev/widget-service",
      "octodev/secret-project",
    ]);

    // No ?owner= means "my repositories" — the 1-click path after the OAuth return.
    const implicit = await SELF.fetch("https://example.com/api/repos", { headers: { cookie } });
    expect(implicit.status).toBe(200);
    expect(((await implicit.json()) as any).count).toBe(2);
  });

  it("refuses another account's repositories even with a valid session, and still accepts the control key", async () => {
    const cookie = await connect();

    const other = await SELF.fetch("https://example.com/api/repos?owner=victimorg", { headers: { cookie } });
    expect(other.status).toBe(403);
    expect(((await other.json()) as any).error).toContain("another account");

    // The machine contract is unchanged: the control key still reads any owner.
    const machine = await SELF.fetch("https://example.com/api/repos?owner=octodev", {
      headers: { "x-factory-control-key": "test-control-key" },
    });
    expect(machine.status).toBe(200);
  });

  it("refuses forged and expired sessions, and clears the state cookie on success", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const forged = await SELF.fetch("https://example.com/api/repos?owner=octodev", {
      headers: { cookie: `cf_session=octodev.${exp}.${"0".repeat(64)}` },
    });
    expect(forged.status).toBe(401);

    const past = Math.floor(Date.now() / 1000) - 10;
    const expired = await SELF.fetch("https://example.com/api/repos?owner=octodev", {
      headers: { cookie: `cf_session=octodev.${past}.${await sign(`octodev.${past}`)}` },
    });
    expect(expired.status).toBe(401);

    // A correctly signed cookie for a login cannot be retargeted at another owner.
    const retargeted = await SELF.fetch("https://example.com/api/repos?owner=victimorg", {
      headers: { cookie: `cf_session=victimorg.${exp}.${await sign(`octodev.${exp}`)}` },
    });
    expect(retargeted.status).toBe(401);
  });

  it("allows browser session auth in handleApiRepos when BROKER_CONTROL_KEY is unset (cloud-factory-cf-owqq)", async () => {
    const cookie = await connect();

    // 1. Valid browser session authenticates successfully even when BROKER_CONTROL_KEY is undefined
    const envNoControlKey = { ...env, BROKER_CONTROL_KEY: undefined };
    const ownReq = new Request("https://example.com/api/repos?owner=octodev", { headers: { cookie } });
    const ownRes = await handleApiRepos(ownReq, envNoControlKey as any, new URL(ownReq.url));
    expect(ownRes.status).toBe(200);
    const ownData = (await ownRes.json()) as any;
    expect(ownData.ok).toBe(true);
    expect(ownData.repositories.map((repo: any) => repo.fullName)).toEqual([
      "octodev/widget-service",
      "octodev/secret-project",
    ]);

    // 2. Implicit owner with omitted ?owner= query parameter still works without control key
    const implicitReq = new Request("https://example.com/api/repos", { headers: { cookie } });
    const implicitRes = await handleApiRepos(implicitReq, envNoControlKey as any, new URL(implicitReq.url));
    expect(implicitRes.status).toBe(200);
    expect(((await implicitRes.json()) as any).count).toBe(2);

    // 3. Machine caller presenting control key when BROKER_CONTROL_KEY is unset returns 503
    const machineReq = new Request("https://example.com/api/repos?owner=octodev", {
      headers: { "x-factory-control-key": "some-key" },
    });
    const machineRes = await handleApiRepos(machineReq, envNoControlKey as any, new URL(machineReq.url));
    expect(machineRes.status).toBe(503);
    const machineData = (await machineRes.json()) as any;
    expect(machineData.ok).toBe(false);
    expect(machineData.error).toContain("control key not configured");

    // 4. Request without session cookie and without control key returns 401
    const unauthReq = new Request("https://example.com/api/repos?owner=octodev");
    const unauthRes = await handleApiRepos(unauthReq, envNoControlKey as any, new URL(unauthReq.url));
    expect(unauthRes.status).toBe(401);

    // 5. When neither control key nor signing key is configured, returns 503
    const envNoKeys = {
      ...env,
      BROKER_CONTROL_KEY: undefined,
      BROKER_SIGNING_KEY: undefined,
      WEBHOOK_SECRET: undefined,
    };
    const noKeysReq = new Request("https://example.com/api/repos?owner=octodev", { headers: { cookie } });
    const noKeysRes = await handleApiRepos(noKeysReq, envNoKeys as any, new URL(noKeysReq.url));
    expect(noKeysRes.status).toBe(503);
    const noKeysData = (await noKeysRes.json()) as any;
    expect(noKeysData.ok).toBe(false);
    expect(noKeysData.error).toContain("control key not configured");

    // 6. WEBHOOK_SECRET must never authenticate a session cookie (cloud-factory-cf-yk2j)
    const webhookOnlyEnv = {
      ...env,
      BROKER_CONTROL_KEY: undefined,
      BROKER_SIGNING_KEY: undefined,
      WEBHOOK_SECRET: "my-webhook-secret",
    };
    // Sign cookie with WEBHOOK_SECRET
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const enc = new TextEncoder();
    const whKey = await crypto.subtle.importKey(
      "raw",
      enc.encode("my-webhook-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const whSig = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", whKey, enc.encode(`octodev.${exp}`))))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const whCookie = `cf_session=octodev.${exp}.${whSig}`;

    const whReq = new Request("https://example.com/api/repos?owner=octodev", { headers: { cookie: whCookie } });
    const whRes = await handleApiRepos(whReq, webhookOnlyEnv as any, new URL(whReq.url));
    // Since neither BROKER_CONTROL_KEY nor BROKER_SIGNING_KEY is set, returns 503 (WEBHOOK_SECRET is not accepted)
    expect(whRes.status).toBe(503);

    // And with BROKER_CONTROL_KEY configured, a WEBHOOK_SECRET-signed cookie is rejected with 401
    const whReqWithControlKey = new Request("https://example.com/api/repos?owner=octodev", { headers: { cookie: whCookie } });
    const whResWithControlKey = await handleApiRepos(whReqWithControlKey, { ...env, BROKER_SIGNING_KEY: "real-signing-key" } as any, new URL(whReqWithControlKey.url));
    expect(whResWithControlKey.status).toBe(401);

    // 7. Case-insensitive owner comparison (cloud-factory-cf-z1ch): "Octodev" matches session "octodev"
    const caseReq = new Request("https://example.com/api/repos?owner=Octodev", { headers: { cookie } });
    const caseRes = await handleApiRepos(caseReq, envNoControlKey as any, new URL(caseReq.url));
    expect(caseRes.status).toBe(200);
    const caseData = (await caseRes.json()) as any;
    expect(caseData.ok).toBe(true);
  });

  it("allows session auth on /api/repos even when BROKER_CONTROL_KEY is unset", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sig = await sign(`octodev.${exp}`);
    const cookie = `cf_session=octodev.${exp}.${sig}`;

    // Test with handleApiRepos directly with env lacking BROKER_CONTROL_KEY
    const req = new Request("https://example.com/api/repos?owner=octodev", {
      headers: { cookie },
    });
    const testEnv = {
      ...env,
      BROKER_CONTROL_KEY: undefined,
      BROKER_SIGNING_KEY: SESSION_SIGNING_KEY,
    } as any;
    const res = await handleApiRepos(req, testEnv, new URL(req.url));
    expect(res.status).toBe(200);

    // Machine caller with presented key gets 503 if controlKey is unset
    const machineReq = new Request("https://example.com/api/repos?owner=octodev", {
      headers: { "x-factory-control-key": "some-key" },
    });
    const machineRes = await handleApiRepos(machineReq, testEnv, new URL(machineReq.url));
    expect(machineRes.status).toBe(503);
  });
});
