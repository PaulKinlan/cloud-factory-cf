import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as http from 'node:http';
import * as net from 'node:net';
import { createLocalTools } from '../src/index.ts';

test('createLocalTools: provides file operations and blocks path traversal', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-cli-tools-'));
  try {
    const tools = createLocalTools({ cwd: tmpDir });
    const writeTool = tools.find((t) => t.name === 'write_file')!;
    const readTool = tools.find((t) => t.name === 'read_file')!;
    const listTool = tools.find((t) => t.name === 'list_files')!;

    assert.ok(writeTool);
    assert.ok(readTool);
    assert.ok(listTool);

    // Write file
    const writeRes = (await writeTool.handler({ path: 'sub/test.txt', content: 'hello world' })) as any;
    assert.equal(writeRes.written, true);

    // Read file
    const readRes = (await readTool.handler({ path: 'sub/test.txt' })) as any;
    assert.equal(readRes.content, 'hello world');

    // List files
    const listRes = (await listTool.handler({ path: 'sub' })) as any;
    assert.equal(listRes.entries.length, 1);
    assert.equal(listRes.entries[0].name, 'test.txt');

    // Block path traversal
    await assert.rejects(
      async () => {
        await readTool.handler({ path: '../../etc/passwd' });
      },
      /Path traversal denied/,
    );

    // Block sibling prefix escape (fixes cloud-factory-cf-df5)
    const siblingDir = tmpDir + '-sibling';
    await fs.mkdir(siblingDir, { recursive: true });
    await fs.writeFile(path.join(siblingDir, 'marker'), 'secret');
    await assert.rejects(
      async () => {
        await readTool.handler({ path: `../${path.basename(siblingDir)}/marker` });
      },
      /Path traversal denied/,
    );
    await fs.rm(siblingDir, { recursive: true, force: true });

    // Block symlink directory escape (fixes cloud-factory-cf-df5)
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-cli-outside-'));
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'top-secret');
    await fs.symlink(outsideDir, path.join(tmpDir, 'symlink-out'));

    await assert.rejects(
      async () => {
        await readTool.handler({ path: 'symlink-out/secret.txt' });
      },
      /Path traversal denied/,
    );
    await fs.rm(outsideDir, { recursive: true, force: true });

    // Test explicit unsandboxed mode (sandbox: 'none') still enforces basic text containment checks
    const unsandboxedTools = createLocalTools({ cwd: tmpDir, sandbox: 'none' });
    const unsandboxedExec = unsandboxedTools.find((t) => t.name === 'exec_command')!;

    await assert.rejects(
      async () => {
        await unsandboxedExec.handler({ command: 'printf ESCAPED > $CF_REVIEW_OUT' });
      },
      /Command containment violation/,
    );

    await assert.rejects(
      async () => {
        await unsandboxedExec.handler({ command: 'echo hello > out.txt' });
      },
      /Command containment violation: shell redirection/,
    );

    await assert.rejects(
      async () => {
        await unsandboxedExec.handler({ command: 'echo $HOME' });
      },
      /Command containment violation: shell variable expansion/,
    );

    await assert.rejects(
      async () => {
        await unsandboxedExec.handler({ command: 'cat ../outside.txt' });
      },
      /Command containment violation: traversal '\.\.' is not allowed in command/,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

/**
 * A GitHub-hosted runner ships bubblewrap but forbids the unprivileged user namespace it
 * needs ("bwrap: setting up uid map: Permission denied"), so the isolation assertions below
 * can only run where bwrap actually works. The sandbox still fails closed everywhere — this
 * probe decides whether the contract can be EXERCISED here, and a skip says so out loud
 * rather than pretending the assertions passed (cloud-factory-cf-n2h0).
 */
async function bwrapUnavailableReason(): Promise<string | false> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const probe = spawn('/usr/bin/bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', 'true'], {
      timeout: 10_000,
    });
    let stderr = '';
    probe.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    probe.on('error', (err) => resolve(`bubblewrap is not usable here (${err.message})`));
    probe.on('close', (code) =>
      resolve(code === 0 ? false : `bubblewrap cannot start here (exit ${code}: ${stderr.trim().slice(0, 160)})`),
    );
  });
}

