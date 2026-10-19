import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleRunCommand,
  handleWorkerCommand,
  handleStudioCommand,
  handleReviewCommand,
  handleWebhookCommand,
} from '../src/commands/index.ts';

test('command handlers: fail cleanly on missing required arguments', async () => {
  const outputs: string[] = [];
  const errors: string[] = [];
  const io = {
    stdout: (m: string) => outputs.push(m),
    stderr: (m: string) => errors.push(m),
  };
  const context = { cwd: process.cwd(), owner: 'local', name: 'local-repo', io };

  // Run command without prompt returns 1
  const runCode = await handleRunCommand({ command: 'run' }, context);
  assert.equal(runCode, 1);
  assert.ok(errors.some((e) => e.includes('missing prompt')));

  // Webhook command without url returns 1
  const webhookCode = await handleWebhookCommand({ command: 'webhook' }, context);
  assert.equal(webhookCode, 1);
  assert.ok(errors.some((e) => e.includes('missing --url')));

  // Studio author without prompt returns 1
  const studioCode = await handleStudioCommand({ command: 'studio', studioAction: 'author' }, context);
  assert.equal(studioCode, 1);
  assert.ok(errors.some((e) => e.includes('missing prompt')));
});

test('runCli: validates slash-less --repo correctly (fixes cloud-factory-cf-byg)', async () => {
  const { runCli } = await import('../src/cli.ts');
  const errors: string[] = [];
  const io = {
    stdout: () => {},
    stderr: (m: string) => errors.push(m),
  };

  const code = await runCli(
    ['webhook', '--repo', 'foo', '--url', 'http://127.0.0.1:8787', '--secret', 'secret'],
    io,
  );
  assert.equal(code, 1);
  assert.ok(errors.some((e) => e.includes('missing --repo <owner/name>')));
});
