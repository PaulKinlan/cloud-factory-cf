import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintSessionToken } from "../src/routes/auth";

/**
 * `POST /api/repos` registered a repository record containing whatever the caller asserted: any
 * fullName, any `private`, any `defaultBranch` (cloud-factory-cf-15ao). That record is what later
 * decides whether a repository is treated as public, which branch the pipeline reads, and which
 * org's coordinator owns it - so a caller could describe a repository it cannot even see and have
 * the fleet act on that description.
 *
 * The cases below drive the real Worker and the real OrgCoordinator Durable Object. Only GitHub
 * is stubbed, because GitHub is the thing being consulted.
 */
const CONTROL_KEY = "test-control-key";
const SIGNING_KEY = "test-broker-signing-key"; // BROKER_SIGNING_KEY in vitest.config.ts

function stubGithub(
  repositories: Record<string, { private?: boolean; default_branch?: string; full_name?: string }>,
  options: { listError?: boolean } = {},
) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const match = /https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/?]+)/.exec(url);
      if (match) {
        const key = `${match[1]}/${match[2]}`.toLowerCase();
        const repo = repositories[key];
        if (!repo) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        return Response.json({
          full_name: repo.full_name ?? `${match[1]}/${match[2]}`,
          name: match[2],
          private: repo.private ?? false,
          default_branch: repo.default_branch ?? "main",
          owner: { login: match[1] },
        });
      }
      if (url.includes("/app/installations") && options.listError) {
        return new Response("nope", { status: 500 });
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch,
  );
  return calls;
}

async function postRepo(fullName: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return SELF.fetch("https://example.com/api/repos", {
    method: "POST",
    headers: { "content-type": "application/json", "x-factory-control-key": CONTROL_KEY, ...headers },
    body: JSON.stringify({ fullName, ...extra }),
  });
}

async function listRepos(owner: string) {
  const res = await SELF.fetch(`https://example.com/api/repos?owner=${encodeURIComponent(owner)}`, {
    headers: { "x-factory-control-key": CONTROL_KEY },
  });
  return (await res.json()) as { repositories?: Array<Record<string, unknown>> };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/repos verifies the repository with GitHub", () => {
  it("stores GitHub's description of the repository, not the caller's claims", async () => {
    stubGithub({ "acme/widgets": { private: true, default_branch: "trunk" } });

    const response = await postRepo("acme/widgets", { private: false, defaultBranch: "main" });
    expect(response.status).toBe(200);

    const listed = await listRepos("acme");
    const stored = listed.repositories?.find((repo) => repo.fullName === "acme/widgets");
    expect(stored).toBeDefined();
    // The caller said public/main; GitHub says private/trunk, and GitHub wins. The coordinator
    // stores the flag as is_private and reports it as isPrivate.
    expect(stored).toMatchObject({ isPrivate: true, defaultBranch: "trunk" });
  });

  it("refuses a repository GitHub does not confirm, and writes nothing", async () => {
    stubGithub({ "acme/widgets": {} });

    const response = await postRepo("evil/not-a-repo");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: "repository could not be verified through GitHub" });

    const listed = await listRepos("evil");
    expect(listed.repositories ?? []).toHaveLength(0);
  });

  it("refuses to file a repository under an account the caller is not acting for", async () => {
    const calls = stubGithub({ "acme/widgets": {} });
    const cookie = `cf_session=${encodeURIComponent(await mintSessionToken(SIGNING_KEY, "octodev"))}`;

    const response = await SELF.fetch("https://example.com/api/repos", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ fullName: "acme/widgets" }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "repositories must belong to the account you are acting for",
    });
    // Refused before asking GitHub anything: nothing to verify for an account that is not ours.
    expect(calls).toHaveLength(0);
  });

  it("refuses rather than trusts when it cannot ask GitHub at all", async () => {
    const calls = stubGithub({ "acme/widgets": {} });
    // A deployment with no GitHub credential cannot verify anything, and a record it cannot
    // verify is exactly the record this endpoint must not write.
    const originalToken = env.GITHUB_TOKEN;
    (env as { GITHUB_TOKEN?: string }).GITHUB_TOKEN = "";
    try {
      const response = await postRepo("acme/widgets");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: expect.stringContaining("cannot be verified"),
      });
      expect(calls).toHaveLength(0);
    } finally {
      (env as { GITHUB_TOKEN?: string }).GITHUB_TOKEN = originalToken;
    }
  });

  it("still refuses a body with no repository to verify", async () => {
    stubGithub({});
    const response = await SELF.fetch("https://example.com/api/repos", {
      method: "POST",
      headers: { "x-factory-control-key": CONTROL_KEY },
    });
    expect(response.status).toBe(400);
  });
});
