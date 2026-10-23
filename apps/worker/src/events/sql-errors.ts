/**
 * Recognising the one SQLite failure the worker treats as transient.
 *
 * A Durable Object applies its schema in `blockConcurrencyWhile`, but a request or alarm
 * can still reach a query before that schema is visible to it, and the query fails with
 * `no such table: <name>`. That error always fires *before* the statement runs, so the
 * caller can safely re-apply the (idempotent) migrations and retry once —
 * cloud-factory-cf-u55u, and cloud-factory-cf-1k1y for the stores that used to swallow it.
 *
 * It lives here rather than in the coordinator because the stores need it too: a store
 * that catches every error turns a transient schema failure into a permanent "bad
 * request", and the retry above never sees it.
 */
export function isMissingSchemaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no such table/i.test(message);
}
