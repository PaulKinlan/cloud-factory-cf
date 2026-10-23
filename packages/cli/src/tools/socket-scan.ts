import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Discovery of host Unix domain sockets inside a workspace (cloud-factory-cf-5vuu,
 * -6rne, -vy8o, -bcra, -khu9, -14xh).
 *
 * The `network-none` sandbox unshares the IP namespace, but Unix domain sockets are
 * **not** namespaced: a socket a host process left inside the workspace is still a door
 * to the host network, so the sandbox masks every socket it finds with
 * `--ro-bind /dev/null <path>`.
 *
 * ## Why this does not read `/proc/net/unix`
 *
 * The first two versions of this file parsed the kernel's bound-socket table. It is
 * cheap (O(number of sockets)) but its Path column is the **string `bind()` was given**,
 * which is not the file: four separate escapes came out of that gap in one afternoon —
 * a pruned directory, a relative name, an absolute name containing `..`, a name gained
 * through a symlink, and a name with a trailing space that the parser trimmed. Each fix
 * was another special case, and the next one was always waiting.
 *
 * So this asks the filesystem instead. `describeSocketEntries()` spawns:
 *
 *     find <root> \( -type s -o -type l -xtype s \) -print0
 *
 * which is *type* discovery: it reports real paths read from directory entries, so any
 * name the filesystem allows is handled natively (spaces, newlines — the output is
 * NUL-delimited — `..`, hardlinks, and symlinks in either direction: `-xtype s` also
 * catches a link inside the workspace that points at a socket outside it).
 *
 * Cost, measured on the VM: ~102ms for an 844-directory worktree (the equivalent Node
 * walk costs 611ms) and 1.8–4.0s for a synthetic 20,201-directory tree. The scan is
 * re-run for every command (`--vy8o`: a cache would silently unmask a socket that
 * appears later) and a scan that cannot finish **refuses** the command rather than
 * running with a partial mask.
 *
 * Naive seccomp (`connect()` on `AF_UNIX` → EPERM) would remove discovery entirely, but
 * it also breaks a legitimate socket a command creates and dials itself, so masking
 * stays the mechanism and this stays its discovery step.
 */

export interface SocketScanOptions {
  /** Wall-clock budget for one scan. Default 5000ms. */
  timeoutMs?: number;
  /** Directory budget for the fallback walk. Default 20000. */
  maxDirs?: number;
  /** Nesting budget for the fallback walk. Default 32. */
  maxDepth?: number;
  /** Directories read in parallel by the fallback walk. Default 16. */
  concurrency?: number;
}

export interface SocketScanResult {
  /**
   * Absolute paths to mask, sorted. A symlink that reaches a socket is reported by the
   * path inside the workspace, because that is the name the sandbox would dial.
   */
  sockets: string[];
  /** Which source answered: `find`, or the fallback walk when `find` is unavailable. */
  source: 'find' | 'walk';
  /** Directories read (0 when `find` answered: it does not report a count). */
  dirsScanned: number;
  /** Wall time spent scanning. */
  elapsedMs: number;
}

/**
 * A scan that could not complete. Callers must treat this as "do not run the command":
 * an incomplete scan means an unknown number of unmasked sockets.
 */
export class SocketScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocketScanError';
  }
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_DIRS = 20000;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_CONCURRENCY = 16;

const FIX_HINT =
  'Refusing to run the command with an unverified socket mask. Narrow the workspace, or raise the budget with createLocalTools({ socketScan: { timeoutMs, maxDirs, maxDepth } }).';

/**
 * `find` expression: sockets, and symlinks whose target is a socket. A symlink inside
 * the workspace pointing at an outside socket is an escape in the other direction and is
 * worth masking for the same reason as a socket inside the tree.
 */
// Bare parens: `spawn` passes arguments through verbatim (no shell to eat them), and GNU
// find rejects the backslash-escaped form when it arrives as a real argv element.
const FIND_EXPRESSION = ['(', '-type', 's', '-o', '-type', 'l', '-xtype', 's', ')', '-print0'];

/**
 * `spawn` is reached through a narrow cast because this package's hand-written
 * `node-env.d.ts` shim declares only `exec` for `node:child_process`, and editing the
 * shim is a gate problem: the fast gate refuses a changed source file that no test
 * references, and nothing references a `.d.ts` (cloud-factory-cf-llyg). `exec` is not an
 * option here — it interpolates the workspace path into a shell command line.
 */
interface SpawnedFind {
  stdout: { on(event: 'data', listener: (chunk: Uint8Array) => void): void } | null;
  stderr: { on(event: 'data', listener: (chunk: { toString(): string }) => void): void } | null;
  on(event: 'error', listener: (error: { code?: string; message?: string }) => void): void;
  on(event: 'close', listener: (code: number | null) => void): void;
  kill(signal?: string): boolean;
}

type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: Array<'ignore' | 'pipe'>; shell: boolean },
) => SpawnedFind;

const spawn = (childProcess as unknown as { spawn: SpawnFn }).spawn;

