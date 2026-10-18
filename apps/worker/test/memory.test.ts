import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CoordinatorMemoryStore } from "@factory-cloud/sdk";

describe("Hierarchical Central Memory Store", () => {
  it("OrgCoordinator performs CRUD and lists keys in SQLite", async () => {
    const orgStub = env.ORG_COORDINATOR!.get(env.ORG_COORDINATOR!.idFromName("acme-corp"));

    // 1. Initial get returns 404
    const initialGet = await orgStub.fetch("https://org-coordinator.internal/memory/guidelines");
    expect(initialGet.status).toBe(404);

    // 2. Set memory with metadata
    const setRes = await orgStub.fetch("https://org-coordinator.internal/memory/guidelines", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        value: { reviewRules: ["no-raw-secrets", "fail-closed"] },
        metadata: { author: "security-team" },
      }),
    });
    expect(setRes.status).toBe(200);

    // 3. Get memory
    const getRes = await orgStub.fetch("https://org-coordinator.internal/memory/guidelines");
    expect(getRes.status).toBe(200);
    const data = (await getRes.json()) as {
      ok: boolean;
      key: string;
      value: { reviewRules: string[] };
      metadata: { author: string };
      createdAt: string;
      updatedAt: string;
    };
    expect(data.ok).toBe(true);
    expect(data.key).toBe("guidelines");
    expect(data.value.reviewRules).toEqual(["no-raw-secrets", "fail-closed"]);
    expect(data.metadata.author).toBe("security-team");

    // 4. List keys with prefix
    await orgStub.fetch("https://org-coordinator.internal/memory/guardrail-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "active" }),
    });

    const listRes = await orgStub.fetch("https://org-coordinator.internal/memory?prefix=guardrail");
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as { ok: boolean; keys: string[] };
    expect(listData.keys).toEqual(["guardrail-1"]);

    // 5. Delete memory
    const delRes = await orgStub.fetch("https://org-coordinator.internal/memory/guardrail-1", {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);

    const afterDel = await orgStub.fetch("https://org-coordinator.internal/memory/guardrail-1");
    expect(afterDel.status).toBe(404);
  });

  it("RepoCoordinator handles repo memory and forwards org memory seamlessly", async () => {
    const repoName = "acme-corp/service-backend";
    const repoStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repoName));

    // Set repo-level memory on RepoCoordinator
    const repoSet = await repoStub.fetch("https://repo-coordinator.internal/memory/runtime-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: { port: 8080, workers: 4 } }),
    });
    expect(repoSet.status).toBe(200);

    // Set org-level memory through RepoCoordinator (?scope=org)
    const orgSet = await repoStub.fetch(
      "https://repo-coordinator.internal/memory/global-policy?scope=org",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: { requireApproval: true } }),
      },
    );
    expect(orgSet.status).toBe(200);

    // Read back repo-level memory (?scope=repo or default)
    const repoGet = await repoStub.fetch("https://repo-coordinator.internal/memory/runtime-config");
    expect(repoGet.status).toBe(200);
    const repoData = (await repoGet.json()) as { value: { port: number } };
    expect(repoData.value.port).toBe(8080);

    // Read back org-level memory through RepoCoordinator (?scope=org)
    const orgGet = await repoStub.fetch(
      "https://repo-coordinator.internal/memory/global-policy?scope=org",
    );
    expect(orgGet.status).toBe(200);
    const orgData = (await orgGet.json()) as { value: { requireApproval: boolean } };
    expect(orgData.value.requireApproval).toBe(true);

    // Verify scope isolation: global-policy does NOT exist in repo scope
    const crossRepoGet = await repoStub.fetch(
      "https://repo-coordinator.internal/memory/global-policy",
    );
    expect(crossRepoGet.status).toBe(404);

    // Verify scope isolation: runtime-config does NOT exist in org scope
    const crossOrgGet = await repoStub.fetch(
      "https://repo-coordinator.internal/memory/runtime-config?scope=org",
    );
    expect(crossOrgGet.status).toBe(404);
  });

  it("CoordinatorMemoryStore works with RepoCoordinator across org and repo scopes", async () => {
    const repoName = "acme-corp/data-pipeline";
    const repoStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repoName));

    const store = new CoordinatorMemoryStore(repoStub);

    // Set memories in both scopes
    await store.set("repo", "cache_ttl", 300);
    await store.set("org", "org_license", "Apache-2.0", { approvedBy: "legal" });

    // Read memories back
    const repoTtl = await store.get("repo", "cache_ttl");
    expect(repoTtl).toBe(300);

    const orgLicense = await store.get("org", "org_license");
    expect(orgLicense).toBe("Apache-2.0");

    // List keys per scope
    const repoEntries = await store.list("repo");
    expect(repoEntries.map((e) => e.key)).toContain("cache_ttl");

    const orgEntries = await store.list("org");
    expect(orgEntries.map((e) => e.key)).toContain("org_license");
    const orgEntry = orgEntries.find((e) => e.key === "org_license");
    expect(orgEntry?.metadata).toEqual({ approvedBy: "legal" });

    // Delete repo key
    const deleted = await store.delete("repo", "cache_ttl");
    expect(deleted).toBe(true);
    const afterDelete = await store.get("repo", "cache_ttl");
    expect(afterDelete).toBeUndefined();
  });
});
