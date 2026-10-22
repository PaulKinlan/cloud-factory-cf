import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as net from 'node:net';
import { scanWorkspaceSockets, SocketScanError, SKIPPED_DIRS } from '../src/tools/socket-scan.ts';

/**
 * The `network-none` sandbox masks host Unix sockets it finds inside the workspace,
 * so the scan is a security control: it must find what is there, stay bounded, and
 * refuse rather than return a partial answer (cloud-factory-cf-5vuu, -6rne, -vy8o,
 * -bcra). These tests need no bubblewrap — they call the scan directly.
 */

async function tempWorkspace(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A listening Unix socket at `socketPath`, closed by the returned function. */
async function listenUnixSocket(
  socketPath: string,
): Promise<() => Promise<void>> {
  const server = net.createServer((connection) => connection.end());
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(socketPath, { force: true }).catch(() => {});
  };
}

test('scanWorkspaceSockets: finds sockets anywhere in the tree, sorted', async () => {
  const root = await tempWorkspace('fc-scan-find-');
  const closeA = await listenUnixSocket(path.join(root, 'b.sock'));
  const nested = path.join(root, 'src', 'deep');
  await fs.mkdir(nested, { recursive: true });
  const closeB = await listenUnixSocket(path.join(nested, 'a.sock'));
  try {
    const result = await scanWorkspaceSockets(root);
    assert.deepEqual(result.sockets, [
      path.join(root, 'b.sock'),
      path.join(nested, 'a.sock'),
    ].sort());
    assert.ok(result.dirsScanned >= 3, `expected to walk into src/deep, scanned ${result.dirsScanned}`);
  } finally {
    await closeA();
    await closeB();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceSockets: skips dependency and build directories instead of walking them', async () => {
  const root = await tempWorkspace('fc-scan-skip-');
  const deep = path.join(root, 'node_modules', 'pkg', 'dist', 'nested');
  await fs.mkdir(deep, { recursive: true });
  const close = await listenUnixSocket(path.join(deep, 'hidden.sock'));
  try {
    const result = await scanWorkspaceSockets(root);
    assert.ok(SKIPPED_DIRS.has('node_modules'));
    assert.equal(result.sockets.length, 0, 'a socket under node_modules is outside the scan by design');
    // Only the root itself is read: the skip list is what keeps a real workspace cheap.
    assert.equal(result.dirsScanned, 1);
  } finally {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceSockets: refuses instead of truncating when the directory budget is exceeded', async () => {
  const root = await tempWorkspace('fc-scan-dirs-');
  for (const name of ['a', 'b', 'c', 'd']) {
    await fs.mkdir(path.join(root, name));
  }
  try {
    await assert.rejects(
      () => scanWorkspaceSockets(root, { maxDirs: 2 }),
      (err: unknown) => {
        assert.ok(err instanceof SocketScanError);
        assert.match(err.message, /more than 2 directories/);
        assert.match(err.message, /socketScan/);
        return true;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceSockets: refuses when the nesting budget is exceeded', async () => {
  const root = await tempWorkspace('fc-scan-depth-');
  await fs.mkdir(path.join(root, 'a', 'b', 'c', 'd'), { recursive: true });
  try {
    await assert.rejects(
      () => scanWorkspaceSockets(root, { maxDepth: 2 }),
      (err: unknown) => {
        assert.ok(err instanceof SocketScanError);
        assert.match(err.message, /nesting exceeds the 2-level/);
        return true;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceSockets: refuses instead of failing open when a directory cannot be read', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root ignores directory permissions');
    return;
  }
  const root = await tempWorkspace('fc-scan-unreadable-');
  const locked = path.join(root, 'locked');
  await fs.mkdir(locked);
  await fs.chmod(locked, 0o000);
  try {
    await assert.rejects(
      () => scanWorkspaceSockets(root),
      (err: unknown) => {
        assert.ok(err instanceof SocketScanError);
        assert.match(err.message, /could not read/);
        return true;
      },
    );
  } finally {
    await fs.chmod(locked, 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceSockets: a socket created after the previous scan is found by the next one (cloud-factory-cf-vy8o)', async () => {
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
