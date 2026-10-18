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
          BROKER_SIGNING_KEY: "test-broker-signing-key",
          BROKER_CONTROL_KEY: "test-control-key",
          GITHUB_TOKEN: "ghp_test_github_credential",
          GITLAB_TOKEN: "glpat_test_gitlab_credential",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
