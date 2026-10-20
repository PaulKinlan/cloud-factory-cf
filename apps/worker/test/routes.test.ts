import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { ADMIN_SETTINGS_PATH, ADMIN_PING_PATH, handleAdmin } from "../src/routes/admin";
import { WEBHOOK_PATH, handleWebhooks } from "../src/routes/webhooks";
import {
  BROKER_PATH,
  STUDIO_PATH,
  CANVAS_PATH,
  CANVAS_RUN_PATH,
  RUN_PATH,
  AUDIT_PATH,
  handleBroker,
  handleStudio,
  handleCanvas,
  handleRuns,
  handleAudit,
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

    expect(AUDIT_PATH.test("/audit/events/acme/widgets")).toBe(true);
    expect(AUDIT_PATH.test("/audit/runs/acme/widgets")).toBe(true);
    expect(AUDIT_PATH.test("/audit/events/acme/widgets/deliv-1")).toBe(true);
    expect(AUDIT_PATH.test("/audit/events/acme")).toBe(false);

    expect(ADMIN_SETTINGS_PATH.test("/api/admin/settings/acme/widgets")).toBe(true);
    expect(ADMIN_PING_PATH.test("/api/admin/test-ping/acme/widgets")).toBe(true);

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
    expect(await handleAudit(req, fakeEnv, url)).toBeNull();
    expect(await handleAdmin(req, fakeEnv, url)).toBeNull();
    expect(await handleWebhooks(req, fakeEnv, url)).toBeNull();
  });

  it("serveAsset returns 404 when ASSETS binding is missing", async () => {
    const fakeEnv = {} as Env;
    const req = new Request("https://example.com/");
    const res = await serveAsset(req, fakeEnv);
    expect(res.status).toBe(404);
  });

  describe("handleRuns route contract", () => {
    const CONTROL_KEY = "test-control-key";
    const testEnv: Env = {
      ...env,
      BROKER_CONTROL_KEY: CONTROL_KEY,
    };

    it("rejects non-POST methods with 405", async () => {
      const req = new Request("https://example.com/runs/acme/widgets", {
        method: "GET",
        headers: { "x-factory-control-key": CONTROL_KEY },
      });
      const res = await handleRuns(req, testEnv, new URL(req.url));
      expect(res?.status).toBe(405);
    });

    it("rejects missing or invalid control key with 401", async () => {
      const unauthReq = new Request("https://example.com/runs/acme/widgets", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const unauthRes = await handleRuns(unauthReq, testEnv, new URL(unauthReq.url));
      expect(unauthRes?.status).toBe(401);

      const badKeyReq = new Request("https://example.com/runs/acme/widgets", {
        method: "POST",
        headers: { "x-factory-control-key": "wrong-secret" },
        body: JSON.stringify({}),
      });
      const badKeyRes = await handleRuns(badKeyReq, testEnv, new URL(badKeyReq.url));
      expect(badKeyRes?.status).toBe(401);
    });

    it("returns 503 when control key is not configured", async () => {
      const unconfiguredEnv: Env = {
        ...env,
        BROKER_CONTROL_KEY: undefined,
      };
      const req = new Request("https://example.com/runs/acme/widgets", {
        method: "POST",
      });
      const res = await handleRuns(req, unconfiguredEnv, new URL(req.url));
      expect(res?.status).toBe(503);
    });

    it("returns 200 with drain report for authenticated valid requests", async () => {
      const req = new Request("https://example.com/runs/acme/widgets", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-factory-control-key": CONTROL_KEY,
        },
        body: JSON.stringify({ limit: 5 }),
      });
      const res = await handleRuns(req, testEnv, new URL(req.url));
      expect(res?.status).toBe(200);
      const json = await res?.json();
      expect(json).toMatchObject({ ok: true, claimed: 0, succeeded: 0, failed: 0, runs: [] });
    });
  });
});
