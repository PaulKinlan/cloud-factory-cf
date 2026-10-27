import { isApprovedCredentialBinding } from "../src/credentials/policy";
import { describe, expect, it } from "vitest";
import {
  credentialEnvFor,
  hasPermission,
  resolveRequest,
} from "../src/credentials/policy";

describe("credential broker policy", () => {
  it("resolves pr.diff with accept diff header and pr.files", () => {
    const diff = resolveRequest({
      service: "github",
      action: "pr.diff",
      repository: "acme/widgets",
      params: { number: 42 },
    });
    expect(diff).toMatchObject({
      ok: true,
      method: "GET",
      url: "https://api.github.com/repos/acme/widgets/pulls/42",
      headers: { accept: "application/vnd.github.v3.diff" },
    });

    const files = resolveRequest({
      service: "github",
      action: "pr.files",
      repository: "acme/widgets",
      params: { number: 42 },
    });
    expect(files).toMatchObject({
      ok: true,
      method: "GET",
      url: "https://api.github.com/repos/acme/widgets/pulls/42/files",
    });
  });

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

  it("refuses control characters in bodies so logs and headers stay clean", () => {
    const multiline = resolveRequest({
      service: "github",
      action: "issue.comment",
      repository: "acme/widgets",
      params: { number: 1, body: "line1\nline2" },
    });
    expect(multiline).toMatchObject({ ok: false, status: 400 });

    const tooLong = resolveRequest({
      service: "github",
      action: "issue.comment",
      repository: "acme/widgets",
      params: { number: 1, body: "x".repeat(8_001) },
    });
    expect(tooLong).toMatchObject({ ok: false, status: 400 });
  });

  it("accepts multi-line bodies where the action can carry one, refusing only control characters", () => {
    // A GitHub issue and a Beads task carry reports, steps and acceptance criteria; the
    // SDK's default sinks forward payload.body/description verbatim, so a single-line
    // rule made them unusable (cloud-factory-cf-g9aw follow-up).
    const issue = resolveRequest({
      service: "github",
      action: "issue.create",
      repository: "acme/widgets",
      params: { title: "Crash on save", body: "Steps:\n1. open\n2. save\n\nExpected: saved" },
    });
    expect(issue).toMatchObject({ ok: true, method: "POST" });
    const issueBody = JSON.parse((issue as { body?: string }).body ?? "{}") as { body?: string };
    expect(issueBody.body).toContain("Steps:\n1. open");

    const task = resolveRequest({
      service: "beads",
      action: "task.create",
      repository: "acme/widgets",
      env: { BEADS_API_HOST: "beads.internal" },
      params: { title: "Ship it", description: "Acceptance:\n- tests\n- review" },
    });
    expect(task).toMatchObject({ ok: true });

    const update = resolveRequest({
      service: "beads",
      action: "task.update",
      repository: "acme/widgets",
      env: { BEADS_API_HOST: "beads.internal" },
      params: { taskId: 7, description: "line1\nline2" },
    });
    expect(update).toMatchObject({ ok: true });

    // Multi-line is not a licence for control characters or an unbounded body.
    const control = resolveRequest({
      service: "github",
      action: "issue.create",
      repository: "acme/widgets",
      params: { title: "Crash", body: "bad\u0000value" },
    });
    expect(control).toMatchObject({ ok: false, status: 400 });

    const tooLong = resolveRequest({
      service: "github",
      action: "issue.create",
      repository: "acme/widgets",
      params: { title: "Crash", body: "x".repeat(64_001) },
    });
    expect(tooLong).toMatchObject({ ok: false, status: 400 });
  });

  it("accepts a beads task id as a slug, and refuses one that could re-aim the route", () => {
    // A beads task id is `cloud-factory-cf-8xzi`, not a number: the positive-integer rule
    // refused every real task.update (cloud-factory-cf-rjei).
    const slug = resolveRequest({
      service: "beads",
      action: "task.update",
      repository: "acme/widgets",
      env: { BEADS_API_HOST: "beads.internal" },
      params: { taskId: "cloud-factory-cf-8xzi", title: "Fix it" },
    });
    expect(slug).toMatchObject({
      ok: true,
      method: "PATCH",
      url: "https://beads.internal/repos/acme/widgets/tasks/cloud-factory-cf-8xzi",
    });

    for (const bad of ["../../admin", "a/b", ".hidden", "", "x".repeat(129)]) {
      const refused = resolveRequest({
        service: "beads",
        action: "task.update",
        repository: "acme/widgets",
        env: { BEADS_API_HOST: "beads.internal" },
        params: { taskId: bad },
      });
      expect(refused).toMatchObject({ ok: false, status: 400, reason: "parameter taskId must be an id" });
    }
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
