import { isApprovedCredentialBinding } from "../src/credentials/policy";
import { describe, expect, it } from "vitest";
import {
  credentialEnvFor,
  hasPermission,
  resolveRequest,
} from "../src/credentials/policy";

describe("credential broker policy", () => {
  it("permits only actions in the registry", () => {
    expect(hasPermission("github", "pr.comment")).toBe(true);
    expect(hasPermission("gitlab", "mr.comment")).toBe(true);
    expect(hasPermission("github", "org.delete")).toBe(false);
    expect(hasPermission("bitbucket", "pr.comment")).toBe(false);
    // Prototype keys must not be mistaken for services.
    expect(hasPermission("__proto__", "toString")).toBe(false);
    expect(hasPermission("github", "constructor")).toBe(false);
  });

  it("builds the upstream request from the capability's repository, not the params", () => {
    const resolved = resolveRequest({
      service: "github",
      action: "pr.comment",
      repository: "acme/widgets",
      params: { number: 42, body: "Looks good" },
    });
    expect(resolved).toMatchObject({
      ok: true,
      url: "https://api.github.com/repos/acme/widgets/issues/42/comments",
      method: "POST",
      body: JSON.stringify({ body: "Looks good" }),
    });

    const read = resolveRequest({ service: "github", action: "repo.read", repository: "acme/widgets" });
    expect(read).toMatchObject({ ok: true, method: "GET", url: "https://api.github.com/repos/acme/widgets" });
    expect(read.ok && read.body).toBeUndefined();
  });

  it("url-encodes the repository for GitLab's project path", () => {
    const resolved = resolveRequest({
      service: "gitlab",
      action: "mr.comment",
      repository: "acme/widgets",
      params: { iid: 7, body: "note" },
    });
    expect(resolved.ok && resolved.url).toBe(
      "https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/7/notes",
    );
  });

  it("refuses path traversal, unknown params and non-integer ids", () => {
    const traversal = resolveRequest({ service: "github", action: "repo.read", repository: "../../evil" });
    expect(traversal).toMatchObject({ ok: false, status: 400 });

    const injectedId = resolveRequest({
      service: "github",
      action: "pr.comment",
      repository: "acme/widgets",
      params: { number: "1/../../repos/other" },
    });
    expect(injectedId).toMatchObject({ ok: false, status: 400 });

    const negative = resolveRequest({
      service: "github",
      action: "pr.comment",
      repository: "acme/widgets",
      params: { number: -1 },
    });
    expect(negative).toMatchObject({ ok: false, status: 400 });

    const extra = resolveRequest({
      service: "github",
      action: "pr.comment",
      repository: "acme/widgets",
      params: { number: 1, body: "x", url: "https://evil.example" },
    });
    expect(extra).toMatchObject({ ok: false, status: 400, reason: "parameter url not permitted" });
  });

  it("allows multi-line comment text but refuses other control characters", () => {
    // A review or a comment is free text: a model writes paragraphs and fenced
    // code, and the value only ever reaches a JSON body, never a header or a log
    // line (cloud-factory-cf-7or). The ban now applies to the control characters
    // that could still mangle a log or a terminal.
    const multiline = resolveRequest({
      service: "github",
      action: "issue.comment",
      repository: "acme/widgets",
      params: { number: 1, body: "line1\nline2" },
    });
    expect(multiline).toMatchObject({ ok: true });
    expect(multiline.ok && JSON.parse(multiline.body ?? "{}").body).toBe("line1\nline2");

    const control = resolveRequest({
      service: "github",
      action: "issue.comment",
      repository: "acme/widgets",
      params: { number: 1, body: "bell\u0007" },
    });
    expect(control).toMatchObject({ ok: false, status: 400 });

    const unbounded = resolveRequest({
      service: "github",
      action: "issue.comment",
      repository: "acme/widgets",
      params: { number: 1, body: "x".repeat(400_001) },
    });
    expect(unbounded).toMatchObject({ ok: false, status: 400 });
  });

  it("maps services to their credential bindings and denies unknown services", () => {
    expect(credentialEnvFor("github")).toBe("GITHUB_TOKEN");
    expect(credentialEnvFor("gitlab")).toBe("GITLAB_TOKEN");
    expect(credentialEnvFor("unknown")).toBeNull();

    const unknownService = resolveRequest({ service: "unknown", action: "read", repository: "acme/widgets" });
    expect(unknownService).toMatchObject({ ok: false, status: 403 });
  });
});

describe("approved credential bindings", () => {
  it("accepts only the service's own credential binding and its siblings", () => {
    expect(isApprovedCredentialBinding("github", "GITHUB_TOKEN")).toBe(true);
    expect(isApprovedCredentialBinding("github", "GITHUB_TOKEN_INSTALL_2")).toBe(true);
    // A binding the deployment declares under the service's credential prefix
    // is a credential for that service, so it is selectable.
    expect(isApprovedCredentialBinding("github", "GITHUB_TOKEN_SECRET")).toBe(true);
    expect(isApprovedCredentialBinding("gitlab", "GITLAB_TOKEN")).toBe(true);

    expect(isApprovedCredentialBinding("github", "BROKER_SIGNING_KEY")).toBe(false);
    expect(isApprovedCredentialBinding("github", "BROKER_CONTROL_KEY")).toBe(false);
    expect(isApprovedCredentialBinding("github", "WEBHOOK_SECRET")).toBe(false);
    expect(isApprovedCredentialBinding("github", "GITLAB_TOKEN")).toBe(false);
    expect(isApprovedCredentialBinding("github", "github_token")).toBe(false);
    expect(isApprovedCredentialBinding("github", "GITHUB_TOKEN_")).toBe(false);
    expect(isApprovedCredentialBinding("unknown", "GITHUB_TOKEN")).toBe(false);
  });
});
