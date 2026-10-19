import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signBody } from "./support/webhook";

/**
 * Gitea/Forgejo ingestion (ADR 003, cloud-factory-cf-6to.2).
 *
 * One adapter, one route shape, one normalised event: a Gitea delivery must arrive
 * in the queue looking exactly like a GitHub or GitLab one.
 */

const GITEA_SECRET = "test-gitea-webhook-secret";
const BASE = "https://repo-coordinator.internal";

function pullRequestBody(repository: string): string {
  return JSON.stringify({
    action: "opened",
    number: 4,
    sender: { login: "forge-user" },
    repository: { full_name: repository },
  });
}

/** Gitea signs bare hex; Forgejo keeps the same scheme under its own header names. */
async function giteaRequest(
  repository: string,
  overrides: { delivery?: string; signature?: string; token?: string; forgejo?: boolean } = {},
): Promise<Request> {
  const body = pullRequestBody(repository);
  const signature = overrides.signature ?? (await signBody(GITEA_SECRET, body)).replace(/^sha256=/, "");
  const prefix = overrides.forgejo === true ? "x-forgejo" : "x-gitea";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [`${prefix}-delivery`]: overrides.delivery ?? "gitea-1",
    [`${prefix}-event`]: "pull_request",
    [`${prefix}-signature`]: signature,
    "x-hub-signature-256": "",
  };
  if (overrides.token !== undefined) headers[`${prefix}-token`] = overrides.token;
  return new Request(`https://example.com/webhooks/gitea/${repository}`, { method: "POST", headers, body });
}

describe("gitea webhooks", () => {
  it("queues a signed Gitea delivery as a normalised event", async () => {
    const response = await SELF.fetch(await giteaRequest("forge/repo"));
    expect(response.status).toBe(202);

    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName("forge/repo"));
    const events = (await (await stub.fetch(`${BASE}/events`)).json()) as {
      events: Array<Record<string, unknown>>;
    };
    const event = events.events.find((entry) => entry["deliveryId"] === "gitea-1");
    expect(event).toMatchObject({
      provider: "gitea",
      event: "pull_request",
      action: "opened",
      // The canonical event travels with the row: a consumer cannot re-derive it,
      // because the adapters need the request headers, which are not stored (06p).
      kind: "merge_request",
      canonicalAction: "opened",
      repository: "forge/repo",
      actor: "forge-user",
      status: "pending",
    });
  });

  it("accepts a Forgejo delivery through the same route and adapter", async () => {
    const response = await SELF.fetch(await giteaRequest("forge/forgejo-repo", { delivery: "forgejo-1", forgejo: true }));
    expect(response.status).toBe(202);
  });

  it("accepts the verbatim hook token when the instance does not sign", async () => {
    const request = await giteaRequest("forge/token-repo", { delivery: "gitea-token-1", token: GITEA_SECRET });
    request.headers.delete("x-gitea-signature");
    const response = await SELF.fetch(request);
    expect(response.status).toBe(202);
  });

  it("refuses a bad signature and a wrong token", async () => {
    const wrongSignature = await SELF.fetch(
      await giteaRequest("forge/bad", { delivery: "gitea-bad", signature: "0".repeat(64) }),
    );
    expect(wrongSignature.status).toBe(401);
    await expect(wrongSignature.json()).resolves.toMatchObject({ error: "invalid signature" });

    // A token-style hook carries no signature, so the token is what is judged.
    const tokenOnly = await giteaRequest("forge/bad", { delivery: "gitea-bad-3", token: "nope" });
    tokenOnly.headers.delete("x-gitea-signature");
    const refused = await SELF.fetch(tokenOnly);
    expect(refused.status).toBe(401);
    await expect(refused.json()).resolves.toMatchObject({ error: "invalid token" });
  });

  it("refuses a delivery that carries no signature and no token", async () => {
    // Unsigned traffic must never be queued: the schema is opt-out, not opt-in.
    const bare = await giteaRequest("forge/unsigned", { delivery: "gitea-unsigned" });
    bare.headers.delete("x-gitea-signature");
    const response = await SELF.fetch(bare);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid token" });
  });

  it("does not let a gitea delivery masquerade as another repository", async () => {
    const request = await giteaRequest("forge/mismatch");
    // The route binds the DO to forge/mismatch; the payload names another repo.
    const body = pullRequestBody("other/repo");
    const signature = (await signBody(GITEA_SECRET, body)).replace(/^sha256=/, "");
    const spoofed = new Request("https://example.com/webhooks/gitea/forge/mismatch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitea-delivery": "gitea-spoof",
        "x-gitea-event": "pull_request",
        "x-gitea-signature": signature,
      },
      body,
    });
    const response = await SELF.fetch(spoofed);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "repository mismatch" });
    // The legitimately-signed request for the same route is unaffected.
    expect((await SELF.fetch(request)).status).toBe(202);
  });
});
