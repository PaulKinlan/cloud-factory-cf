import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as net from 'node:net';
import {
  analyseSocketTable,
  readHostUnixSocketTable,
  scanWorkspaceSockets,
  socketsUnderRoot,
  walkWorkspaceSockets,
  SocketScanError,
} from '../src/tools/socket-scan.ts';

/**
 * The `network-none` sandbox masks host Unix sockets it finds inside the workspace,
 * so discovery is a security control: it must be **complete** (a pruned directory is
 * an escape — cloud-factory-cf-5vuu), cheap (a full walk per command is the cost
 * problem — cloud-factory-cf-6rne), and never silently partial (`SocketScanError`).
 * These tests need no bubblewrap.
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

const HEADER =
  'Num       RefCount Protocol Flags    Type St Inode Path';

test('socketsUnderRoot: parses the kernel table, keeping only paths inside the workspace', () => {
  const table = [
    HEADER,
    '0000000000000000: 00000002 00000000 00010000 0001 01 7092884 /srv/app/node_modules/pkg/host.sock',
    '0000000000000000: 00000002 00000000 00010000 0001 01 7092885 /srv/app/src/app.sock',
    '0000000000000000: 00000002 00000000 00010000 0001 01 7092886 /srv/application/decoy.sock',
    '0000000000000000: 00000002 00000000 00010000 0001 01 7092887 /srv/app/a socket with spaces.sock',
    '0000000000000000: 00000002 00000000 00010000 0001 01 7092888 @abstract-name',
    '0000000000000000: 00000002 00000000 00010000 0001 01 7092889 /run/systemd/private',
    '0000000000000000: 00000002 00000000 00010000 0001 01 7092890',
    '',
  ].join('\n');

  // Table order is preserved here; `scanWorkspaceSockets` sorts before returning.
  assert.deepEqual(socketsUnderRoot(table, '/srv/app').sort(), [
    '/srv/app/node_modules/pkg/host.sock',
    '/srv/app/src/app.sock',
    '/srv/app/a socket with spaces.sock',
  ].sort());
});

test('socketsUnderRoot: a prefix that only looks like the workspace is not inside it', () => {
  const table = [
    HEADER,
    '0000000000000000: 00000002 00000000 00010000 0001 01 1 /srv/app-other/x.sock',
    '0000000000000000: 00000002 00000000 00010000 0001 01 2 /srv/app/x.sock',
  ].join('\n');
  assert.deepEqual(socketsUnderRoot(table, '/srv/app'), ['/srv/app/x.sock']);
});

test('scanWorkspaceSockets: finds a socket under node_modules (cloud-factory-cf-5vuu: no pruned subtrees)', async () => {
  const root = await tempWorkspace('fc-scan-prune-');
  const deep = path.join(root, 'node_modules', 'pkg', 'dist');
  await fs.mkdir(deep, { recursive: true });
  const close = await listenUnixSocket(path.join(deep, 'hidden.sock'));
  try {
    const result = await scanWorkspaceSockets(root);
    assert.deepEqual(result.sockets, [path.join(deep, 'hidden.sock')]);
    // The kernel table answers this, so no directory walk was needed at all.
    assert.equal(result.source, 'proc');
    assert.ok(result.elapsedMs < 500, `kernel table scan took ${result.elapsedMs}ms`);
  } finally {
    await close();
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

test('readHostUnixSocketTable: returns the table on this host (the primary source)', async () => {
  const table = await readHostUnixSocketTable();
  // Linux publishes it; if this ever becomes null the fallback walk takes over and
  // the tests below cover that path.
  if (table === null) return;
  assert.match(table, /Num|RefCount/);
});

test('walkWorkspaceSockets: the fallback prunes nothing and finds deep sockets', async () => {
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

test('walkWorkspaceSockets: refuses instead of truncating when the directory budget is exceeded', async () => {
  const root = await tempWorkspace('fc-walk-dirs-');
  for (const name of ['a', 'b', 'c', 'd']) await fs.mkdir(path.join(root, name));
  try {
    await assert.rejects(
      () => walkWorkspaceSockets(root, { maxDirs: 2 }),
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

test('walkWorkspaceSockets: refuses when the nesting budget is exceeded', async () => {
  const root = await tempWorkspace('fc-walk-depth-');
  await fs.mkdir(path.join(root, 'a', 'b', 'c', 'd'), { recursive: true });
  try {
    await assert.rejects(
      () => walkWorkspaceSockets(root, { maxDepth: 2 }),
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


test('analyseSocketTable: a relative pathname is reported, not silently dropped (cloud-factory-cf-khu9)', () => {
  const table = [
    HEADER,
    '0000000000000000: 00000002 00000000 00010000 0001 01 1 /srv/app/abs.sock',
    '0000000000000000: 00000002 00000000 00010000 0001 01 2 relative.sock',
    '0000000000000000: 00000002 00000000 00010000 0001 01 3 sub/dir/other.sock',
    '0000000000000000: 00000002 00000000 00010000 0001 01 4 @abstract',
  ].join('\n');

  const analysis = analyseSocketTable(table, '/srv/app');
  assert.deepEqual(analysis.sockets, ['/srv/app/abs.sock']);
  // `bind("relative.sock")` from a cwd inside the workspace is an escape, so the scan
  // cannot trust an absolute-only answer for this table.
  assert.equal(analysis.relativePaths, true);

  const absoluteOnly = analyseSocketTable(
    [HEADER, '0000000000000000: 00000002 00000000 00010000 0001 01 1 /srv/app/abs.sock'].join('\n'),
    '/srv/app',
  );
  assert.equal(absoluteOnly.relativePaths, false);
});

test('scanWorkspaceSockets: a relative row forces the complete walk and still finds the socket (cloud-factory-cf-khu9)', async () => {
  const root = await tempWorkspace('fc-scan-relative-');
  const deep = path.join(root, 'node_modules', 'pkg');
  await fs.mkdir(deep, { recursive: true });
  const close = await listenUnixSocket(path.join(deep, 'relative.sock'));
  const tablePath = path.join(root, '..', `${path.basename(root)}-table`);
  try {
    // A table shaped like the kernel's after `bind("relative.sock")` from a cwd inside
    // the workspace: the socket is real, but the row cannot place it.
    await fs.writeFile(
      tablePath,
      [HEADER, '0000000000000000: 00000002 00000000 00010000 0001 01 1 relative.sock'].join('\n'),
    );

    const result = await scanWorkspaceSockets(root, { tablePath });
    assert.equal(result.source, 'walk');
    assert.deepEqual(result.sockets, [path.join(deep, 'relative.sock')]);
  } finally {
    await close();
    await fs.rm(tablePath, { force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('analyseSocketTable: an absolute path with ".." is normalised into the workspace', () => {
  const table = [
    HEADER,
    '0000000000000000: 00000002 00000000 00010000 0001 01 1 /srv/other/../app/host.sock',
    '0000000000000000: 00000002 00000000 00010000 0001 01 2 /srv/app/sub/../../elsewhere/x.sock',
  ].join('\n');

  const analysis = analyseSocketTable(table, '/srv/app');
  // The kernel keeps the pathname `bind()` received, so the first row is a socket inside
  // the workspace that a plain string-prefix test would have discarded.
  assert.deepEqual(analysis.sockets, ['/srv/app/host.sock']);
  assert.deepEqual(analysis.outside, ['/srv/elsewhere/x.sock']);
});

test('scanWorkspaceSockets: a socket bound through a symlink into the workspace is found', async () => {
  const base = await tempWorkspace('fc-scan-symlink-');
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.symlink(root, path.join(outside, 'link'));
  const close = await listenUnixSocket(path.join(root, 'host.sock'));
  try {
    // Bound as `/base/outside/link/host.sock`: lexically outside the workspace, but the
    // same file, and the same bind mount masks it (mount targets resolve symlinks).
    const tablePath = path.join(base, 'table');
    await fs.writeFile(
      tablePath,
      [
        HEADER,
        `0000000000000000: 00000002 00000000 00010000 0001 01 1 ${path.join(outside, 'link', 'host.sock')}`,
      ].join('\n'),
    );

    const result = await scanWorkspaceSockets(root, { tablePath });
    assert.equal(result.source, 'proc');
    // The realpath is what gets masked: that is the path the sandbox would dial.
    assert.deepEqual(result.sockets, [path.join(root, 'host.sock')]);
  } finally {
    await close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('scanWorkspaceSockets: an unrelated host socket outside the workspace is left alone', async () => {
  const base = await tempWorkspace('fc-scan-unrelated-');
  const root = path.join(base, 'workspace');
  await fs.mkdir(root, { recursive: true });
  const outsideSock = path.join(base, 'other.sock');
  const close = await listenUnixSocket(outsideSock);
  try {
    const tablePath = path.join(base, 'table');
    await fs.writeFile(
      tablePath,
      [HEADER, `0000000000000000: 00000002 00000000 00010000 0001 01 1 ${outsideSock}`].join('\n'),
    );

    const result = await scanWorkspaceSockets(root, { tablePath });
    // Masking is a workspace control, not a system-wide one: an unrelated socket (an
    // ssh-agent, say) must stay usable.
    assert.deepEqual(result.sockets, []);
  } finally {
    await close();
    await fs.rm(base, { recursive: true, force: true });
  }
});
