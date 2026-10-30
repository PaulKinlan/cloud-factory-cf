import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { mintTraceTicket } from "../src/routes/trace";

describe("trace ticket key isolation", () => {
  it("never accepts a webhook-signed socket ticket when broker keys are absent", async () => {
    const webhookSecret = "webhook-only-trace-secret";
    const workerEnv = {
      ...env,
      BROKER_SIGNING_KEY: undefined,
      BROKER_CONTROL_KEY: undefined,
      WEBHOOK_SECRET: webhookSecret,
    };
    const { ticket } = await mintTraceTicket(webhookSecret, "acme", "widget");

    const socket = await worker.fetch(
      new Request(`https://factory.example/trace/acme/widget/socket?ticket=${encodeURIComponent(ticket)}`, {
        headers: { upgrade: "websocket" },
      }),
      workerEnv as never,
    );
    expect(socket.status).toBe(401);

    const mint = await worker.fetch(
      new Request("https://factory.example/trace/acme/widget/ticket", {
        method: "POST",
        headers: { "x-factory-control-key": webhookSecret },
      }),
      workerEnv as never,
    );
    expect(mint.status).toBe(503);
  });
});
