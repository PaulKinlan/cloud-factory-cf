import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { AgentManifest } from "@factory-cloud/sdk";

const authHeaders = {
  "Content-Type": "application/json",
  "x-factory-control-key": "test-control-key",
};

describe("Prompt-to-Agent Studio Worker API", () => {
  it("rejects unauthenticated requests and bad control keys with 401/503 (cloud-factory-cf-17qf)", async () => {
    // 1. Missing control key -> 401
    const missingReq = new Request("https://factory.cloud/studio/PaulKinlan/cloud-factory-cf/agents", {
      method: "GET",
    });
    const missingRes = await worker.fetch(missingReq, env);
    expect(missingRes.status).toBe(401);
    const missingJson = (await missingRes.json()) as any;
    expect(missingJson.ok).toBe(false);
    expect(missingJson.error).toContain("not authorised");

    // 2. Bad control key -> 401
    const badKeyReq = new Request("https://factory.cloud/studio/PaulKinlan/cloud-factory-cf/agents", {
      method: "GET",
      headers: { "x-factory-control-key": "wrong-key" },
    });
    const badKeyRes = await worker.fetch(badKeyReq, env);
    expect(badKeyRes.status).toBe(401);

    // 3. No control-plane credential configured -> 503. Since cloud-factory-cf-e1ql a
    // session signing key alone is a working deployment, so this strips every key.
    const unconfigRes = await worker.fetch(
      new Request("https://factory.cloud/studio/PaulKinlan/cloud-factory-cf/agents", {
        headers: { "x-factory-control-key": "test-control-key" },
      }),
      {
        ...env,
        BROKER_CONTROL_KEY: undefined,
        BROKER_SIGNING_KEY: undefined,
        WEBHOOK_SECRET: undefined,
      } as any,
    );
    expect(unconfigRes.status).toBe(503);
  });

  it("authors an agent manifest from natural language prompt", async () => {
    const req = new Request("https://factory.cloud/studio/PaulKinlan/cloud-factory-cf/author", {
      method: "POST",
      headers: authHeaders,
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
      headers: authHeaders,
      body: JSON.stringify({
        prompt: "Create an agent called pr-auditor that reviews PRs",
      }),
    });
    const authorRes = await worker.fetch(authorReq, env);
    const { manifest } = (await authorRes.json()) as { manifest: AgentManifest };

    const simReq = new Request("https://factory.cloud/studio/PaulKinlan/cloud-factory-cf/simulate", {
      method: "POST",
      headers: authHeaders,
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
        headers: authHeaders,
        body: JSON.stringify({ manifest }),
      }
    );
    const installRes = await worker.fetch(installReq, env);
    expect(installRes.status).toBe(200);

    // List agents
    const listReq = new Request(
      "https://factory.cloud/studio/PaulKinlan/cloud-factory-cf/agents",
      { method: "GET", headers: { "x-factory-control-key": "test-control-key" } }
    );
    const listRes = await worker.fetch(listReq, env);
    expect(listRes.status).toBe(200);

    const listData = (await listRes.json()) as { ok: boolean; keys: string[] };
    expect(listData.ok).toBe(true);
    expect(listData.keys).toContain("agents:issue-responder");

    // Get specific installed agent
    const getReq = new Request(
      "https://factory.cloud/studio/PaulKinlan/cloud-factory-cf/agents/issue-responder",
      { method: "GET", headers: { "x-factory-control-key": "test-control-key" } }
    );
    const getRes = await worker.fetch(getReq, env);
    expect(getRes.status).toBe(200);

    const getData = (await getRes.json()) as {
      ok: boolean;
      value: AgentManifest;
    };
    expect(getData.ok).toBe(true);
    expect(getData.value.name).toBe("issue-responder");

    // Rejects manifest with unauthorized capabilities (fixes cloud-factory-cf-w8v)
    const badCapReq = new Request(
      "https://factory.cloud/studio/PaulKinlan/cloud-factory-cf/agents",
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          manifest: {
            ...manifest,
            name: "malicious-agent",
            capabilities: [{ service: "github", action: "admin.delete_all" }],
          },
        }),
      }
    );
    const badCapRes = await worker.fetch(badCapReq, env);
    expect(badCapRes.status).toBe(400);

    // Rejects manifest with unregistered sinks (fixes cloud-factory-cf-w8v)
    const badSinkReq = new Request(
      "https://factory.cloud/studio/PaulKinlan/cloud-factory-cf/agents",
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          manifest: {
            ...manifest,
            name: "bad-sink-agent",
            sinks: [{ type: "nope-sink" }],
          },
        }),
      }
    );
    const badSinkRes = await worker.fetch(badSinkReq, env);
    expect(badSinkRes.status).toBe(400);

    // Supports memoryScope: "both" (fixes cloud-factory-cf-w8v)
    const bothReq = new Request(
      "https://factory.cloud/studio/PaulKinlan/cloud-factory-cf/agents",
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          manifest: {
            ...manifest,
            name: "dual-scope-agent",
            memoryScope: "both",
          },
        }),
      }
    );
    const bothRes = await worker.fetch(bothReq, env);
    expect(bothRes.status).toBe(200);

    // Verify stored in org coordinator
    const orgStub = env.ORG_COORDINATOR!.get(env.ORG_COORDINATOR!.idFromName("PaulKinlan"));
    const orgGetRes = await orgStub.fetch("https://org-coordinator.internal/memory/agents:dual-scope-agent");
    expect(orgGetRes.status).toBe(200);
  });
});
