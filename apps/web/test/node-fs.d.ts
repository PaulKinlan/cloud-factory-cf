/**
 * This workspace's tsconfig sets `types: ["vite/client"]`, so Node's globals are not in
 * scope for `apps/web` sources or tests - deliberately, because the app runs in a
 * browser. Two kinds of file still need Node types: the stylesheet test reads
 * `src/styles.css` as text (Vitest's `?raw` import returns an empty string for CSS in this
 * setup), and `vite.config.ts` copies the built pages around after the bundle is written.
 *
 * The declarations below cover exactly what those files call, so the web workspace can be
 * typechecked without pulling all of `@types/node` into a browser bundle's config. They
 * were the remaining ten errors when `npm run typecheck -w @factory-cloud/web` was fixed
 * (cloud-factory-cf-m1la): the app itself typechecked, but the two Node-side files could
 * not see `node:path`, `import.meta.dirname`, or the `fs` calls they use.
 */
declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8" | "utf-8"): string;
  export function copyFileSync(source: string, destination: string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
  export function join(...paths: string[]): string;
}

interface ImportMeta {
  /** Node's ESM directory of the current module - always present under Node/vitest. */
  readonly dirname: string;
}
