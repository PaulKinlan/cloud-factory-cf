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

    // Exec command
    const execRes = (await execTool.handler({ command: 'node -e "console.log(12345)"' })) as any;
    assert.match(execRes.stdout, /12345/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
