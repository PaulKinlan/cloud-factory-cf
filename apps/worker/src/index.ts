import type { Env } from "./env";
import { handleBroker } from "./routes/broker";
import { handleAdmin } from "./routes/admin";
import { handleAuth } from "./routes/auth";
import { handleStudio } from "./routes/studio";
import { handleCanvas } from "./routes/canvas";
import { handleGitTree } from "./routes/git-tree";
import { handleRuns } from "./routes/runs";
import { handleAudit } from "./routes/audit";
import { handleTrace } from "./routes/trace";
import { handleWebhooks } from "./routes/webhooks";
import { clientIdentity, controlKeyThrottle } from "./auth/throttle";
import { handleHealth } from "./routes/health";
import { serveAsset } from "./routes/assets";

// Durable Object classes are resolved from the Worker's main module, so they
// have to be exported here (see `durable_objects` in wrangler.jsonc).
export { CredentialBroker } from "./credential-broker-object";
export { OrgCoordinator } from "./org-coordinator";
export { RepoCoordinator } from "./repo-coordinator";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // A liveness probe answers liveness only: no environment, commit or version
    // fingerprint for an unauthenticated caller (cloud-factory-cf-gqyx).
    const healthResponse = handleHealth(url, request.method);
    if (healthResponse) return healthResponse;

    // The control key is one bearer secret with one comparison per route. Counting
    // rejections here, at the single point every request passes through, is what makes a
    // throttle on one route (root-login) a control rather than a filter: without this, the
    // same key stayed guessable at full speed on every authorizeControlPlane route
    // (cloud-factory-cf-m5dk). One read per control-key request; a write only after a
    // streak exists and a request succeeds.
    // root-login is excluded here because it takes an atomic reservation per attempt
    // itself (routes/auth.ts): counting it in both places would halve its budget and
    // counting it only here would let a parallel burst through. Both share one counter.
    const controlKeyPresented = Boolean(
      request.headers.get("x-factory-control-key") && env.BROKER_CONTROL_KEY && url.pathname !== "/api/auth/root-login",
    );
    const controlIdentity = controlKeyPresented ? clientIdentity(request) : "";
    if (controlKeyPresented) {
      // Refuse before routing when this address has already spent its attempts. The
      // failure is recorded where the key is actually compared (auth/tenant.ts and
      // routes/auth.ts), not from the response status: a 401 on this plane is usually
      // about a capability or a session, and counting those would lock out honest
      // machine traffic.
      const gate = await controlKeyThrottle(env, controlIdentity, "check");
      if (gate && !gate.allowed) {
        return Response.json(
          { ok: false, error: "too many control key attempts; try again later" },
          { status: 429, headers: { "retry-after": String(gate.retryAfterSec) } },
        );
      }
    }

    const brokerResponse = await handleBroker(request, env, url);
    if (brokerResponse) return brokerResponse;

    const adminResponse = await handleAdmin(request, env, url);
    if (adminResponse) return adminResponse;

    const authResponse = await handleAuth(request, env, url);
    if (authResponse) return authResponse;

    const studioResponse = await handleStudio(request, env, url);
    if (studioResponse) return studioResponse;

    const canvasResponse = await handleCanvas(request, env, url);
    if (canvasResponse) return canvasResponse;

    const gitTreeResponse = await handleGitTree(request, env, url);
    if (gitTreeResponse) return gitTreeResponse;

    const runResponse = await handleRuns(request, env, url);
    if (runResponse) return runResponse;

    const auditResponse = await handleAudit(request, env, url);
    if (auditResponse) return auditResponse;

    const traceResponse = await handleTrace(request, env, url);
    if (traceResponse) return traceResponse;

    const webhookResponse = await handleWebhooks(request, env, url);
    if (webhookResponse) return webhookResponse;

    return serveAsset(request, env);
  },
} satisfies ExportedHandler<Env>;
