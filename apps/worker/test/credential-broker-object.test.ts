import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

const CONTROL_KEY = "test-control-key";
const SIGNING_KEY = "test-broker-signing-key";
const GITHUB_CREDENTIAL = "ghp_test_github_credential";

interface IssuedCapability {
  ok: boolean;
  capability?: string;
  expiresAt?: number;
  repository?: string;
  error?: string;
}

function brokerUrl(repository: string, operation: string): string {
  return `https://example.com/broker/${repository}/${operation}`;
}

async function brokerFetch(
  repository: string,
  operation: string,
  init: { method?: string; body?: unknown; controlKey?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.controlKey !== undefined) headers["x-factory-control-key"] = init.controlKey;
  return SELF.fetch(brokerUrl(repository, operation), {
    method: init.method ?? "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** Capability issuance needs a provisioning record, so tests provision first. */
async function provision(
  repository: string,
  body: { agent: string; service: string; action: string },
): Promise<Response> {
  return brokerFetch(repository, "provisioning", { body, controlKey: CONTROL_KEY });
}

async function issue(
  repository: string,
  body: { agent: string; service: string; action: string; ttlSeconds?: number },
): Promise<IssuedCapability> {
  await provision(repository, { agent: body.agent, service: body.service, action: body.action });
  const response = await brokerFetch(repository, "capabilities", { body, controlKey: CONTROL_KEY });
  return (await response.json()) as IssuedCapability;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("credential broker object: issuance", () => {
  it("requires the control-plane key to mint a capability", async () => {
    const missing = await brokerFetch("acme/rta5-issue", "capabilities", {
      body: { agent: "agent-1", service: "github", action: "repo.read" },
    });
    expect(missing.status).toBe(401);

    const wrong = await brokerFetch("acme/rta5-issue", "capabilities", {
      body: { agent: "agent-1", service: "github", action: "repo.read" },
      controlKey: "not-the-key",
    });
    expect(wrong.status).toBe(401);

    const good = await issue("acme/rta5-issue", { agent: "agent-1", service: "github", action: "repo.read" });
    expect(good.ok).toBe(true);
    expect(good.capability?.split(".")).toHaveLength(2);
    expect(good.repository).toBe("acme/rta5-issue");
    expect(good.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("refuses to mint a capability for an action outside the policy", async () => {
    const response = await brokerFetch("acme/rta5-issue", "capabilities", {
      body: { agent: "agent-1", service: "github", action: "org.delete" },
      controlKey: CONTROL_KEY,
    });
    expect(response.status).toBe(403);

    const missingFields = await brokerFetch("acme/rta5-issue", "capabilities", {
      body: { service: "github", action: "repo.read" },
      controlKey: CONTROL_KEY,
    });
    expect(missingFields.status).toBe(400);
  });

  it("answers permission queries for the control plane, and refuses them without it", async () => {
    // Policy state is tenant data, and the broker object's own GET /permissions answers
    // with no check, so this route is the only gate (cloud-factory-cf-1osx). The test
    // used to read it anonymously - it encoded the exposure rather than the contract.
    const anonymous = await brokerFetch("acme/rta5-perm", "permissions?service=github&action=pr.comment", {
      method: "GET",
    });
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as { permitted?: boolean }).permitted).toBeUndefined();

    const permitted = (await (
      await brokerFetch("acme/rta5-perm", "permissions?service=github&action=pr.comment", {
        method: "GET",
        controlKey: CONTROL_KEY,
      })
    ).json()) as { permitted: boolean };
    expect(permitted.permitted).toBe(true);

    const denied = (await (
      await brokerFetch("acme/rta5-perm", "permissions?service=github&action=org.delete", {
        method: "GET",
        controlKey: CONTROL_KEY,
      })
    ).json()) as { permitted: boolean };
    expect(denied.permitted).toBe(false);
  });
});

describe("credential broker object: proxying", () => {
  it("executes a signed request with the credential attached only upstream", async () => {
    const repository = "acme/rta5-proxy";
    const issued = await issue(repository, { agent: "agent-1", service: "github", action: "pr.comment" });
    expect(issued.ok).toBe(true);

    const calls: Array<{ url: string; authorization: string | null; body?: string }> = [];
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(JSON.stringify({ id: 9, note: `echo ${GITHUB_CREDENTIAL}` }), {
        status: 201,
        headers: { authorization: `Bearer ${GITHUB_CREDENTIAL}`, "set-cookie": "session=abc" },
      });
    }) as typeof fetch);

    const response = await brokerFetch(repository, "proxy", {
      body: { capability: issued.capability, params: { number: 7, body: "LGTM" } },
    });
    const payload = (await response.json()) as {
      ok: boolean;
      status: number;
      body: string;
      redactions: number;
      auditId: number;
    };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, status: 201, redactions: 1 });
    expect(payload.body).not.toContain(GITHUB_CREDENTIAL);
    expect(payload.body).toContain("[redacted]");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/rta5-proxy/issues/7/comments");
    expect(calls[0]?.authorization).toBe(`Bearer ${GITHUB_CREDENTIAL}`);
    expect(calls[0]?.body).toBe(JSON.stringify({ body: "LGTM" }));
    // The broker's own response carries no upstream headers at all.
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("authorization")).toBeNull();
  });

  it("denies tampered, cross-repository and widened capabilities, and audits each attempt", async () => {
    const repository = "acme/rta5-deny";
    const issued = await issue(repository, { agent: "agent-2", service: "github", action: "repo.read" });
    const token = issued.capability as string;

    const tampered = await brokerFetch(repository, "proxy", {
      body: { capability: `${token.split(".")[0]}.${"A".repeat(43)}`, params: {} },
    });
    expect(tampered.status).toBe(401);

    const widened = await brokerFetch(repository, "proxy", {
      body: { capability: token, service: "github", action: "pr.comment", params: { number: 1, body: "x" } },
    });
    expect(widened.status).toBe(403);

    // A capability minted for another repository must not work here.
    const other = await issue("acme/rta5-other", { agent: "agent-2", service: "github", action: "repo.read" });
    const crossRepo = await brokerFetch(repository, "proxy", {
      body: { capability: other.capability, params: {} },
    });
    expect(crossRepo.status).toBe(403);

    const unauthorisedAudit = await brokerFetch(repository, "audit?limit=20", { method: "GET" });
    expect(unauthorisedAudit.status).toBe(401);

    const audit = (await (
      await brokerFetch(repository, "audit?limit=20", { method: "GET", controlKey: CONTROL_KEY })
    ).json()) as { entries: Array<{ outcome: string; agent: string; detail: string | null }>; count: number };

    expect(audit.entries.some((entry) => entry.outcome === "denied")).toBe(true);
    const serialised = JSON.stringify(audit);
    expect(serialised).not.toContain(GITHUB_CREDENTIAL);
    expect(serialised).not.toContain(token.split(".")[1] as string);
  });

  it("executes read-only actions without a body and records the outcome", async () => {
    const repository = "acme/rta5-read";
    const issued = await issue(repository, { agent: "agent-3", service: "github", action: "repo.read" });

    vi.stubGlobal("fetch", (async () =>
      new Response(JSON.stringify({ full_name: "acme/rta5-read" }), { status: 200 })) as typeof fetch);

    const response = await brokerFetch(repository, "proxy", { body: { capability: issued.capability } });
    const payload = (await response.json()) as { ok: boolean; status: number; auditId: number };
    expect(payload).toMatchObject({ ok: true, status: 200 });

    const audit = (await (
      await brokerFetch(repository, "audit", { method: "GET", controlKey: CONTROL_KEY })
    ).json()) as { entries: Array<{ outcome: string; service: string; action: string; status: number | null }> };
    const executed = audit.entries.find((entry) => entry.outcome === "executed");
    expect(executed).toMatchObject({ service: "github", action: "repo.read", status: 200 });
  });
});
