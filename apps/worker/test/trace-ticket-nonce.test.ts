import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintTraceTicket, verifyTraceTicket, coordinatorTicketConsumer } from "../src/routes/trace";
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
  it("spends a ticket once, in the repository's own store", async () => {
    const { ticket, expiresAt } = await mintTraceTicket(SECRET, "acme", "widget");
    const stub = coordinator();

    const first = await verifyTraceTicket(SECRET, ticket, "acme", "widget", Date.now(), coordinatorTicketConsumer(stub));
    expect(first).toBe(true);

    // A second verification of the same ticket - a fresh consumer, emulating another
    // isolate - must be refused, because the nonce is spent in the shared store.
    const second = await verifyTraceTicket(SECRET, ticket, "acme", "widget", Date.now(), coordinatorTicketConsumer(stub));
    expect(second).toBe(false);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it("does not spend a nonce when the ticket is forged or for another repository", async () => {
    const stub = coordinator();
    const { ticket } = await mintTraceTicket(SECRET, "acme", "widget");

    // Wrong secret: refused before the nonce is touched.
    expect(await verifyTraceTicket("other-secret", ticket, "acme", "widget", Date.now(), coordinatorTicketConsumer(stub))).toBe(false);
    // Right ticket, wrong repository.
    expect(await verifyTraceTicket(SECRET, ticket, "acme", "other", Date.now(), coordinatorTicketConsumer(stub))).toBe(false);

    // The ticket is still usable where it belongs.
    expect(await verifyTraceTicket(SECRET, ticket, "acme", "widget", Date.now(), coordinatorTicketConsumer(stub))).toBe(true);
  });

  it("refuses an expired ticket without consuming it", async () => {
    const stub = coordinator();
    const mintedAt = Date.now();
    const { ticket, expiresAt } = await mintTraceTicket(SECRET, "acme", "widget", mintedAt);
    const later = expiresAt + 1;
    expect(await verifyTraceTicket(SECRET, ticket, "acme", "widget", later, coordinatorTicketConsumer(stub))).toBe(false);
  });

  it("fails closed when the store cannot be reached", async () => {
    const { ticket } = await mintTraceTicket(SECRET, "acme", "widget");
    const broken = { fetch: async () => { throw new Error("store down"); } } as unknown as { fetch: typeof fetch };
    expect(await verifyTraceTicket(SECRET, ticket, "acme", "widget", Date.now(), coordinatorTicketConsumer(broken))).toBe(false);

    const notOk = { fetch: async () => new Response("nope", { status: 500 }) } as unknown as { fetch: typeof fetch };
    expect(await verifyTraceTicket(SECRET, ticket, "acme", "widget", Date.now(), coordinatorTicketConsumer(notOk))).toBe(false);
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
    const repository = "acme/consume-route";
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`github:${repository}`));
    const consume = coordinatorTicketConsumer(stub);
    const expiresAt = Date.now() + 60_000;

    expect(await consume("route-nonce", expiresAt)).toBe(true);
    expect(await consume("route-nonce", expiresAt)).toBe(false);
    expect(await consume("another", Date.now() - 1)).toBe(false);
  });
});
