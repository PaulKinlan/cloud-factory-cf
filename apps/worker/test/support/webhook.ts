const encoder = new TextEncoder();

/** Signs a webhook body exactly the way GitHub does (`X-Hub-Signature-256`). */
export async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `sha256=${toHex(signature)}`;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export const TEST_SECRET = "test-webhook-secret";
export const TEST_GITLAB_TOKEN = "test-gitlab-token";

export function pushPayload(deliveryId: string, repository = "acme/widgets") {
  return JSON.stringify({
    action: "opened",
    number: 7,
    delivery: deliveryId,
    sender: { login: "octocat" },
    repository: { full_name: repository },
  });
}

export function gitlabPayload(deliveryId: string, repository = "acme/widgets") {
  return JSON.stringify({
    object_kind: "merge_request",
    event_uuid: deliveryId,
    user: { username: "tanuki" },
    project: { path_with_namespace: repository },
    object_attributes: { action: "open", iid: 3 },
  });
}

/** A signed GitHub webhook request addressed at `<repository>`'s endpoint. */
export async function githubRequest(
  deliveryId: string,
  repository = "acme/widgets",
  overrides: { body?: string; signature?: string; event?: string } = {},
): Promise<Request> {
  const body = overrides.body ?? pushPayload(deliveryId, repository);
  return new Request(`https://example.com/webhooks/github/${repository}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": overrides.event ?? "pull_request",
      "x-hub-signature-256": overrides.signature ?? (await signBody(TEST_SECRET, body)),
    },
    body,
  });
}

/** A GitLab webhook request authenticated with `X-Gitlab-Token`. */
export function gitlabRequest(
  deliveryId: string,
  repository = "acme/widgets",
  overrides: { body?: string; token?: string } = {},
): Request {
  const body = overrides.body ?? gitlabPayload(deliveryId, repository);
  return new Request(`https://example.com/webhooks/gitlab/${repository}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-event-uuid": deliveryId,
      "x-gitlab-event": "Merge Request Hook",
      "x-gitlab-token": overrides.token ?? TEST_GITLAB_TOKEN,
    },
    body,
  });
}

// ---------------------------------------------------------------- App payloads
//
// The builders above are deliberately minimal: they carry only the fields a
// normaliser reads, which keeps the queue/decision tests readable. The end-to-end
// suite (test/webhook-e2e.test.ts) instead replays the shape GitHub App deliveries
// actually have — installation, repository, actor, PR/issue objects, HTML urls — so
// a change that starts reading a different field breaks a test that looks like
// production traffic rather than one that looks like a fixture.

export interface AppPayloadOptions {
  repository?: string;
  sender?: string;
  installationId?: number;
  headSha?: string;
}

function appEnvelope(options: AppPayloadOptions) {
  const repository = options.repository ?? "acme/widgets";
  const [owner, name] = repository.split("/");
  return {
    enterprise: null,
    repository: {
      id: 1296269,
      node_id: "MDEwOlJlcG9zaXRvcnkxMjk2MjY5",
      name,
      full_name: repository,
      private: true,
      owner: { login: owner, id: 9919, type: "Organization" },
      html_url: `https://github.com/${repository}`,
      default_branch: "main",
    },
    installation: { id: options.installationId ?? 4242, node_id: "MDIzOkludGVncmF0aW9uNDI0Mg==" },
    sender: { login: options.sender ?? "octocat", id: 583231, type: "User" },
  };
}

/** A GitHub App `pull_request` delivery, as GitHub sends it. */
export function githubPullRequestPayload(
  options: AppPayloadOptions & {
    action?: string;
    number?: number;
    title?: string;
    headRef?: string;
    merged?: boolean;
  } = {},
): string {
  const number = options.number ?? 42;
  const headSha = options.headSha ?? "1111111111111111111111111111111111111111";
  return JSON.stringify({
    action: options.action ?? "opened",
    number,
    pull_request: {
      url: `https://api.github.com/repos/${options.repository ?? "acme/widgets"}/pulls/${number}`,
      id: 279147437,
      node_id: "PR_kwDOBm6k_c5Q",
      html_url: `https://github.com/${options.repository ?? "acme/widgets"}/pull/${number}`,
      number,
      state: options.action === "closed" ? "closed" : "open",
      locked: false,
      title: options.title ?? "Add the webhook adapter",
      user: { login: "octocat", id: 583231, type: "User" },
      body: "Adds the ADR 003 platform adapters.",
      created_at: "2026-10-19T11:58:00Z",
      updated_at: "2026-10-19T12:00:00Z",
      head: {
        label: `octocat:${options.headRef ?? "adapter"}`,
        ref: options.headRef ?? "adapter",
        sha: headSha,
        user: { login: "octocat", id: 583231 },
      },
      base: {
        label: "acme:main",
        ref: "main",
        sha: "2222222222222222222222222222222222222222",
        user: { login: "acme", id: 9919 },
      },
      merged: options.merged ?? false,
      mergeable: true,
    },
    ...appEnvelope(options),
  });
}

/** A GitHub App `issues` delivery, as GitHub sends it. */
export function githubIssuesPayload(
  options: AppPayloadOptions & { action?: string; number?: number; title?: string } = {},
): string {
  const number = options.number ?? 9;
  return JSON.stringify({
    action: options.action ?? "opened",
    issue: {
      url: `https://api.github.com/repos/${options.repository ?? "acme/widgets"}/issues/${number}`,
      id: 1,
      number,
      title: options.title ?? "Crash on boot with a stored canvas",
      user: { login: "octocat", id: 583231, type: "User" },
      state: "open",
      body: "Steps to reproduce…",
      html_url: `https://github.com/${options.repository ?? "acme/widgets"}/issues/${number}`,
      labels: [],
    },
    ...appEnvelope(options),
  });
}

/** A GitHub App `push` delivery (no PR number, nothing to review). */
export function githubPushPayload(options: AppPayloadOptions & { ref?: string } = {}): string {
  return JSON.stringify({
    ref: options.ref ?? "refs/heads/main",
    before: "2222222222222222222222222222222222222222",
    after: options.headSha ?? "3333333333333333333333333333333333333333",
    created: false,
    deleted: false,
    forced: false,
    commits: [
      {
        id: "3333333333333333333333333333333333333333",
        message: "chore: bump the adapter",
        author: { name: "Octocat", email: "octocat@example.com" },
      },
    ],
    head_commit: { id: "3333333333333333333333333333333333333333", message: "chore: bump the adapter" },
    ...appEnvelope(options),
  });
}

/** A GitHub App `ping` delivery: the hook handshake, which carries no work. */
export function githubPingPayload(options: AppPayloadOptions = {}): string {
  return JSON.stringify({
    zen: "Keep it logically awesome.",
    hook_id: 1,
    hook: { type: "Repository", id: 1, active: true, events: ["pull_request", "issues", "push"] },
    ...appEnvelope(options),
  });
}
