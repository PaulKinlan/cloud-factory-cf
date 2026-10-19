import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPABILITY_TTL_SECONDS,
  MAX_CAPABILITY_TTL_SECONDS,
  issueCapability,
  verifyCapability,
} from "../src/credentials/capability";

const SIGNING_KEY = "unit-signing-key";

describe("capability tokens", () => {
  it("round-trips the exact scope it was issued for", async () => {
    const token = await issueCapability(SIGNING_KEY, {
      sub: "agent-1",
      repo: "acme/widgets",
      service: "github",
      action: "issue.comment",
    }, { ttlSeconds: 60, now: 1_000 });

    const verified = await verifyCapability(SIGNING_KEY, token, { now: 1_030 });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims).toMatchObject({
      sub: "agent-1",
      repo: "acme/widgets",
      service: "github",
      action: "issue.comment",
      iat: 1_000,
      exp: 1_060,
    });
    expect(verified.claims.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects a tampered payload and a token signed with another key", async () => {
    const token = await issueCapability(SIGNING_KEY, {
      sub: "agent-1",
      repo: "acme/widgets",
      service: "github",
      action: "repo.read",
    }, { now: 2_000 });

    const [payload, signature] = token.split(".");
    const claims = JSON.parse(atob((payload as string).replaceAll("-", "+").replaceAll("_", "/")));
    claims.action = "issue.comment";
    const forgedPayload = btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

    await expect(verifyCapability(SIGNING_KEY, `${forgedPayload}.${signature}`, { now: 2_010 })).resolves.toEqual({
      ok: false,
      reason: "signature",
    });
    await expect(verifyCapability("another-key", token, { now: 2_010 })).resolves.toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("expires, refuses future-minted tokens, and rejects malformed input", async () => {
    const token = await issueCapability(SIGNING_KEY, {
      sub: "agent-1",
      repo: "acme/widgets",
      service: "github",
      action: "repo.read",
    }, { ttlSeconds: 10, now: 5_000 });

    await expect(verifyCapability(SIGNING_KEY, token, { now: 5_009 })).resolves.toMatchObject({ ok: true });
    await expect(verifyCapability(SIGNING_KEY, token, { now: 5_011 })).resolves.toEqual({
      ok: false,
      reason: "expired",
    });

    const future = await issueCapability(SIGNING_KEY, {
      sub: "agent-1",
      repo: "acme/widgets",
      service: "github",
      action: "repo.read",
    }, { now: 9_000 });
    await expect(verifyCapability(SIGNING_KEY, future, { now: 8_000 })).resolves.toEqual({
      ok: false,
      reason: "not-yet-valid",
    });

    for (const bad of ["", "no-dot", "a.", ".b", "!!!.???", "a.b.c"]) {
      const result = await verifyCapability(SIGNING_KEY, bad, { now: 1 });
      expect(result.ok).toBe(false);
    }
  });

  it("clamps the TTL to a short window so a leaked token ages out", async () => {
    const dflt = await issueCapability(SIGNING_KEY, {
      sub: "a", repo: "acme/widgets", service: "github", action: "repo.read",
    }, { now: 0 });
    const defaultClaims = await verifyCapability(SIGNING_KEY, dflt, { now: 0 });
    expect(defaultClaims.ok && defaultClaims.claims.exp).toBe(DEFAULT_CAPABILITY_TTL_SECONDS);

    const long = await issueCapability(SIGNING_KEY, {
      sub: "a", repo: "acme/widgets", service: "github", action: "repo.read",
    }, { ttlSeconds: 999_999, now: 0 });
    const longClaims = await verifyCapability(SIGNING_KEY, long, { now: 0 });
    expect(longClaims.ok && longClaims.claims.exp).toBe(MAX_CAPABILITY_TTL_SECONDS);
  });

  it("never embeds a credential-shaped value in the token", async () => {
    const token = await issueCapability(SIGNING_KEY, {
      sub: "agent-1",
      repo: "acme/widgets",
      service: "github",
      action: "repo.read",
    }, { now: 1_000 });
    // A capability names the action, not the secret: the token is only the
    // payload + signature, and the payload has no field for a credential.
    const decoded = atob(token.split(".")[0]!.replaceAll("-", "+").replaceAll("_", "/"));
    expect(Object.keys(JSON.parse(decoded)).sort()).toEqual(
      ["action", "exp", "iat", "jti", "repo", "service", "sub"],
    );
  });
});
