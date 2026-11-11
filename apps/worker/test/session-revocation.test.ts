import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken, verifySessionToken } from "../src/auth/sessions";
import { brokerInternalHeaders } from "../src/auth/delegation";

/**
 * Session revocation (cloud-factory-cf-2lbm).
 *
 * `cf_session` is a stateless HMAC token. Before this, nothing could un-issue one:
 * `POST /api/auth/logout` only cleared the caller's cookie, so a copied token stayed
 * valid for its full 8 hours, and deleting a passkey — the "I lost that device" lever —
 * revoked nothing. These tests pin the deny list that fixes it:
 *
 * - the token carries a per-session id (`sid`) and an issued-at (`iat`);
 * - `readSession` consults the deployment's revocation list on every read;
 * - logout revokes that session, passkey deletion revokes every session its owner holds,
 *   and an operator can revoke every session for a login.
 *
 * Every test uses its own login so the shared deny list never leaks between them.
 */

const SIGNING_KEY = "test-broker-signing-key"; // BROKER_SIGNING_KEY in vitest.config.ts
const CONTROL_KEY = "test-control-key"; // BROKER_CONTROL_KEY in vitest.config.ts
const AUDIT = (owner: string) => `/audit/events/${owner}/widget-service`;

async function call(path: string, init: RequestInit = {}, bindings: unknown = env): Promise<Response> {
  const handler = await import("../src/index").then((m) => m.default);
  return handler.fetch(new Request(`https://factory.example${path}`, init), bindings as never);
}

const cookie = (token: string) => ({ cookie: `cf_session=${token}` });

async function isAuthenticated(token: string, bindings: unknown = env): Promise<boolean> {
  const res = await call("/api/auth/session", { headers: cookie(token) }, bindings);
  const body = (await res.json()) as { authenticated: boolean };
  return body.authenticated;
}

/** Puts a passkey credential straight into the broker, as registration would. */
async function putPasskey(credentialId: string, subject: string): Promise<void> {
  const broker = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName("default"));
  const res = await broker.fetch("https://credential-broker.internal/passkeys", {
    method: "POST",
    headers: await brokerInternalHeaders(env, "default", { "content-type": "application/json" }),
    body: JSON.stringify({
      credentialId,
      subject,
      role: "user",
      publicKeySpki: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE",
      algorithm: -7,
      label: "test key",
    }),
  });
  expect(res.ok).toBe(true);
}

