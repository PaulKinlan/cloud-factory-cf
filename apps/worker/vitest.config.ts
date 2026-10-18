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
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
