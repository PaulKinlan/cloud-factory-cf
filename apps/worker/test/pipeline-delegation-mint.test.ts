import { describe, expect, it } from "vitest";
import { BrokerCredentialBroker } from "../src/pipeline";
/** The one thing the pipeline needs from the other side of a DO stub. */
type CoordinatorStub = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };


/**
 * A run mints a capability per (service, action), and a delegation is single-use in the
 * broker (cloud-factory-cf-tkfb). So the pipeline must present a *fresh* delegation on each
 * of those requests: one token carried for the whole run is refused from the second sink
 * onwards, which is exactly what the reviewer's finding described.
 *
 * This pins the shape the routes rely on — `RunDeps.delegation` is a minting function, not
 * a token — without needing a broker, a run, or a network.
 */
function recordingBroker(): {
  stub: CoordinatorStub;
  delegationHeaders: Array<string | null>;
  /** Answer every capability request with a distinct, unexpired capability. */
} {
  const delegationHeaders: Array<string | null> = [];
  let issued = 0;
  const stub = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/capabilities")) {
        const headers = new Headers(init?.headers);
        delegationHeaders.push(headers.get("x-factory-delegation"));
        issued += 1;
        return Response.json({
          ok: true,
          capability: `capability-${issued}`,
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        });
      }
      if (url.includes("/permissions")) return Response.json({ ok: true, permitted: true });
      if (url.endsWith("/proxy")) return Response.json({ ok: true, status: 200, body: "{}" });
      return Response.json({ ok: false, error: "unexpected broker path" }, { status: 404 });
    },
  } as unknown as CoordinatorStub;
  return { stub, delegationHeaders };
}

describe("the pipeline presents one delegation per broker request", () => {
  it("mints a delegation for each capability it requests, and reuses a cached one otherwise", async () => {
    const { stub, delegationHeaders } = recordingBroker();
    const minted: string[] = [];
    const broker = new BrokerCredentialBroker(
      stub,
      {
        delegation: async () => {
          const token = `delegation-${minted.length + 1}`;
          minted.push(token);
          return token;
        },
      },
      "acme/widget",
    );

    // Two different capabilities: two requests, each with its own token.
    await broker.executeSignedRequest({ service: "github", action: "read" } as never);
    await broker.executeSignedRequest({ service: "github", action: "write" } as never);
    expect(minted).toEqual(["delegation-1", "delegation-2"]);
    expect(delegationHeaders).toEqual(["delegation-1", "delegation-2"]);

    // The capability cache still works: a repeated request spends no extra delegation.
    await broker.executeSignedRequest({ service: "github", action: "read" } as never);
    expect(minted).toHaveLength(2);
    expect(delegationHeaders).toHaveLength(2);
  });

  it("carries on when the mint fails, letting the broker answer rather than inventing authorisation", async () => {
    const { stub, delegationHeaders } = recordingBroker();
    const broker = new BrokerCredentialBroker(
      stub,
      { delegation: async () => undefined },
      "acme/widget",
    );

    // The request still goes out - with no delegation header and no control key - so the
    // broker's own 401 is what the run sees, not a silent local success.
    await broker.executeSignedRequest({ service: "github", action: "read" } as never);
    expect(delegationHeaders).toEqual([null]);
  });
});
