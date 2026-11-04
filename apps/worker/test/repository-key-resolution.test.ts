import { describe, expect, it } from "vitest";
import { resolveRepositoryKey } from "../src/repo-coordinator-addressing";

/**
 * The platform a key belongs to must never come from text the caller can shape inside a
 * repository name (cloud-factory-cf-6eqm). Routes take the platform from the path - `/webhooks
 * /:provider/...`, `/api/.../ :platform?`, or `?platform=` - and pass it as the hint; a prefix
 * written into the repository half (`github:acme/widgets`) is a convenience for internal
 * callers, not an override.
 *
 * The case that matters is the mismatch: before this, `resolveRepositoryKey("github:acme/
 * widgets", "gitlab")` returned the github key, so a caller asking for gitlab silently
 * addressed the github coordinator for that repository - across the Durable Object namespace
 * both platforms share.
 */
describe("resolveRepositoryKey (cloud-factory-cf-6eqm)", () => {
  it("keeps a prefixed key when no platform is given", () => {
    expect(resolveRepositoryKey("gitlab:acme/widgets")).toBe("gitlab:acme/widgets");
  });

  it("keeps a prefixed key when the platform agrees with it", () => {
    expect(resolveRepositoryKey("gitlab:acme/widgets", "gitlab")).toBe("gitlab:acme/widgets");
  });

  it("follows the platform hint when the prefix names a different platform", () => {
    expect(resolveRepositoryKey("github:acme/widgets", "gitlab")).toBe("gitlab:acme/widgets");
    expect(resolveRepositoryKey("gitlab:acme/widgets", "github")).toBe("github:acme/widgets");
  });

  it("applies the hint to an unprefixed repository", () => {
    expect(resolveRepositoryKey("acme/widgets", "gitlab")).toBe("gitlab:acme/widgets");
  });

  it("defaults to github when there is no hint", () => {
    expect(resolveRepositoryKey("acme/widgets")).toBe("github:acme/widgets");
  });

  it("ignores a hint that is not a platform, rather than trusting it", () => {
    expect(resolveRepositoryKey("acme/widgets", "bitbucket")).toBe("github:acme/widgets");
    expect(resolveRepositoryKey("github:acme/widgets", "bitbucket")).toBe("github:acme/widgets");
  });

  it("trims before deciding, so whitespace cannot smuggle a prefix past the check", () => {
    expect(resolveRepositoryKey("  github:acme/widgets  ", "gitlab")).toBe("gitlab:acme/widgets");
  });
});
