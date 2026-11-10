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

  it("serves admin dashboard at /admin without redirect loops", async () => {
    // Direct GET to /admin must serve 200 without 307 redirect loops
    const adminRes = await SELF.fetch("https://example.com/admin", { redirect: "manual" });
    expect(adminRes.status).toBe(200);
    expect(adminRes.headers.get("content-type")).toContain("text/html");
    const html = await adminRes.text();
    expect(html).toContain("Admin Settings");

    // Trailing slash /admin/ also serves 200 cleanly
    const adminSlashRes = await SELF.fetch("https://example.com/admin/", { redirect: "manual" });
    expect(adminSlashRes.status).toBe(200);
    expect(adminSlashRes.headers.get("content-type")).toContain("text/html");

    // With html_handling: "none", /admin.html also serves 200 directly without 307 redirect
    const adminHtmlRes = await SELF.fetch("https://example.com/admin.html", { redirect: "manual" });
    expect(adminHtmlRes.status).toBe(200);
    expect(adminHtmlRes.headers.get("content-type")).toContain("text/html");

    // Non-GET/HEAD methods to /admin return 405
    const postRes = await SELF.fetch("https://example.com/admin", { method: "POST" });
    expect(postRes.status).toBe(405);
  });
});

/**
 * Security headers on everything the asset layer serves (cloud-factory-cf-5np7).
 *
 * The asset origin is the only one a browser renders as markup, so it is the one that
 * needs a policy: a file served here inherits the control plane's origin and cookies.
 * These tests pin both halves — the headers are present, and the policy still admits
 * what `apps/web` actually does (a bundled module script, an inline `style=` attribute,
 * a `data:` favicon, a same-origin WebSocket).
 */
describe("asset responses carry the deployment's security headers", () => {
  const page = () => SELF.fetch("https://example.com/");

  it("sets CSP and nosniff on the canvas document, keeping the asset's own headers", async () => {
    const response = await page();
    expect(response.status).toBe(200);
    // The asset layer's own headers survive: the policy is additive.
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("permissions-policy")).toContain("geolocation=()");
  });

  it("pins the policy's shape rather than the browser's defaults", async () => {
    const csp = (await page()).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    // A policy that allows eval or a wildcard script source is the hole, not the fix.
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*\*/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // What the canvas itself needs, so a future edit does not quietly break it.
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data:");
    // The live trace socket is pinned to this deployment's host, not to the `ws:` scheme:
    // a bare scheme would let an injected script exfiltrate to any socket server.
    expect(csp).toContain("connect-src 'self' ws://example.com wss://example.com");
    expect(csp).not.toMatch(/connect-src[^;]*\sws:\s/);
  });

  it("sets them on the route's own refusals too, not only on files", async () => {
    const missing = await SELF.fetch("https://example.com/no-such-page");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-security-policy")).toBeTruthy();
    expect(missing.headers.get("x-content-type-options")).toBe("nosniff");

    const post = await SELF.fetch("https://example.com/", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sets them on served subresources, so a script or stylesheet is never sniffed", async () => {
    const html = await (await page()).text();
    const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    expect(script, "the built canvas must load a bundled module").toBeTruthy();

    const asset = await SELF.fetch(`https://example.com${script}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    expect(asset.headers.get("content-security-policy")).toBeTruthy();
  });
});
