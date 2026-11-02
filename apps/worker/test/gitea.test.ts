import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decideAction, type EventFacts } from "../src/pipeline";
import { signBody } from "./support/webhook";
import { getRepoCoordinator } from "../src/repo-coordinator-addressing";

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

    const stub = getRepoCoordinator(env, "forge/repo", "gitea");
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

  it("turns the queued Gitea row into the same review action a GitHub PR gets", async () => {
    // The whole slice: ingest a Gitea delivery, read the row the queue actually
    // stores, and let the pipeline decide on it. No provider-specific branch.
    const response = await SELF.fetch(await giteaRequest("forge/decision-repo", { delivery: "gitea-decide" }));
    expect(response.status).toBe(202);

    const stub = getRepoCoordinator(env, "forge/decision-repo", "gitea");
    const listed = (await (await stub.fetch(`${BASE}/events`)).json()) as {
      events: Array<Record<string, unknown>>;
    };
    const row = listed.events.find((entry) => entry["deliveryId"] === "gitea-decide");
    expect(row).toBeDefined();

    const facts = {
      ...(row as unknown as EventFacts),
      payload: { action: "opened", number: 4, repository: { full_name: "forge/decision-repo" } },
      number: 4,
      title: "Add the adapter",
    } satisfies EventFacts;
    expect(decideAction(facts)).toMatchObject({ type: "github:pr:review", payload: { prNumber: 4 } });
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

  it("refuses the deployment's GitHub webhook secret, and fails closed when its own is unset (cloud-factory-cf-dxuh)", async () => {
    // WEBHOOK_SECRET is the GitHub App secret. A Gitea endpoint must never accept it -
    // one platform's hook secret authenticating another platform's endpoint is how a
    // single leaked deployment secret becomes every provider's key.
    const body = pullRequestBody("forge/shared-secret");
    const githubSecretSignature = (await signBody("test-webhook-secret", body)).replace(/^sha256=/, "");
    const signedWithGithubSecret = await SELF.fetch(
      new Request("https://example.com/webhooks/gitea/forge/shared-secret", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gitea-delivery": "gitea-github-secret",
          "x-gitea-event": "pull_request",
          "x-gitea-signature": githubSecretSignature,
        },
        body,
      }),
    );
    expect(signedWithGithubSecret.status).toBe(401);

    const tokenWithGithubSecret = await giteaRequest("forge/shared-secret", {
      delivery: "gitea-github-secret-token",
      token: "test-webhook-secret",
    });
    tokenWithGithubSecret.headers.delete("x-gitea-signature");
    const refused = await SELF.fetch(tokenWithGithubSecret);
    expect(refused.status).toBe(401);

    // With GITEA_WEBHOOK_SECRET unset there is nothing to verify against: 503, never a
    // fallback to a secret that belongs to another provider. A Durable Object's bindings
    // are fixed at namespace level in the test runtime, so clear it inside the instance
    // (the same shape as the 1xs3 test) rather than passing a binding override.
    const unconfiguredRepo = "forge/unconfigured-dxuh";
    const unconfiguredStub = getRepoCoordinator(env, unconfiguredRepo, "gitea");
    // The instance's env IS the shared binding object in this runtime, so the clear has
    // to be undone or every later test in the file sees an unconfigured platform.
    const setSecret = (value: string | undefined) =>
      runInDurableObject(unconfiguredStub, (instance) => {
        (instance as unknown as { env: { GITEA_WEBHOOK_SECRET?: string } }).env.GITEA_WEBHOOK_SECRET = value;
      });
    await setSecret(undefined);
    try {
      const unconfigured = await SELF.fetch(
        new Request(`https://example.com/webhooks/gitea/${unconfiguredRepo}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-gitea-delivery": "gitea-unconfigured",
            "x-gitea-event": "pull_request",
            "x-gitea-token": "test-webhook-secret",
          },
          body: pullRequestBody(unconfiguredRepo),
        }),
      );
      expect(unconfigured.status).toBe(503);
      await expect(unconfigured.json()).resolves.toMatchObject({ error: "gitea webhook secret not configured" });
    } finally {
      await setSecret(GITEA_SECRET);
    }
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
