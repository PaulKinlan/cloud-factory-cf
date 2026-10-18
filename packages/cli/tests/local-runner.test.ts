import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { LocalAgentRunner } from '../src/index.ts';
import type { Extension } from '@factory-cloud/sdk';

test('LocalAgentRunner: executes agent runs with local tools and lifecycle extensions', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-cli-runner-'));
  try {
    let hookRan = false;
    const testExtension: Extension = (api) => {
      api.on('before_run', (payload) => {
        hookRan = true;
        return { prompt: `[PREPENDED] ${payload.prompt}` };
      });
    };

    const runner = new LocalAgentRunner({
      cwd: tmpDir,
      repo: { owner: 'acme', name: 'repo' },
      extensions: [testExtension],
    });

    const summary = await runner.run('Analyze codebase', async (input) => {
      assert.ok(input.prompt.startsWith('[PREPENDED]'));
      assert.ok(input.tools.includes('read_file'));
      input.ctx.log('info', 'Running in test');
      return { status: 'success', output: 'Analyzed', toolCallsCount: 0 };
    });

    assert.equal(summary.status, 'success');
    assert.equal(hookRan, true);
    assert.equal(summary.output, 'Analyzed');

    // Test runner fails explicitly when no executor is configured (fixes cloud-factory-cf-3s1)
    const noExecRunner = new LocalAgentRunner({ cwd: tmpDir });
    const noExecSummary = await noExecRunner.run('No executor run');
    assert.equal(noExecSummary.status, 'failure');
    assert.match(noExecSummary.error!, /No agent execution function configured/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
