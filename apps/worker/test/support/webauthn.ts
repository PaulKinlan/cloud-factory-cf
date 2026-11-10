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
  if (-1 - value < 24) return new Uint8Array([0x20 | (-1 - value)]);
  return concat(new Uint8Array([0x38]), uint(-1 - value));
}
function cborByteString(bytes: Uint8Array): Uint8Array {
  return bytes.length < 24
    ? concat(new Uint8Array([0x40 | bytes.length]), bytes)
    : concat(new Uint8Array([0x58, bytes.length]), bytes);
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
  /** Defaults to UP|AT (0x41): user present, attested credential data included. */
  flags?: number;
  signCount?: number;
  spki: Uint8Array;
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
    coseKeyFromSpki(options.spki),
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
