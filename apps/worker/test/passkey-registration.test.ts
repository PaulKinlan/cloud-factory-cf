import { describe, expect, it } from "vitest";
import { handlePasskeyRoute } from "../src/auth/passkey";
import { mintSessionToken } from "../src/routes/auth";

/**
 * Passkey registration binds a credential to OUR challenge and OUR origin, and it does
 * that by validating `clientDataJSON`. The route used to validate it only `if
 * (clientDataJSON)`, so a request that simply omitted the field skipped the type, the
 * challenge and the origin check and got a credential registered plus a session cookie
 * (cloud-factory-cf-cuor). The assertion path already refused a request without it.
 *
 * These cases drive `handlePasskeyRoute` directly with a stubbed CredentialBroker, so
 * they assert the route's own decisions - no Durable Object, no browser, no network.
 */
const SIGNING_KEY = "test-passkey-signing-key";
const CONTROL_KEY = "test-passkey-control-key";
const ORIGIN = "https://example.com";
const SAVE_URL = "https://credential-broker.internal/passkeys";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function testEnv() {
  const saved: unknown[] = [];
  const broker = {
    fetch: async (input: RequestInfo | URL) => {
      if (String(input) === SAVE_URL) return Response.json({ ok: true });
      return Response.json({ ok: false, error: "unexpected broker path" }, { status: 404 });
    },
  };
  const saveRequest = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === SAVE_URL && init?.body) saved.push(JSON.parse(String(init.body)));
      return broker.fetch(input);
    },
  };
  return {
    saved,
    env: {
      BROKER_SIGNING_KEY: SIGNING_KEY,
      BROKER_CONTROL_KEY: CONTROL_KEY,
      CREDENTIAL_BROKER: { idFromName: (name: string) => name, get: () => saveRequest },
    } as never,
  };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Runs register/options as the root control plane and returns the challenge + cookie. */
async function startRegistration(env: never): Promise<{ challenge: string; cookie: string }> {
  const response = await handlePasskeyRoute(
    post("/api/auth/passkey/register/options", {}, { "x-factory-control-key": CONTROL_KEY }),
    env,
    new URL(`${ORIGIN}/api/auth/passkey/register/options`),
  );
  expect(response?.status).toBe(200);
  const options = (await response!.json()) as { options: { challenge: string } };
  const setCookie = response!.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] as string;
  expect(cookie).toContain("=");
  return { challenge: options.options.challenge, cookie };
}

/** A real ES256 public key in SPKI form, base64url - what the browser's credential holds. */
async function es256PublicKeySpki(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const spki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  return base64Url(new Uint8Array(spki));
}

function clientData(overrides: Record<string, unknown> = {}): string {
  return base64Url(
    new TextEncoder().encode(
      JSON.stringify({ type: "webauthn.create", challenge: "seed", origin: ORIGIN, ...overrides }),
    ),
  );
}

const VERIFY_URL = `${ORIGIN}/api/auth/passkey/register/verify`;

describe("passkey registration client data", () => {
  it("refuses a registration that omits clientDataJSON", async () => {
    const { env, saved } = testEnv();
    const { cookie } = await startRegistration(env);

    const response = await handlePasskeyRoute(
      post(
        "/api/auth/passkey/register/verify",
        { credentialId: "cred-missing-client-data", publicKeySpki: await es256PublicKeySpki() },
        { cookie },
      ),
      env,
      new URL(VERIFY_URL),
    );

    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({ ok: false, error: "Missing clientDataJSON" });
    expect(saved).toEqual([]);
    expect(response?.headers.get("set-cookie")).toBeNull();
  });

  it("refuses client data from another origin", async () => {
    const { env, saved } = testEnv();
    const { challenge, cookie } = await startRegistration(env);

    const response = await handlePasskeyRoute(
      post(
        "/api/auth/passkey/register/verify",
        {
          credentialId: "cred-wrong-origin",
          publicKeySpki: await es256PublicKeySpki(),
          clientDataJSON: clientData({ challenge, origin: "https://evil.example" }),
        },
        { cookie },
      ),
      env,
      new URL(VERIFY_URL),
    );

    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({ ok: false, error: "Origin mismatch" });
    expect(saved).toEqual([]);
  });

  it("refuses client data that answers another challenge", async () => {
    const { env, saved } = testEnv();
    const { cookie } = await startRegistration(env);

    const response = await handlePasskeyRoute(
      post(
        "/api/auth/passkey/register/verify",
        {
          credentialId: "cred-wrong-challenge",
          publicKeySpki: await es256PublicKeySpki(),
          clientDataJSON: clientData({ challenge: "some-other-challenge" }),
        },
        { cookie },
      ),
      env,
      new URL(VERIFY_URL),
    );

    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({ ok: false, error: "Challenge mismatch" });
    expect(saved).toEqual([]);
  });

  it("registers a credential whose client data answers this challenge from this origin", async () => {
    const { env, saved } = testEnv();
    const { challenge, cookie } = await startRegistration(env);
    const publicKeySpki = await es256PublicKeySpki();

    const response = await handlePasskeyRoute(
      post(
        "/api/auth/passkey/register/verify",
        { credentialId: "cred-valid", publicKeySpki, clientDataJSON: clientData({ challenge }) },
        { cookie },
      ),
      env,
      new URL(VERIFY_URL),
    );

    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ ok: true, credentialId: "cred-valid" });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ credentialId: "cred-valid", publicKeySpki });
    // A passkey session is only minted for a registration that passed every check.
    expect(response?.headers.get("set-cookie")).toContain("cf_session=");
  });
});
