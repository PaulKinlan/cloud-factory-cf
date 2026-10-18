/**
 * Dual-runtime ID generation: uses Web Crypto API (supported natively in
 * Cloudflare Workers, Durable Objects, browsers, and Node 19+) without
 * forcing node:crypto or nodejs_compat.
 */

export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
