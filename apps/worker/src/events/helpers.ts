export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export function safeParseJson(value: string, fallback: unknown = null): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Reads a request body, refusing to buffer more than `limit` bytes.
 *
 * Every webhook body has to be read in full before its HMAC can be checked, so the
 * buffer is unavoidable for a legitimate delivery - but the body arrives *before*
 * anything is authenticated, and `await request.text()` reads all of it however large
 * it is. A chunked request sends no `content-length` to refuse up front, so the cap has
 * to be enforced while reading: stop at the first chunk that crosses the limit and
 * cancel the stream rather than draining it (cloud-factory-cf-v0xd).
 *
 * Returns the decoded body, or null when the limit was exceeded.
 */
export async function readBodyWithinLimit(request: Request, limit: number): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // The signature is computed over the bytes as sent; decoding once at the end keeps
  // the string identical to `await request.text()` for any valid UTF-8 body.
  return new TextDecoder().decode(merged);
}
