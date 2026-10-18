const encoder = new TextEncoder();

/**
 * Verifies a GitHub-style `X-Hub-Signature-256` header (`sha256=<hex>`) against
 * the raw request body. Uses WebCrypto verify, so the comparison is constant
 * time and no secret ever leaves the isolate unhashed.
 */
export async function verifyHmacSha256(
  secret: string,
  body: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader) return false;

  const separator = signatureHeader.indexOf("=");
  if (separator === -1) return false;

  const scheme = signatureHeader.slice(0, separator);
  const hex = signatureHeader.slice(separator + 1);
  if (scheme !== "sha256" || hex.length !== 64) return false;

  const signature = hexToBytes(hex);
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(body));
}

function hexToBytes(hex: string): Uint8Array | null {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    bytes[i] = byte;
  }
  return bytes;
}
