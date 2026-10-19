import { describe, expect, it } from "vitest";
import {
  BROKER_PATH,
  STUDIO_PATH,
  CANVAS_PATH,
  CANVAS_RUN_PATH,
  RUN_PATH,
  WEBHOOK_PATH,
  handleBroker,
  handleStudio,
  handleCanvas,
  handleRuns,
  handleWebhooks,
  serveAsset,
} from "../src/routes";
import type { Env } from "../src/env";

describe("domain route handlers", () => {
  it("exports expected route path patterns", () => {
    expect(BROKER_PATH.test("/broker/acme/widgets/capabilities")).toBe(true);
    expect(BROKER_PATH.test("/broker/acme/widgets/invalid")).toBe(false);

    expect(STUDIO_PATH.test("/studio/acme/widgets/author")).toBe(true);
    expect(STUDIO_PATH.test("/studio/acme/widgets/simulate")).toBe(true);
    expect(STUDIO_PATH.test("/studio/acme/widgets/agents")).toBe(true);
    expect(STUDIO_PATH.test("/studio/acme/widgets/agents/reviewer")).toBe(true);
    expect(STUDIO_PATH.test("/studio/acme/widgets/other")).toBe(false);

    expect(CANVAS_PATH.test("/canvas/acme/widgets/documents")).toBe(true);
    expect(CANVAS_PATH.test("/canvas/acme/widgets/documents/doc-1")).toBe(true);
    expect(CANVAS_RUN_PATH.test("/canvas/acme/widgets/documents/doc-1/run")).toBe(true);

    expect(RUN_PATH.test("/runs/acme/widgets")).toBe(true);
    expect(RUN_PATH.test("/runs/acme")).toBe(false);

    expect(WEBHOOK_PATH.test("/webhooks/github/acme/widgets")).toBe(true);
    expect(WEBHOOK_PATH.test("/webhooks/gitlab/acme/widgets")).toBe(true);
    expect(WEBHOOK_PATH.test("/webhooks/bitbucket/acme/widgets")).toBe(false);
  });

  it("handlers return null for unmatched URLs", async () => {
    const fakeEnv = {} as Env;
    const req = new Request("https://example.com/unmatched");
    const url = new URL(req.url);

    expect(await handleBroker(req, fakeEnv, url)).toBeNull();
    expect(await handleStudio(req, fakeEnv, url)).toBeNull();
    expect(await handleCanvas(req, fakeEnv, url)).toBeNull();
    expect(await handleRuns(req, fakeEnv, url)).toBeNull();
    expect(await handleWebhooks(req, fakeEnv, url)).toBeNull();
  });

  it("serveAsset returns 404 when ASSETS binding is missing", async () => {
    const fakeEnv = {} as Env;
    const req = new Request("https://example.com/");
    const res = await serveAsset(req, fakeEnv);
    expect(res.status).toBe(404);
  });
});
