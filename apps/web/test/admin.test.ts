import { describe, expect, it } from "vitest";
import viteConfig from "../vite.config";
import {
  validatePem,
  validateApiKey,
  maskSecret,
  buildWebhookUrl,
} from "../src/admin";

describe("Admin Dashboard Frontend Utilities", () => {
  it("validatePem: accepts valid RSA and EC private keys", () => {
    const rsaPem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Y1...",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(validatePem(rsaPem)).toMatchObject({ valid: true, type: "RSA" });

    const ecPem = [
      "-----BEGIN EC PRIVATE KEY-----",
      "MHcCAQEEI...",
      "-----END EC PRIVATE KEY-----",
    ].join("\n");
    expect(validatePem(ecPem)).toMatchObject({ valid: true, type: "EC" });

    const pkcs8Pem = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvgIBADANBgkq...",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    expect(validatePem(pkcs8Pem).valid).toBe(true);
  });

  it("validatePem: rejects malformed or incomplete PEM private keys", () => {
    expect(validatePem("").valid).toBe(false);
    expect(validatePem("not a pem").valid).toBe(false);
    expect(
      validatePem("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Y1..."),
    ).toMatchObject({ valid: false });
    expect(
      validatePem("-----BEGIN CERTIFICATE-----\nMIIEowIBAAKCAQEA0Y1...\n-----END CERTIFICATE-----"),
    ).toMatchObject({ valid: false });
  });

  it("validateApiKey: checks known provider prefixes and lengths", () => {
    expect(validateApiKey("anthropic", "sk-ant-api03-1234567890abcdef").valid).toBe(true);
    expect(validateApiKey("anthropic", "sk-wrong").valid).toBe(false);

    expect(validateApiKey("openai", "sk-proj-abcdef1234567890").valid).toBe(true);
    expect(validateApiKey("openai", "bad-key").valid).toBe(false);

    expect(validateApiKey("deepseek", "sk-deepseek-1234567890").valid).toBe(true);
    expect(validateApiKey("deepseek", "bad").valid).toBe(false);

    expect(validateApiKey("gemini", "AIzaSyDummyGeminiKey123456").valid).toBe(true);
    expect(validateApiKey("gemini", "sk-ant-key").valid).toBe(false);

    // Masked values are accepted as valid
    expect(validateApiKey("anthropic", "sk-a••••••••cdef").valid).toBe(true);
  });

  it("maskSecret: masks middle characters while retaining endpoints", () => {
    expect(maskSecret("")).toBe("");
    expect(maskSecret("short")).toBe("••••••••");
    expect(maskSecret("sk-ant-api03-1234567890abcdef")).toBe("sk-a••••••••cdef");
  });

  it("buildWebhookUrl: constructs clean URL without duplicate slashes", () => {
    expect(buildWebhookUrl("https://cf.factory.dev/", "acme", "widgets")).toBe(
      "https://cf.factory.dev/webhooks/github/acme/widgets",
    );
    expect(buildWebhookUrl("http://localhost:8787", "org", "repo")).toBe(
      "http://localhost:8787/webhooks/github/org/repo",
    );
  });

  it("vite.config: configures multi-page inputs for main and admin", () => {
    expect((viteConfig.build?.rollupOptions?.input as any)?.admin).toBe("admin.html");
    expect((viteConfig.build?.rollupOptions?.input as any)?.main).toBe("index.html");
  });
});
