import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OrgCoordinator } from "../src/org-coordinator";

function orgCoordinator(org: string) {
  return env.ORG_COORDINATOR!.get(env.ORG_COORDINATOR!.idFromName(org));
}

describe("OrgCoordinator Durable Object", () => {
  it("initializes OrgCoordinator and records installations and authorized repos", async () => {
    const stub = orgCoordinator("octodev");

    // 1. Initially no repos
    const initialRes = await stub.fetch("https://org-coordinator.internal/repos");
    expect(initialRes.status).toBe(200);
    const initialData = (await initialRes.json()) as any;
    expect(initialData.ok).toBe(true);
    expect(initialData.count).toBe(0);
    expect(initialData.repositories).toEqual([]);

    // 2. Record installation with repos
    const installRes = await stub.fetch("https://org-coordinator.internal/installations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installationId: "inst_12345",
        accountLogin: "octodev",
        accountType: "User",
        repos: [
          {
            fullName: "octodev/repo-alpha",
            owner: "octodev",
            name: "repo-alpha",
            private: false,
            defaultBranch: "main",
          },
          {
            fullName: "octodev/repo-beta",
            owner: "octodev",
            name: "repo-beta",
            private: true,
            defaultBranch: "trunk",
          },
        ],
      }),
    });
    expect(installRes.status).toBe(200);
    const installData = (await installRes.json()) as any;
    expect(installData.ok).toBe(true);
    expect(installData.count).toBe(2);

    // 3. List repos
    const listRes = await stub.fetch("https://org-coordinator.internal/repos");
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as any;
    expect(listData.ok).toBe(true);
    expect(listData.count).toBe(2);
    expect(listData.repositories).toHaveLength(2);
    expect(listData.repositories[0].fullName).toBe("octodev/repo-alpha");
    expect(listData.repositories[1].isPrivate).toBe(true);

    // 4. Check stats
    const statsRes = await stub.fetch("https://org-coordinator.internal/stats");
    expect(statsRes.status).toBe(200);
    const statsData = (await statsRes.json()) as any;
    expect(statsData.ok).toBe(true);
    expect(statsData.org).toBe("octodev");
  });

  it("handles org-scoped memory storage", async () => {
    const stub = orgCoordinator("octodev");

    // Store key
    const putRes = await stub.fetch("https://org-coordinator.internal/memory/test-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: { note: "hello org" } }),
    });
    expect(putRes.status).toBe(200);

    // Retrieve key
    const getRes = await stub.fetch("https://org-coordinator.internal/memory/test-key");
    expect(getRes.status).toBe(200);
    const getData = (await getRes.json()) as any;
    expect(getData.ok).toBe(true);
    expect(getData.value).toEqual({ note: "hello org" });

    // Delete key
    const delRes = await stub.fetch("https://org-coordinator.internal/memory/test-key", {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
  });
});
