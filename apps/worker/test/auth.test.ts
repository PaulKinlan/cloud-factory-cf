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

    const callbackRes = await SELF.fetch(
      "https://example.com/auth/github/callback?code=mock_code_123&installation_id=inst_456&return_to=/",
      {
        method: "GET",
        redirect: "manual",
      },
    );

    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get("location");
    expect(location).toBeDefined();
    expect(location).toContain("connected=1");
    expect(location).toContain(`owner=${testUser}`);
    expect(location).toContain("installation_id=inst_456");

    // 4. Query /api/repos to verify repos are persisted in OrgCoordinator
    const reposRes = await SELF.fetch(`https://example.com/api/repos?owner=${testUser}`);
    expect(reposRes.status).toBe(200);
    const reposData = (await reposRes.json()) as any;
    expect(reposData.ok).toBe(true);
    expect(reposData.count).toBe(2);
    expect(reposData.repositories).toHaveLength(2);
    expect(reposData.repositories[0].fullName).toBe("octodev/widget-service");
    expect(reposData.repositories[1].isPrivate).toBe(true);
  });
});
