import { describe, expect, it } from "vitest";
import { verifyRegistrationAttestation } from "../src/auth/webauthn-attestation";
import { base64Url, buildAttestationObject, es256KeyPair } from "./support/webauthn";

/**
 * Registration used to file whatever `credentialId` and `publicKeySpki` the client sent, without
 * ever reading the attestation object (cloud-factory-cf-evbe). Nothing then tied the stored key
 * to this relying party, to a user-presence check, or to the credential id it was stored under.
 *
 * These cases hand the verifier authenticator data built the way an authenticator builds it,
 * and then break exactly one thing at a time - which is the only way to know the check is
 * doing the work rather than the fixture agreeing with the parser.
 */
const RP_ID = "example.com";

async function valid() {
  const key = await es256KeyPair();
  const attestationObject = await buildAttestationObject({ rpId: RP_ID, credentialId: key.credentialId, spki: key.spki });
  return { ...key, attestationObject };
}

describe("registration attestation verification", () => {
  it("accepts a well-formed registration and reports the attested key", async () => {
    const { attestationObject, credentialId, spkiBase64Url } = await valid();
    const attested = await verifyRegistrationAttestation({
      attestationObject,
      expectedRpId: RP_ID,
      expectedCredentialId: base64Url(credentialId),
    });
    expect(attested.credentialId).toBe(base64Url(credentialId));
    expect(attested.algorithm).toBe(-7);
    // The key is derived from the COSE key in the authenticator data - not taken from the client.
    expect(attested.publicKeySpki).toBe(spkiBase64Url);
  });

  it("refuses authenticator data for a different relying party", async () => {
    const key = await es256KeyPair();
    const attestationObject = await buildAttestationObject({
      rpId: RP_ID,
      credentialId: key.credentialId,
      spki: key.spki,
      rpIdHash: new Uint8Array(32).fill(7),
    });
    await expect(
      verifyRegistrationAttestation({
        attestationObject,
        expectedRpId: RP_ID,
        expectedCredentialId: base64Url(key.credentialId),
      }),
    ).rejects.toThrow(/RP ID hash mismatch/);
  });

  it("refuses a registration with no user presence", async () => {
    const key = await es256KeyPair();
    const attestationObject = await buildAttestationObject({
      rpId: RP_ID,
      credentialId: key.credentialId,
      spki: key.spki,
      flags: 0x40, // attested credential data, but the user was never present
    });
    await expect(
      verifyRegistrationAttestation({
        attestationObject,
        expectedRpId: RP_ID,
        expectedCredentialId: base64Url(key.credentialId),
      }),
    ).rejects.toThrow(/user presence/);
  });

  it("refuses authenticator data without attested credential data", async () => {
    const key = await es256KeyPair();
    const attestationObject = await buildAttestationObject({
      rpId: RP_ID,
      credentialId: key.credentialId,
      spki: key.spki,
      flags: 0x01, // user present, but no credential follows - nothing to register
    });
    await expect(
      verifyRegistrationAttestation({
        attestationObject,
        expectedRpId: RP_ID,
        expectedCredentialId: base64Url(key.credentialId),
      }),
    ).rejects.toThrow(/no attested credential data/);
  });

  it("refuses a credential id that is not the one in the authenticator data", async () => {
    const { attestationObject } = await valid();
    await expect(
      verifyRegistrationAttestation({
        attestationObject,
        expectedRpId: RP_ID,
        expectedCredentialId: "c29tZS1vdGhlci1jcmVkZW50aWFs",
      }),
    ).rejects.toThrow(/credential id does not match/);
  });

  it("refuses a truncated attestation object instead of throwing something untyped", async () => {
    await expect(
      verifyRegistrationAttestation({
        attestationObject: base64Url(new Uint8Array([0xa3, 0x63])),
        expectedRpId: RP_ID,
        expectedCredentialId: "x",
      }),
    ).rejects.toThrow();
  });
});
