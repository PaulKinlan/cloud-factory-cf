/**
 * This workspace's tsconfig sets `types: ["vite/client"]`, so Node's globals are not in
 * scope for `apps/web` sources or tests - deliberately, because the app runs in a
 * browser. The stylesheet test still has to read `src/styles.css` as text, and Vitest's
 * `?raw` import returns an empty string for CSS in this setup, so it uses `node:fs`.
 * This declaration gives that one call its types without pulling all of `@types/node`
 * into the web workspace.
 */
declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
}
