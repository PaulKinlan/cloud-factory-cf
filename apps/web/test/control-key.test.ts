import { describe, expect, it, vi } from "vitest";
import {
  adoptControlKey,
  adoptControlKeyFromInput,
  controlKeyHeaders,
} from "../src/control-key";

/**
 * The browser must not hold the platform control key (cloud-factory-cf-2gsy): it is
 * exchanged once for an HttpOnly session cookie, and only a refused key is ever sent as a
 * header afterwards.
 */

const ok = (): Response => new Response(JSON.stringify({ ok: true }), { status: 200 });
const refused = (): Response =>
  new Response(JSON.stringify({ ok: false, error: "Invalid root bootstrap password / control key" }), {
    status: 401,
  });

describe("adopting the operator's control key (cloud-factory-cf-2gsy)", () => {
  it("does nothing when the field is empty", async () => {
    const fetchImpl = vi.fn();
    await expect(adoptControlKey("   ", fetchImpl as never)).resolves.toEqual({ mode: "none" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("exchanges the key once and stops sending it", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const result = await adoptControlKey("master-key", fetchImpl as never);
    expect(result.mode).toBe("session");
    expect(result.key).toBeUndefined();
    // one exchange, to the root-login endpoint, with the key in the body
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/root-login");
    expect(JSON.parse(String(init.body))).toEqual({ controlKey: "master-key" });
    // and the caller is told to send no key header
    expect(controlKeyHeaders(result)).toEqual({});
  });

  it("keeps a refused key in the caller's hands, so the route can refuse it visibly", async () => {
    const fetchImpl = vi.fn(async () => refused());
    const result = await adoptControlKey("not-the-key", fetchImpl as never);
    expect(result).toEqual({ mode: "key", key: "not-the-key" });
    expect(controlKeyHeaders(result)).toEqual({ "x-factory-control-key": "not-the-key" });
  });

  it("treats a network failure as 'keep the legacy path', not as authenticated", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await adoptControlKey("master-key", fetchImpl as never);
    expect(result.mode).toBe("key");
  });

  it("clears the input it exchanged, so the secret does not stay in the DOM", async () => {
    const input = { value: "master-key" } as HTMLInputElement;
    const fetchImpl = vi.fn(async () => ok());
    const result = await adoptControlKeyFromInput(input, fetchImpl as never);
    expect(result.mode).toBe("session");
    expect(input.value).toBe("");
  });

  it("leaves the input alone when the key is refused, so the operator can correct it", async () => {
    const input = { value: "typo" } as HTMLInputElement;
    const fetchImpl = vi.fn(async () => refused());
    await adoptControlKeyFromInput(input, fetchImpl as never);
    expect(input.value).toBe("typo");
  });
});
