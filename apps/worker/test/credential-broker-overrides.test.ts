import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Per-repository overrides let one deployment serve several installations: the
 * repository's broker object can name a different credential binding, and can
 * narrow (never widen) the actions the policy already allows.
 */
const CONTROL_KEY = "test-control-key";
const REPOSITORY = "acme/rta5-overrides";
const DEFAULT_GITHUB = "ghp_test_github_credential";
const INSTALL_2 = "ghp_test_github_install_2";

interface Capability {
  ok: boolean;
  capability?: string;
  error?: string;
}

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

async function provisionAndIssue(agent: string, action: string): Promise<string> {
  await brokerFetch("provisioning", { body: { agent, service: "github", action } });
  const response = await brokerFetch("capabilities", { body: { agent, service: "github", action } });
  const payload = (await response.json()) as Capability;
  expect(payload.ok, `issuing ${action} for ${agent}: ${payload.error ?? ""}`).toBe(true);
  return payload.capability as string;
}

async function clearOverrides(): Promise<void> {
  for (const kind of ["credential_binding", "allowed_actions"]) {
    await brokerFetch("overrides", { method: "DELETE", body: { service: "github", kind } });
  }
}

async function setOverride(kind: string, value: unknown, service = "github"): Promise<Response> {
  return brokerFetch("overrides", { body: { service, kind, value } });
}

function stubUpstream(seen: Array<{ url: string; authorization: string | null }> = []) {
  vi.stubGlobal(
    "fetch",
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch,
  );
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("credential broker object: per-repository overrides", () => {
  it("uses the repository's credential binding when one is set", async () => {
    await clearOverrides();
    const capability = await provisionAndIssue("agent-cred", "repo.read");

    const defaultSeen = stubUpstream();
    expect((await brokerFetch("proxy", { body: { capability } })).status).toBe(200);
    expect(defaultSeen[0]?.authorization).toBe(`Bearer ${DEFAULT_GITHUB}`);

    expect((await setOverride("credential_binding", "GITHUB_TOKEN_INSTALL_2")).status).toBe(200);

    const overrideSeen = stubUpstream();
    expect((await brokerFetch("proxy", { body: { capability } })).status).toBe(200);
    expect(overrideSeen[0]?.authorization).toBe(`Bearer ${INSTALL_2}`);

    const listed = (await (await brokerFetch("overrides", { method: "GET" })).json()) as {
      entries: Array<{ kind: string; value: unknown }>;
    };
    expect(listed.entries).toContainEqual(expect.objectContaining({ kind: "credential_binding", value: "GITHUB_TOKEN_INSTALL_2" }));
  });

  it("narrows the allowed actions for the repository", async () => {
    await clearOverrides();
    // Allowed by policy, and issued before the narrowing.
    await provisionAndIssue("agent-narrow", "pr.comment");

    expect((await setOverride("allowed_actions", ["repo.read"])).status).toBe(200);

    const narrowed = await brokerFetch("capabilities", {
      body: { agent: "agent-narrow", service: "github", action: "pr.comment" },
    });
    expect(narrowed.status).toBe(403);
    await expect(narrowed.json()).resolves.toMatchObject({
      ok: false,
      error: "action not allowed in this repository",
    });

    await brokerFetch("provisioning", { body: { agent: "agent-narrow", service: "github", action: "repo.read" } });
    const stillAllowed = await brokerFetch("capabilities", {
      body: { agent: "agent-narrow", service: "github", action: "repo.read" },
    });
    expect(stillAllowed.status).toBe(200);

    const permissions = (await (
      await SELF.fetch(`https://example.com/broker/${REPOSITORY}/permissions?service=github&action=pr.comment`)
    ).json()) as { permitted: boolean; narrowedByRepository: boolean };
    expect(permissions).toMatchObject({ permitted: false, narrowedByRepository: true });
  });

  it("refuses to widen the policy and refuses a malformed binding", async () => {
    await clearOverrides();

    const widened = await setOverride("allowed_actions", ["repo.read", "org.delete"]);
    expect(widened.status).toBe(400);
    await expect(widened.json()).resolves.toMatchObject({
      ok: false,
      error: "action org.delete is not permitted by policy for github",
    });

    const badBinding = await setOverride("credential_binding", "not a binding!");
    expect(badBinding.status).toBe(400);

    const badKind = await brokerFetch("overrides", { body: { service: "github", kind: "anything", value: "x" } });
    expect(badKind.status).toBe(400);

    // Neither refusal wrote a record.
    const listed = (await (await brokerFetch("overrides", { method: "GET" })).json()) as { entries: unknown[] };
    expect(listed.entries).toHaveLength(0);
  });

  it("denies a capability issued before the narrowing when it is used", async () => {
    await clearOverrides();
    const stale = await provisionAndIssue("agent-stale", "pr.comment");

    expect((await setOverride("allowed_actions", ["repo.read"])).status).toBe(200);

    const seen = stubUpstream();
    const refused = await brokerFetch("proxy", {
      body: { capability: stale, params: { number: 1, body: "too late" } },
    });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ ok: false, error: "action not allowed in this repository" });
    expect(seen).toHaveLength(0);
  });

  it("restores the defaults when an override is deleted, and 404s an absent one", async () => {
    await clearOverrides();
    const capability = await provisionAndIssue("agent-restore", "repo.read");
    await setOverride("credential_binding", "GITHUB_TOKEN_INSTALL_2");

    const deleted = await brokerFetch("overrides", {
      method: "DELETE",
      body: { service: "github", kind: "credential_binding" },
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ ok: true, service: "github", kind: "credential_binding" });

    const seen = stubUpstream();
    expect((await brokerFetch("proxy", { body: { capability } })).status).toBe(200);
    expect(seen[0]?.authorization).toBe(`Bearer ${DEFAULT_GITHUB}`);

    const missing = await brokerFetch("overrides", {
      method: "DELETE",
      body: { service: "github", kind: "credential_binding" },
    });
    expect(missing.status).toBe(404);
  });

  it("keeps overrides on the control plane", async () => {
    expect((await brokerFetch("overrides", { method: "GET", controlKey: null })).status).toBe(401);
    expect(
      (await brokerFetch("overrides", { body: { service: "github", kind: "allowed_actions", value: [] }, controlKey: null }))
        .status,
    ).toBe(401);
    expect(
      (await brokerFetch("overrides", { method: "DELETE", body: { service: "github", kind: "allowed_actions" }, controlKey: "wrong" }))
        .status,
    ).toBe(401);
  });

  it("fails closed when a stored allowlist is corrupt", async () => {
    await clearOverrides();
    // Reach into the object's storage the way a partial write would.
    const { runInDurableObject } = await import("cloudflare:test");
    const id = (await import("cloudflare:test")).env.CREDENTIAL_BROKER.idFromName(REPOSITORY);
    const stub = (await import("cloudflare:test")).env.CREDENTIAL_BROKER.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO repo_overrides (service, kind, value, updated_at) VALUES ('github', 'allowed_actions', ?, 'now')`,
        "{not json",
      );
    });

    const response = await brokerFetch("capabilities", {
      body: { agent: "agent-corrupt", service: "github", action: "repo.read" },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "action not allowed in this repository" });
  });
});
