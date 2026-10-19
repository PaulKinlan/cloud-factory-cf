import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: true,
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
