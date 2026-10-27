import type { Env } from "../env";
import { sameSecret } from "../secrets";
import { mintSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "../routes/auth";
import { readSession } from "../routes/auth";

export const WEBAUTHN_CHALLENGE_COOKIE = "cf_webauthn_challenge";

export function base64UrlEncode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * WebCrypto's BufferSource wants bytes over a plain ArrayBuffer; since TypeScript 5.7 a
 * `Uint8Array` is generic over `ArrayBufferLike`, and a view over a SharedArrayBuffer (or a
 * value typed as such) is not assignable. Copying into a fresh ArrayBuffer-backed array is
 * the one conversion that satisfies both the DOM and workers types (cloud-factory-cf-6xju).
 */
function bufferSource(bytes: Uint8Array): BufferSource {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export function base64UrlDecode(input: string): Uint8Array {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Converts ASN.1 DER ECDSA signature to IEEE P1363 raw (r || s) 64-byte format
 * required by Web Crypto API for P-256 verification.
 */
export function derToP1363(der: Uint8Array): Uint8Array {
  if (der.length === 64) return der; // Already raw format
  if (der[0] !== 0x30) throw new Error("Invalid ASN.1 DER sequence");

  let pos = 2; // Skip 0x30 and length
  if (der[1]! & 0x80) {
    pos = 2 + (der[1]! & 0x7f);
  }

  // Parse r
  if (der[pos] !== 0x02) throw new Error("Expected ASN.1 INTEGER for r");
  pos++;
  const rLen = der[pos++]!;
  let r = der.slice(pos, pos + rLen);
  pos += rLen;

  // Parse s
  if (der[pos] !== 0x02) throw new Error("Expected ASN.1 INTEGER for s");
  pos++;
  const sLen = der[pos++]!;
  let s = der.slice(pos, pos + sLen);

  // Strip leading zeroes if > 32 bytes
  while (r.length > 32 && r[0] === 0) r = r.slice(1);
  while (s.length > 32 && s[0] === 0) s = s.slice(1);

  // Pad to 32 bytes if < 32 bytes
  const out = new Uint8Array(64);
  out.set(r, 32 - r.length);
  out.set(s, 64 - s.length);
  return out;
}

async function signHmacSha256(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getCookie(headers: Headers, name: string): string | null {
  const cookie = headers.get("cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export async function mintChallengeCookie(
  signingKey: string,
  challenge: string,
  subject: string,
  role: string,
  flowType: "create" | "get",
  url: URL,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 300; // 5 min TTL
  const payload = `${challenge}.${exp}.${subject}.${role}.${flowType}`;
  const sig = await signHmacSha256(signingKey, payload);
  const cookieVal = `${payload}.${sig}`;
  const isSecure = url.protocol === "https:";
  return `${WEBAUTHN_CHALLENGE_COOKIE}=${encodeURIComponent(cookieVal)}; HttpOnly; ${isSecure ? "Secure; " : ""}SameSite=Lax; Path=/api/auth/passkey; Max-Age=300`;
}

export async function verifyChallengeCookie(
  request: Request,
  signingKey: string,
  expectedFlow: "create" | "get",
): Promise<{ ok: true; challenge: string; subject: string; role: string } | { ok: false; error: string }> {
  const cookieVal = getCookie(request.headers, WEBAUTHN_CHALLENGE_COOKIE);
  if (!cookieVal) return { ok: false, error: "Missing WebAuthn challenge cookie" };

  const parts = cookieVal.split(".");
  if (parts.length !== 6) return { ok: false, error: "Malformed challenge cookie" };
  const [challenge, expStr, subject, role, flowType, sig] = parts as [string, string, string, string, string, string];

  const expectedSig = await signHmacSha256(signingKey, `${challenge}.${expStr}.${subject}.${role}.${flowType}`);
  if (!(await sameSecret(expectedSig, sig))) {
    return { ok: false, error: "Invalid challenge cookie signature" };
  }

  const exp = Number.parseInt(expStr, 10);
  if (Number.isNaN(exp) || Math.floor(Date.now() / 1000) > exp) {
    return { ok: false, error: "WebAuthn challenge expired" };
  }

  if (flowType !== expectedFlow) {
    return { ok: false, error: "WebAuthn flow mismatch" };
  }

  return { ok: true, challenge, subject, role };
}

export async function handlePasskeyRoute(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  const signingKey = env.BROKER_SIGNING_KEY ?? env.BROKER_CONTROL_KEY;
  if (!signingKey) {
    return Response.json({ ok: false, error: "Signing key not configured" }, { status: 503 });
  }

  // 1. POST /api/auth/passkey/register/options
  if (url.pathname === "/api/auth/passkey/register/options" && request.method === "POST") {
    // Requires active session or control key
    const session = await readSession(request.headers, signingKey);
    const controlKey = request.headers.get("x-factory-control-key");
    const hasValidControlKey = Boolean(
      controlKey && env.BROKER_CONTROL_KEY && (await sameSecret(env.BROKER_CONTROL_KEY, controlKey)),
    );

    let body: Record<string, any> = {};
    try {
      body = (await request.json()) as Record<string, any>;
    } catch {
      // empty body is fine
    }

    let subject = body.subject ? String(body.subject).trim() : "";
    let role = body.role ? String(body.role).trim() : "user";

    if (hasValidControlKey || (session.ok && session.login === "__root__")) {
      if (!subject) subject = "__root__";
      if (subject === "__root__") role = "root";
    } else if (session.ok) {
      subject = session.login;
      role = "user";
    } else {
      return Response.json({ ok: false, error: "Authentication required to register a passkey" }, { status: 401 });
    }

    const challengeBytes = new Uint8Array(32);
    crypto.getRandomValues(challengeBytes);
    const challenge = base64UrlEncode(challengeBytes);

    const userBytes = new TextEncoder().encode(subject);
    const userId = base64UrlEncode(userBytes);

    const challengeCookie = await mintChallengeCookie(signingKey, challenge, subject, role, "create", url);

    const options = {
      challenge,
      rp: {
        name: "Cloud Factory",
        id: url.hostname,
      },
      user: {
        id: userId,
        name: subject,
        displayName: subject === "__root__" ? "Root Administrator" : subject,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },   // ES256 (P-256)
        { type: "public-key", alg: -257 }, // RS256
      ],
      timeout: 60000,
      attestation: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    };

    return Response.json({ ok: true, options }, { headers: { "set-cookie": challengeCookie } });
  }

  // 2. POST /api/auth/passkey/register/verify
  if (url.pathname === "/api/auth/passkey/register/verify" && request.method === "POST") {
    const verifiedCookie = await verifyChallengeCookie(request, signingKey, "create");
    if (!verifiedCookie.ok) {
      return Response.json({ ok: false, error: verifiedCookie.error }, { status: 400 });
    }

    let body: Record<string, any>;
    try {
      body = (await request.json()) as Record<string, any>;
    } catch {
      return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const { credentialId, publicKeySpki, algorithm, clientDataJSON, label } = body;
    if (!credentialId || !publicKeySpki) {
      return Response.json({ ok: false, error: "Missing credentialId or publicKeySpki" }, { status: 400 });
    }

    // Verify clientDataJSON
    if (clientDataJSON) {
      try {
        const clientDataBytes = base64UrlDecode(String(clientDataJSON));
        const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes)) as {
          type?: string;
          challenge?: string;
          origin?: string;
        };
        if (clientData.type !== "webauthn.create") {
          return Response.json({ ok: false, error: "Invalid clientData type" }, { status: 400 });
        }
        if (clientData.challenge !== verifiedCookie.challenge) {
          return Response.json({ ok: false, error: "Challenge mismatch" }, { status: 400 });
        }
        if (clientData.origin !== url.origin) {
          return Response.json({ ok: false, error: "Origin mismatch" }, { status: 400 });
        }
      } catch (err) {
        return Response.json({ ok: false, error: `Failed to parse clientData: ${String(err)}` }, { status: 400 });
      }
    }

    // Validate publicKeySpki can be imported
    try {
      const spkiBytes = base64UrlDecode(String(publicKeySpki));
      const alg = Number(algorithm ?? -7);
      if (alg === -7) {
        await crypto.subtle.importKey(
          "spki",
          bufferSource(spkiBytes),
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"],
        );
      } else if (alg === -257) {
        await crypto.subtle.importKey(
          "spki",
          bufferSource(spkiBytes),
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
      }
    } catch (err) {
      return Response.json({ ok: false, error: `Invalid SPKI public key: ${String(err)}` }, { status: 400 });
    }

    // Store in root CredentialBroker ("default")
    if (!env.CREDENTIAL_BROKER) {
      return Response.json({ ok: false, error: "CredentialBroker not available" }, { status: 503 });
    }
    const broker = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName("default"));
    const saveRes = await broker.fetch("https://credential-broker.internal/passkeys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credentialId,
        subject: verifiedCookie.subject,
        role: verifiedCookie.role,
        publicKeySpki,
        algorithm: algorithm ?? -7,
        label: label ?? `Passkey (${new Date().toLocaleDateString()})`,
      }),
    });

    if (!saveRes.ok) {
      return Response.json({ ok: false, error: "Failed to persist passkey in broker" }, { status: 500 });
    }

    // Mint session cookie for the user
    const sessionToken = await mintSessionToken(signingKey, verifiedCookie.subject);
    const isSecure = url.protocol === "https:";
    const sessionCookieHeader = `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; ${isSecure ? "Secure; " : ""}SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
    const clearChallengeCookie = `${WEBAUTHN_CHALLENGE_COOKIE}=; Path=/api/auth/passkey; HttpOnly; ${isSecure ? "Secure; " : ""}SameSite=Lax; Max-Age=0`;

    const headers = new Headers();
    headers.append("set-cookie", sessionCookieHeader);
    headers.append("set-cookie", clearChallengeCookie);

    return Response.json(
      {
        ok: true,
        credentialId,
        subject: verifiedCookie.subject,
        role: verifiedCookie.role,
      },
      { headers },
    );
  }

  // 3. POST /api/auth/passkey/login/options
  if (url.pathname === "/api/auth/passkey/login/options" && request.method === "POST") {
    const challengeBytes = new Uint8Array(32);
    crypto.getRandomValues(challengeBytes);
    const challenge = base64UrlEncode(challengeBytes);

    const challengeCookie = await mintChallengeCookie(signingKey, challenge, "", "", "get", url);

    const options = {
      challenge,
      rpId: url.hostname,
      timeout: 60000,
      userVerification: "preferred",
    };

    return Response.json({ ok: true, options, publicKey: options }, { headers: { "set-cookie": challengeCookie } });
  }

  // 4. POST /api/auth/passkey/login/verify
  if (url.pathname === "/api/auth/passkey/login/verify" && request.method === "POST") {
    const verifiedCookie = await verifyChallengeCookie(request, signingKey, "get");
    if (!verifiedCookie.ok) {
      return Response.json({ ok: false, error: verifiedCookie.error }, { status: 400 });
    }

    let body: Record<string, any>;
    try {
      body = (await request.json()) as Record<string, any>;
    } catch {
      return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const credentialId = body.credentialId ?? body.rawId ?? body.id;
    const authenticatorData = body.authenticatorData ?? body.response?.authenticatorData;
    const clientDataJSON = body.clientDataJSON ?? body.response?.clientDataJSON;
    const signature = body.signature ?? body.response?.signature;
    if (!credentialId || !authenticatorData || !clientDataJSON || !signature) {
      return Response.json({ ok: false, error: "Missing required WebAuthn authentication fields" }, { status: 400 });
    }

    // Verify clientDataJSON
    let clientDataChallenge = "";
    try {
      const clientDataBytes = base64UrlDecode(String(clientDataJSON));
      const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes)) as {
        type?: string;
        challenge?: string;
        origin?: string;
      };
      if (clientData.type !== "webauthn.get") {
        return Response.json({ ok: false, error: "Invalid clientData type" }, { status: 400 });
      }
      if (clientData.challenge !== verifiedCookie.challenge) {
        return Response.json({ ok: false, error: "Challenge mismatch" }, { status: 400 });
      }
      if (clientData.origin !== url.origin) {
        return Response.json({ ok: false, error: "Origin mismatch" }, { status: 400 });
      }
      clientDataChallenge = clientData.challenge;
    } catch (err) {
      return Response.json({ ok: false, error: `Failed to parse clientData: ${String(err)}` }, { status: 400 });
    }

    // Verify authenticatorData (UP flag and RP ID hash)
    const authDataBytes = base64UrlDecode(String(authenticatorData));
    if (authDataBytes.length < 37) {
      return Response.json({ ok: false, error: "AuthenticatorData too short" }, { status: 400 });
    }
    const flags = authDataBytes[32]!;
    if ((flags & 0x01) === 0) {
      return Response.json({ ok: false, error: "User presence bit not set" }, { status: 400 });
    }

    // Verify RP ID hash
    const expectedRpIdHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url.hostname)),
    );
    for (let i = 0; i < 32; i++) {
      if (authDataBytes[i] !== expectedRpIdHash[i]) {
        return Response.json({ ok: false, error: "RP ID hash mismatch" }, { status: 400 });
      }
    }

    // Lookup passkey from default CredentialBroker
    if (!env.CREDENTIAL_BROKER) {
      return Response.json({ ok: false, error: "CredentialBroker not available" }, { status: 503 });
    }
    const broker = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName("default"));
    const getRes = await broker.fetch(`https://credential-broker.internal/passkeys?id=${encodeURIComponent(credentialId)}`);
    if (!getRes.ok) {
      return Response.json({ ok: false, error: "Passkey lookup failed" }, { status: 500 });
    }
    const passkeyData = (await getRes.json()) as { passkeys?: Array<Record<string, any>> };
    const passkey = passkeyData.passkeys?.[0];
    if (!passkey || !passkey.publicKeySpki) {
      return Response.json({ ok: false, error: "Passkey not found" }, { status: 404 });
    }

    // Cryptographic signature verification
    const spkiBytes = base64UrlDecode(String(passkey.publicKeySpki));
    const sigBytes = base64UrlDecode(String(signature));
    const alg = Number(passkey.algorithm ?? -7);

    // Compute signed payload: authenticatorData || SHA-256(clientDataJSON)
    const clientDataHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", bufferSource(base64UrlDecode(String(clientDataJSON)))),
    );
    const signedData = new Uint8Array(authDataBytes.length + clientDataHash.length);
    signedData.set(authDataBytes, 0);
    signedData.set(clientDataHash, authDataBytes.length);

    let verified = false;
    try {
      if (alg === -7) {
        const cryptoKey = await crypto.subtle.importKey(
          "spki",
          bufferSource(spkiBytes),
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"],
        );
        const p1363Sig = derToP1363(sigBytes);
        verified = await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          cryptoKey,
          bufferSource(p1363Sig),
          bufferSource(signedData),
        );
      } else if (alg === -257) {
        const cryptoKey = await crypto.subtle.importKey(
          "spki",
          bufferSource(spkiBytes),
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        verified = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          cryptoKey,
          bufferSource(sigBytes),
          bufferSource(signedData),
        );
      }
    } catch (err) {
      return Response.json({ ok: false, error: `Signature verification error: ${String(err)}` }, { status: 400 });
    }

    if (!verified) {
      return Response.json({ ok: false, error: "Invalid WebAuthn signature" }, { status: 401 });
    }

    // Touch last_used_at
    await broker.fetch("https://credential-broker.internal/passkeys/touch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credentialId }),
    }).catch(() => null);

    // Mint session cookie for the passkey subject
    const subject = String(passkey.subject);
    const sessionToken = await mintSessionToken(signingKey, subject);
    const isSecure = url.protocol === "https:";
    const sessionCookieHeader = `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; ${isSecure ? "Secure; " : ""}SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
    const clearChallengeCookie = `${WEBAUTHN_CHALLENGE_COOKIE}=; Path=/api/auth/passkey; HttpOnly; ${isSecure ? "Secure; " : ""}SameSite=Lax; Max-Age=0`;

    const headers = new Headers();
    headers.append("set-cookie", sessionCookieHeader);
    headers.append("set-cookie", clearChallengeCookie);

    return Response.json(
      {
        ok: true,
        login: subject,
        role: passkey.role,
        isRootAdmin: passkey.role === "root" || subject === "__root__",
      },
      { headers },
    );
  }

  // 5. GET /api/auth/passkeys
  if (url.pathname === "/api/auth/passkeys" && request.method === "GET") {
    const session = await readSession(request.headers, signingKey);
    const controlKey = request.headers.get("x-factory-control-key");
    const isRoot = Boolean(
      (controlKey && env.BROKER_CONTROL_KEY && (await sameSecret(env.BROKER_CONTROL_KEY, controlKey))) ||
      (session.ok && session.login === "__root__"),
    );

    if (!session.ok && !isRoot) {
      return Response.json({ ok: false, error: "Authentication required" }, { status: 401 });
    }

    // Narrowed once: `session` is a discriminated union, and the 401 guard above is a
    // compound condition that does not narrow it at each later use (cloud-factory-cf-6xju).
    const sessionLogin = session.ok ? session.login : null;
    const subject = isRoot ? (url.searchParams.get("subject") ?? "__root__") : (sessionLogin ?? "__root__");
    if (!env.CREDENTIAL_BROKER) {
      return Response.json({ ok: true, passkeys: [] });
    }
    const broker = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName("default"));
    const res = await broker.fetch(`https://credential-broker.internal/passkeys?subject=${encodeURIComponent(subject)}`);
    const data = await res.json();
    return Response.json(data);
  }

  // 6. DELETE /api/auth/passkeys
  if (url.pathname === "/api/auth/passkeys" && request.method === "DELETE") {
    const session = await readSession(request.headers, signingKey);
    const controlKey = request.headers.get("x-factory-control-key");
    const isRoot = Boolean(
      (controlKey && env.BROKER_CONTROL_KEY && (await sameSecret(env.BROKER_CONTROL_KEY, controlKey))) ||
      (session.ok && session.login === "__root__"),
    );

    if (!session.ok && !isRoot) {
      return Response.json({ ok: false, error: "Authentication required" }, { status: 401 });
    }

    const id = url.searchParams.get("id");
    if (!id) {
      return Response.json({ ok: false, error: "Missing passkey id parameter" }, { status: 400 });
    }

    const subject = isRoot ? undefined : (session.ok ? session.login : undefined);
    if (!env.CREDENTIAL_BROKER) {
      return Response.json({ ok: false, error: "CredentialBroker not available" }, { status: 503 });
    }
    const broker = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName("default"));
    const query = subject ? `?id=${encodeURIComponent(id)}&subject=${encodeURIComponent(subject)}` : `?id=${encodeURIComponent(id)}`;
    const res = await broker.fetch(`https://credential-broker.internal/passkeys${query}`, { method: "DELETE" });
    const data = await res.json();
    return Response.json(data);
  }

  return null;
}