test('createLocalTools: exec_command isolation under bubblewrap', async (t) => {
  const reason = await bwrapUnavailableReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-cli-sandbox-'));
  try {
    const tools = createLocalTools({ cwd: tmpDir });
    const execTool = tools.find((t2) => t2.name === 'exec_command')!;
    assert.ok(execTool);

    // The sandboxed command runs for real through bwrap.
    const execRes = (await execTool.handler({ command: 'node -e "console.log(12345)"' })) as any;
    assert.match(execRes.stdout, /12345/);

    // Test bwrap sandbox blocks host filesystem mutations from dynamic code (fixes cloud-factory-cf-a9h)
    const hostEscapePath = path.join(os.tmpdir(), 'cf-escape-test-host');
    await fs.rm(hostEscapePath, { force: true });
    const bwrapEncodedPath = Buffer.from(hostEscapePath).toString('base64');
    const dynamicCmd = `node -e 'require("fs").writeFileSync(Buffer.from("${bwrapEncodedPath}","base64").toString(),"ESCAPED")'`;

    await execTool.handler({ command: dynamicCmd });
    const hostEscaped = await fs.stat(hostEscapePath).then(() => true).catch(() => false);
    assert.equal(hostEscaped, false, 'Host filesystem outside workspace must not be modified by dynamic command');

    // Test bwrap sandbox blocks reading host files outside workspace (fixes cloud-factory-cf-7c2)
    const baseDir = await fs.mkdtemp(path.join(os.homedir(), 'cf-review-test-'));
    try {
      const privateMarkerPath = path.join(baseDir, 'private-marker');
      await fs.writeFile(privateMarkerPath, 'PRIVATE_OUTSIDE_WORKSPACE');
      await assert.rejects(
        async () => {
          await execTool.handler({ command: `cat ${privateMarkerPath}` });
        },
        /No such file or directory|Command failed/,
      );
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }

    // Test bwrap sandbox does not expose Node parent directory (fixes cloud-factory-cf-buy)
    const nodeParentMarker = path.join(path.dirname(path.dirname(process.execPath)), `cf-review-marker-${process.pid}`);
    try {
      await fs.writeFile(nodeParentMarker, 'PRIVATE_OUTSIDE_WORKSPACE');
      await assert.rejects(
        async () => {
          await execTool.handler({ command: `cat ${nodeParentMarker}` });
        },
        /No such file or directory|Command failed/,
      );
    } finally {
      await fs.rm(nodeParentMarker, { force: true });
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('createLocalTools: exec_command network confinement under bubblewrap (cloud-factory-cf-u8py)', async (t) => {
  const reason = await bwrapUnavailableReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-cli-net-'));
  try {
    // Start a temporary local HTTP server on the host loopback
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('HOST_SERVER_OK');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as net.AddressInfo;
    const localUrl = `http://127.0.0.1:${address.port}`;

    try {
      // Default / host mode: can connect to host loopback
      const hostTools = createLocalTools({ cwd: tmpDir, sandboxNetwork: 'host' });
      const hostExec = hostTools.find((t2) => t2.name === 'exec_command')!;
      const hostRes = (await hostExec.handler({
        command: `node -e 'fetch("${localUrl}").then(r => r.text()).then(t => console.log("CONNECTED:" + t))'`,
      })) as any;
      assert.match(hostRes.stdout, /CONNECTED:HOST_SERVER_OK/);

      // None mode: cannot connect to loopback or metadata IP (169.254.169.254)
      const isolatedTools = createLocalTools({ cwd: tmpDir, sandboxNetwork: 'none' });
      const isolatedExec = isolatedTools.find((t2) => t2.name === 'exec_command')!;

      const localCheck = (await isolatedExec.handler({
        command: `node -e 'fetch("${localUrl}", { signal: AbortSignal.timeout(1000) }).then(() => console.log("CONNECTED")).catch(e => console.log("FAILED:" + (e.cause?.code || e.message)))'`,
      })) as any;
      assert.match(localCheck.stdout, /FAILED:/);
      assert.doesNotMatch(localCheck.stdout, /CONNECTED/);

      const metaCheck = (await isolatedExec.handler({
        command: `node -e 'fetch("http://169.254.169.254:80", { signal: AbortSignal.timeout(1000) }).then(() => console.log("CONNECTED")).catch(e => console.log("FAILED:" + (e.cause?.code || e.message)))'`,
      })) as any;
      assert.match(metaCheck.stdout, /FAILED:/);
      assert.doesNotMatch(metaCheck.stdout, /CONNECTED/);

      // Unix socket isolation test: host Unix domain socket placed in workspace (fixes cloud-factory-cf-5vuu)
      const sockPath = path.join(tmpDir, 'test-host.sock');
      const unixServer = net.createServer((c) => {
        c.write('HOST_SOCKET_REACHED\n');
        c.end();
      });
      await new Promise<void>((resolve) => unixServer.listen(sockPath, () => resolve()));
      try {
        // Mode 'host' can reach the socket
        const hostUnixRes = (await hostExec.handler({
          command: `node -e 'const net = require("net"); net.connect("${sockPath}").on("data", d => console.log(d.toString().trim()))'`,
        })) as any;
        assert.match(hostUnixRes.stdout, /HOST_SOCKET_REACHED/);

        // Mode 'none' cannot reach the host Unix socket because it is masked with /dev/null
        const noneUnixTools = createLocalTools({ cwd: tmpDir, sandboxNetwork: 'none' });
        const noneUnixExec = noneUnixTools.find((t2) => t2.name === 'exec_command')!;
        const noneUnixRes = (await noneUnixExec.handler({
          command: `node -e 'const net = require("net"); net.connect("${sockPath}").on("data", () => console.log("HOST_SOCKET_REACHED")).on("error", e => console.log("MASKED_ERR:" + e.code))'`,
        })) as any;
        assert.match(noneUnixRes.stdout, /MASKED_ERR:/);
        assert.doesNotMatch(noneUnixRes.stdout, /HOST_SOCKET_REACHED/);
      } finally {
        await new Promise<void>((resolve) => unixServer.close(() => resolve()));
        await fs.rm(sockPath, { force: true }).catch(() => {});
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('createLocalTools: exec_command network-none skips ignored dirs and bounds socket scans (cloud-factory-cf-6rne)', async (t) => {
  const reason = await bwrapUnavailableReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-cli-dirs-'));
  try {
    // Create ignored directory trees (e.g. node_modules/pkg/...)
    const nmDir = path.join(tmpDir, 'node_modules', 'large-pkg', 'dist');
    await fs.mkdir(nmDir, { recursive: true });

    const tools = createLocalTools({ cwd: tmpDir, sandboxNetwork: 'none' });
    const execTool = tools.find((t2) => t2.name === 'exec_command')!;

    // Should execute quickly without walking inside node_modules
    const start = Date.now();
    const res = (await execTool.handler({ command: 'node -e "console.log(999)"' })) as any;
    const elapsed = Date.now() - start;
    assert.match(res.stdout, /999/);
    assert.ok(elapsed < 5000, `Execution took ${elapsed}ms, expected < 5000ms`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('createLocalTools: network-none masks a host socket created after an earlier command (cloud-factory-cf-vy8o)', async (t) => {
  const reason = await bwrapUnavailableReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-cli-stale-'));
  try {
    const tools = createLocalTools({ cwd: tmpDir, sandboxNetwork: 'none' });
    const execTool = tools.find((t2) => t2.name === 'exec_command')!;

    // First command: no socket exists yet, so the mask built for it is empty.
    const first = (await execTool.handler({ command: 'true' })) as any;
    assert.equal(first.exitCode, 0);

    // Now a host process leaves a socket in the workspace, as a proxy or API daemon
    // would. A cached scan would never see it.
    const sockPath = path.join(tmpDir, 'later-host.sock');
    const server = net.createServer((connection) => {
      connection.write('HOST_SOCKET_REACHED\n');
      connection.end();
    });
    await new Promise<void>((resolve) => server.listen(sockPath, () => resolve()));
    try {
      const second = (await execTool.handler({
        command: `node -e 'const net = require("net"); net.connect("${sockPath}").on("data", () => console.log("HOST_SOCKET_REACHED")).on("error", e => console.log("MASKED_ERR:" + e.code))'`,
      })) as any;
      assert.match(second.stdout, /MASKED_ERR:/);
      assert.doesNotMatch(second.stdout, /HOST_SOCKET_REACHED/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(sockPath, { force: true }).catch(() => {});
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('createLocalTools: an incomplete socket scan refuses the command instead of running unmasked (cloud-factory-cf-6rne, cloud-factory-cf-bcra)', async (t) => {
  const reason = await bwrapUnavailableReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-cli-budget-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'one'));
    await fs.mkdir(path.join(tmpDir, 'two'));

    const tools = createLocalTools({
      cwd: tmpDir,
      sandboxNetwork: 'none',
      // Point at a table that does not exist so the degraded walk runs, then make its
      // budget too small for this tree. The point is that an incomplete scan refuses.
      socketScan: { maxDirs: 1, tablePath: path.join(tmpDir, 'no-such-unix-table') },
    });
    const execTool = tools.find((t2) => t2.name === 'exec_command')!;

    await assert.rejects(
      () => execTool.handler({ command: 'true' }) as Promise<unknown>,
      (err: unknown) => {
        assert.match(String((err as Error).message ?? err), /more than 1 directories/);
        assert.match(String((err as Error).message ?? err), /socketScan/);
        return true;
      },
    );

    // The same tree is fine with the default budget (and fine immediately when the
    // kernel table answers): the refusal is a bounded security control, not a hard
    // workspace-size limit.
    const permissive = createLocalTools({ cwd: tmpDir, sandboxNetwork: 'none' });
    const okRes = (await permissive.find((t2) => t2.name === 'exec_command')!.handler({ command: 'true' })) as any;
    assert.equal(okRes.exitCode, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('createLocalTools: network-none masks a host socket inside node_modules too (cloud-factory-cf-5vuu)', async (t) => {
  const reason = await bwrapUnavailableReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-cli-pruned-'));
  try {
    // The escape a pruning scan left open: a socket under a directory the scan used
    // to skip was never masked, so it stayed reachable from inside `--unshare-net`.
    const hiddenDir = path.join(tmpDir, 'node_modules', 'pkg', 'dist');
    await fs.mkdir(hiddenDir, { recursive: true });
    const sockPath = path.join(hiddenDir, 'host.sock');
    const server = net.createServer((connection) => {
      connection.write('HOST_SOCKET_REACHED\n');
      connection.end();
    });
    await new Promise<void>((resolve) => server.listen(sockPath, () => resolve()));

    try {
      const tools = createLocalTools({ cwd: tmpDir, sandboxNetwork: 'none' });
      const execTool = tools.find((t2) => t2.name === 'exec_command')!;
      const res = (await execTool.handler({
        command: `node -e 'const net = require("net"); net.connect("${sockPath}").on("data", () => console.log("HOST_SOCKET_REACHED")).on("error", e => console.log("MASKED_ERR:" + e.code))'`,
      })) as any;
      assert.match(res.stdout, /MASKED_ERR:/);
      assert.doesNotMatch(res.stdout, /HOST_SOCKET_REACHED/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(sockPath, { force: true }).catch(() => {});
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
