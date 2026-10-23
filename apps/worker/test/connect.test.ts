import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ConnectStore } from "../src/events/connect";
import { signBody, TEST_SECRET } from "./support/webhook";
import { getRepoCoordinator } from "../src/repo-coordinator-addressing";
import { mintSessionToken } from "../src/routes/auth";

/**
 * Webhook connection evidence (cloud-factory-cf-7gq.1).
 *
 * GitHub's `ping` is the only thing that proves a hook is pointed at a
 * repository's Durable Object, so the onboarding UI reads it rather than guessing.
 * These run against a real Durable Object and the real webhook route.
 */

const BASE = "https://repo-coordinator.internal";
const controlKey = "test-control-key";

function pingBody(repository: string): string {
  return JSON.stringify({
    zen: "Keep it logically awesome.",
    hook_id: 42,
    hook: { type: "Repository", active: true },
    repository: { full_name: repository },
  });
}

function pullRequestBody(repository: string): string {
  return JSON.stringify({
    action: "opened",
    number: 7,
    sender: { login: "octocat" },
    repository: { full_name: repository },
  });
}

async function deliver(
  repository: string,
  event: string,
  deliveryId: string,
  body: string,
): Promise<Response> {
  const signature = await signBody(TEST_SECRET, body);
  return SELF.fetch(
    new Request(`https://example.com/webhooks/github/${repository}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": event,
        "x-hub-signature-256": signature,
      },
      body,
    }),
  );
}

/** The public, control-key-guarded read the onboarding UI will poll. */
async function connect(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const handler = (await import("../src/index")).default;
  return handler.fetch(
    new Request(`https://factory.example${path}`, { headers }),
    { ...env, BROKER_CONTROL_KEY: controlKey } as never,
  );
}

interface ConnectBody {
  ok: boolean;
  connect: {
    repository: string;
    lastPingAt: string | null;
    lastEventAt: string | null;
    lastEvent: string | null;
    pings: number;
  };
}

describe("connect evidence", () => {
  it("records the ping that proves a hook is connected", async () => {
    const repository = "acme/connect-ping";
    const first = await deliver(repository, "ping", "ping-1", pingBody(repository));
    expect(first.status).toBe(202);
    const body = (await first.json()) as { ping?: boolean; connect?: ConnectBody["connect"] };
    expect(body.ping).toBe(true);
    expect(body.connect?.lastPingAt).toEqual(expect.any(String));

    const response = await connect("/trace/acme/connect-ping/connect", { "x-factory-control-key": controlKey });
    expect(response.status).toBe(200);
    const status = (await response.json()) as ConnectBody;
    expect(status.ok).toBe(true);
    expect(status.connect).toMatchObject({ repository, lastEvent: "ping", pings: 1 });
    expect(status.connect.lastPingAt).toEqual(expect.any(String));

    // A re-created hook pings again; the store counts it rather than overwriting.
    await deliver(repository, "ping", "ping-2", pingBody(repository));
    const second = (await (await connect("/trace/acme/connect-ping/connect", { "x-factory-control-key": controlKey })).json()) as ConnectBody;
    expect(second.connect.pings).toBe(2);
  });

  it("records ordinary deliveries without claiming they were a ping", async () => {
    const repository = "acme/connect-event";
    const delivered = await deliver(repository, "pull_request", "pr-1", pullRequestBody(repository));
    expect(delivered.status).toBe(202);

    const status = (await (await connect("/trace/acme/connect-event/connect", { "x-factory-control-key": controlKey })).json()) as ConnectBody;
    expect(status.connect).toMatchObject({ repository, lastPingAt: null, lastEvent: "pull_request", pings: 0 });
    expect(status.connect.lastEventAt).toEqual(expect.any(String));

    // The delivery is still queued for the pipeline: recording evidence must not
    // swallow ordinary work.
    const stub = getRepoCoordinator(env, repository, "github");
    const events = (await (await stub.fetch(`${BASE}/events`)).json()) as {
      events: Array<Record<string, unknown>>;
    };
    expect(events.events.some((event) => event["deliveryId"] === "pr-1")).toBe(true);
  });

  it("does not queue a ping as work the pipeline would have to skip", async () => {
    const repository = "acme/connect-nopqueue";
    await deliver(repository, "ping", "ping-only", pingBody(repository));
    const stub = getRepoCoordinator(env, repository, "github");
    const events = (await (await stub.fetch(`${BASE}/events`)).json()) as {
      events: Array<Record<string, unknown>>;
    };
    expect(events.events).toHaveLength(0);
  });

  it("never invents a connection: an empty store reports nulls", async () => {
    // The gate (and the UI) must be able to tell "no evidence" from "connected",
    // so exercise the store itself against real DO SQLite, not just the wire shape.
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName("acme/connect-store"));
    const result = await runInDurableObject(stub, (_instance, state) => {
      const store = new ConnectStore(state.storage.sql, "acme/connect-store");
      const empty = store.snapshot();
      store.recordPing("2026-10-19T16:00:00.000Z");
      store.recordEvent("pull_request", "2026-10-19T16:01:00.000Z");
      return { empty, after: store.snapshot() };
    });
    expect(result.empty).toEqual({
      repository: "acme/connect-store",
      lastPingAt: null,
      lastEventAt: null,
      lastEvent: null,
      pings: 0,
    });
    expect(result.after).toEqual({
      repository: "acme/connect-store",
      lastPingAt: "2026-10-19T16:00:00.000Z",
      lastEventAt: "2026-10-19T16:01:00.000Z",
      lastEvent: "pull_request",
      pings: 1,
    });
  });

  it("keeps the connection state on the control plane only", async () => {
    const handler = (await import("../src/index")).default;
    const guarded = (workerEnv: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> =>
      handler.fetch(
        new Request("https://factory.example/trace/acme/connect-ping/connect", { headers }),
        workerEnv as never,
      );

    // Fails closed with no key configured, and refuses a caller without one.
    expect((await guarded({ ...env, BROKER_CONTROL_KEY: undefined })).status).toBe(503);
    expect((await guarded({ ...env, BROKER_CONTROL_KEY: controlKey })).status).toBe(401);
    expect(
      (await guarded({ ...env, BROKER_CONTROL_KEY: controlKey }, { "x-factory-control-key": controlKey })).status,
    ).toBe(200);
  });

  it("authorizes /trace/:owner/:repo/connect with browser session cookie without control key (cloud-factory-cf-qdud)", async () => {
    const handler = (await import("../src/index")).default;
    const signingKey = "test-broker-signing-key";
    const token = await mintSessionToken(signingKey, "octodev");
    const otherToken = await mintSessionToken(signingKey, "otheruser");

    const testEnv = {
      ...env,
      BROKER_CONTROL_KEY: undefined,
      BROKER_SIGNING_KEY: signingKey,
    };

    // 1. Valid session for octodev accessing octodev's repo succeeds even when BROKER_CONTROL_KEY is undefined
    const res = await handler.fetch(
      new Request("https://factory.example/trace/octodev/connect-ping/connect", {
        headers: { cookie: `cf_session=${token}` },
      }),
      testEnv as never,
    );
    expect(res.status).toBe(200);

    // 2. Session for otheruser attempting to read octodev's connection status returns 403
    const forbidden = await handler.fetch(
      new Request("https://factory.example/trace/octodev/connect-ping/connect", {
        headers: { cookie: `cf_session=${otherToken}` },
      }),
      testEnv as never,
    );
    expect(forbidden.status).toBe(403);
    const forbiddenJson = (await forbidden.json()) as any;
    expect(forbiddenJson.error).toContain("another account");
  });

  it("rejects cookies signed with WEBHOOK_SECRET on /trace/:owner/:repo/connect (cloud-factory-cf-7suc)", async () => {
    const handler = (await import("../src/index")).default;
    const webhookSecret = "webhook-secret-only";
    const token = await mintSessionToken(webhookSecret, "octodev");

    // When broker keys are unset, WEBHOOK_SECRET must never authenticate a browser session (503 control key not configured)
    const unsetEnv = {
      ...env,
      BROKER_CONTROL_KEY: undefined,
      BROKER_SIGNING_KEY: undefined,
      WEBHOOK_SECRET: webhookSecret,
    };

    const res = await handler.fetch(
      new Request("https://factory.example/trace/octodev/connect-ping/connect", {
        headers: { cookie: `cf_session=${token}` },
      }),
      unsetEnv as never,
    );
    expect(res.status).toBe(503);
  });
});
