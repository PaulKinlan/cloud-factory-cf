import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "copy-admin-index",
      writeBundle() {
        const adminHtml = resolve(import.meta.dirname, "dist/admin.html");
        if (existsSync(adminHtml)) {
          mkdirSync(resolve(import.meta.dirname, "dist/admin"), { recursive: true });
          copyFileSync(adminHtml, resolve(import.meta.dirname, "dist/admin/index.html"));
        }
      },
    },
  ],
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: "index.html",
        admin: "admin.html",
      },
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The default 5000ms is the web counterpart of the 20s worker timeout fixed in
    // cloud-factory-cf-t8mu: a suite that drives real timers and fetch stubs takes 1.6s
    // quiet and blows 5s under load, so a gate reports "Test timed out in 5000ms" for a
    // branch that is fine. 60s still fails a hanging test.
    testTimeout: 60_000,
  },
});
