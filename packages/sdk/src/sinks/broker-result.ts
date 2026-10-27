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
 * Returns the upstream status for an accepted call, and throws for anything that is not
 * a 2xx/3xx — a sink that reports `success: true` for a rejected call is a false green.
 */
export function assertUpstreamAccepted(
  result: SignedBrokerResult | undefined,
  what: string,
): { status: number } {
  if (typeof result?.status !== 'number' || result.status >= 400) {
    throw new Error(`${what} answered ${result?.status ?? 'no status'}`);
  }
  return { status: result.status };
}
