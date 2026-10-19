import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Capability issuance requires a provisioning record (`BROKER_REQUIRE_PROVISIONING`
 * is unset in tests, i.e. enforcement on). The control key is the only way to
 * write one, which is what stops any control-key holder from minting a
 * capability for an arbitrary, never-provisioned agent id.
 */
const CONTROL_KEY = "test-control-key";
const REPOSITORY = "acme/rta5-provisioning";

async function brokerFetch(
  operation: string,
  init: { method?: string; body?: unknown; controlKey?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.controlKey !== null) headers["x-factory-control-key"] = init.controlKey ?? CONTROL_KEY;
  return SELF.fetch(`https://example.com/broker/${REPOSITORY}/${operation}`, {
    method: init.method ?? "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function provision(agent: string, action: string, service = "github"): Promise<Response> {
  return brokerFetch("provisioning", { body: { agent, service, action } });
}

async function issue(agent: string, action: string, service = "github"): Promise<Response> {
  return brokerFetch("capabilities", { body: { agent, service, action } });
}

async function auditEntries(): Promise<Array<{ outcome: string; agent: string; detail: string | null }>> {
  const response = await SELF.fetch(`https://example.com/broker/${REPOSITORY}/audit?limit=50`, {
    headers: { "x-factory-control-key": CONTROL_KEY },
  });
  const payload = (await response.json()) as { entries: Array<{ outcome: string; agent: string; detail: string | null }> };
  return payload.entries;
}

describe("credential broker object: provisioning", () => {
  it("refuses a capability for an agent with no provisioning record, and audits it", async () => {
    const response = await issue("agent-unprovisioned", "repo.read");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "agent is not provisioned for this action",
    });

    const entries = await auditEntries();
    expect(entries).toContainEqual(
      expect.objectContaining({
        agent: "agent-unprovisioned",
        outcome: "denied",
        detail: "agent is not provisioned for this action",
      }),
    );
  });

  it("issues once the control plane provisions the exact action", async () => {
    const provisioned = await provision("agent-exact", "repo.read");
    expect(provisioned.status).toBe(200);
    await expect(provisioned.json()).resolves.toMatchObject({
      ok: true,
      agent: "agent-exact",
      service: "github",
      action: "repo.read",
    });

    const issued = await issue("agent-exact", "repo.read");
    expect(issued.status).toBe(200);
    await expect(issued.json()).resolves.toMatchObject({ ok: true, agent: "agent-exact" });

    // The exact provisioning record does not leak to a different action.
    expect((await issue("agent-exact", "pr.comment")).status).toBe(403);

    const entries = await auditEntries();
    expect(entries.some((entry) => entry.outcome === "provisioned" && entry.agent === "agent-exact")).toBe(true);
  });

  it("allows a wildcard action but never a policy-denied one", async () => {
    expect((await provision("agent-wildcard", "*")).status).toBe(200);

    expect((await issue("agent-wildcard", "repo.read")).status).toBe(200);
    expect((await issue("agent-wildcard", "pr.comment")).status).toBe(200);
    // `org.delete` is not in the policy table, so provisioning cannot open it.
    const denied = await issue("agent-wildcard", "org.delete");
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ ok: false, error: "action not permitted" });

    // Nor can the control plane provision a policy-denied action directly.
    const badProvision = await provision("agent-wildcard", "org.delete");
    expect(badProvision.status).toBe(403);
  });

  it("revokes a provisioning record and refuses issuance again", async () => {
    await provision("agent-revoked", "repo.read");
    expect((await issue("agent-revoked", "repo.read")).status).toBe(200);

    const revoked = await brokerFetch("provisioning", {
      method: "DELETE",
      body: { agent: "agent-revoked", service: "github", action: "repo.read" },
    });
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({ ok: true, revoked: 1 });

    expect((await issue("agent-revoked", "repo.read")).status).toBe(403);

    const missing = await brokerFetch("provisioning", {
      method: "DELETE",
      body: { agent: "agent-revoked", service: "github", action: "repo.read" },
    });
    expect(missing.status).toBe(404);
  });

  it("keeps provisioning on the control plane", async () => {
    expect((await brokerFetch("provisioning", { controlKey: null })).status).toBe(401);
    expect((await brokerFetch("provisioning", { controlKey: "wrong" })).status).toBe(401);
    expect(
      (await brokerFetch("provisioning", { body: { agent: "a", service: "github", action: "repo.read" }, controlKey: null }))
        .status,
    ).toBe(401);

    const list = await brokerFetch("provisioning", { method: "GET", controlKey: null });
    expect(list.status).toBe(401);
  });

  it("lists records for the repository", async () => {
    await provision("agent-listed", "repo.read");
    const response = await brokerFetch("provisioning", { method: "GET" });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      enforced: boolean;
      repository: string;
      entries: Array<{ agent: string; service: string; action: string; createdAt: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.enforced).toBe(true);
    expect(payload.repository).toBe(REPOSITORY);
    expect(payload.entries).toContainEqual(
      expect.objectContaining({ agent: "agent-listed", service: "github", action: "repo.read" }),
    );
    expect(payload.entries.every((entry) => typeof entry.createdAt === "string")).toBe(true);
  });

  it("rejects a record with a missing field", async () => {
    const response = await brokerFetch("provisioning", { body: { agent: "agent-incomplete", service: "github" } });
    expect(response.status).toBe(400);
  });
});
