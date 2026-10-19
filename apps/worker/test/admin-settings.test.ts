import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const CONTROL_KEY = "test-control-key";
const REPOSITORY = "acme/admin-test";

const VALID_RSA_PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEA0Y1...",
  "AQABoUCD5bK9qH5f",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

describe("Admin Dashboard & Settings API", () => {
  it("requires control key authentication for settings", async () => {
    const unauth = await SELF.fetch(`https://example.com/api/admin/settings/${REPOSITORY}`, {
      method: "GET",
    });
    expect(unauth.status).toBe(401);

    const badKey = await SELF.fetch(`https://example.com/api/admin/settings/${REPOSITORY}`, {
      method: "GET",
      headers: { "x-factory-control-key": "invalid-key" },
    });
    expect(badKey.status).toBe(401);
  });

  it("stores and retrieves GitHub App credentials with masked secrets", async () => {
    // 1. Post settings
    const saveRes = await SELF.fetch(`https://example.com/api/admin/settings/${REPOSITORY}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-control-key": CONTROL_KEY,
      },
      body: JSON.stringify({
        githubApp: {
          appId: "123456",
          clientId: "Iv1.abcdef123456",
          clientSecret: "github_secret_abcdef987654321",
          privateKey: VALID_RSA_PEM,
        },
      }),
    });
    expect(saveRes.status).toBe(200);
    const saveBody = (await saveRes.json()) as { ok: boolean; updated: string[] };
    expect(saveBody.ok).toBe(true);
    expect(saveBody.updated).toContain("github.app_id");
    expect(saveBody.updated).toContain("github.client_secret");
    expect(saveBody.updated).toContain("github.private_key");

    // 2. Get settings and verify masking
    const getRes = await SELF.fetch(`https://example.com/api/admin/settings/${REPOSITORY}`, {
      method: "GET",
      headers: { "x-factory-control-key": CONTROL_KEY },
    });
    expect(getRes.status).toBe(200);
    const settings = (await getRes.json()) as any;
    expect(settings.ok).toBe(true);
    expect(settings.githubApp.appId).toBe("123456");
    expect(settings.githubApp.clientId).toBe("Iv1.abcdef123456");
    expect(settings.githubApp.hasClientSecret).toBe(true);
    expect(settings.githubApp.clientSecretMasked).toContain("••••••••");
    expect(settings.githubApp.clientSecretMasked).not.toBe("github_secret_abcdef987654321");
    expect(settings.githubApp.hasPrivateKey).toBe(true);
    expect(settings.githubApp.privateKeyFingerprint).toMatch(/^sha256:/);
  });

  it("rejects invalid PEM private key format with 400", async () => {
    const res = await SELF.fetch(`https://example.com/api/admin/settings/${REPOSITORY}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-control-key": CONTROL_KEY,
      },
      body: JSON.stringify({
        githubApp: {
          privateKey: "not a valid pem private key header",
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Invalid PEM private key");
  });

  it("stores and retrieves BYOK AI provider keys with masked display", async () => {
    const saveRes = await SELF.fetch(`https://example.com/api/admin/settings/${REPOSITORY}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-control-key": CONTROL_KEY,
      },
      body: JSON.stringify({
        aiProviders: {
          anthropic: { key: "sk-ant-api03-1234567890abcdef", model: "claude-3-7-sonnet" },
          openai: { key: "sk-proj-abcdef1234567890", model: "gpt-4o" },
          deepseek: { key: "sk-deepseek-1234567890", model: "deepseek-chat" },
          gemini: { key: "AIzaSyDummyGeminiKey123456", model: "gemini-2.0-flash" },
        },
      }),
    });
    expect(saveRes.status).toBe(200);

    const getRes = await SELF.fetch(`https://example.com/api/admin/settings/${REPOSITORY}`, {
      method: "GET",
      headers: { "x-factory-control-key": CONTROL_KEY },
    });
    const settings = (await getRes.json()) as any;
    expect(settings.aiProviders.anthropic.configured).toBe(true);
    expect(settings.aiProviders.anthropic.maskedKey).toContain("••••••••");
    expect(settings.aiProviders.anthropic.model).toBe("claude-3-7-sonnet");

    expect(settings.aiProviders.openai.configured).toBe(true);
    expect(settings.aiProviders.openai.maskedKey).toContain("••••••••");

    expect(settings.aiProviders.deepseek.configured).toBe(true);
    expect(settings.aiProviders.gemini.configured).toBe(true);
  });

  it("triggers test ping webhook and returns delivery confirmation", async () => {
    const pingRes = await SELF.fetch(`https://example.com/api/admin/test-ping/${REPOSITORY}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-control-key": CONTROL_KEY,
      },
    });

    expect(pingRes.status).toBe(200);
    const body = (await pingRes.json()) as { ok: boolean; status: number; message: string; deliveryId: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe(202);
    expect(body.message).toContain("Test ping delivered");
    expect(body.deliveryId).toMatch(/^test-ping-/);
  });
});
