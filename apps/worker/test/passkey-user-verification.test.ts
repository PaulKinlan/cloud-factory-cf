import { describe, expect, it } from "vitest";
import { handlePasskeyRoute } from "../src/auth/passkey";
import { mintSessionToken } from "../src/auth/sessions";

/**
 * A root passkey must be used with user verification.
 *
 * The UP flag (0x01) proves a human was present; only the UV flag (0x04) proves they
 * unlocked the authenticator. The admin console asked for `required` in its own JavaScript,
 * which an attacker scripting the API never runs, and the server derived nothing from the
 * credential it resolved - so a touch-only assertion minted a root session
 * (cloud-factory-cf-dxy4).
 *
 * These cases drive `handlePasskeyRoute` directly with a stubbed CredentialBroker and a real
 * ES256 signature, so they assert the route's own decision: same assertion shape, same valid
 * signature, and the only difference is the UV bit.
 */
const SIGNING_KEY = "test-passkey-signing-key";
const ORIGIN = "https://example.com";
const CHALLENGE_URL = "https://credential-broker.internal/passkeys/challenge";
const CONSUME_URL = `${CHALLENGE_URL}/consume`;
const LOOKUP_PREFIX = "https://credential-broker.internal/passkeys?id=";
const TOUCH_URL = "https://credential-broker.internal/passkeys/touch";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** WebCrypto returns r||s; WebAuthn verifiers take DER, so wrap it the way a browser does. */
function p1363ToDer(signature: Uint8Array): Uint8Array {
  const encodeInteger = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const trimmed = Array.from(bytes.slice(start));
    if ((trimmed[0]! & 0x80) !== 0) trimmed.unshift(0);
    return [0x02, trimmed.length, ...trimmed];
  };
  const r = signature.slice(0, 32);
  const s = signature.slice(32);
  const body = [...encodeInteger(r), ...encodeInteger(s)];
  return new Uint8Array([0x30, body.length, ...body]);
}

interface StoredCredential {
  credentialId: string;
  subject: string;
  role: string;
  publicKeySpki: string;
  algorithm: number;
}

function testEnv(credential: StoredCredential, extra: Record<string, unknown> = {}) {
  const challenges = new Set<string>();
  const broker = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      // Some callers pass a Request rather than a URL string (`isSessionRevoked` does, so the
      // stub has to read `.url` instead of stringifying it to "[object Request]").
      const target =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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
      if (target.startsWith(LOOKUP_PREFIX)) {
        const id = decodeURIComponent(target.slice(LOOKUP_PREFIX.length));
        return Response.json({
          ok: true,
          passkeys: id === credential.credentialId ? [credential] : [],
        });
      }
      if (target === TOUCH_URL) return Response.json({ ok: true });
      // A session-authenticated route also reads the revocation list on this same object
      // (cloud-factory-cf-2lbm); it is bookkeeping, not a passkey operation.
      if (target.startsWith(SESSION_CHECK_PREFIX)) return Response.json({ ok: true, revoked: false });
      return Response.json({ ok: false, error: "unexpected broker path" }, { status: 404 });
    },
  };
  return {
    BROKER_SIGNING_KEY: SIGNING_KEY,
    BROKER_CONTROL_KEY: "test-passkey-control-key",
    CREDENTIAL_BROKER: { idFromName: (name: string) => name, get: () => broker },
    ...extra,
  } as never;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** A stored credential row plus the key that can sign for it. */
async function makeCredential(role: string, subject: string) {
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  return {
    privateKey: keyPair.privateKey,
    credential: {
      credentialId: `credential-${role}`,
      subject,
      role,
      publicKeySpki: base64Url(spki),
      algorithm: -7,
    } as StoredCredential,
  };
}

/** Runs login/options and returns the challenge plus the challenge cookie. */
async function startLogin(env: never): Promise<{ challenge: string; cookie: string }> {
  const response = await handlePasskeyRoute(
    post("/api/auth/passkey/login/options", {}),
    env,
    new URL(`${ORIGIN}/api/auth/passkey/login/options`),
  );
  expect(response?.status).toBe(200);
  const body = (await response!.json()) as { options: { challenge: string } };
  const cookie = (response!.headers.get("set-cookie") ?? "").split(";")[0] as string;
  return { challenge: body.options.challenge, cookie };
}

