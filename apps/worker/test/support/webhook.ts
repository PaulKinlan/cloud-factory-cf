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