describe("session token shape (cloud-factory-cf-2lbm)", () => {
  it("mints a token that carries a revocable per-session id, and verifies it", async () => {
    const token = await mintSessionToken(SIGNING_KEY, "octodev");
    const claims = await verifySessionToken(token, SIGNING_KEY);
    expect(claims?.login).toBe("octodev");
    expect(claims?.sid).toMatch(/^[0-9a-f]{32}$/);
    // Every mint is a distinct session, so a logout cannot take out its siblings.
    expect((await mintSessionToken(SIGNING_KEY, "octodev"))).not.toBe(token);
  });

  it("rejects the pre-revocation three-part cookie — it carries no sid to revoke", async () => {
    const exp = Math.floor(Date.now() / 1000) + 900;
    const payload = `octodev.${exp}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SIGNING_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = Array.from(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    // Correctly signed, still refused: accepting it would leave an unrevocable token
    // valid for the rest of its TTL.
    expect(await verifySessionToken(`${payload}.${sig}`, SIGNING_KEY)).toBeNull();
  });

  it("refuses a token whose sid was swapped (the sid is inside the signature)", async () => {
    const token = await mintSessionToken(SIGNING_KEY, "octodev");
    const parts = token.split(".");
    parts[3] = "f".repeat(32);
    expect(await verifySessionToken(parts.join("."), SIGNING_KEY)).toBeNull();
  });

  it("refuses an expired token and one issued in the future", async () => {
    expect(
      await verifySessionToken(await mintSessionToken(SIGNING_KEY, "octodev", Date.now() - 9 * 3600 * 1000), SIGNING_KEY),
    ).toBeNull();
    expect(
      await verifySessionToken(await mintSessionToken(SIGNING_KEY, "octodev", Date.now() + 3600 * 1000), SIGNING_KEY),
    ).toBeNull();
  });
});

describe("revoking a session (cloud-factory-cf-2lbm)", () => {
  it("makes a logged-out token useless for the rest of its TTL, but not its siblings", async () => {
    const revokedToken = await mintSessionToken(SIGNING_KEY, "logout-user");
    const sibling = await mintSessionToken(SIGNING_KEY, "logout-user");
    expect(await isAuthenticated(revokedToken)).toBe(true);

    const res = await call("/api/auth/logout", { method: "POST", headers: cookie(revokedToken) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revoked: boolean }).revoked).toBe(true);
    expect(res.headers.get("set-cookie") ?? "").toContain("cf_session=;");

    // The token that was logged out is dead everywhere it could be replayed, not just
    // in the browser that dropped the cookie.
    expect(await isAuthenticated(revokedToken)).toBe(false);
    expect(await isAuthenticated(sibling)).toBe(true);
    expect((await call(AUDIT("logout-user"), { headers: cookie(revokedToken) })).status).toBe(401);
  });

  it("revokes every session for the login when logout is asked to sign out everywhere", async () => {
    const first = await mintSessionToken(SIGNING_KEY, "everywhere-user");
    const second = await mintSessionToken(SIGNING_KEY, "everywhere-user");

    const res = await call("/api/auth/logout?all=1", { method: "POST", headers: cookie(first) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { all: boolean }).all).toBe(true);

    expect(await isAuthenticated(first)).toBe(false);
    expect(await isAuthenticated(second)).toBe(false);
  });

  it("signs out a browser that still holds the pre-__Host- cookie too (cloud-factory-cf-7by9)", async () => {
    // readSession accepts both names, so a browser can hold both: the plain one from
    // before the prefix existed, the prefixed one from after. Clearing and revoking only
    // the name this origin mints today left the other one signing it straight back in.
    const recent = await mintSessionToken(SIGNING_KEY, "dual-cookie-user");
    const legacy = await mintSessionToken(SIGNING_KEY, "dual-cookie-user");

    const res = await call("/api/auth/logout", {
      method: "POST",
      headers: { cookie: `__Host-cf_session=${recent}; cf_session=${legacy}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revoked: boolean }).revoked).toBe(true);

    // Both cookies are cleared...
    const cleared = res.headers.get("set-cookie") ?? "";
    expect(cleared).toContain("__Host-cf_session=;");
    expect(cleared).toContain("cf_session=;");

    // ...and both tokens are denied, so neither can be replayed or left in the browser.
    expect(await isAuthenticated(recent)).toBe(false);
    expect(await isAuthenticated(legacy)).toBe(false);
  });

  it("clears the cookie even when the token is already invalid, and revokes nothing", async () => {
    const res = await call("/api/auth/logout", {
      method: "POST",
      headers: { cookie: "cf_session=not-a-token" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revoked: boolean }).revoked).toBe(false);
    expect(res.headers.get("set-cookie") ?? "").toContain("cf_session=;");
  });

  it("lets an operator revoke every session for a login after removing it from the allowlist", async () => {
    const target = await mintSessionToken(SIGNING_KEY, "removed-user");
    const bystander = await mintSessionToken(SIGNING_KEY, "kept-user");

    // No credential at all, or a browser session that is not root: refused.
    expect(
      (await call("/api/auth/sessions/revoke", { method: "POST", body: JSON.stringify({ login: "removed-user" }) }))
        .status,
    ).toBe(401);
    expect(
      (
        await call("/api/auth/sessions/revoke", {
          method: "POST",
          headers: { ...cookie(target), "content-type": "application/json" },
          body: JSON.stringify({ login: "kept-user" }),
        })
      ).status,
    ).toBe(401);

    const res = await call("/api/auth/sessions/revoke", {
      method: "POST",
      headers: { "x-factory-control-key": CONTROL_KEY, "content-type": "application/json" },
      body: JSON.stringify({ login: "removed-user" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revoked: boolean }).revoked).toBe(true);

    expect(await isAuthenticated(target)).toBe(false);
    expect(await isAuthenticated(bystander)).toBe(true);
  });

  it("fails closed when the revocation store cannot be read", async () => {
    const token = await mintSessionToken(SIGNING_KEY, "broker-down-user");
    const brokenBindings = {
      ...env,
      CREDENTIAL_BROKER: {
        idFromName: () => "default",
        get: () => {
          throw new Error("broker unavailable");
        },
      },
    };
    // A deny list that cannot be read cannot be trusted.
    expect((await call(AUDIT("broker-down-user"), { headers: cookie(token) }, brokenBindings)).status).toBe(401);
  });

  it("keeps working when the deployment has no broker binding to revoke in", async () => {
    const token = await mintSessionToken(SIGNING_KEY, "no-broker-user");
    const bindings = { ...env, CREDENTIAL_BROKER: undefined };
    // Nothing can revoke anything there, so nothing is revoked — the documented cost of
    // running without the binding, not a silent hole in a configured deployment.
    expect(await isAuthenticated(token, bindings)).toBe(true);
  });
});

