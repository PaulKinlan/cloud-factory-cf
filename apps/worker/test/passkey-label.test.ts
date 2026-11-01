import { describe, expect, it } from "vitest";
import { MAX_PASSKEY_LABEL_LENGTH, sanitizePasskeyLabel } from "../src/auth/passkey";

/**
 * A passkey label is operator-supplied display text: it is stored in the broker and shown
 * in the admin passkey tables. It must never be a document, and it must never be unbounded
 * (cloud-factory-cf-khnm). The renderer is the primary defence - it sets `textContent`, so
 * markup is shown rather than parsed - and this is the second one: what we store is
 * single-line, control-character free and capped.
 */
const FALLBACK = "Passkey (1/11/2026)";

describe("passkey label sanitisation", () => {
  it("keeps an ordinary label as it is", () => {
    expect(sanitizePasskeyLabel("Mac Touch ID", FALLBACK)).toBe("Mac Touch ID");
  });

  it("falls back when the label is missing, empty or not a string", () => {
    expect(sanitizePasskeyLabel(undefined, FALLBACK)).toBe(FALLBACK);
    expect(sanitizePasskeyLabel(null, FALLBACK)).toBe(FALLBACK);
    expect(sanitizePasskeyLabel(42, FALLBACK)).toBe(FALLBACK);
    expect(sanitizePasskeyLabel({}, FALLBACK)).toBe(FALLBACK);
    expect(sanitizePasskeyLabel("   ", FALLBACK)).toBe(FALLBACK);
  });

  it("collapses control characters and newlines instead of storing them", () => {
    expect(sanitizePasskeyLabel("work\nlaptop", FALLBACK)).toBe("work laptop");
    expect(sanitizePasskeyLabel("a\u0000b\u009fc", FALLBACK)).toBe("a b c");
    expect(sanitizePasskeyLabel("  spaced \t out  ", FALLBACK)).toBe("spaced out");
  });

  it("caps a long label", () => {
    const label = sanitizePasskeyLabel("x".repeat(500), FALLBACK);
    expect(label).toHaveLength(MAX_PASSKEY_LABEL_LENGTH);
  });

  it("does not strip markup characters - the renderer is what makes them text", () => {
    // Keeping `<` and `>` means a label like "a<b" is not silently rewritten; the admin
    // table sets the value with textContent, so it is shown literally and never parsed.
    expect(sanitizePasskeyLabel("<img src=x onerror=alert(1)>", FALLBACK)).toBe(
      "<img src=x onerror=alert(1)>",
    );
  });
});
