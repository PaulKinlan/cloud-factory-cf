import type { Env } from "./env";
import { handleBroker } from "./routes/broker";
import { handleStudio } from "./routes/studio";
import { handleCanvas } from "./routes/canvas";
import { handleRuns } from "./routes/runs";
import { handleAudit } from "./routes/audit";
import { handleWebhooks } from "./routes/webhooks";
import { serveAsset } from "./routes/assets";

// Durable Object classes are resolved from the Worker's main module, so they
// have to be exported here (see `durable_objects` in wrangler.jsonc).
export { CredentialBroker } from "./credential-broker-object";
export { OrgCoordinator } from "./org-coordinator";
export { RepoCoordinator } from "./repo-coordinator";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "cloud-factory-cf",
        environment: env.ENVIRONMENT ?? "unknown",
      });
    }

    const brokerResponse = await handleBroker(request, env, url);
    if (brokerResponse) return brokerResponse;

    const studioResponse = await handleStudio(request, env, url);
    if (studioResponse) return studioResponse;

    const canvasResponse = await handleCanvas(request, env, url);
    if (canvasResponse) return canvasResponse;

    const runResponse = await handleRuns(request, env, url);
    if (runResponse) return runResponse;

    const auditResponse = await handleAudit(request, env, url);
    if (auditResponse) return auditResponse;

    const webhookResponse = await handleWebhooks(request, env, url);
    if (webhookResponse) return webhookResponse;

    return serveAsset(request, env);
  },
} satisfies ExportedHandler<Env>;