const UTF8_DECODER = (
  globalThis as unknown as {
    TextDecoder: new (label: string, options?: { fatal?: boolean }) => {
      decode(bytes: Uint8Array): string;
    };
  }
).TextDecoder;

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export interface FindOutputParse {
  sockets: string[];
  /**
   * Entries whose bytes are not valid UTF-8. Such a name cannot be represented as a string,
   * so it cannot be handed to `bwrap` to mask — the caller must refuse rather than mask a
   * mangled path and report success (cloud-factory-cf-sd2y).
   */
  undecodable: number;
}

/**
 * Splits `find -print0` output on NUL **at the byte level** and decodes each entry once.
 * NUL delimiting means a name containing a newline is one entry; decoding the whole buffer
 * once means a multi-byte character split across stream chunks is still one character.
 */
export function parseFindOutput(bytes: Uint8Array, root: string): FindOutputParse {
  const normalisedRoot = path.resolve(root);
  const prefix = normalisedRoot.endsWith(path.sep)
    ? normalisedRoot
    : normalisedRoot + path.sep;
  const decoder = new UTF8_DECODER('utf-8', { fatal: true });
  const sockets: string[] = [];
  let undecodable = 0;

  let start = 0;
  const entries: Array<[number, number]> = [];
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0) {
      entries.push([start, i]);
      start = i + 1;
    }
  }
  if (start < bytes.length) entries.push([start, bytes.length]);

  for (const [from, to] of entries) {
    if (to <= from) continue;
    let text: string;
    try {
      text = decoder.decode(bytes.subarray(from, to));
    } catch {
      undecodable += 1;
      continue;
    }
    // `find` prints the path it was given, so entries are already absolute; the check keeps
    // a stray `.`-relative path from slipping through.
    const absolute = path.resolve(text);
    if (absolute === normalisedRoot || absolute.startsWith(prefix)) sockets.push(absolute);
  }
  return { sockets, undecodable };
}

interface FindRun {
  code: number | null;
  /** Raw stdout bytes: decoding is a separate step so a multi-byte name split across
   * chunks is not mangled (cloud-factory-cf-sd2y). */
  stdout: Uint8Array;
  stderr: string;
  timedOut: boolean;
  missing: boolean;
}

function runFind(findBinary: string, root: string, timeoutMs: number): Promise<FindRun> {
  return new Promise((resolve) => {
    const child = spawn(findBinary, [root, ...FIND_EXPRESSION], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // No shell: the workspace path is data, not code.
      shell: false,
    });

    const chunks: Uint8Array[] = [];
    // `Uint8Array<ArrayBufferLike>` vs `Uint8Array<ArrayBuffer>`: the shim has no Buffer, and
    // every read path here treats the value opaquely, so the wide type is used throughout.
    let stdout: Uint8Array = new Uint8Array(0);
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let missing = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Uint8Array) => {
      // Keep the bytes. A `find -print0` entry can be split across chunks anywhere,
      // including inside a multi-byte character, so decoding per chunk corrupts the name.
      chunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: { toString(): string }) => {
      stderr += chunk.toString();
    });
    child.on('error', (err: { code?: string; message?: string }) => {
      if (err.code === 'ENOENT') missing = true;
      else stderr += err.message ?? 'spawn failed';
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr, timedOut, missing });
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout = concatBytes(chunks);
      resolve({ code, stdout, stderr, timedOut, missing });
    });
  });
}

/**
 * Complete-or-refuse directory walk, used only when `find` is not installed. It prunes
 * nothing, and anything it cannot read is an error rather than a gap.
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

        let entries: Array<{ name: Uint8Array; isSocket(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
        try {
          // Names as bytes: `readdir` with the default encoding replaces invalid UTF-8 with
          // U+FFFD, which would produce a path that cannot mask the real file
          // (cloud-factory-cf-sd2y, fallback walk).
          entries = await (
            fs as unknown as {
              readdir(
                dir: string,
                options: { withFileTypes: true; encoding: 'buffer' },
              ): Promise<Array<{ name: Uint8Array; isSocket(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>>;
            }
          ).readdir(dir, { withFileTypes: true, encoding: 'buffer' });
        } catch (err) {
          throw new SocketScanError(
            `could not read '${dir}' while scanning for host Unix sockets: ${(err as Error).message}. ${FIX_HINT}`,
          );
        }

        const found: string[] = [];
        const next: Array<{ dir: string; depth: number }> = [];
        const decoder = new UTF8_DECODER('utf-8', { fatal: true });
        for (const entry of entries) {
          let name: string;
          try {
            name = decoder.decode(entry.name);
          } catch {
            // A name that is not valid UTF-8 has no string form, so it cannot be handed to
            // bubblewrap to mask. Sockets and symlinks must refuse; other entries cannot be
            // dialled and are skipped rather than blocking every command in the workspace.
            if (entry.isSocket() || entry.isSymbolicLink()) {
              throw new SocketScanError(
                `socket scan found a ${entry.isSocket() ? 'socket' : 'symlink'} whose name is not valid UTF-8 under '${dir}' and cannot be masked. ${FIX_HINT}`,
              );
            }
            continue;
          }
          const full = path.join(dir, name);
          // `readdir({withFileTypes:true})` reports lstat semantics: a symlink is neither
          // a socket nor a directory here, so links are not followed. One that reaches a
          // socket is exactly what `find`'s `-xtype s` catches, and it is checked below.
          if (isSocketEntry(entry)) {
            found.push(full);
          } else if (isSymbolicLinkEntry(entry)) {
            const target = await socketTarget(full);
            if (target !== null) found.push(full);
          } else if (entry.isDirectory()) {
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
 * `Dirent`/`Stats` here come from this package's hand-written `node-env.d.ts` shim,
 * which declares a subset of the real module; Node provides `isSocket` at runtime, and a
 * `.d.ts` edit has no covering suite (the fast gate refuses unmapped source,
 * cloud-factory-cf-llyg), so the narrow cast keeps the shim untouched.
 */
