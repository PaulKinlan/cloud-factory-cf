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
