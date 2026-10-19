import { defineConfig } from "vitest/config";

export default defineConfig({
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
