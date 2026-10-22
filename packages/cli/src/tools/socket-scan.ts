import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Bounded discovery of host Unix domain sockets inside a workspace
 * (cloud-factory-cf-5vuu, cloud-factory-cf-6rne, cloud-factory-cf-vy8o,
 * cloud-factory-cf-bcra).
 *
 * The `network-none` sandbox unshares the IP namespace, but Unix domain sockets are
 * **not** namespaced: a socket a host process left inside the workspace is still a
 * door to the host network. The sandbox therefore masks every socket it can find
 * (`--ro-bind /dev/null <path>`).
 *
 * That makes the scan a security control, so it is written to fail **closed**:
 *
 * - it never silently skips a subtree it cannot read — it throws;
 * - it never silently skips a subtree because the budget ran out — it throws;
 * - it is bounded (`maxDirs`, `maxDepth`, `timeoutMs`) so a large workspace cannot
 *   make every command slow;
 * - it is re-run for every command, so a socket that appears later is still masked
 *   (no cache — a stale snapshot silently unmasks).
 *
 * The skip list keeps the common case cheap: build and dependency directories are
 * not descended into. A subtree that is skipped is *not* verified, which is why the
 * operators' escape hatch is an explicit option rather than an assumption.
 */

/** Directory names never descended into. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  // Dependencies and build output
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.pnpm-store',
  '.yarn',
  '.output',
  // VCS and caches
  '.git',
  '.cache',
  // Language toolchains and virtualenvs
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.tox',
  '.cargo',
  '.rustup',
  '.gradle',
  '.m2',
  '.terraform',
]);

export interface SocketScanOptions {
  /** Directory budget for one scan. Default 4096. */
  maxDirs?: number;
  /** Nesting budget for one scan. Default 12. */
  maxDepth?: number;
  /** Wall-clock budget for one scan. Default 5000ms. */
  timeoutMs?: number;
  /** Directories read in parallel. Default 8. */
  concurrency?: number;
}

export interface SocketScanResult {
  /** Absolute paths of every Unix socket found, sorted. */
  sockets: string[];
  /** Directories actually read. */
  dirsScanned: number;
  /** Wall time spent scanning. */
  elapsedMs: number;
}

/**
 * A scan that could not complete. Callers must treat this as "do not run the
 * command": an incomplete scan means an unknown number of unmasked sockets.
 */
export class SocketScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocketScanError';
  }
}

/**
 * `Dirent` here comes from this package's hand-written `node-env.d.ts` shim, which
 * declares only `isFile`/`isDirectory`; Node provides `isSocket` at runtime. Casting
 * keeps the shim untouched: a `.d.ts` edit has no covering suite, and the fast gate
 * refuses unmapped source (cloud-factory-cf-llyg).
 */
type SocketDirent = { isSocket(): boolean };

const DEFAULT_MAX_DIRS = 4096;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CONCURRENCY = 8;

const FIX_HINT =
  'Refusing to run the command with an unverified socket mask. Narrow the workspace, add the directory to the skip list, or raise the budget with createLocalTools({ socketScan: { maxDirs, maxDepth, timeoutMs } }).';

/**
 * Finds every Unix domain socket inside `root`, bounded by the options, and throws
 * `SocketScanError` rather than return a partial answer.
 */
export async function scanWorkspaceSockets(
  root: string,
  options: SocketScanOptions = {},
): Promise<SocketScanResult> {
  const maxDirs = options.maxDirs ?? DEFAULT_MAX_DIRS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const sockets: string[] = [];
  let dirsScanned = 0;
  // Counted when a directory is *discovered*, not when it is read: the budget must
  // refuse before spending the time it is trying to bound (a 5k-directory tree is
  // refused after reading its parents, not after reading all 5k).
  let dirsDiscovered = 1;

  let frontier: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (frontier.length > 0) {
    const wave = frontier.splice(0, concurrency);
    const results = await Promise.all(
      wave.map(async ({ dir, depth }) => {
        if (Date.now() > deadline) {
          throw new SocketScanError(
            `socket scan exceeded its ${timeoutMs}ms budget at '${dir}'. ${FIX_HINT}`,
          );
        }
        if (depth > maxDepth) {
          throw new SocketScanError(
            `workspace nesting exceeds the ${maxDepth}-level socket scan limit at '${dir}'. ${FIX_HINT}`,
          );
        }
        dirsScanned += 1;

        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (err) {
          throw new SocketScanError(
            `could not read '${dir}' while scanning for host Unix sockets: ${(err as Error).message}. ${FIX_HINT}`,
          );
        }

        const found: string[] = [];
        const next: Array<{ dir: string; depth: number }> = [];
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if ((entry as unknown as SocketDirent).isSocket()) {
            found.push(full);
          } else if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) {
            // `readdir({withFileTypes:true})` reports lstat semantics, so a symlink to a
            // directory is `isSymbolicLink()` and *not* `isDirectory()`: links are never
            // followed. The sandbox mounts only the workspace, so a link could not reach
            // outside it anyway, and following links reintroduces loops.
            dirsDiscovered += 1;
            if (dirsDiscovered > maxDirs) {
              throw new SocketScanError(
                `workspace has more than ${maxDirs} directories to scan (stopped at '${full}'). ${FIX_HINT}`,
              );
            }
            next.push({ dir: full, depth: depth + 1 });
          }
        }
        return { found, next };
      }),
    );

    frontier = frontier.concat(...results.map((r) => r.next));
    for (const r of results) sockets.push(...r.found);
  }

  sockets.sort();
  return { sockets, dirsScanned, elapsedMs: Date.now() - startedAt };
}
