/**
 * GitHub App authentication helpers: PEM parsing and RS256 App JWT minting.
 * Uses native Web Crypto (crypto.subtle) without external dependencies.
 */

function wrapPkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  // AlgorithmIdentifier for rsaEncryption: 1.2.840.113549.1.1.1
  const algorithmIdentifier = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  // Version: INTEGER 0
  const version = new Uint8Array([0x02, 0x01, 0x00]);

  function encodeLength(len: number): Uint8Array {
    if (len < 128) return new Uint8Array([len]);
    const bytes: number[] = [];
    let temp = len;
    while (temp > 0) {
      bytes.unshift(temp & 0xff);
      temp >>= 8;
    }
    return new Uint8Array([0x80 | bytes.length, ...bytes]);
  }

  const octetLen = encodeLength(pkcs1.length);
  const octetString = new Uint8Array(1 + octetLen.length + pkcs1.length);
  octetString[0] = 0x04;
  octetString.set(octetLen, 1);
  octetString.set(pkcs1, 1 + octetLen.length);

  const totalContentLen = version.length + algorithmIdentifier.length + octetString.length;
  const seqLen = encodeLength(totalContentLen);

  const pkcs8 = new Uint8Array(1 + seqLen.length + totalContentLen);
  pkcs8[0] = 0x30;
  pkcs8.set(seqLen, 1);
  let offset = 1 + seqLen.length;
  pkcs8.set(version, offset);
  offset += version.length;
  pkcs8.set(algorithmIdentifier, offset);
  offset += algorithmIdentifier.length;
  pkcs8.set(octetString, offset);

  return pkcs8;
}

export function pemToPkcs8Der(pem: string): Uint8Array {
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "")
    .replace(/-----END [A-Z ]*PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return isPkcs1 ? wrapPkcs1ToPkcs8(bytes) : bytes;
}

export async function importAppPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemToPkcs8Der(pem);
  // Copy into a plain Uint8Array<ArrayBuffer>: `der.buffer` is ArrayBufferLike, and
  // the `pkcs8` overload of importKey wants a BufferSource (not a SharedArrayBuffer).
  const keyData = new Uint8Array(der.length);
  keyData.set(der);
  return await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64UrlEncode(data: Uint8Array | string): string {
  const binary = typeof data === "string" ? data : String.fromCharCode(...data);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function mintAppJwt(appId: string | number, privateKey: CryptoKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 10 * 60,
    iss: String(appId),
  };

  const encHeader = base64UrlEncode(JSON.stringify(header));
  const encPayload = base64UrlEncode(JSON.stringify(payload));
  const message = new TextEncoder().encode(`${encHeader}.${encPayload}`);

  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, message);
  const encSignature = base64UrlEncode(new Uint8Array(signature));

  return `${encHeader}.${encPayload}.${encSignature}`;
}
