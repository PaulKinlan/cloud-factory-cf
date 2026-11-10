/**
 * Durable single-use store for trace-ticket nonces (cloud-factory-cf-il5w).
 *
 * A trace ticket is a 60s one-time credential for the live-trace WebSocket. It used to be
 * single-use only within the Worker isolate that minted it: the used-nonce set was a
 * module-scoped Map, so a second isolate - or the same ticket replayed to a different
 * isolate - accepted it again. A ticket is a bearer credential, so single-use has to be a
 * property of the repository, not of one process.
 *
 * The store lives in the repository's coordinator, next to the run trace it guards. The
 * coordinator is single-threaded and the SQL below is synchronous, so the read and the
 * write in consumeTraceTicketNonce cannot interleave with another request - the same
 * reasoning that makes the passkey challenge consume (cloud-factory-cf-zl0a) atomic.
 */
/** The longest ticket this store will accept, so a caller cannot pin an entry forever. */
const MAX_TICKET_TTL_MS = 10 * 60_000;

export function migrateTraceTicketTable(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS trace_ticket_nonces (
      nonce TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    )`);
}

export interface NonceConsumeResult {
  ok: boolean;
  reason?: "already used" | "expired" | "invalid";
}

/**
 * Record a nonce as used, or report that it already was.
 *
 * Returns ok only for the first caller: every later caller for the same nonce - in any
 * isolate - gets `already used`. Expired entries are pruned on the way through, and an
 * expiry that is already past, or further away than any ticket should live, is refused
 * rather than stored, so this table cannot grow without bound.
 */
export function consumeTraceTicketNonce(
  sql: SqlStorage,
  nonce: string,
  expiresAt: number,
  now = Date.now(),
): NonceConsumeResult {
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 128) {
    return { ok: false, reason: "invalid" };
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now) {
    return { ok: false, reason: "expired" };
  }
  if (expiresAt > now + MAX_TICKET_TTL_MS) {
    return { ok: false, reason: "invalid" };
  }

  sql.exec("DELETE FROM trace_ticket_nonces WHERE expires_at < ?", now);
  const existing = sql
    .exec<{ nonce: string }>("SELECT nonce FROM trace_ticket_nonces WHERE nonce = ?", nonce)
    .toArray()[0];
  if (existing !== undefined) {
    return { ok: false, reason: "already used" };
  }
  sql.exec(
    "INSERT INTO trace_ticket_nonces (nonce, expires_at) VALUES (?, ?)",
    nonce,
    Math.trunc(expiresAt),
  );
  return { ok: true };
}
