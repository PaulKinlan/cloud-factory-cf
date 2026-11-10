/**
 * Builds a registration attestation object the way an authenticator does, so the verifier can
 * be tested on data with the right shape rather than on data invented to suit the parser
 * (cloud-factory-cf-evbe). CBOR is encoded by hand: the subset an attestation object needs is
 * small, and a test fixture that depends on the same code it is testing proves less.
 */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

function uint(value: number): Uint8Array {
  if (value < 24) return new Uint8Array([value]);
  if (value < 256) return new Uint8Array([0x18, value]);
  if (value < 65536) return new Uint8Array([0x19, value >> 8, value & 0xff]);
  return new Uint8Array([0x1a, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function cborUint(value: number): Uint8Array {
  // CBOR majors: 0 for a non-negative integer, 1 for a negative one whose ARGUMENT is (-1-value)
  // - so -1 is the single byte 0x20, not 0x20 followed by an argument byte. Encoding the
  // argument separately shifted every following key by one, which the verifier then refused
  // (correctly) as a COSE key it could not read.
  if (value >= 0) return uint(value);
  // For a negative integer the ARGUMENT is (-1 - value) and the header carries its WIDTH:
  // -257 is 0x39 0x01 0x00 (2-byte argument), not 0x38 followed by a separately encoded
  // number. Writing it the second way made the verifier read -26 and then treat the remaining
  // bytes as further map keys.
  const arg = -1 - value;
  if (arg < 24) return new Uint8Array([0x20 | arg]);
  if (arg < 256) return new Uint8Array([0x38, arg]);
  if (arg < 65536) return new Uint8Array([0x39, (arg >> 8) & 0xff, arg & 0xff]);
  return new Uint8Array([0x3a, (arg >>> 24) & 0xff, (arg >>> 16) & 0xff, (arg >>> 8) & 0xff, arg & 0xff]);
}
function cborByteString(bytes: Uint8Array): Uint8Array {
  // 0x58 carries ONE length byte, so it stops at 255; a 2048-bit RSA modulus is 256 bytes and
  // needs 0x59 with a two-byte length. Encoding it with 0x58 truncated the length and shifted
  // the rest of the key - the verifier then read kty 0 and refused the whole attestation.
  if (bytes.length < 24) return concat(new Uint8Array([0x40 | bytes.length]), bytes);
  if (bytes.length < 256) return concat(new Uint8Array([0x58, bytes.length]), bytes);
  return concat(new Uint8Array([0x59, (bytes.length >> 8) & 0xff, bytes.length & 0xff]), bytes);
}
function cborText(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  return bytes.length < 24
    ? concat(new Uint8Array([0x60 | bytes.length]), bytes)
    : concat(new Uint8Array([0x78, bytes.length]), bytes);
}
function cborMap(entries: Array<[Uint8Array, Uint8Array]>): Uint8Array {
  // The map header is a major-type byte, not a number encoded by uint(): uint(0x83) would emit
  // 0x18 0x83 (the integer 131) and the verifier would rightly refuse the fixture.
  if (entries.length >= 24) throw new Error("test maps are small");
  // 0xa0 is CBOR map; 0x80 would be an ARRAY, which the verifier refused - correctly.
  return concat(new Uint8Array([0xa0 | entries.length]), ...entries.flatMap(([key, value]) => [key, value]));
}

/** Extracts the raw P-256 coordinates from an SPKI DER, so a COSE key can be built from it. */
export function coseKeyFromSpki(spki: Uint8Array): Uint8Array {
  const point = spki.slice(spki.length - 65);
  if (point[0] !== 0x04) throw new Error("test key is not an uncompressed P-256 point");
  return cborMap([
    [cborUint(1), cborUint(2)], // kty: EC2
    [cborUint(3), cborUint(-7)], // alg: ES256
    [cborUint(-1), cborUint(1)], // crv: P-256
    [cborUint(-2), cborByteString(point.slice(1, 33))],
    [cborUint(-3), cborByteString(point.slice(33, 65))],
  ]);
}

export interface AttestationOptions {
  rpId: string;
  credentialId: Uint8Array;
  /**
   * An explicit COSE key, for the cases that have to build a key the helpers would never
   * produce - an off-curve P-256 point, for instance. Takes precedence over `spki`.
   */
  coseKey?: Uint8Array;
  /** Defaults to UP|AT (0x41): user present, attested credential data included. */
  flags?: number;
  signCount?: number;
  spki?: Uint8Array;
  /** Override the rpId hash, to build the mismatch case. */
  rpIdHash?: Uint8Array;
}

export async function buildAttestationObject(options: AttestationOptions): Promise<string> {
  const rpIdHash =
    options.rpIdHash ?? new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(options.rpId)));
  const signCount = options.signCount ?? 0;
  const counter = new Uint8Array([
    (signCount >>> 24) & 0xff,
    (signCount >>> 16) & 0xff,
    (signCount >>> 8) & 0xff,
    signCount & 0xff,
  ]);
  const aaguid = new Uint8Array(16);
  const credentialIdLength = new Uint8Array([(options.credentialId.length >> 8) & 0xff, options.credentialId.length & 0xff]);
  const authData = concat(
    rpIdHash,
    new Uint8Array([options.flags ?? 0x41]),
    counter,
    aaguid,
    credentialIdLength,
    options.credentialId,
    options.coseKey ?? coseKeyFromSpki(options.spki!),
  );
  const attestationObject = cborMap([
    [cborText("fmt"), cborText("none")],
    [cborText("attStmt"), cborMap([])],
    [cborText("authData"), cborByteString(authData)],
  ]);
  return base64Url(attestationObject);
}

/** A fresh ES256 key pair in the shapes the verifier deals with. */
export async function es256KeyPair(): Promise<{ spki: Uint8Array; spkiBase64Url: string; credentialId: Uint8Array }> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  const credentialId = new Uint8Array(16).map(() => Math.floor(Math.random() * 256));
  return { spki, spkiBase64Url: base64Url(spki), credentialId };
}

export { base64Url };

/** COSE key for an RSA public key, from its JWK: kty=3, alg=-257, n and e. */
export async function coseKeyFromRsaKey(key: CryptoKey): Promise<Uint8Array> {
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as { n?: string; e?: string };
  if (!jwk.n || !jwk.e) throw new Error("RSA test key did not export a modulus and exponent");
  const decode = (value: string) => {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
  return cborMap([
    [cborUint(1), cborUint(3)],
    [cborUint(3), cborUint(-257)],
    [cborUint(-1), cborByteString(decode(jwk.n))],
    [cborUint(-2), cborByteString(decode(jwk.e))],
  ]);
}

/** A fresh RS256 key pair, plus a credential id, for the RSA path. */
export async function rsaKeyPair(): Promise<{ spkiBase64Url: string; coseKey: Uint8Array; credentialId: Uint8Array }> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  const credentialId = new Uint8Array(16).map(() => Math.floor(Math.random() * 256));
  return { spkiBase64Url: base64Url(spki), coseKey: await coseKeyFromRsaKey(keyPair.publicKey), credentialId };
}
