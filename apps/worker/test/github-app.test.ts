import { describe, expect, it } from "vitest";
import { importAppPrivateKey, mintAppJwt, pemToPkcs8Der } from "../src/github-app";

describe("GitHub App JWT & PEM helpers", () => {
  it("imports PKCS#8 and PKCS#1 RSA keys and signs RS256 JWTs", async () => {
    // Generate RSA key pair for testing
    const keyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign"],
    );
    const pkcs8Der = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8Der)));
    const pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;

    const importedKey = await importAppPrivateKey(pkcs8Pem);
    expect(importedKey).toBeDefined();

    const jwt = await mintAppJwt("123456", importedKey);
    expect(jwt).toBeTypeOf("string");
    const parts = jwt.split(".");
    expect(parts.length).toBe(3);

    const header = JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")));
    expect(header).toMatchObject({ alg: "RS256", typ: "JWT" });

    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    expect(payload.iss).toBe("123456");
    expect(payload.exp).toBeGreaterThan(payload.iat);

    // Also test PKCS#1 wrapping
    const octetIndex = new Uint8Array(pkcs8Der).findIndex((b, i) => b === 0x04 && new Uint8Array(pkcs8Der)[i + 1] === 0x82);
    if (octetIndex !== -1) {
      const pkcs1Der = new Uint8Array(pkcs8Der).slice(octetIndex + 4);
      const pkcs1B64 = btoa(String.fromCharCode(...pkcs1Der));
      const pkcs1Pem = `-----BEGIN RSA PRIVATE KEY-----\n${pkcs1B64}\n-----END RSA PRIVATE KEY-----`;
      const pkcs1Key = await importAppPrivateKey(pkcs1Pem);
      expect(pkcs1Key).toBeDefined();

      const pkcs1Jwt = await mintAppJwt("654321", pkcs1Key);
      const pkcs1Parts = pkcs1Jwt.split(".");
      expect(pkcs1Parts.length).toBe(3);
      const pkcs1Payload = JSON.parse(atob(pkcs1Parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      expect(pkcs1Payload.iss).toBe("654321");
    }
  });
});
