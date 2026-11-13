import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signBody } from "./support/webhook";
import { resolveBrokerRepository, resolveRepositoryKey } from "../src/repo-coordinator-addressing";

/**
 * Canonical repository addressing (cloud-factory-cf-n23o).
 *
 * The Durable Object key IS the repository spelling, so before canonicalisation a delivery
 * stored under GitHub's own casing was invisible to a trace read typed in any other casing:
 * two spellings, two objects, 0 evidence. These tests pin the fix - one canonical lowercase
 * key for every caller, with the pre-canonicalisation spellings recovered by the legacy
 * read-through rather than orphaned.
 */

const controlKey = "test-control-key";

function pingBody(repository: string): string {
  return JSON.stringify({
    zen: "Keep it logically awesome.",
    hook_id: 42,
    hook: { type: "Repository", active: true },
    repository: { full_name: repository },
  });
}

/**
 * Posts to the real webhook route. The path and the payload spelling are separate on
 * purpose: GitHub sends its own casing in `repository.full_name` while the hook URL
 * carries whatever the operator configured.
 */
async function deliver(
  pathRepository: string,
  payloadFullName: string,
  deliveryId: string,
  secret = "test-webhook-secret",
): Promise<Response> {
  const body = pingBody(payloadFullName);
  const signature = await signBody(secret, body);
  return SELF.fetch(
    new Request(`https://example.com/webhooks/github/${pathRepository}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "ping",
        "x-hub-signature-256": signature,
      },
      body,
    }),
  );
}

/** The app-level endpoint whose routing comes from the payload's own casing. */
async function deliverGlobal(
  payloadFullName: string,
  deliveryId: string,
  secret = "test-webhook-secret",
): Promise<Response> {
  const body = pingBody(payloadFullName);
  const signature = await signBody(secret, body);
  return SELF.fetch(
    new Request("https://example.com/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "ping",
        "x-hub-signature-256": signature,
      },
      body,
    }),
  );
}

async function connect(path: string): Promise<{ ok: boolean; connect: { repository: string; pings: number } }> {
  const res = await SELF.fetch(`https://example.com${path}`, {
    headers: { "x-factory-control-key": controlKey },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { ok: boolean; connect: { repository: string; pings: number } };
}

describe("canonical repository addressing", () => {
  it("folds owner and repo casing in the one resolver, keeping platform precedence", () => {
    expect(resolveRepositoryKey("Acme/Widget", "github")).toBe("github:acme/widget");
    expect(resolveRepositoryKey("github:Acme/Widget")).toBe("github:acme/widget");
    // 6eqm still holds: an explicit hint beats a contradicting prefix, folded.
    expect(resolveRepositoryKey("github:Acme/Widget", "gitlab")).toBe("gitlab:acme/widget");
    expect(resolveRepositoryKey("gitlab:Acme/Widget", "github")).toBe("github:acme/widget");
    expect(resolveRepositoryKey("gitlab:Group/Project")).toBe("gitlab:group/project");
    // The broker key is the bare, folded twin - the g5c0 lesson: both families must fold
    // the same way or the coordinator asks a broker the settings UI never wrote to.
    expect(resolveBrokerRepository("github:Acme/Widget")).toBe("acme/widget");
    expect(resolveBrokerRepository("Acme/Widget")).toBe("acme/widget");
  });

  it("sees a ping delivered under one casing from a trace read typed in another", async () => {
    // The bead's own repro: delivery addressed as octodev/probe-owner-case, read as
    // Octodev/Probe-Owner-Case. Before the fix this read landed in a different, empty
    // object and reported 0.
    const delivered = await deliver("octodev/probe-owner-case", "octodev/probe-owner-case", "case-ping-1");
    expect(delivered.status).toBe(202);

    const status = await connect("/trace/Octodev/Probe-Owner-Case/connect");
    expect(status.connect.pings).toBe(1);

    // And the other direction, with the payload carrying GitHub's own mixed casing while
    // the hook URL is lowercase - the two ingress branches must not fork.
    const delivered2 = await deliver("acme/case-url", "Acme/Case-URL", "case-ping-2");
    expect(delivered2.status).toBe(202);
    const status2 = await connect("/trace/ACME/CASE-URL/connect");
    expect(status2.connect.pings).toBe(1);
    const status2b = await connect("/trace/acme/case-url/connect");
    expect(status2b.connect.pings).toBe(1);
  });

  it("recovers history stranded in a pre-canonicalisation object, without double counting", async () => {
    // A pre-canonicalisation object named by GitHub's own casing holds two pings.
    const stranded = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName("github:Acme/Stranded"));
    await runInDurableObject(stranded, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO webhook_connect (id, last_ping_at, last_event_at, last_event, pings, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        "default",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "ping",
        2,
        "2026-01-01T00:00:00.000Z",
      );
    });

    // First delivery to the canonical object, through the app-level endpoint so the
    // payload's own casing (GitHub's, exactly how pre-canonicalisation objects were
    // named) is the routing and the hint: the stranded object is probed and merged (2),
    // then the new ping is recorded (3).
    const delivered = await deliverGlobal("Acme/Stranded", "stranded-ping-1");
    expect(delivered.status).toBe(202);

    const status = await connect("/trace/acme/stranded/connect");
    expect(status.connect.pings).toBe(3);

    // Re-reading (and re-delivering) must not re-sum the stranded counter: the probe
    // marker makes every merge idempotent.
    await deliverGlobal("Acme/Stranded", "stranded-ping-2");
    const again = await connect("/trace/acme/stranded/connect");
    expect(again.connect.pings).toBe(4);

    // The stranded object was told its history is reachable now.
    const acked = await runInDurableObject(stranded, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM _schema_migrations WHERE name = 'migrated_to_prefixed'")
        .toArray(),
    );
    expect(acked).toHaveLength(1);
  });

  it("recovers stranded evidence on a trace read alone, before any delivery", async () => {
    const stranded = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName("github:Acme/ReadOnly"));
    await runInDurableObject(stranded, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO webhook_connect (id, last_ping_at, last_event_at, last_event, pings, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        "default",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "ping",
        5,
        "2026-01-01T00:00:00.000Z",
      );
    });

    // No delivery since the deploy - the READ is the first contact, and its spelling is
    // what tells the canonical object where the old history lives.
    const status = await connect("/trace/Acme/ReadOnly/connect");
    expect(status.connect.pings).toBe(5);
  });

  it("authorises a delivery against settings stored under a different casing", async () => {
    // Settings saved under the operator's casing...
    const saveRes = await SELF.fetch("https://example.com/api/admin/settings/Acme/Aligned", {
      method: "POST",
      headers: { "content-type": "application/json", "x-factory-control-key": controlKey },
      body: JSON.stringify({ webhookSecret: "aligned-repo-secret-n23o" }),
    });
    expect(saveRes.status).toBe(200);

    // ...must authorise a delivery addressed to the canonical lowercase coordinator: the
    // coordinator asks its (canonical) broker, the broker finds the sibling spelling and
    // copies it. Without that, every delivery for an existing tenant would 401 (g5c0).
    const delivered = await deliver("acme/aligned", "acme/aligned", "aligned-ping-1", "aligned-repo-secret-n23o");
    expect(delivered.status).toBe(202);

    // The canonical settings store has converged: the secret was copied on read.
    const getRes = await SELF.fetch("https://example.com/api/admin/settings/acme/aligned", {
      method: "GET",
      headers: { "x-factory-control-key": controlKey },
    });
    expect(getRes.status).toBe(200);
    const settings = (await getRes.json()) as { webhook: { configured: boolean; isRepoOverride: boolean } };
    expect(settings.webhook.configured).toBe(true);
    expect(settings.webhook.isRepoOverride).toBe(true);
  });
});