describe("revoking a passkey's sessions (cloud-factory-cf-2lbm)", () => {
  it("ends every session its owner holds, and leaves other logins alone", async () => {
    const owner = "passkey-owner";
    await putPasskey("pk-owner-1", owner);
    const current = await mintSessionToken(SIGNING_KEY, owner);
    const otherDevice = await mintSessionToken(SIGNING_KEY, owner);
    const bystander = await mintSessionToken(SIGNING_KEY, "passkey-bystander");

    const res = await call(`/api/auth/passkeys?id=pk-owner-1`, { method: "DELETE", headers: cookie(current) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; subject: string; sessionsRevoked: boolean; signedOut: boolean };
    expect(body.ok).toBe(true);
    expect(body.subject).toBe(owner);
    expect(body.sessionsRevoked).toBe(true);
    // The caller's own cookie is cleared rather than left to 401 on its next request.
    expect(body.signedOut).toBe(true);
    expect(res.headers.get("set-cookie") ?? "").toContain("cf_session=;");

    expect(await isAuthenticated(current)).toBe(false);
    expect(await isAuthenticated(otherDevice)).toBe(false);
    expect(await isAuthenticated(bystander)).toBe(true);
  });

  it("revokes the owner's sessions when root deletes someone else's passkey", async () => {
    await putPasskey("pk-someone-2", "passkey-target");
    const victim = await mintSessionToken(SIGNING_KEY, "passkey-target");
    const root = await mintSessionToken(SIGNING_KEY, "__root__");

    const res = await call("/api/auth/passkeys?id=pk-someone-2", { method: "DELETE", headers: cookie(root) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subject: string; signedOut: boolean };
    expect(body.subject).toBe("passkey-target");
    expect(body.signedOut).toBe(false);

    expect(await isAuthenticated(victim)).toBe(false);
    // Root's own session is a different login and survives.
    expect(await isAuthenticated(root)).toBe(true);
  });

  /**
   * A non-root caller must not be able to name someone else's credential
   * (cloud-factory-cf-plc4). The lookup that decides whose sessions to revoke is scoped to
   * the caller, and the answer is checked again before anything is revoked, so an id that
   * belongs to another account is simply "not found" here.
   */
  it("does not let one login revoke another login's sessions with their credential id", async () => {
    await putPasskey("pk-victim-9", "passkey-victim");
    const victimSession = await mintSessionToken(SIGNING_KEY, "passkey-victim");
    const attackerSession = await mintSessionToken(SIGNING_KEY, "passkey-attacker");

    const res = await call("/api/auth/passkeys?id=pk-victim-9", { method: "DELETE", headers: cookie(attackerSession) });
    expect(res.status).toBe(404);
    const body = (await res.text()).toLowerCase();
    // No disclosure that the credential exists, and no mention of the victim's login.
    expect(body).not.toContain("passkey-victim");

    // The victim's credential and every session it holds are untouched.
    expect(await isAuthenticated(victimSession)).toBe(true);
    const listed = await env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName("default")).fetch(
      "https://credential-broker.internal/passkeys?subject=passkey-victim",
      { headers: await brokerInternalHeaders(env, "default") },
    );
    const rows = (await listed.json()) as { passkeys?: Array<{ credentialId: string }> };
    expect(rows.passkeys?.map((row) => row.credentialId)).toContain("pk-victim-9");
    // The attacker's own session is untouched too (nothing happened to them either).
    expect(await isAuthenticated(attackerSession)).toBe(true);
  });

  it("scopes the broker's own lookup to id AND subject, so the owner check cannot be bypassed", async () => {
    await putPasskey("pk-scoped-10", "passkey-scoped-owner");
    const broker = env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName("default"));
    const headers = await brokerInternalHeaders(env, "default");

    // The root cause of plc4: with both parameters present the broker used to drop `subject`
    // and answer by id alone.
    const mismatched = await broker.fetch(
      "https://credential-broker.internal/passkeys?id=pk-scoped-10&subject=someone-else",
      { headers },
    );
    expect(((await mismatched.json()) as { passkeys?: unknown[] }).passkeys).toEqual([]);

    // And a scoped delete that matches nothing says so instead of answering ok:true.
    const noop = await broker.fetch(
      "https://credential-broker.internal/passkeys?id=pk-scoped-10&subject=someone-else",
      { method: "DELETE", headers: await brokerInternalHeaders(env, "default") },
    );
    const noopBody = (await noop.json()) as { ok: boolean; deletedCount: number };
    expect(noopBody.deletedCount).toBe(0);
    expect(noopBody.ok).toBe(false);

    const real = await broker.fetch("https://credential-broker.internal/passkeys?id=pk-scoped-10&subject=passkey-scoped-owner", {
      method: "DELETE",
      headers: await brokerInternalHeaders(env, "default"),
    });
    expect(((await real.json()) as { deletedCount: number }).deletedCount).toBe(1);
  });

  it("does not revoke anything for a passkey that does not exist", async () => {
    const caller = await mintSessionToken(SIGNING_KEY, "passkey-missing-user");
    const res = await call("/api/auth/passkeys?id=pk-does-not-exist", { method: "DELETE", headers: cookie(caller) });
    expect(res.status).toBe(404);
    expect(await isAuthenticated(caller)).toBe(true);
  });
});
