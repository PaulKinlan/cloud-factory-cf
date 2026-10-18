const encoder = new TextEncoder();

/** Signs a webhook body exactly the way GitHub does (`X-Hub-Signature-256`). */
export async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `sha256=${toHex(signature)}`;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export const TEST_SECRET = "test-webhook-secret";

export function pushPayload(deliveryId: string, repository = "acme/widgets") {
  return JSON.stringify({
    action: "opened",
    number: 7,
    delivery: deliveryId,
    repository: { full_name: repository },
  });
}
