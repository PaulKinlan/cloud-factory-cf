import { defineConfig } from "vitest/config";

/**
 * Worker tests that need no Workers runtime (cloud-factory-cf-n8v9).
 *
 * These five files touch no Durable Object, no SQLite and no `cloudflare:test` binding, so
 * they were paying a Worker instantiation plus its transform/import cost for nothing - each
 * file in the workerd pool is its own instance, and start-up there can take the 90s vitest
 * allows before it gives up entirely (docs/speed.md).
 *
 * Deliberately a SEPARATE config rather than a `projects` entry in vitest.config.ts: the
 * cloudflare plugin's project registration does not answer to `--project worker` (verified:
 * "No projects matched the filter"), and a config every lane's gate depends on is the wrong
 * place to discover that. `npm test` therefore keeps running exactly what it ran before, and
 * `npm run test:unit -w @factory-cloud/worker` runs this.
 */
export default defineConfig({
  test: {
    include: [
      "test/credentials-broker.test.ts",
      "test/credentials-capability.test.ts",
      "test/credentials-policy.test.ts",
      "test/github-app.test.ts",
      "test/review-model.test.ts",
    ],
    environment: "node",
    // Same reasoning as t8mu and the web suite: 5s (the default here) expires mid-test on a
    // loaded VM - two RSA/crypto cases took 5.3s and 6.2s at load 16 - and the failure reads
    // like a broken test rather than a busy machine. 60s still fails a genuine hang.
    testTimeout: 60_000,
  },
});
