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
    testTimeout: 60_000,
  },
});
