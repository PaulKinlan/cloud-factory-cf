import { defineConfig } from "vitest/config";

/**
 * apps/web had no vitest config, so its suites inherited vitest's 5s per-test default
 * while `apps/worker` had already raised its bound (cloud-factory-cf-t8mu). The web
 * suites drive DOM-shaped code with mocked fetch, and on a loaded VM one of those
 * "plain" poller tests took 3999ms of its 5000ms budget in a passing gate run - one
 * slow moment away from a spurious red that looks like a code regression
 * (cloud-factory-cf-cmty).
 *
 * These tests run in Node, not in a Worker, so the only thing this config needs to do
 * is give them the same room the worker workspace has: 60s still fails a genuinely
 * hung test, but it does not expire a test that is merely waiting on a busy machine.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
