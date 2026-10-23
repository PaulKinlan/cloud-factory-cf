import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Discovery of host Unix domain sockets inside a workspace (cloud-factory-cf-5vuu,
 * -6rne, -vy8o, -bcra).
 *
 * The `network-none` sandbox unshares the IP namespace, but Unix domain sockets are
 * **not** namespaced: a socket a host process left inside the workspace is still a
 * door to the host network. The sandbox therefore masks every socket it finds
 * (`--ro-bind /dev/null <path>`).
 *
 * Discovery must be complete *and* cheap, and those two pull against each other:
 *
 * - a bounded directory walk that prunes `node_modules`/`target`/… is cheap but
 *   **bypassable** — a socket under a pruned directory is never masked (that was a
 *   reproducible escape on the first version of this fix);
 * - a complete walk is honest but costs ~1ms per directory, so a 20k-directory
 *   workspace pays seconds on *every* command.
 *
 * So the primary source is not a walk at all: the kernel already publishes every
 * bound Unix socket in `/proc/net/unix`, path included. Reading that table is
 * O(number of sockets) — well under a millisecond — and it cannot be bypassed by
 * putting the socket somewhere inconvenient. The directory walk remains only as a
 * degraded fallback for hosts without `/proc`, and it **prunes nothing**: complete
 * or refused, never partial. Every incomplete scan throws
 * (`SocketScanError`), because a partial answer means an unmasked socket.
 */

/** Directory names the degraded walk used to prune. Kept only so the docs can say why it does not. */
export const FORMERLY_SKIPPED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.git',
  '.cache',
]);

export interface SocketScanOptions {
  /** Directory budget for the degraded walk. Default 20000. */
  maxDirs?: number;
  /** Nesting budget for the degraded walk. Default 32. */
  maxDepth?: number;
  /** Wall-clock budget for the degraded walk. Default 5000ms. */
  timeoutMs?: number;
  /** Directories read in parallel by the degraded walk. Default 16. */
  concurrency?: number;
  /**
   * Where to read the kernel socket table from. Default `/proc/net/unix`. This only
   * relocates the source — it never skips verification — so a host that mounts `/proc`
   * elsewhere can still use the cheap path, and the degraded walk can be exercised.
   */
  tablePath?: string;
}

export interface SocketScanResult {
  /** Absolute paths of every Unix socket found, sorted. */
  sockets: string[];
  /** Which source answered: the kernel's socket table, or the fallback walk. */
  source: 'proc' | 'walk';
  /** Directories read (0 for the socket table). */
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

const DEFAULT_MAX_DIRS = 20000;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CONCURRENCY = 16;

const FIX_HINT =
  'Refusing to run the command with an unverified socket mask. Narrow the workspace, or raise the budget with createLocalTools({ socketScan: { timeoutMs, maxDirs, maxDepth } }).';

/** `/proc/net/unix` rows: `Num: RefCount Protocol Flags Type St Inode Path`. */
const SOCKET_TABLE_ROW = /^\s*[0-9a-fA-F]+:\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\d+\s+(.*)$/;

/**
 * Filters a `/proc/net/unix` table down to the sockets inside `root`.
 *
 * The Path column is free-form (it may contain spaces) and abstract sockets appear
 * as `@name`, so the path is everything after the inode column rather than a
 * whitespace-split field. Exported for tests: parsing a table is pure.
 */
export function socketsUnderRoot(table: string, root: string): string[] {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  const found: string[] = [];
  for (const line of table.split('\n')) {
    const match = SOCKET_TABLE_ROW.exec(line);
    if (!match) continue;
    const socketPath = (match[1] ?? '').trim();
    // Bind-mountable paths only: an abstract socket (@) has no filesystem path, so
    // there is nothing to mask and nothing the sandbox can dial by name.
    if (!socketPath.startsWith(path.sep)) continue;
    if (socketPath.startsWith(prefix)) found.push(socketPath);
  }
  return found;
}

/** The kernel's bound-socket table, or `null` when this host does not publish one. */
export async function readHostUnixSocketTable(
  tablePath = '/proc/net/unix',
): Promise<string | null> {
  try {
    return await fs.readFile(tablePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Complete-or-refuse directory walk, used only when `/proc/net/unix` is missing.
 * It prunes nothing: a socket under `node_modules` is exactly the escape this
 * function exists to prevent.
 */
export async function walkWorkspaceSockets(
  root: string,
  options: SocketScanOptions = {},
): Promise<{ sockets: string[]; dirsScanned: number }> {
  const maxDirs = options.maxDirs ?? DEFAULT_MAX_DIRS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const deadline = Date.now() + timeoutMs;
  const sockets: string[] = [];
  let dirsScanned = 0;
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
          if (isSocketEntry(entry)) {
            found.push(full);
          } else if (entry.isDirectory()) {
            // `readdir({withFileTypes:true})` reports lstat semantics, so a symlink to
            // a directory is not `isDirectory()`: links are never followed.
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

  return { sockets: sockets.sort(), dirsScanned };
}

/**
 * `Dirent` here comes from this package's hand-written `node-env.d.ts` shim, which
 * declares only `isFile`/`isDirectory`; Node provides `isSocket` at runtime. Casting
 * keeps the shim untouched: a `.d.ts` edit has no covering suite, and the fast gate
 * refuses unmapped source (cloud-factory-cf-llyg).
 */
type SocketDirent = { isSocket(): boolean };

function isSocketEntry(entry: unknown): boolean {
  return (entry as SocketDirent).isSocket();
}

/**
 * Every Unix socket inside `root`, from the cheapest complete source available.
 * Throws `SocketScanError` rather than return a partial answer.
 */
export async function scanWorkspaceSockets(
  root: string,
  options: SocketScanOptions = {},
): Promise<SocketScanResult> {
  const startedAt = Date.now();

  const table = await readHostUnixSocketTable(options.tablePath);
  if (table !== null) {
    const sockets = socketsUnderRoot(table, root).sort();
    return { sockets, source: 'proc', dirsScanned: 0, elapsedMs: Date.now() - startedAt };
  }

  const walk = await walkWorkspaceSockets(root, options);
  return {
    sockets: walk.sockets,
    source: 'walk',
    dirsScanned: walk.dirsScanned,
    elapsedMs: Date.now() - startedAt,
  };
}
