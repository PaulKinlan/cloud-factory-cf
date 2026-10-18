import type { Env } from "../src/env";

declare module "cloudflare:test" {
  // Bindings available to tests: the same `Env` the worker sees, plus the
  // test-only WEBHOOK_SECRET set in vitest.config.ts.
  interface ProvidedEnv extends Env {}
}
