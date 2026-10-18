import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createLocalTools } from '../src/index.ts';

test('createLocalTools: provides file operations and blocks path traversal', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-cli-tools-'));
  try {
    const tools = createLocalTools({ cwd: tmpDir });
    const writeTool = tools.find((t) => t.name === 'write_file')!;
    const readTool = tools.find((t) => t.name === 'read_file')!;
    const listTool = tools.find((t) => t.name === 'list_files')!;
    const execTool = tools.find((t) => t.name === 'exec_command')!;

    assert.ok(writeTool);
    assert.ok(readTool);
    assert.ok(listTool);
    assert.ok(execTool);

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

    // Exec command
    const execRes = (await execTool.handler({ command: 'node -e "console.log(12345)"' })) as any;
    assert.match(execRes.stdout, /12345/);

    // Test containment mode explicitly blocks shell redirection, expansions, and traversal (fixes cloud-factory-cf-2yl and cloud-factory-cf-ad5)
    const containmentTools = createLocalTools({ cwd: tmpDir, sandbox: 'containment' });
    const containmentExec = containmentTools.find((t) => t.name === 'exec_command')!;

    await assert.rejects(
      async () => {
        await containmentExec.handler({ command: 'printf ESCAPED > $CF_REVIEW_OUT' });
      },
      /Command containment violation/,
    );

    await assert.rejects(
      async () => {
        await containmentExec.handler({ command: 'echo hello > out.txt' });
      },
      /Command containment violation: shell redirection/,
    );

    await assert.rejects(
      async () => {
        await containmentExec.handler({ command: 'echo $HOME' });
      },
      /Command containment violation: shell variable expansion/,
    );

    await assert.rejects(
      async () => {
        await containmentExec.handler({ command: 'cat ../outside.txt' });
      },
      /Command containment violation: traversal '\.\.' is not allowed in command/,
    );

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
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
