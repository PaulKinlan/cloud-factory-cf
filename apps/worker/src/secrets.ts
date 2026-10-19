/** Constant-time-ish comparison of a shared secret header. */
export async function sameSecret(expected: string, provided: string | null): Promise<boolean> {
  if (!provided || provided.length === 0) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) {
    difference |= (left[i] as number) ^ (right[i] as number);
  }
  return difference === 0;
}
