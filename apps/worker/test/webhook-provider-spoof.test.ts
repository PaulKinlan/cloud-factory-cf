import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { gitlabPayload, TEST_GITLAB_TOKEN } from "./support/webhook";

/**
 * The platform a delivery belongs to comes from the PATH - `/webhooks/:provider/:owner/:repo` -
 * so it must not be overridable by text inside the owner or repository segment
 * (cloud-factory-cf-6eqm).
 *
 * `resolveRepositoryKey` accepts an already-prefixed key and returns it unchanged, which is
 * what makes `?platform=` and internal callers convenient. At the edge it was also a hole: a
 * POST to `/webhooks/gitlab/github:acme/widgets` produced the repository string
 * `github:acme/widgets`, which parses as a prefixed key, so a GITLAB delivery was addressed to
 * the GITHUB coordinator for acme/widgets. Two platforms share one Durable Object namespace,
 * so that is a cross-provider key spoof by URL text alone.
 *
 * These cases drive the real endpoint: the assertion is on the response status, because a 400
 * means the delivery never reached any coordinator.
 */
function spoofedRequest(path: string): Request {
  const body = gitlabPayload("spoof-1");
  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-event-uuid": "spoof-1",
      "x-gitlab-event": "Merge Request Hook",
      "x-gitlab-token": TEST_GITLAB_TOKEN,
    },
    body,
  });
}

describe("webhook provider is taken from the path, never from the repository text", () => {
  it("refuses a colon in the owner segment instead of addressing the other platform", async () => {
    const response = await SELF.fetch(spoofedRequest("/webhooks/gitlab/github:acme/widgets"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  it("refuses a colon in the repository segment", async () => {
    const response = await SELF.fetch(spoofedRequest("/webhooks/gitlab/acme/widgets:github"));
    expect(response.status).toBe(400);
  });

  it("refuses a percent-encoded colon, because the router decodes before it routes", async () => {
    const response = await SELF.fetch(spoofedRequest("/webhooks/gitlab/github%3Aacme/widgets"));
    expect(response.status).toBe(400);
  });

  it("still accepts an ordinary delivery on the same provider", async () => {
    const response = await SELF.fetch(spoofedRequest("/webhooks/gitlab/acme/widgets"));
    expect(response.status).not.toBe(400);
  });
});
