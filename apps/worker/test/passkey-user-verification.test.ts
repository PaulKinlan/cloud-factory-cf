import { describe, expect, it } from "vitest";
import { handlePasskeyRoute } from "../src/auth/passkey";

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

function testEnv(credential: StoredCredential) {
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
      if (target.startsWith(LOOKUP_PREFIX)) {
        const id = decodeURIComponent(target.slice(LOOKUP_PREFIX.length));
        return Response.json({
          ok: true,
          passkeys: id === credential.credentialId ? [credential] : [],
        });
      }
      if (target === TOUCH_URL) return Response.json({ ok: true });
      return Response.json({ ok: false, error: "unexpected broker path" }, { status: 404 });
    },
  };
  return {
    BROKER_SIGNING_KEY: SIGNING_KEY,
    BROKER_CONTROL_KEY: "test-passkey-control-key",
    CREDENTIAL_BROKER: { idFromName: (name: string) => name, get: () => broker },
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
