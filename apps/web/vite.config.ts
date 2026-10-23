import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "copy-admin-index",
      closeBundle() {
        mkdirSync(resolve(import.meta.dirname, "dist/admin"), { recursive: true });
        copyFileSync(resolve(import.meta.dirname, "dist/admin.html"), resolve(import.meta.dirname, "dist/admin/index.html"));
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
  },
});
