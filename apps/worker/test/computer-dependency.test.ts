import { describe, expect, it } from "vitest";

/**
 * Guard for the dual-runtime ACI dependency: `@cloudflare/computer` is declared
 * by the Worker because the RepoCoordinator's filesystem is a SQLite-backed
 * Workspace. Asserting it resolves *inside workerd* (not just in npm) catches a
 * dependency that only works in Node before anyone builds on it.
 */
describe("@cloudflare/computer", () => {
  it("resolves and exposes the workspace API inside the Workers runtime", async () => {
    const computer = await import("@cloudflare/computer");
    expect(typeof computer.Workspace).toBe("function");
    expect(typeof computer.WorkerBundle).toBe("function");
  });
});
