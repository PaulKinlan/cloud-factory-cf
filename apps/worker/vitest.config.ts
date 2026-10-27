import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Test-only secret: real deployments set WEBHOOK_SECRET with
          // `wrangler secret put` and never commit a value.
          WEBHOOK_SECRET: "test-webhook-secret",
          GITLAB_WEBHOOK_TOKEN: "test-gitlab-token",
          // Gitea/Forgejo hook secret (ADR 003, cloud-factory-cf-6to).
          GITEA_WEBHOOK_SECRET: "test-gitea-webhook-secret",
          BROKER_SIGNING_KEY: "test-broker-signing-key",
          BROKER_CONTROL_KEY: "test-control-key",
          // Small window so the 429 path is exercised without 60 calls.
          BROKER_QUOTA_PER_MINUTE: "4",
          GITHUB_TOKEN: "ghp_test_github_credential",
          GITLAB_TOKEN: "glpat_test_gitlab_credential",
          // Beads sink: a test host + token so the broker path can be exercised
          // end to end without any real service.
          BEADS_API_HOST: "beads.test",
          BEADS_TOKEN: "test-beads-token",
          // GitHub OAuth app test credentials
          GITHUB_CLIENT_ID: "gh_test_client_id",
          GITHUB_CLIENT_SECRET: "gh_test_client_secret",
          // Alternate installation credential used by the per-repository
          // override tests.
          GITHUB_TOKEN_INSTALL_2: "ghp_test_github_install_2",
          // Review model credentials (cloud-factory-cf-7or). Test-only values: a real
          // deployment provisions the key into the broker, never into the repo.
          ANTHROPIC_API_KEY: "sk-ant-test-review-key",
          OPENAI_API_KEY: "sk-test-openai-review-key",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // 20s was the default and it is what turns a loaded VM into a red gate: these suites
    // drive real Durable Objects (audit 20-46s per test, connect 21-25s per test under
    // load 6-16 on 2 vCPU), so 20s expired mid-test and the failure looked like a code
    // regression (cloud-factory-cf-t8mu). 60s still fails a genuinely hung test but gives
    // the DO round-trips room on a busy machine.
    testTimeout: 60_000,
    // Parallel, but BOUNDED. Each test file boots its own workerd, so letting vitest start
    // one per selected file on a 2 vCPU VM is a startup stampede: two consecutive runs died
    // with "Timeout starting cloudflare-pool runner" and executed no tests at all
    // (transform 0ms, import 0ms). Two at a time still removes the serial hang (2 files:
    // 292s in parallel versus a run killed at 351s serial) without stampeding the pool.
    maxWorkers: 2,
    // Files run in parallel again (j998): serial execution is what turns "slow" into
    // "never starts" on this VM - two small files took 292s in parallel versus a run
    // killed at 351s serial. The read-after-write assertions that parallelism exposed
    // are fixed in the same branch (worker.test.ts) and in 8xzi (audit.test.ts).
  },
});
