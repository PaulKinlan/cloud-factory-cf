import { describe, expect, it } from "vitest";
import { handlePasskeyRoute } from "../src/auth/passkey";
import { mintSessionToken } from "../src/routes/auth";
import { buildAttestationObject, es256KeyPair } from "./support/webauthn";

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

function testEnv(initial: { passkeys?: Array<Record<string, unknown>> } = {}) {
  const saved: unknown[] = [];
  // The broker's challenge table, in memory: store on issue, delete on consume, so the
  // single-use rule is what these cases observe (cloud-factory-cf-zl0a).
  const challenges = new Set<string>();
  const broker = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
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
      return Response.json({ ok: false, error: "unexpected broker path" }, { status: 404 });
    },
  };
  const stored: Array<Record<string, unknown>> = [...(initial.passkeys ?? [])];
  const saveRequest = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      if (target.startsWith(`${SAVE_URL}?id=`)) {
        // The login path looks a credential up by id and reads its role from this record.
        return Response.json({ passkeys: stored });
      }
      if (target === SAVE_URL && init?.body) {
        const parsed = JSON.parse(String(init.body)) as Record<string, unknown>;
        saved.push(parsed);
        stored.push(parsed);
      }
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
async function startRegistration(
  env: never,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = { "x-factory-control-key": CONTROL_KEY },
): Promise<{ challenge: string; cookie: string; userVerification: string }> {
  const response = await handlePasskeyRoute(
    post("/api/auth/passkey/register/options", body, headers),
    env,
    new URL(`${ORIGIN}/api/auth/passkey/register/options`),
  );
  expect(response?.status).toBe(200);
  const options = (await response!.json()) as {
    // For a creation ceremony the level belongs in authenticatorSelection (the spec's shape);
    // for an assertion it is top-level. Reading the wrong one is how this check first came back
    // undefined, which is the same mistake a client would make.
    options: { challenge: string; authenticatorSelection: { userVerification: string } };
  };
  const setCookie = response!.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] as string;
  expect(cookie).toContain("=");
  return {
    challenge: options.options.challenge,
    cookie,
    userVerification: options.options.authenticatorSelection.userVerification,
  };
}

/** Runs login/options and returns the challenge, the cookie and the level we asked for. */
async function startLogin(
  env: never,
  body: Record<string, unknown> = {},
): Promise<{ challenge: string; cookie: string; userVerification: string }> {
  const response = await handlePasskeyRoute(
    post("/api/auth/passkey/login/options", body),
    env,
    new URL(`${ORIGIN}/api/auth/passkey/login/options`),
  );
  expect(response?.status).toBe(200);
  const options = (await response!.json()) as {
    options: { challenge: string; userVerification: string };
  };
  const cookie = (response!.headers.get("set-cookie") ?? "").split(";")[0] as string;
  return { challenge: options.options.challenge, cookie, userVerification: options.options.userVerification };
}

/** Authenticator data as an assertion carries it: rpIdHash, flags, sign count. */
async function assertionAuthenticatorData(flags: number): Promise<string> {
  const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("example.com")));
  return base64Url(new Uint8Array([...rpIdHash, flags, 0, 0, 0, 1]));
}

function assertionClientData(challenge: string): string {
  return base64Url(
    new TextEncoder().encode(
      JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN }),
    ),
  );
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
    const key = await es256KeyPair();
    const credentialId = base64Url(key.credentialId);
    const attestationObject = await buildAttestationObject({
      rpId: "example.com",
      credentialId: key.credentialId,
      spki: key.spki,
      flags: 0x45, // UP|UV|AT: this is a root registration, which now always requires verification
    });

    const response = await handlePasskeyRoute(
      post(
        "/api/auth/passkey/register/verify",
        { credentialId, attestationObject, clientDataJSON: clientData({ challenge }) },
        { cookie },
      ),
      env,
      new URL(VERIFY_URL),
    );

    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ ok: true, credentialId });
    expect(saved).toHaveLength(1);
    // The stored key is the one in the authenticator data, which is the same SPKI the
    // registration was built from - so the derivation is byte-exact, not merely accepted.
    expect(saved[0]).toMatchObject({ credentialId, publicKeySpki: key.spkiBase64Url, algorithm: -7 });
    // A passkey session is only minted for a registration that passed every check.
    expect(response?.headers.get("set-cookie")).toContain("cf_session=");
  });

  it("refuses a registration that never presented an attestation object", async () => {
    // The reported hole (cloud-factory-cf-evbe): credentialId and publicKeySpki were taken on
    // trust, so a caller could file any key under any credential id without an authenticator
    // ever being involved.
    const { env, saved } = testEnv();
    const { challenge, cookie } = await startRegistration(env);

    const response = await handlePasskeyRoute(
      post(
        "/api/auth/passkey/register/verify",
        {
          credentialId: "cred-no-attestation",
          publicKeySpki: await es256PublicKeySpki(),
          clientDataJSON: clientData({ challenge }),
        },
        { cookie },
      ),
      env,
      new URL(VERIFY_URL),
    );

    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({ ok: false, error: "Missing attestationObject" });
    expect(saved).toHaveLength(0);
    expect(response?.headers.get("set-cookie") ?? "").not.toContain("cf_session=");
  });

  it("refuses an attestation object for a different credential id", async () => {
    const { env, saved } = testEnv();
    const { challenge, cookie } = await startRegistration(env);
    const key = await es256KeyPair();
    const other = await es256KeyPair();
    const attestationObject = await buildAttestationObject({
      rpId: "example.com",
      credentialId: other.credentialId,
      spki: key.spki,
      flags: 0x45,
    });

    const response = await handlePasskeyRoute(
      post(
        "/api/auth/passkey/register/verify",
        {
          credentialId: base64Url(key.credentialId),
          attestationObject,
          clientDataJSON: clientData({ challenge }),
        },
        { cookie },
      ),
      env,
      new URL(VERIFY_URL),
    );

    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("credential id does not match"),
    });
    expect(saved).toHaveLength(0);
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
        get: () => ({ fetch: async () => Response.json({ ok: false }, { status: 503 }) }),
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

