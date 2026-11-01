/**
 * The liveness probe.
 *
 * `/health` is unauthenticated by construction - a load balancer, a deploy script and an
 * uptime monitor all have to reach it without a credential - so it must not answer
 * anything beyond "this Worker is up". It used to report the deployment's `environment`,
 * a build `commit`, a `build_timestamp` and a `version`: that fingerprints the deployment
 * (which environment is this, which exact revision is running, what is vulnerable) for
 * anyone who can reach the host, and none of it is needed to answer a health check
 * (cloud-factory-cf-gqyx).
 *
 * Build identity belongs on an authenticated surface - the audit/admin routes already
 * require the control plane.
 */
export const HEALTH_SERVICE = "cloud-factory-cf";

export function handleHealth(url: URL, method: string): Response | null {
  if (url.pathname !== "/health") return null;
  if (method !== "GET" && method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  return Response.json({ ok: true, service: HEALTH_SERVICE });
}
