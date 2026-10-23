import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as net from 'node:net';
import {
  parseFindOutput,
  scanWorkspaceSockets,
  walkWorkspaceSockets,
  SocketScanError,
} from '../src/tools/socket-scan.ts';

/**
 * Discovery of host Unix sockets in the `network-none` sandbox is a security control, so
 * it must be **complete** (a missed socket is a host-network escape), and cheap enough to
 * run before every command. It asks the filesystem (`find -type s -print0`) rather than
 * parsing `/proc/net/unix`, because that table reports the string `bind()` was given —
 * which produced five escapes in a day (`cloud-factory-cf-5vuu`, `-khu9`, `-14xh`, and
 * two more in review). These tests use real sockets and need no bubblewrap.
 */

async function tempWorkspace(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A listening Unix socket at `socketPath`, closed by the returned function. */
async function listenUnixSocket(socketPath: string): Promise<() => Promise<void>> {
  const server = net.createServer((connection) => connection.end());
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(socketPath, { force: true }).catch(() => {});
  };
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

test('parseFindOutput: NUL-separated paths, so a name containing a newline stays one entry', () => {
  const root = '/srv/app';
  const stdout = utf8(['/srv/app/a.sock', '/srv/app/b\nc.sock', '/srv/app/d ir .sock', ''].join('\0'));
  assert.deepEqual(parseFindOutput(stdout, root).sockets.sort(), [
    '/srv/app/a.sock',
    '/srv/app/b\nc.sock',
    '/srv/app/d ir .sock',
  ].sort());
  assert.equal(parseFindOutput(stdout, root).undecodable, 0);
});

test('parseFindOutput: a multi-byte name split across stream chunks is decoded once (cloud-factory-cf-sd2y)', () => {
  const root = '/srv/app';
  const name = `${'/srv/app/'}${'\u00e9'.repeat(30)}-0045.sock`;
  const bytes = utf8(`${name}\0`);
  // Every split point must decode identically: the parse sees the concatenated buffer, so a
  // boundary inside a two-byte character is not the parse's problem.
  for (const cut of [1, 2, 3, 7, 31, bytes.length - 1]) {
    const stitched = new Uint8Array([
      ...bytes.subarray(0, cut),
      ...bytes.subarray(cut),
    ]);
    const parsed = parseFindOutput(stitched, root);
    assert.deepEqual(parsed.sockets, [name], `cut at ${cut}`);
    assert.equal(parsed.undecodable, 0);
  }
});

test('parseFindOutput: an entry that is not valid UTF-8 is reported, not mangled (cloud-factory-cf-sd2y)', () => {
  const root = '/srv/app';
  // 0xff is not a valid UTF-8 byte: there is no string form to hand to bwrap, so the scan
  // must refuse rather than mask a replacement-character path.
  const bytes = new Uint8Array([...utf8('/srv/app/bad'), 0xff, ...utf8('.sock'), 0]);
  const parsed = parseFindOutput(bytes, root);
  assert.deepEqual(parsed.sockets, []);
  assert.equal(parsed.undecodable, 1);
});

test('parseFindOutput: only paths inside the workspace are kept', () => {
  const stdout = utf8(['/srv/application/decoy.sock', '/srv/app/real.sock'].join('\0'));
  assert.deepEqual(parseFindOutput(stdout, '/srv/app').sockets, ['/srv/app/real.sock']);
});

test('scanWorkspaceSockets: finds a socket under node_modules (cloud-factory-cf-5vuu)', async () => {
  const root = await tempWorkspace('fc-scan-prune-');
  const deep = path.join(root, 'node_modules', 'pkg', 'dist');
  await fs.mkdir(deep, { recursive: true });
  const close = await listenUnixSocket(path.join(deep, 'hidden.sock'));
  try {
    const result = await scanWorkspaceSockets(root);
    assert.deepEqual(result.sockets, [path.join(deep, 'hidden.sock')]);
    assert.equal(result.source, 'find');
  } finally {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceSockets: a socket created after an earlier scan is found by the next one (cloud-factory-cf-vy8o)', async () => {
  const root = await tempWorkspace('fc-scan-fresh-');
  try {
    const before = await scanWorkspaceSockets(root);
    assert.deepEqual(before.sockets, []);

    const socketPath = path.join(root, 'appeared.sock');
    const close = await listenUnixSocket(socketPath);
    try {
      const after = await scanWorkspaceSockets(root);
      assert.deepEqual(after.sockets, [socketPath]);
    } finally {
      await close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceSockets: a name with a trailing space, a newline, or `..` needs no special case', async () => {
  const root = await tempWorkspace('fc-scan-names-');
  const names = ['host.sock ', 'two  spaces.sock', 'new\nline.sock'];
  const closers: Array<() => Promise<void>> = [];
  try {
    for (const name of names) closers.push(await listenUnixSocket(path.join(root, name)));
    const result = await scanWorkspaceSockets(root);
    assert.deepEqual(result.sockets, names.map((name) => path.join(root, name)).sort());
  } finally {
    for (const close of closers) await close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceSockets: a relative bind inside the workspace is found by type, whatever it was called', async () => {
  const root = await tempWorkspace('fc-scan-relative-');
  const previous = process.cwd();
  const server = net.createServer((connection) => connection.end());
  try {
    process.chdir(root);
    await new Promise<void>((resolve) => server.listen('relative.sock', () => resolve()));
    process.chdir(previous);
    const result = await scanWorkspaceSockets(root);
    assert.deepEqual(result.sockets, [path.join(root, 'relative.sock')]);
  } finally {
    process.chdir(previous);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceSockets: a symlink inside the workspace that reaches a socket is reported', async () => {
  const base = await tempWorkspace('fc-scan-symlink-');
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  const outsideSock = path.join(outside, 'host.sock');
  const close = await listenUnixSocket(outsideSock);
  try {
    await fs.symlink(outsideSock, path.join(root, 'link.sock'));
    const result = await scanWorkspaceSockets(root);
    // Reported by the in-workspace name: that is the path the sandbox would dial, and the
    // mount follows the link to the socket it reaches.
    assert.deepEqual(result.sockets, [path.join(root, 'link.sock')]);
  } finally {
    await close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('scanWorkspaceSockets: an unrelated socket outside the workspace is left alone', async () => {
  const base = await tempWorkspace('fc-scan-unrelated-');
  const root = path.join(base, 'workspace');
  await fs.mkdir(root, { recursive: true });
  const close = await listenUnixSocket(path.join(base, 'other.sock'));
  try {
    const result = await scanWorkspaceSockets(root);
    // Masking is a workspace control, not a system-wide one: an unrelated socket (an
    // ssh-agent, say) must stay usable.
    assert.deepEqual(result.sockets, []);
  } finally {
    await close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('scanWorkspaceSockets: refuses instead of masking nothing when the scan cannot read the workspace', async () => {
  const root = await tempWorkspace('fc-scan-partial-');
  try {
    // `find` exits non-zero when it cannot read everything, and a partial read must never
    // be reported as "no sockets": that is the failure mode where the mask is applied to
    // nothing while a host socket sits in the unreadable part of the tree.
    await assert.rejects(
      () => scanWorkspaceSockets(path.join(root, 'does-not-exist')),
      (err: unknown) => {
        assert.ok(err instanceof SocketScanError);
        assert.match(err.message, /could not read the whole workspace/);
        assert.match(err.message, /socketScan/);
        return true;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceSockets: refuses when an unreadable subtree stops find (unless root)', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root ignores directory permissions');
    return;
  }
  const root = await tempWorkspace('fc-scan-locked-');
  const locked = path.join(root, 'locked');
  await fs.mkdir(locked);
  await fs.chmod(locked, 0o000);
  try {
    await assert.rejects(
      () => scanWorkspaceSockets(root),
      (err: unknown) => err instanceof SocketScanError && /could not read/.test(err.message),
    );
  } finally {
    await fs.chmod(locked, 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('walkWorkspaceSockets: the no-find fallback prunes nothing and finds deep sockets', async () => {
  const root = await tempWorkspace('fc-walk-deep-');
  const deep = path.join(root, 'node_modules', 'pkg', 'dist', 'nested');
  await fs.mkdir(deep, { recursive: true });
  const close = await listenUnixSocket(path.join(deep, 'deep.sock'));
  try {
    const result = await walkWorkspaceSockets(root);
    assert.deepEqual(result.sockets, [path.join(deep, 'deep.sock')]);
    assert.ok(result.dirsScanned >= 5, `expected the walk to descend, scanned ${result.dirsScanned}`);
  } finally {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('walkWorkspaceSockets: refuses when the nesting or directory budget is exceeded', async () => {
  const root = await tempWorkspace('fc-walk-budget-');
  await fs.mkdir(path.join(root, 'a', 'b', 'c'), { recursive: true });
  try {
    await assert.rejects(
      () => walkWorkspaceSockets(root, { maxDepth: 1 }),
      (err: unknown) => err instanceof SocketScanError && /nesting exceeds/.test(err.message),
    );
    await assert.rejects(
      () => walkWorkspaceSockets(root, { maxDirs: 2 }),
      (err: unknown) => err instanceof SocketScanError && /more than 2 directories/.test(err.message),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('walkWorkspaceSockets: refuses instead of failing open when a directory cannot be read', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root ignores directory permissions');
    return;
  }
  const root = await tempWorkspace('fc-walk-unreadable-');
  const locked = path.join(root, 'locked');
  await fs.mkdir(locked);
  await fs.chmod(locked, 0o000);
  try {
    await assert.rejects(
      () => walkWorkspaceSockets(root),
      (err: unknown) => err instanceof SocketScanError && /could not read/.test(err.message),
    );
  } finally {
    await fs.chmod(locked, 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('scanWorkspaceSockets: a workspace-provided `find` on PATH cannot silence the scan (PATH hijack)', async () => {
  const root = await tempWorkspace('fc-scan-path-');
  const binDir = path.join(root, 'node_modules', '.bin');
  await fs.mkdir(binDir, { recursive: true });
  // What a hostile (or merely odd) repository can ship: a `find` that claims the workspace
  // is empty. If discovery resolved `find` through PATH — and an npm-style PATH starts
  // with the workspace's .bin — the mask would be applied to nothing.
  const fakeFind = path.join(binDir, 'find');
  await fs.writeFile(fakeFind, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const close = await listenUnixSocket(path.join(root, 'host.sock'));

  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    const result = await scanWorkspaceSockets(root);
    // Absolute-path resolution means the real `find` runs, so the socket is still found.
    assert.ok(result.sockets.includes(path.join(root, 'host.sock')), `expected host.sock, got ${JSON.stringify(result.sockets)}`);
  } finally {
    process.env.PATH = previousPath;
    await close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceSockets: prefers the system find even when the workspace shadows it', async () => {
  const root = await tempWorkspace('fc-scan-shadow-');
  // A `find` at the workspace root as well, in case anything ever resolves relatively.
  await fs.writeFile(path.join(root, 'find'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const close = await listenUnixSocket(path.join(root, 'deep.sock'));
  try {
    const result = await scanWorkspaceSockets(root);
    assert.deepEqual(result.sockets, [path.join(root, 'deep.sock')]);
    assert.equal(result.source, 'find');
  } finally {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('scanWorkspaceSockets: a non-ASCII socket name is found exactly (cloud-factory-cf-sd2y)', async () => {
  const root = await tempWorkspace('fc-scan-utf8-');
  const name = `${'\u00e9'.repeat(30)}-0045.sock`;
  const close = await listenUnixSocket(path.join(root, name));
  try {
    const result = await scanWorkspaceSockets(root);
    assert.deepEqual(result.sockets, [path.join(root, name)]);
  } finally {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceSockets: refuses when a socket name is not valid UTF-8 (cloud-factory-cf-sd2y)', async (t) => {
  const root = await tempWorkspace('fc-scan-nonutf8-');
  // A byte path, because no JS string can name this file: 0xff is not valid UTF-8.
  const BufferCtor = (
    globalThis as unknown as {
      Buffer: { from(input: string | number[]): Uint8Array; concat(parts: Uint8Array[]): Uint8Array };
    }
  ).Buffer;
  const socketPath = BufferCtor.concat([
    BufferCtor.from(`${root}/`),
    BufferCtor.from([0x62, 0x61, 0x64, 0xff]),
    BufferCtor.from('.sock'),
  ]);

  const server = net.createServer((connection) => connection.end());
  try {
    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(socketPath as unknown as string, () => resolve());
    });
  } catch {
    t.skip('this platform cannot create a socket with a non-UTF-8 name');
    return;
  }

  try {
    // The name cannot be represented as a string, so it cannot be handed to bubblewrap to
    // mask. Refusing is the fail-closed answer: masking a replacement-character path and
    // returning success would leave the real socket reachable.
    await assert.rejects(
      () => scanWorkspaceSockets(root),
      (err: unknown) => err instanceof SocketScanError && /not valid UTF-8/.test(err.message),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
