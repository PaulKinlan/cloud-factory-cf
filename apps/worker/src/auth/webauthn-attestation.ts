/**
 * Registration-side WebAuthn verification (cloud-factory-cf-evbe).
 *
 * The registration route used to take a client-supplied `credentialId` and `publicKeySpki`
 * on trust: it never looked at the attestation object, so nothing tied the stored key to this
 * relying party, to a user-presence check, or even to the credential id it was filed under.
 * This module reads what the authenticator actually returned.
 *
 * SCOPE, stated rather than implied: this verifies the AUTHENTICATOR DATA - the rpId hash, the
 * user-presence and attested-credential-data flags, and that the credential id and public key
 * in it are the ones being registered. It does NOT verify an attestation STATEMENT: the
 * options request asks for attestation "none", and with that format there is no statement to
 * verify. Proving an authenticator physically made the credential needs a real attestation
 * format plus a trust anchor, which is a deployment policy decision, not a parsing one.
 */

/** The subset of CBOR an attestation object uses: ints, byte/text strings, arrays, maps, bools. */
class CborReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  read(): unknown {
    const initial = this.byte();
    const major = initial >> 5;
    const minor = initial & 0x1f;
    switch (major) {
      case 0:
        return this.length(minor);
      case 1:
        return -1 - this.length(minor);
      case 2: {
        const length = this.length(minor);
        const value = this.bytes.slice(this.offset, this.offset + length);
        this.offset += length;
        return value;
      }
      case 3: {
        const length = this.length(minor);
        const value = new TextDecoder().decode(this.bytes.slice(this.offset, this.offset + length));
        this.offset += length;
        return value;
      }
      case 4: {
        const length = this.length(minor);
        return Array.from({ length }, () => this.read());
      }
      case 5: {
        const length = this.length(minor);
        const map = new Map<unknown, unknown>();
        for (let i = 0; i < length; i += 1) {
          const key = this.read();
          map.set(key, this.read());
        }
        return map;
      }
      case 7:
        if (minor === 20) return false;
        if (minor === 21) return true;
        if (minor === 22) return null;
        throw new Error(`unsupported CBOR simple value ${minor}`);
      default:
        throw new Error(`unsupported CBOR major type ${major}`);
    }
  }

  private byte(): number {
    if (this.offset >= this.bytes.length) throw new Error("truncated CBOR");
    return this.bytes[this.offset++]!;
  }

  private length(minor: number): number {
    if (minor < 24) return minor;
    if (minor === 24) return this.byte();
    if (minor === 25) {
      const value = (this.byte() << 8) | this.byte();
      return value;
    }
    if (minor === 26) {
      return ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0;
    }
    throw new Error(`unsupported CBOR length encoding ${minor}`);
  }
}

export interface AttestedCredential {
  /** Credential id the authenticator says it created, base64url. */
  credentialId: string;
  /** SPKI DER for the public key inside the authenticator data, base64url. */
  publicKeySpki: string;
  /** COSE algorithm identifier (-7 ES256, -257 RS256). */
  algorithm: number;
  signCount: number;
}

export interface VerifyRegistrationInput {
  attestationObject: string;
  expectedRpId: string;
  expectedCredentialId: string;
  /** When true, the authenticator data must also report that the user was verified (cloud-factory-cf-l28o). */
  requireUserVerification?: boolean;
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...parts: Array<Uint8Array>): Uint8Array {
  const body = concat(...parts);
  return concat(new Uint8Array([tag]), derLength(body.length), body);
}

function concat(...parts: Array<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const OID_EC_PUBLIC_KEY = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
const OID_P256 = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
const OID_RSA_ENCRYPTION = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);

/** Minimal CBOR decode of a COSE key, then DER for `crypto.subtle.importKey("spki", ...)`. */
function coseToSpki(key: Map<unknown, unknown>): { spki: Uint8Array; algorithm: number } {
  const kty = Number(key.get(1));
  const alg = Number(key.get(3));
  if (kty === 2) {
    // EC2: only P-256 is accepted, which is what a "none"/default registration produces.
    const crv = Number(key.get(-1));
    if (crv !== 1) throw new Error(`unsupported EC curve ${crv}`);
    const x = key.get(-2);
    const y = key.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
      throw new Error("malformed EC public key coordinates");
    }
    if (alg !== -7) throw new Error(`EC key with unsupported algorithm ${alg}`);
    const algorithmId = der(0x30, der(0x06, OID_EC_PUBLIC_KEY), der(0x06, OID_P256));
    const point = concat(new Uint8Array([0x04]), x, y);
    const spki = der(0x30, algorithmId, der(0x03, new Uint8Array([0x00]), point));
    return { spki, algorithm: -7 };
  }
  if (kty === 3) {
    const n = key.get(-1);
    const e = key.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) throw new Error("malformed RSA public key");
    if (alg !== -257) throw new Error(`RSA key with unsupported algorithm ${alg}`);
    const unsigned = (bytes: Uint8Array) => {
      // DER INTEGER is signed: a leading byte >= 0x80 needs a 0x00 pad, and leading zeroes go.
      let start = 0;
      while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
      const trimmed = bytes.slice(start);
      const body = trimmed[0]! >= 0x80 ? concat(new Uint8Array([0x00]), trimmed) : trimmed;
      return der(0x02, body);
    };
    const rsaKey = der(0x30, unsigned(n), unsigned(e));
    // SubjectPublicKeyInfo's AlgorithmIdentifier for RSA is rsaEncryption WITH NULL
    // parameters. Encoding sha256WithRSAEncryption here as well produced a structure the
    // runtime refuses with "DataError Invalid keyData" - a registration that verified and then
    // could never authenticate (cloud-factory-cf-4m44, found by review).
    const algorithmId = der(0x30, der(0x06, OID_RSA_ENCRYPTION), new Uint8Array([0x05, 0x00]));
    const spki = der(0x30, algorithmId, der(0x03, new Uint8Array([0x00]), rsaKey));
    return { spki, algorithm: -257 };
  }
  throw new Error(`unsupported COSE key type ${kty}`);
}


