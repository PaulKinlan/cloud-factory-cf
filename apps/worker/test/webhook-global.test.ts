import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signBody, TEST_SECRET } from "./support/webhook";

/**
 * The app-level GitHub webhook (`POST /webhooks/github`) writes installation
 * repositories straight into the OrgCoordinator, and nothing behind it verifies the
 * delivery - so the route itself has to refuse an unauthenticated body BEFORE it
 * records anything (cloud-factory-cf-r5ns). An unsigned delivery used to be able to
 * seed any account's installation repositories, private flags included.
 *
 * Each case owns its account login: the OrgCoordinator is keyed by name and the cases
 * are independent, so they hold in any order.
 */
const GLOBAL_URL = "https://example.com/webhooks/github";

/** An app-level `installation_repositories` delivery, in GitHub's shape. */
function installationPayload(account: string, repositories: Array<{ name: string; private?: boolean }>): string {
  return JSON.stringify({
    action: "added",
    installation: { id: 4242, account: { login: account, type: "Organization" } },
    repositories_added: repositories.map((repo) => ({
      id: 1,
      name: repo.name,
      full_name: `${account}/${repo.name}`,
      private: repo.private ?? false,
    })),
  });
}

function orgStub(account: string) {
  return env.ORG_COORDINATOR!.get(env.ORG_COORDINATOR!.idFromName(account));
}

async function recordedRepos(account: string): Promise<Array<{ fullName: string }>> {
  const res = await orgStub(account).fetch("https://org-coordinator.internal/repos");
  expect(res.status).toBe(200);
  const data = (await res.json()) as { repositories?: Array<{ fullName: string }> };
  return data.repositories ?? [];
}

async function deliver(body: string, headers: Record<string, string>): Promise<Response> {
  return SELF.fetch(GLOBAL_URL, { method: "POST", headers, body });
}

describe("global GitHub webhook authentication", () => {
  it("refuses an installation delivery with no signature and records nothing", async () => {
    const account = "unsigned-install";
    const body = installationPayload(account, [{ name: "leaked", private: true }]);

    const res = await deliver(body, { "content-type": "application/json", "x-github-event": "installation_repositories" });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid signature" });
    expect(await recordedRepos(account)).toEqual([]);
  });

  it("refuses a delivery signed with the wrong secret", async () => {
    const account = "forged-install";
    const body = installationPayload(account, [{ name: "leaked" }]);

    const res = await deliver(body, {
      "content-type": "application/json",
      "x-github-event": "installation_repositories",
      "x-hub-signature-256": await signBody("not-the-webhook-secret", body),
    });

    expect(res.status).toBe(401);
    expect(await recordedRepos(account)).toEqual([]);
  });

  it("records the repositories of a correctly signed installation delivery", async () => {
    const account = "signed-install";
    const body = installationPayload(account, [
      { name: "alpha" },
      { name: "beta", private: true },
    ]);

    const res = await deliver(body, {
      "content-type": "application/json",
      "x-github-event": "installation_repositories",
      "x-hub-signature-256": await signBody(TEST_SECRET, body),
    });

    expect(res.status).toBe(202);
    const recorded = await recordedRepos(account);
    expect(recorded.map((repo) => repo.fullName).sort()).toEqual([
      `${account}/alpha`,
      `${account}/beta`,
    ]);
  });

  it("refuses an unsigned repository delivery at the edge instead of forwarding it", async () => {
    const body = JSON.stringify({
      action: "opened",
      repository: { full_name: "edge-unverified/widgets" },
      sender: { login: "octocat" },
    });

    const res = await deliver(body, {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "11111111-2222-3333-4444-555555555555",
    });

    expect(res.status).toBe(401);
  });
});
