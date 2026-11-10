import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  handleTrace,
  mintTraceTicket,
  verifyTraceTicket,
  coordinatorTicketConsumer,
  ticketRepositoryKey,
} from "../src/routes/trace";
import { consumeTraceTicketNonce, migrateTraceTicketTable } from "../src/trace-ticket-store";

/**
 * A trace ticket is a bearer credential for the live-trace WebSocket, valid for 60s. It was
 * single-use only inside the isolate that minted it (a module-scoped Map), so a replay to
 * another isolate was accepted - no real one-shot property at all
 * (cloud-factory-cf-il5w). These cases pin the durable store underneath it.
 */
const SECRET = "test-broker-signing-key";

const coordinator = (repository = "acme/widget") =>
  env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`github:${repository}`));

describe("trace ticket nonces are single-use across isolates", () => {
  const consume = async (ticket: string, now = Date.now()) => {
    const identity = await verifyTraceTicket(SECRET, ticket, now);
    if (!identity) return false;
    const stub = env.REPO_COORDINATOR.get(
      env.REPO_COORDINATOR.idFromName(ticketRepositoryKey(identity)),
    );
    return coordinatorTicketConsumer(stub)(identity.nonce, identity.expiresAt);
  };

  it("spends a ticket once, in the repository the ticket names", async () => {
    const { ticket, expiresAt } = await mintTraceTicket(SECRET, "acme", "widget");
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(await consume(ticket)).toBe(true);
    // A second verification - a fresh consumer, emulating another isolate - is refused,
    // because the nonce is spent in the shared store.
    expect(await consume(ticket)).toBe(false);
  });

  it("cannot be replayed by flipping the case of the URL", async () => {
    // The reviewer's finding (cloud-factory-cf-idqf): the nonce store used to live in
    // whichever coordinator the URL spelled, so `github:Acme/Widget` was a different store
    // from `github:acme/widget` and the replay succeeded. The key now comes from the ticket
    // and is case-folded, so both spellings resolve to one store.
    const { ticket } = await mintTraceTicket(SECRET, "acme", "widget");
    const identity = await verifyTraceTicket(SECRET, ticket);
    expect(identity).not.toBeNull();
    expect(ticketRepositoryKey(identity!)).toBe(ticketRepositoryKey({ ...identity!, owner: "Acme", repo: "Widget" }));

    expect(await consume(ticket)).toBe(true);
    expect(await consume(ticket)).toBe(false);
  });

  it("binds the ticket to the platform it was minted for", async () => {
    // A ticket minted for github must not open a gitea socket: the platform is inside the
    // signature, so a ?platform=gitea request cannot reinterpret the ticket, and its nonce
    // is still spent in the github store.
    const { ticket } = await mintTraceTicket(SECRET, "acme", "widget", "github");
    const identity = (await verifyTraceTicket(SECRET, ticket))!;
    expect(identity.platform).toBe("github");
    expect(ticketRepositoryKey(identity)).not.toBe(
      ticketRepositoryKey({ ...identity, platform: "gitea" }),
    );

    expect(await consume(ticket)).toBe(true);
    // Replaying with a platform hint cannot find a fresh store, because the identity is the
    // ticket's, not the URL's.
    expect(await consume(ticket)).toBe(false);
  });

  it("does not spend a nonce when the ticket is forged or expired", async () => {
    const { ticket } = await mintTraceTicket(SECRET, "acme", "widget");
    expect(await verifyTraceTicket("other-secret", ticket)).toBeNull();
    expect(await verifyTraceTicket(SECRET, ticket.replace(/.$/, (c) => (c === "0" ? "1" : "0")))).toBeNull();

    const mintedAt = Date.now();
    const shortLived = await mintTraceTicket(SECRET, "acme", "widget", "github", mintedAt);
    expect(await verifyTraceTicket(SECRET, shortLived.ticket, shortLived.expiresAt + 1)).toBeNull();

    // ... and the ticket is still usable where it belongs.
    expect(await consume(ticket)).toBe(true);
  });

  it("fails closed when the store cannot be reached", async () => {
    const { ticket } = await mintTraceTicket(SECRET, "acme", "widget");
    const identity = (await verifyTraceTicket(SECRET, ticket))!;
    const broken = { fetch: async () => { throw new Error("store down"); } } as unknown as { fetch: typeof fetch };
    expect(await coordinatorTicketConsumer(broken)(identity.nonce, identity.expiresAt)).toBe(false);

    const notOk = { fetch: async () => new Response("nope", { status: 500 }) } as unknown as { fetch: typeof fetch };
    expect(await coordinatorTicketConsumer(notOk)(identity.nonce, identity.expiresAt)).toBe(false);

    // Nothing was recorded by the failed attempts, so the ticket still works.
    expect(await consume(ticket)).toBe(true);
  });

  it("prunes expired nonces and refuses unusable expiries", () => {
    const statements: string[] = [];
    const rows: Array<{ nonce: string; expires_at: number }> = [];
    const fakeSql = {
      exec(query: string, ...params: unknown[]) {
        statements.push(query.trim().split("\n")[0] as string);
        if (query.includes("DELETE")) {
          const cutoff = Number(params[0]);
          rows.splice(0, rows.length, ...rows.filter((row) => row.expires_at >= cutoff));
        }
        if (query.includes("INSERT INTO")) {
          rows.push({ nonce: String(params[0]), expires_at: Number(params[1]) });
        }
        return {
          toArray: () => rows.filter((row) => row.nonce === params[0]).map((row) => ({ nonce: row.nonce })),
        };
      },
    } as unknown as SqlStorage;

    migrateTraceTicketTable(fakeSql);
    const now = Date.now();
    expect(consumeTraceTicketNonce(fakeSql, "n1", now + 60_000, now)).toEqual({ ok: true });
    expect(consumeTraceTicketNonce(fakeSql, "n1", now + 60_000, now)).toEqual({ ok: false, reason: "already used" });
    expect(consumeTraceTicketNonce(fakeSql, "", now + 60_000, now)).toEqual({ ok: false, reason: "invalid" });
    expect(consumeTraceTicketNonce(fakeSql, "n2", now - 1, now)).toEqual({ ok: false, reason: "expired" });
    expect(consumeTraceTicketNonce(fakeSql, "n3", now + 60 * 60_000, now)).toEqual({ ok: false, reason: "invalid" });
    expect(statements.some((line) => line.startsWith("CREATE TABLE IF NOT EXISTS trace_ticket_nonces"))).toBe(true);
  });

  it("answers the coordinator's consume route", async () => {
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName("github:acme/consume-route"));
    const consumer = coordinatorTicketConsumer(stub);
    const expiresAt = Date.now() + 60_000;

    expect(await consumer("route-nonce", expiresAt)).toBe(true);
    expect(await consumer("route-nonce", expiresAt)).toBe(false);
    expect(await consumer("another", Date.now() - 1)).toBe(false);
  });
});

