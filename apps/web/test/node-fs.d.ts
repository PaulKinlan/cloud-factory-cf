/**
 * This workspace's tsconfig sets `types: ["vite/client"]`, so Node's globals are not in
 * scope for `apps/web` sources or tests - deliberately, because the app runs in a
 * browser. Two kinds of file here are Node, not browser, code:
 *
 *   - the stylesheet test has to read `src/styles.css` as text, and Vitest's `?raw`
 *     import returns an empty string for CSS in this setup, so it uses `node:fs`;
 *   - `vite.config.ts` is build tooling: it copies the emitted `dist/admin.html` to
 *     `dist/admin/index.html` with `node:fs`, and resolves paths from
 *     `import.meta.dirname` (Node >= 20.11), which Vite loads in Node, never in a page.
 *
 * This declaration gives exactly those calls their types without pulling all of
 * `@types/node` into the web workspace (the repo depends on no @types/node at all, and
 * `packages/cli/src/node-env.d.ts` is the same pattern for the CLI). Widen a signature
 * here only when a real call needs it (cloud-factory-cf-6xju).
 */
declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8" | "utf-8"): string;
  export function existsSync(path: URL | string): boolean;
  export function mkdirSync(path: URL | string, options?: { recursive?: boolean }): string | undefined;
  export function copyFileSync(source: URL | string, destination: URL | string): void;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
}

interface ImportMeta {
  /** Directory of the current module; Node >= 20.11 (used by vite.config.ts). */
  readonly dirname: string;
}
