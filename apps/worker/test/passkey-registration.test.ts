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

const CHALLENGE_URL = "https://credential-broker.internal/passkeys/challenge";
const CONSUME_URL = `${CHALLENGE_URL}/consume`;

function testEnv() {
  const saved: unknown[] = [];
  // The broker's challenge table, in memory: store on issue, delete on consume, so the
  // single-use rule is what these cases observe (cloud-factory-cf-zl0a).
  const challenges = new Set<string>();
  const broker = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      // The broker is addressed with a `Request` for the throttle and with a URL string for
      // the passkey calls; both name the same object.
      const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (target === CHALLENGE_URL) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { challenge?: string };
        if (typeof body.challenge === "string") challenges.add(body.challenge);
        return Response.json({ ok: true });
      }
      if (target === CONSUME_URL) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { challenge?: string };
        const consumed = typeof body.challenge === "string" && challenges.delete(body.challenge);
        return consumed
          ? Response.json({ ok: true })
          : Response.json({ ok: false, error: "unknown or already used challenge" }, { status: 409 });
      }
      if (target === SAVE_URL) return Response.json({ ok: true });
      // The control-key comparison reserves a throttle slot before it compares, and the real
      // broker serves that on this same object (cloud-factory-cf-m3hx). Answering 404 here
      // would model a deployment whose counter cannot be read, which the throttle now refuses
      // to treat as "allowed".
      if (target.startsWith("https://credential-broker.internal/auth-throttle/")) {
        return Response.json({ ok: true, allowed: true, failures: 0, retryAfterSec: 0 });
      }
      return Response.json({ ok: false, error: "unexpected broker path" }, { status: 404 });
    },
  };
  const saveRequest = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === SAVE_URL && init?.body) saved.push(JSON.parse(String(init.body)));
      return broker.fetch(input, init);
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

/**
 * A WebAuthn challenge is good for exactly one attempt (cloud-factory-cf-zl0a). The signed
 * cookie proves we minted it, but nothing stopped the same assertion and cookie being
 * presented twice inside the five-minute window - so the challenge is registered in the
 * broker when the options are handed out and consumed when the answer comes back, before
 * the answer is judged. A failed attempt therefore burns it: a challenge that survives a
 * failure is one an attacker still holds.
 */
describe("passkey challenges are single use", () => {
  it("burns a registration challenge even when the first attempt fails", async () => {
    const { env } = testEnv();
    const { challenge, cookie } = await startRegistration(env);

    // Attempt 1: no client data - refused after the challenge was consumed.
    const first = await handlePasskeyRoute(
      post("/api/auth/passkey/register/verify", { credentialId: "cred-1", publicKeySpki: await es256PublicKeySpki() }, { cookie }),
      env,
      new URL(VERIFY_URL),
    );
    expect(first?.status).toBe(400);

    // Attempt 2: a complete, well-formed answer for the same challenge. It must be
    // refused because the challenge is spent, not because anything else is wrong.
    const second = await handlePasskeyRoute(
      post(
        "/api/auth/passkey/register/verify",
        {
          credentialId: "cred-1",
          publicKeySpki: await es256PublicKeySpki(),
          clientDataJSON: clientData({ challenge, type: "webauthn.create" }),
        },
        { cookie },
      ),
      env,
      new URL(VERIFY_URL),
    );
    expect(second?.status).toBe(401);
    expect(await second!.json()).toMatchObject({ ok: false, error: expect.stringContaining("already used") });
  });

  it("burns a login challenge the same way", async () => {
    const { env } = testEnv();

    const optionsResponse = await handlePasskeyRoute(
      post("/api/auth/passkey/login/options", {}),
      env,
      new URL(`${ORIGIN}/api/auth/passkey/login/options`),
    );
    expect(optionsResponse?.status).toBe(200);
    const cookie = (optionsResponse!.headers.get("set-cookie") ?? "").split(";")[0] as string;

    const assertion = { credentialId: "unknown-credential", authenticatorData: "AAAA", clientDataJSON: "AAAA", signature: "AAAA" };
    const verifyUrl = new URL(`${ORIGIN}/api/auth/passkey/login/verify`);

    // Attempt 1 is judged after the challenge is consumed (here: the credential is not
    // found), attempt 2 is refused for the spent challenge itself.
    const first = await handlePasskeyRoute(post("/api/auth/passkey/login/verify", assertion, { cookie }), env, verifyUrl);
    expect(first?.status).not.toBe(200);

    const second = await handlePasskeyRoute(post("/api/auth/passkey/login/verify", assertion, { cookie }), env, verifyUrl);
    expect(second?.status).toBe(401);
    expect(await second!.json()).toMatchObject({ ok: false, error: expect.stringContaining("already used") });
  });

  it("refuses to hand out options when the challenge cannot be recorded", async () => {
    const env = {
      BROKER_SIGNING_KEY: SIGNING_KEY,
      BROKER_CONTROL_KEY: CONTROL_KEY,
      CREDENTIAL_BROKER: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (input: Request | string) => {
            const target = typeof input === "string" ? input : input.url;
            // Only the challenge table is broken. The throttle has to keep answering, or the
            // control-key caller is refused before the write this case is about is attempted
            // (cloud-factory-cf-m3hx).
            if (target.startsWith("https://credential-broker.internal/auth-throttle/")) {
              return Response.json({ ok: true, allowed: true, failures: 0, retryAfterSec: 0 });
            }
            return Response.json({ ok: false }, { status: 503 });
          },
        }),
      },
    } as never;

    const response = await handlePasskeyRoute(
      post("/api/auth/passkey/register/options", {}, { "x-factory-control-key": CONTROL_KEY }),
      env,
      new URL(`${ORIGIN}/api/auth/passkey/register/options`),
    );

    // Failing closed: a challenge the broker never recorded could never be consumed, so
    // the flow would only fail later with a worse message.
    expect(response?.status).toBe(503);
    expect(response?.headers.get("set-cookie")).toBeNull();
  });
});