/**
 * The end-to-end shape of cloud-factory-cf-idqf: the same ticket presented twice, the second
 * time with the URL spelled differently. Before the fix each spelling reached its own
 * coordinator, so the second request was authorised with no session at all.
 */
describe("the socket route refuses a ticket replayed under another spelling", () => {
  const socket = async (path: string) => {
    const url = new URL(`https://example.com${path}`);
    return handleTrace(new Request(url.toString(), { method: "GET" }), env, url);
  };

  it("authorises the ticket's own repository once and refuses a case-flipped replay", async () => {
    const { ticket } = await mintTraceTicket(SECRET, "acme", "widget");

    const first = await socket(`/trace/acme/widget/socket?ticket=${encodeURIComponent(ticket)}`);
    expect(first?.status).not.toBe(401);

    // Same ticket, same repository, different capitalisation: refused, because the nonce was
    // spent in the one canonical store rather than in `github:Acme/Widget`'s.
    const replay = await socket(`/trace/Acme/Widget/socket?ticket=${encodeURIComponent(ticket)}`);
    expect(replay?.status).toBe(401);
  });

  it("refuses a replay that names another platform's coordinator", async () => {
    const { ticket } = await mintTraceTicket(SECRET, "acme", "widget");

    const first = await socket(`/trace/acme/widget/socket?ticket=${encodeURIComponent(ticket)}`);
    expect(first?.status).not.toBe(401);

    const replay = await socket(
      `/trace/acme/widget/socket?ticket=${encodeURIComponent(ticket)}&platform=gitea`,
    );
    expect(replay?.status).toBe(401);
  });
});