/**
 * User verification (cloud-factory-cf-l28o). The assertion path checked the UP flag and never
 * looked at UV, so a challenge we handed out asking for verification could be answered by a
 * bare touch. What makes this a server-side property rather than a client courtesy is that the
 * requirement is written into the SIGNED challenge cookie when the challenge is issued: the
 * assertion cannot lower it, because the assertion is the part an attacker controls.
 */
describe("passkey user verification", () => {
  it("asks for the level the caller requests, and defaults to preferred", async () => {
    const { env } = testEnv();
    const required = await startRegistration(env, { userVerification: "required" });
    expect(required.userVerification).toBe("required");
    const byDefault = await startRegistration(env);
    expect(byDefault.userVerification).toBe("preferred");
    const bogus = await startRegistration(env, { userVerification: "yes-please" });
    expect(bogus.userVerification).toBe("preferred");
  });

  it("refuses a registration whose authenticator never verified the user, when it asked for that", async () => {
    const { env, saved } = testEnv();
    const { challenge, cookie } = await startRegistration(env, { userVerification: "required" });
    const key = await es256KeyPair();
    // UP|AT: present, attested data - but no UV, which is what a bare touch reports.
    const attestationObject = await buildAttestationObject({
      rpId: "example.com",
      credentialId: key.credentialId,
      spki: key.spki,
      flags: 0x41,
    });

    const response = await handlePasskeyRoute(
      post(
        "/api/auth/passkey/register/verify",
        { credentialId: base64Url(key.credentialId), attestationObject, clientDataJSON: clientData({ challenge }) },
        { cookie },
      ),
      env,
      new URL(VERIFY_URL),
    );

    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("user verification required but not performed"),
    });
    expect(saved).toEqual([]);
  });

  it("registers when the authenticator did verify the user", async () => {
    const { env, saved } = testEnv();
    const { challenge, cookie } = await startRegistration(env, { userVerification: "required" });
    const key = await es256KeyPair();
    const attestationObject = await buildAttestationObject({
      rpId: "example.com",
      credentialId: key.credentialId,
      spki: key.spki,
      flags: 0x45, // UP|UV|AT
    });

    const response = await handlePasskeyRoute(
      post(
        "/api/auth/passkey/register/verify",
        { credentialId: base64Url(key.credentialId), attestationObject, clientDataJSON: clientData({ challenge }) },
        { cookie },
      ),
      env,
      new URL(VERIFY_URL),
    );

    expect(response?.status).toBe(200);
    expect(saved).toHaveLength(1);
  });

  it("does not demand verification from an ordinary user's preferred challenge", async () => {
    // The other half of the rule: for an ordinary user, "preferred" must stay honest, or every
    // security key without a PIN is locked out of the product. Note the registration is made as
    // a USER, not with the control key - a root registration requires verification regardless of
    // what was asked for (cloud-factory-cf-dxy4), which the next case covers.
    const { env, saved } = testEnv();
    const userSession = `cf_session=${encodeURIComponent(await mintSessionToken(SIGNING_KEY, "alice"))}`;
    const { challenge, cookie } = await startRegistration(env, {}, { cookie: userSession });
    const key = await es256KeyPair();
    const attestationObject = await buildAttestationObject({
      rpId: "example.com",
      credentialId: key.credentialId,
      spki: key.spki,
      flags: 0x41,
    });

    const response = await handlePasskeyRoute(
      post(
        "/api/auth/passkey/register/verify",
        { credentialId: base64Url(key.credentialId), attestationObject, clientDataJSON: clientData({ challenge }) },
        { cookie },
      ),
      env,
      new URL(VERIFY_URL),
    );

    expect(response?.status).toBe(200);
    expect(saved).toHaveLength(1);
  });

  it("refuses a login whose assertion never verified the user, when it asked for that", async () => {
    const { env } = testEnv();
    const { challenge, cookie } = await startLogin(env, { userVerification: "required" });
    expect(cookie).toContain("=");

    const response = await handlePasskeyRoute(
      post(
        "/api/auth/passkey/login/verify",
        {
          credentialId: "unknown-credential",
          authenticatorData: await assertionAuthenticatorData(0x01), // UP only
          clientDataJSON: assertionClientData(challenge),
          signature: "AAAA",
        },
        { cookie },
      ),
      env,
      new URL(`${ORIGIN}/api/auth/passkey/login/verify`),
    );

    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({
      ok: false,
      error: "User verification required but not performed",
    });
  });

  it("lets a verified assertion through to the credential lookup", async () => {
    // This case is about ORDERING: with UV set, the request must get past the flag checks and
    // fail on the unknown credential instead. If the UV gate were placed before the UP check,
    // or if it fired on a satisfied requirement, this would return the UV error.
    const { env } = testEnv();
    const { challenge, cookie } = await startLogin(env, { userVerification: "required" });

    const response = await handlePasskeyRoute(
      post(
        "/api/auth/passkey/login/verify",
        {
          credentialId: "unknown-credential",
          authenticatorData: await assertionAuthenticatorData(0x05), // UP|UV
          clientDataJSON: assertionClientData(challenge),
          signature: "AAAA",
        },
        { cookie },
      ),
      env,
      new URL(`${ORIGIN}/api/auth/passkey/login/verify`),
    );

    const body = (await response!.json()) as { error?: string };
    expect(body.error).not.toBe("User verification required but not performed");
  });
});

  it("refuses an ordinary root login whose assertion never verified the user, whatever was asked", async () => {
    // cloud-factory-cf-dxy4: the requirement must come from the record's role, not from the
    // caller. Here the caller asked for nothing, so the challenge is "preferred" - and the
    // server still refuses, because the credential being unlocked is a root one.
    const { env } = testEnv({
      passkeys: [{ credentialId: "root-cred", publicKeySpki: "AAAA", algorithm: -7, role: "root" }],
    });
    const { challenge, cookie } = await startLogin(env); // no userVerification: "preferred"
    expect(cookie).toContain("=");

    const response = await handlePasskeyRoute(
      post(
        "/api/auth/passkey/login/verify",
        {
          credentialId: "root-cred",
          authenticatorData: await assertionAuthenticatorData(0x01), // UP only
          clientDataJSON: assertionClientData(challenge),
          signature: "AAAA",
        },
        { cookie },
      ),
      env,
      new URL(`${ORIGIN}/api/auth/passkey/login/verify`),
    );

    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({
      ok: false,
      error: "User verification required but not performed",
    });
  });

  it("lets an ordinary user's assertion through when the challenge only preferred verification", async () => {
    const { env } = testEnv({
      passkeys: [{ credentialId: "user-cred", publicKeySpki: "AAAA", algorithm: -7, role: "user" }],
    });
    const { challenge, cookie } = await startLogin(env);

    const response = await handlePasskeyRoute(
      post(
        "/api/auth/passkey/login/verify",
        {
          credentialId: "user-cred",
          authenticatorData: await assertionAuthenticatorData(0x01),
          clientDataJSON: assertionClientData(challenge),
          signature: "AAAA",
        },
        { cookie },
      ),
      env,
      new URL(`${ORIGIN}/api/auth/passkey/login/verify`),
    );

    // It goes on to fail signature verification with the stub key, which is the point: the UV
    // gate did not fire for a user credential on a preferred challenge.
    const body = (await response!.json()) as { error?: string };
    expect(body.error).not.toBe("User verification required but not performed");
  });

  it("refuses a root registration that only preferred verification", async () => {
    // The other half of the same finding: registerUv came from the request body, so a root
    // registration could run under "preferred". The role in the signed cookie is the server's
    // own decision, and it now forces the requirement.
    const { env, saved } = testEnv();
    const { challenge, cookie } = await startRegistration(env); // control key, no userVerification
    const key = await es256KeyPair();
    const attestationObject = await buildAttestationObject({
      rpId: "example.com",
      credentialId: key.credentialId,
      spki: key.spki,
      flags: 0x41,
    });

    const response = await handlePasskeyRoute(
      post(
        "/api/auth/passkey/register/verify",
        { credentialId: base64Url(key.credentialId), attestationObject, clientDataJSON: clientData({ challenge }) },
        { cookie },
      ),
      env,
      new URL(VERIFY_URL),
    );

    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("user verification required but not performed"),
    });
    expect(saved).toEqual([]);
  });