/** Imports the derived key with the algorithm the assertion path will use, or throws. */
async function assertVerificationKey(spki: Uint8Array, algorithm: number): Promise<void> {
  const params =
    algorithm === -7
      ? { name: "ECDSA", namedCurve: "P-256" }
      : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  try {
    // Copy into a fresh buffer: the view may be a slice of a larger ArrayBuffer, and the
    // runtime's BufferSource typing wants the plain buffer.
    await crypto.subtle.importKey("spki", new Uint8Array(spki).buffer, params, false, ["verify"]);
  } catch {
    throw new Error("credential public key is not an importable verification key");
  }
}

/**
 * Verifies the registration response and returns the credential the authenticator attested.
 * Throws with a caller-facing message when anything does not line up.
 */
export async function verifyRegistrationAttestation(
  input: VerifyRegistrationInput,
): Promise<AttestedCredential> {
  const object = new CborReader(base64UrlToBytes(input.attestationObject)).read();
  if (!(object instanceof Map)) throw new Error("attestation object is not a CBOR map");
  const authData = object.get("authData");
  if (!(authData instanceof Uint8Array)) throw new Error("attestation object has no authData");

  // rpIdHash(32) | flags(1) | signCount(4) | [attested credential data when AT is set]
  if (authData.length < 37) throw new Error("authenticator data too short");

  const expectedRpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.expectedRpId)),
  );
  for (let i = 0; i < 32; i += 1) {
    if (authData[i] !== expectedRpIdHash[i]) throw new Error("RP ID hash mismatch");
  }

  const flags = authData[32]!;
  if ((flags & 0x01) === 0) throw new Error("user presence flag not set");
  // UV is enforced only when the challenge was issued asking for it: "preferred" lets the
  // authenticator skip it, and demanding it anyway would reject honest registrations from
  // security keys that have no PIN (cloud-factory-cf-l28o).
  if (input.requireUserVerification && (flags & 0x04) === 0) {
    throw new Error("user verification required but not performed");
  }
  // Bit 0x40 says attested credential data follows; without it there is no key to register.
  if ((flags & 0x40) === 0) throw new Error("no attested credential data in the registration");

  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  const signCount = view.getUint32(33);
  let offset = 37 + 16; // rpIdHash + flags + signCount, then the AAGUID

  if (authData.length < offset + 2) throw new Error("authenticator data truncated before the credential id");
  const credentialIdLength = view.getUint16(offset);
  offset += 2;
  if (authData.length < offset + credentialIdLength) {
    throw new Error("authenticator data truncated inside the credential id");
  }
  const credentialId = authData.slice(offset, offset + credentialIdLength);
  offset += credentialIdLength;

  if (bytesToBase64Url(credentialId) !== input.expectedCredentialId.replace(/=+$/, "")) {
    throw new Error("credential id does not match the one in the authenticator data");
  }

  const publicKeyCose = new CborReader(authData.slice(offset)).read();
  if (!(publicKeyCose instanceof Map)) throw new Error("credential public key is not a COSE map");
  const { spki, algorithm } = coseToSpki(publicKeyCose);

  // The key must be importable AS A VERIFICATION KEY, not merely well-formed DER. An
  // off-curve P-256 point (x=y=0 passes every structural check) imports as nothing, so a
  // registration could be accepted here and then fail every login at passkey.ts - the old
  // route imported the SPKI before persisting and the rewrite dropped that
  // (cloud-factory-cf-7mzy, found by review). Importing it here is the only check that
  // exercises the same primitive the assertion path will use.
  await assertVerificationKey(spki, algorithm);

  return { credentialId: bytesToBase64Url(credentialId), publicKeySpki: bytesToBase64Url(spki), algorithm, signCount };
}
