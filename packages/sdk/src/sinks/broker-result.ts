/**
 * The default sinks talk to GitHub and Beads **through the credential broker**, never
 * with a raw token. A broker call resolves with the upstream status when the request
 * asks for it (`includeStatus`), so "it did not throw" is not the same as "the upstream
 * accepted it": a 404 for an unsupported action used to be dispatched as
 * `success: true` (cloud-factory-cf-g9aw).
 *
 * The worker's own sinks (`apps/worker/src/action-sinks.ts`) apply the same rule; the
 * dependency runs worker → sdk, so the contract is mirrored here rather than imported.
 */

/** What the broker resolves with when `includeStatus` is set. */
export interface SignedBrokerResult {
  status: number;
  body: unknown;
}

/**
 * Returns the upstream status for an accepted call, and throws for anything that is not a
 * 2xx/3xx — a sink that reports `success: true` for a rejected call is a false green.
 *
 * The band is explicit rather than "below 400": `0` is how a status-less answer reaches a
 * sink on the worker path (`pipeline.ts` coerces a missing status to 0), and a 1xx is not
 * an outcome any GitHub or Beads action can return. Both would otherwise pass as accepted
 * (cloud-factory-cf-g9aw follow-up).
 */
export function assertUpstreamAccepted(
  result: SignedBrokerResult | undefined,
  what: string,
): { status: number } {
  const status = result?.status;
  if (typeof status !== 'number' || status < 200 || status >= 400) {
    throw new Error(`${what} answered ${typeof status === 'number' ? status : 'no status'}`);
  }
  return { status };
}
