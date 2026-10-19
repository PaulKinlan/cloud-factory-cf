import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { AgentManifest } from "@factory-cloud/sdk";

describe("Prompt-to-Agent Studio Worker API", () => {
  it("authors an agent manifest from natural language prompt", async () => {
    const req = new Request("https://factory.cloud/studio/PaulKinlan/cloud-factory-cf/author", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Create an agent called pr-triage that reviews pull requests and reads code files",
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    const data = (await res.json()) as { ok: boolean; manifest: AgentManifest };
    expect(data.ok).toBe(true);
    expect(data.manifest.name).toBe("pr-triage");
    expect(data.manifest.version).toBe("0.1.0");
    expect(data.manifest.triggers.length).toBeGreaterThan(0);
    expect(data.manifest.capabilities.some((c) => c.action === "pr.review")).toBe(true);
  });

  it("simulates authored agent execution inside Workers runtime", async () => {
    const authorReq = new Request("https://factory.cloud/studio/PaulKinlan/cloud-factory-cf/author", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Create an agent called pr-auditor that reviews PRs",
      }),
    });
    const authorRes = await worker.fetch(authorReq, env);
    const { manifest } = (await authorRes.json()) as { manifest: AgentManifest };

    const simReq = new Request("https://factory.cloud/studio/PaulKinlan/cloud-factory-cf/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest,
        event: {
          action: "opened",
          pull_request: { number: 101, title: "fix: critical security bug" },
        },
      }),
    });

    const simRes = await worker.fetch(simReq, env);
    expect(simRes.status).toBe(200);

    const simData = (await simRes.json()) as { ok: boolean; result: any };
    expect(simData.ok).toBe(true);
    expect(simData.result.status).toBe("completed");
    expect(Array.isArray(simData.result.logs)).toBe(true);
  });

  it("installs and lists agents in RepoCoordinator memory", async () => {
    const manifest: AgentManifest = {
      name: "issue-responder",
      version: "0.1.0",
      description: "Auto-responds to issues",
      prompt: "Respond politely to issues",
      triggers: [{ event: "issues.opened" }],
      tools: [],
      capabilities: [{ service: "github", action: "issue.comment" }],
      sinks: [{ type: "github-issue" }],
      memoryScope: "repo",
    };

    // Install agent
    const installReq = new Request(
      "https://factory.cloud/studio/PaulKinlan/cloud-factory-cf/agents",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest }),
      }
    );
    const installRes = await worker.fetch(installReq, env);
    expect(installRes.status).toBe(200);

    // List agents
    const listReq = new Request(
      "https://factory.cloud/studio/PaulKinlan/cloud-factory-cf/agents",
      { method: "GET" }
    );
    const listRes = await worker.fetch(listReq, env);
    expect(listRes.status).toBe(200);

    const listData = (await listRes.json()) as { ok: boolean; keys: string[] };
    expect(listData.ok).toBe(true);
    expect(listData.keys).toContain("agents:issue-responder");

    // Get specific installed agent
    const getReq = new Request(
      "https://factory.cloud/studio/PaulKinlan/cloud-factory-cf/agents/issue-responder",
      { method: "GET" }
    );
    const getRes = await worker.fetch(getReq, env);
    expect(getRes.status).toBe(200);

    const getData = (await getRes.json()) as {
      ok: boolean;
      value: AgentManifest;
    };
    expect(getData.ok).toBe(true);
    expect(getData.value.name).toBe("issue-responder");
  });
});