/** A valid assertion for the challenge, with exactly the flags the caller chose. */
async function assertion(
  privateKey: CryptoKey,
  credentialId: string,
  challenge: string,
  flags: number,
): Promise<Record<string, unknown>> {
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(new URL(ORIGIN).hostname)),
  );
  const authData = new Uint8Array(37);
  authData.set(rpIdHash, 0);
  authData[32] = flags;
  authData[33] = 0;
  authData[34] = 0;
  authData[35] = 0;
  authData[36] = 1;

  const clientDataJSON = base64Url(
    new TextEncoder().encode(
      JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN }),
    ),
  );
  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", base64UrlDecode(clientDataJSON) as unknown as BufferSource),
  );
  const signedData = new Uint8Array(authData.length + clientDataHash.length);
  signedData.set(authData, 0);
  signedData.set(clientDataHash, authData.length);
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, signedData as unknown as BufferSource),
  );

  return {
    credentialId,
    authenticatorData: base64Url(authData),
    clientDataJSON,
    signature: base64Url(p1363ToDer(raw)),
  };
}

const SESSION_CHECK_PREFIX = "https://credential-broker.internal/sessions/revoked";

const verifyUrl = new URL(`${ORIGIN}/api/auth/passkey/login/verify`);

describe("a root passkey requires user verification", () => {
  it("refuses a touch-only assertion for a root credential, however valid the signature", async () => {
    const { privateKey, credential } = await makeCredential("root", "__root__");
    const env = testEnv(credential);
    const { challenge, cookie } = await startLogin(env);
    const payload = await assertion(privateKey, credential.credentialId, challenge, 0x01); // UP only

    const response = await handlePasskeyRoute(
      post("/api/auth/passkey/login/verify", payload, { cookie }),
      env,
      verifyUrl,
    );
    expect(response?.status).toBe(401);
    await expect(response!.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("User verification required"),
    });
    // No session is minted on that path.
    expect(response!.headers.get("set-cookie") ?? "").not.toContain("cf_session");
  });

  it("accepts the same assertion once the UV bit is set", async () => {
    const { privateKey, credential } = await makeCredential("root", "__root__");
    const env = testEnv(credential);
    const { challenge, cookie } = await startLogin(env);
    const payload = await assertion(privateKey, credential.credentialId, challenge, 0x05); // UP | UV

    const response = await handlePasskeyRoute(
      post("/api/auth/passkey/login/verify", payload, { cookie }),
      env,
      verifyUrl,
    );
    expect(response?.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({ ok: true });
    expect(response!.headers.get("set-cookie") ?? "").toContain("cf_session");
  });

  it("does not require UV of an ordinary user's passkey", async () => {
    // The requirement is derived from the credential being used, so a normal session login
    // is unaffected: UP alone is still a normal passkey login for a user.
    const { privateKey, credential } = await makeCredential("user", "alice");
    const env = testEnv(credential);
    const { challenge, cookie } = await startLogin(env);
    const payload = await assertion(privateKey, credential.credentialId, challenge, 0x01);

    const response = await handlePasskeyRoute(
      post("/api/auth/passkey/login/verify", payload, { cookie }),
      env,
      verifyUrl,
    );
    expect(response?.status).toBe(200);
  });

  it("treats the root subject as root even if the stored role says otherwise", async () => {
    const { privateKey, credential } = await makeCredential("user", "__root__");
    const env = testEnv(credential);
    const { challenge, cookie } = await startLogin(env);
    const payload = await assertion(privateKey, credential.credentialId, challenge, 0x01);

    const response = await handlePasskeyRoute(
      post("/api/auth/passkey/login/verify", payload, { cookie }),
      env,
      verifyUrl,
    );
    expect(response?.status).toBe(401);
  });

  /**
   * "Root" is the control plane's predicate, not the credential's role (cloud-factory-cf-bgjb).
   * A deployment lists its operators in PLATFORM_OWNERS (ADR 006), and those logins get
   * deployment-wide authority from `authorizeControlPlane` while their passkey is stored with
   * `role: "user"`. A touch-only assertion for one of them would have minted exactly that
   * session, so the UV requirement has to follow the same predicate.
   */
  it("requires UV of a platform owner's passkey, not only of the __root__ subject", async () => {
    const { privateKey, credential } = await makeCredential("user", "alice");
    const env = testEnv(credential, { PLATFORM_OWNERS: "alice" });

    const first = await startLogin(env);
    const touchOnly = await assertion(privateKey, credential.credentialId, first.challenge, 0x01); // UP only
    const refused = await handlePasskeyRoute(
      post("/api/auth/passkey/login/verify", touchOnly, { cookie: first.cookie }),
      env,
      verifyUrl,
    );
    expect(refused?.status).toBe(401);
    await expect(refused!.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("User verification required"),
    });
    expect(refused!.headers.get("set-cookie") ?? "").not.toContain("cf_session");

    // The same owner with a verified authenticator still signs in.
    const second = await startLogin(env);
    const withUv = await assertion(privateKey, credential.credentialId, second.challenge, 0x05); // UP | UV
    const accepted = await handlePasskeyRoute(
      post("/api/auth/passkey/login/verify", withUv, { cookie: second.cookie }),
      env,
      verifyUrl,
    );
    expect(accepted?.status).toBe(200);
    expect(accepted!.headers.get("set-cookie") ?? "").toContain("cf_session");

    // A login that is NOT on the platform-owner list keeps the ordinary rule: UP alone is
    // enough, so this fix does not make every passkey a UV-gated one.
    const { privateKey: bobKey, credential: bob } = await makeCredential("user", "bob");
    const bobEnv = testEnv(bob, { PLATFORM_OWNERS: "alice" });
    const third = await startLogin(bobEnv);
    const bobTouchOnly = await assertion(bobKey, bob.credentialId, third.challenge, 0x01);
    const bobAccepted = await handlePasskeyRoute(
      post("/api/auth/passkey/login/verify", bobTouchOnly, { cookie: third.cookie }),
      bobEnv,
      verifyUrl,
    );
    expect(bobAccepted?.status).toBe(200);
  });

  /**
   * Registration has to advertise what login will require (cloud-factory-cf-trej). A
   * platform owner registers under their own login, so the stored role is "user" while the
   * control plane treats them as root; asking only "preferred" of them produced credentials
   * that `login/verify` then refuses.
   */
  it("asks a platform owner's registration for user verification, like any other root credential", async () => {
    const { credential } = await makeCredential("user", "alice");
    const env = testEnv(credential, { PLATFORM_OWNERS: "alice" });
    const cookie = `cf_session=${await mintSessionToken(SIGNING_KEY, "alice")}`;

    const ownerOptions = await handlePasskeyRoute(
      post("/api/auth/passkey/register/options", {}, { cookie }),
      env,
      new URL(`${ORIGIN}/api/auth/passkey/register/options`),
    );
    expect(ownerOptions?.status).toBe(200);
    const ownerBody = (await ownerOptions!.json()) as {
      options: { authenticatorSelection: { userVerification: string } };
    };
    expect(ownerBody.options.authenticatorSelection.userVerification).toBe("required");

    // A login that is not a platform owner keeps the ordinary policy.
    const bobCookie = `cf_session=${await mintSessionToken(SIGNING_KEY, "bob")}`;
    const userOptions = await handlePasskeyRoute(
      post("/api/auth/passkey/register/options", {}, { cookie: bobCookie }),
      env,
      new URL(`${ORIGIN}/api/auth/passkey/register/options`),
    );
    const userBody = (await userOptions!.json()) as {
      options: { authenticatorSelection: { userVerification: string } };
    };
    expect(userBody.options.authenticatorSelection.userVerification).toBe("preferred");
  });

  it("asks a root registration for user verification, and a user registration for preferred", async () => {
    const { credential } = await makeCredential("root", "__root__");
    const env = testEnv(credential);

    const rootOptions = await handlePasskeyRoute(
      post("/api/auth/passkey/register/options", {}, { "x-factory-control-key": "test-passkey-control-key" }),
      env,
      new URL(`${ORIGIN}/api/auth/passkey/register/options`),
    );
    const rootBody = (await rootOptions!.json()) as {
      options: { authenticatorSelection: { userVerification: string } };
    };
    expect(rootBody.options.authenticatorSelection.userVerification).toBe("required");

    const userOptions = await handlePasskeyRoute(
      post("/api/auth/passkey/login/options", {}),
      env,
      new URL(`${ORIGIN}/api/auth/passkey/login/options`),
    );
    const userBody = (await userOptions!.json()) as { options: { userVerification: string } };
    expect(userBody.options.userVerification).toBe("preferred");
  });
});