type SocketEntry = { isSocket(): boolean };

function isSocketEntry(entry: unknown): boolean {
  return (entry as SocketEntry).isSocket();
}

/** `Dirent.isSymbolicLink`, which the shim does not declare either. */
function isSymbolicLinkEntry(entry: unknown): boolean {
  return (entry as { isSymbolicLink(): boolean }).isSymbolicLink();
}

/** The real path a symlink reaches when that target is a socket, else `null`. */
async function socketTarget(link: string): Promise<string | null> {
  try {
    const real = await fs.realpath(link);
    const stat = await (fs as unknown as {
      lstat(target: string): Promise<SocketEntry>;
    }).lstat(real);
    return stat.isSocket() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Every socket the sandbox must mask for `root`: sockets in the workspace plus symlinks
 * that reach one. Throws `SocketScanError` rather than return a partial answer.
 */
/**
 * Absolute locations of `find`, in preference order. `find` is **never** resolved through
 * `PATH`: an `npm`-style `PATH` commonly starts with the workspace's `node_modules/.bin`,
 * so a repository could ship an executable called `find` that exits 0 with no output and
 * have the scan report "no sockets" — the mask would then be applied to nothing
 * (cloud-factory-cf-5vuu, rev-sandbox-4 PATH-hijack finding).
 */
const FIND_BINARIES = ['/usr/bin/find', '/bin/find', '/usr/local/bin/find'] as const;

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

async function resolveFindBinary(root: string): Promise<string | null> {
  const realRoot = await realpathOrNull(path.resolve(root));
  const prefix = realRoot === null ? null : realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  for (const candidate of FIND_BINARIES) {
    const real = await realpathOrNull(candidate);
    if (real === null) continue;
    // Belt and braces on top of the absolute path: never execute a `find` that lives
    // inside the workspace being scanned.
    if (prefix !== null && (real === realRoot || real.startsWith(prefix))) continue;
    return real;
  }
  return null;
}

export async function scanWorkspaceSockets(
  root: string,
  options: SocketScanOptions = {},
): Promise<SocketScanResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const findBinary = await resolveFindBinary(root);
  if (findBinary === null) {
    // No trustworthy `find` on this host: use the complete-or-refuse walk, which needs no
    // external binary at all.
    const walk = await walkWorkspaceSockets(root, options);
    return {
      sockets: walk.sockets,
      source: 'walk',
      dirsScanned: walk.dirsScanned,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const result = await runFind(findBinary, root, timeoutMs);

  if (result.missing) {
    // No `find` on this host: fall back to the complete-or-refuse walk.
    const walk = await walkWorkspaceSockets(root, options);
    return {
      sockets: walk.sockets,
      source: 'walk',
      dirsScanned: walk.dirsScanned,
      elapsedMs: Date.now() - startedAt,
    };
  }

  if (result.timedOut) {
    throw new SocketScanError(
      `socket scan exceeded its ${timeoutMs}ms budget under '${root}'. ${FIX_HINT}`,
    );
  }
  if (result.code !== 0) {
    // `find` exits non-zero when it could not read everything, which is exactly the case
    // that must not be treated as "no sockets".
    throw new SocketScanError(
      `socket scan could not read the whole workspace under '${root}': ${result.stderr.trim() || `find exited ${result.code}`}. ${FIX_HINT}`,
    );
  }

  const parsed = parseFindOutput(result.stdout, root);
  if (parsed.undecodable > 0) {
    // A name that is not valid UTF-8 cannot be passed to `bwrap` as an argument, so the
    // mask cannot cover it. Refusing is the fail-closed answer: masking a mangled path and
    // returning success would leave the real socket reachable (cloud-factory-cf-sd2y).
    throw new SocketScanError(
      `socket scan found ${parsed.undecodable} workspace socket name(s) that are not valid UTF-8 and cannot be masked. ${FIX_HINT}`,
    );
  }

  // Mask the path inside the workspace. For a symlink that is the link itself: the mount
  // follows it, so the target socket becomes unreachable under either name.
  return {
    sockets: [...new Set(parsed.sockets)].sort(),
    source: 'find',
    dirsScanned: 0,
    elapsedMs: Date.now() - startedAt,
  };
}
