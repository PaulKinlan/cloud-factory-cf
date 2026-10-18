import { describe, expect, it } from "vitest";
import { MAX_RESPONSE_BYTES, executeSignedRequest, redact } from "../src/credentials/broker";

const GITHUB_CREDENTIAL = "ghp_test_github_credential";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function recordingFetch(response: () => Response): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return response();
  };
  return { fetchImpl, calls };
}

describe("broker execution", () => {
  it("attaches the credential itself and keeps it out of the result", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(JSON.stringify({ id: 1, echoed: `token ${GITHUB_CREDENTIAL}` }), {
          status: 201,
          headers: { "content-type": "application/json", authorization: `Bearer ${GITHUB_CREDENTIAL}` },
        }),
    );

    const outcome = await executeSignedRequest(
      { service: "github", action: "pr.comment", repository: "acme/widgets", params: { number: 3, body: "hi" } },
      { fetchImpl, readCredential: (name) => (name === "GITHUB_TOKEN" ? GITHUB_CREDENTIAL : undefined) },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The agent never supplied a credential; the broker added it upstream.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/widgets/issues/3/comments");
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${GITHUB_CREDENTIAL}`);
    expect(calls[0]?.body).toBe(JSON.stringify({ body: "hi" }));

    // ...and the credential is scrubbed from what comes back.
    expect(outcome.execution.body).not.toContain(GITHUB_CREDENTIAL);
    expect(outcome.execution.body).toContain("[redacted]");
    expect(outcome.execution.redactions).toBe(1);
    expect(outcome.execution.status).toBe(201);
  });

  it("reports a missing credential as unavailable instead of calling upstream", async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response("should not happen", { status: 200 }));

    const outcome = await executeSignedRequest(
      { service: "gitlab", action: "project.read", repository: "acme/widgets" },
      { fetchImpl, readCredential: () => undefined },
    );

    expect(outcome).toMatchObject({ ok: false, status: 503 });
    expect(calls).toHaveLength(0);
  });

  it("never surfaces upstream fetch errors verbatim", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error(`connect ECONNREFUSED with header authorization: Bearer ${GITHUB_CREDENTIAL}`);
    };
    const outcome = await executeSignedRequest(
      { service: "github", action: "repo.read", repository: "acme/widgets" },
      { fetchImpl, readCredential: () => GITHUB_CREDENTIAL },
    );
    expect(outcome).toMatchObject({ ok: false, status: 502, reason: "upstream request failed" });
    expect(JSON.stringify(outcome)).not.toContain(GITHUB_CREDENTIAL);
  });

  it("truncates oversized upstream bodies", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("x".repeat(MAX_RESPONSE_BYTES + 100), { status: 200 }));
    const outcome = await executeSignedRequest(
      { service: "github", action: "repo.read", repository: "acme/widgets" },
      { fetchImpl, readCredential: () => GITHUB_CREDENTIAL },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.execution.truncated).toBe(true);
    expect(outcome.execution.body.endsWith("…[truncated]")).toBe(true);
  });

  it("redacts both raw and url-encoded forms of a secret", () => {
    const secret = "glpat-abc123/xyz";
    const { text, redactions } = redact(`raw=${secret} encoded=${encodeURIComponent(secret)}`, [
      secret,
      encodeURIComponent(secret),
    ]);
    expect(text).toBe("raw=[redacted] encoded=[redacted]");
    expect(redactions).toBe(2);
  });
});
