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
    expect(settings.githubApp.privateKeyFingerprint).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(settings.githubApp.privateKeyFingerprint).not.toContain("MIIEow");
  });

  it("DELETE ?key= removes only the specified setting, leaving others intact", async () => {
    // 1. Delete only github.client_secret
    const delRes = await SELF.fetch(`https://example.com/api/admin/settings/${REPOSITORY}?key=github.client_secret`, {
      method: "DELETE",
      headers: { "x-factory-control-key": CONTROL_KEY },
    });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { ok: boolean; deleted: string };
    expect(delBody.ok).toBe(true);
    expect(delBody.deleted).toBe("github.client_secret");

    // 2. Verify github.app_id is still present, but client secret is gone
    const getRes = await SELF.fetch(`https://example.com/api/admin/settings/${REPOSITORY}`, {
      method: "GET",
      headers: { "x-factory-control-key": CONTROL_KEY },
    });
    const settings = (await getRes.json()) as any;
    expect(settings.githubApp.appId).toBe("123456");
    expect(settings.githubApp.hasClientSecret).toBe(false);
  });

  it("rejects masked placeholder values with 400", async () => {
    const res = await SELF.fetch(`https://example.com/api/admin/settings/${REPOSITORY}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-control-key": CONTROL_KEY,
      },
      body: JSON.stringify({
        aiProviders: {
          openai: { key: "sk-••••••••1234" },
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Masked values cannot be stored");
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

    // Empty model string falls back to default and does not overwrite with blank (cloud-factory-cf-q83o)
    const blankRepo = "acme/blank-model-repo";
    await SELF.fetch(`https://example.com/api/admin/settings/${blankRepo}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-control-key": CONTROL_KEY,
      },
      body: JSON.stringify({
        aiProviders: {
          anthropic: { model: "" },
          openai: { model: "   " },
        },
      }),
    });
    const blankRes = await SELF.fetch(`https://example.com/api/admin/settings/${blankRepo}`, {
      method: "GET",
      headers: { "x-factory-control-key": CONTROL_KEY },
    });
    const blankSettings = (await blankRes.json()) as any;
    expect(blankSettings.aiProviders.anthropic.model).toBe("claude-sonnet-5-5");
    expect(blankSettings.aiProviders.openai.model).toBe("gpt-6-astra");
  });

  it("triggers test ping webhook and returns delivery confirmation with custom secret", async () => {
    // Set a custom repository webhook secret
    const customSecret = "custom-repo-webhook-secret-456";
    await SELF.fetch(`https://example.com/api/admin/settings/${REPOSITORY}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-control-key": CONTROL_KEY,
      },
      body: JSON.stringify({ webhookSecret: customSecret }),
    });

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

  it("aligns CredentialBroker and RepoCoordinator addressing across case variations (cloud-factory-cf-g5c0, cloud-factory-cf-n23o)", async () => {
    const customSecret = "custom-mixed-case-secret-999";
    const mixedRepo = "Octodev/Probe-Repo";
    const lowerRepo = "octodev/probe-repo";

    // 1. Save settings under mixed-case repository path
    const saveRes = await SELF.fetch(`https://example.com/api/admin/settings/${mixedRepo}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-control-key": CONTROL_KEY,
      },
      body: JSON.stringify({
        webhookSecret: customSecret,
        aiProviders: {
          anthropic: { key: "sk-ant-api03-1234567890abcdef", model: "claude-probe-model" },
        },
      }),
    });
    expect(saveRes.status).toBe(200);

    // 2. Read back settings under lowercase path
    const getRes = await SELF.fetch(`https://example.com/api/admin/settings/${lowerRepo}`, {
      method: "GET",
      headers: { "x-factory-control-key": CONTROL_KEY },
    });
    expect(getRes.status).toBe(200);
    const settings = (await getRes.json()) as any;
    expect(settings.ok).toBe(true);
    expect(settings.aiProviders.anthropic.configured).toBe(true);
    expect(settings.aiProviders.anthropic.model).toBe("claude-probe-model");

    // 3. Trigger test ping with mixed case and verify RepoCoordinator & CredentialBroker align
    const pingRes = await SELF.fetch(`https://example.com/api/admin/test-ping/${mixedRepo}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-control-key": CONTROL_KEY,
      },
    });
    expect(pingRes.status).toBe(200);
    const pingBody = (await pingRes.json()) as any;
    expect(pingBody.ok).toBe(true);
    expect(pingBody.status).toBe(202);
  });
});
