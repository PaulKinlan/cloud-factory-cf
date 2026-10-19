import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The canvas is served from the same origin as the API. These tests pin the
 * boundary: static files come from the assets binding, while every API prefix
 * (and unknown paths) still reach the Worker's own routing.
 */
describe("canvas assets on the API origin", () => {
  it("serves the canvas document at the root", async () => {
    const response = await SELF.fetch("https://example.com/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Cloud Factory");
    expect(html).toContain("/assets/");
  });

  it("keeps API routes on the Worker instead of the asset layer", async () => {
    const health = await SELF.fetch("https://example.com/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ service: "cloud-factory-cf" });

    // A webhook path must be handled by the Worker (405 for GET), not be
    // answered with the canvas HTML.
    const webhook = await SELF.fetch("https://example.com/webhooks/github/acme/assets-repo");
    expect(webhook.status).toBe(405);
    expect(webhook.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  it("does not fall back to HTML for unknown paths", async () => {
    const response = await SELF.fetch("https://example.com/no-such-page");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type") ?? "").not.toContain("text/html");
  });
});
