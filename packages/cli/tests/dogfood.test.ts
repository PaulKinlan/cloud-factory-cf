import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { runPrReview, sendWebhook, runCli, parseArgs } from '../src/index.ts';

test('parseArgs: parses review and webhook commands correctly', () => {
  const reviewParsed = parseArgs([
    'review',
    '--pr',
    '42',
    '--repo',
    'acme/my-repo',
    '--dry-run',
    '--out',
    'summary.md',
    '--strict',
  ]);
  assert.equal(reviewParsed.command, 'review');
  assert.equal(reviewParsed.prNumber, 42);
  assert.equal(reviewParsed.repo, 'acme/my-repo');
  assert.equal(reviewParsed.dryRun, true);
  assert.equal(reviewParsed.outPath, 'summary.md');
  assert.equal(reviewParsed.strict, true);

  const webhookParsed = parseArgs([
    'webhook',
    '--url',
    'http://127.0.0.1:8787',
    '--secret',
    'whsec_test',
    '--event',
    'pull_request',
    '--repo',
    'acme/my-repo',
    '--payload',
    '{"action":"opened"}',
    '--drain',
    '--control-key',
    'secret123',
  ]);
  assert.equal(webhookParsed.command, 'webhook');
  assert.equal(webhookParsed.url, 'http://127.0.0.1:8787');
  assert.equal(webhookParsed.secret, 'whsec_test');
  assert.equal(webhookParsed.event, 'pull_request');
  assert.equal(webhookParsed.repo, 'acme/my-repo');
  assert.equal(webhookParsed.drain, true);
  assert.equal(webhookParsed.controlKey, 'secret123');
});

test('runPrReview: generates formatted markdown and evaluates checks in dry-run mode', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-pr-review-test-'));
  const outPath = path.join(tmpDir, 'step-summary.md');

  // Create workspace files
  await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test Project\n', 'utf8');
  await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'src', 'index.ts'), 'export const hello = "world";\n', 'utf8');
  await fs.mkdir(path.join(tmpDir, 'tests'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'tests', 'index.test.ts'), 'import "./src/index.ts";\n', 'utf8');

  const eventPayload = {
    action: 'opened',
    number: 101,
    pull_request: {
      number: 101,
      title: 'feat: add hello world module',
      user: { login: 'octocat' },
      base: { ref: 'main' },
      head: { ref: 'feat/hello', sha: 'a1b2c3d4e5f6' },
    },
    repository: {
      full_name: 'PaulKinlan/cloud-factory-cf',
    },
  };

  const logs: string[] = [];
  const result = await runPrReview({
    cwd: tmpDir,
    eventPayload,
    dryRun: true,
    outPath,
    io: {
      stdout: (msg) => logs.push(msg),
      stderr: (msg) => logs.push(msg),
    },
  });

  assert.equal(result.prNumber, 101);
  assert.equal(result.repo.owner, 'PaulKinlan');
  assert.equal(result.repo.name, 'cloud-factory-cf');
  assert.equal(result.commitSha, 'a1b2c3d4e5f6');
  assert.ok(result.body.includes('Cloud Factory Dogfood Review'));
  assert.ok(result.body.includes('feat: add hello world module'));
  assert.ok(result.body.includes('@octocat'));

  // Verify file was written to outPath
  const summaryContent = await fs.readFile(outPath, 'utf8');
  assert.equal(summaryContent, result.body);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('runPrReview: flags missing lockfile update when package.json is modified', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-pr-review-lockfile-'));

  await fs.writeFile(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({ name: 'test', dependencies: { foo: '1.0.0' } }),
    'utf8',
  );

  const eventPayload = {
    number: 45,
    pull_request: {
      number: 45,
      title: 'chore: bump foo dependency',
      user: { login: 'dependabot' },
      head: { sha: 'abcdef123456' },
    },
    repository: { full_name: 'test-org/test-repo' },
  };

  const result = await runPrReview({
    cwd: tmpDir,
    eventPayload,
    dryRun: true,
    strict: true,
    io: { stdout: () => {}, stderr: () => {} },
  });

  assert.equal(result.verdict, 'REQUEST_CHANGES');
  assert.ok(result.findings.some((f) => f.includes('package-lock.json')));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('runPrReview: flags detected secret pattern', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-pr-review-secret-'));

  await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'src', 'config.ts'),
    'export const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";\n',
    'utf8',
  );

  const eventPayload = {
    number: 99,
    pull_request: {
      number: 99,
      title: 'fix: hardcoded token test',
      user: { login: 'dev' },
      head: { sha: '778899aabbcc' },
    },
    repository: { full_name: 'test-org/test-repo' },
  };

  const result = await runPrReview({
    cwd: tmpDir,
    eventPayload,
    dryRun: true,
    io: { stdout: () => {}, stderr: () => {} },
  });

  assert.equal(result.verdict, 'REQUEST_CHANGES');
  assert.ok(result.findings.some((f) => f.includes('Potential credential detected')));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('sendWebhook: delivers signed webhook payload and can trigger drain', async () => {
  let receivedSignature = '';
  let receivedEvent = '';
  let receivedBody = '';
  let drainCalled = false;
  let drainAuth = '';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    if (url.pathname === '/webhooks/github/test-owner/test-repo') {
      receivedSignature = (req.headers['x-hub-signature-256'] as string) ?? '';
      receivedEvent = (req.headers['x-github-event'] as string) ?? '';
      receivedBody = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deliveryId: req.headers['x-github-delivery'] }));
      return;
    }

    if (url.pathname === '/runs/test-owner/test-repo') {
      drainCalled = true;
      drainAuth = (req.headers['authorization'] as string) ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, claimed: 1, succeeded: 1, failed: 0 }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const payload = { action: 'opened', pull_request: { number: 12 } };
  const secret = 'whsec_supersecret_test';

  const result = await sendWebhook({
    url: baseUrl,
    owner: 'test-owner',
    repo: 'test-repo',
    secret,
    event: 'pull_request',
    payload,
    drain: true,
    controlKey: 'control-12345',
    io: { stdout: () => {}, stderr: () => {} },
  });

  server.close();

  assert.equal(result.ok, true);
  assert.equal(result.webhookStatus, 200);
  assert.equal(receivedEvent, 'pull_request');
  assert.deepEqual(JSON.parse(receivedBody), payload);

  // Validate HMAC signature
  const expectedHmac = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
  assert.equal(receivedSignature, `sha256=${expectedHmac}`);

  // Validate drain call
  assert.equal(drainCalled, true);
  assert.equal(drainAuth, 'Bearer control-12345');
});

test('sendWebhook: fails closed and returns ok: false when drain fails (fixes cloud-factory-cf-6ox)', async () => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname.startsWith('/webhooks/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deliveryId: 'deliv-123' }));
      return;
    }
    if (url.pathname.startsWith('/runs/')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'internal error' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const result = await sendWebhook({
    url: baseUrl,
    owner: 'test-owner',
    repo: 'test-repo',
    secret: 'whsec_test',
    event: 'pull_request',
    payload: { action: 'opened' },
    drain: true,
    controlKey: 'control-12345',
    io: { stdout: () => {}, stderr: () => {} },
  });

  server.close();

  assert.equal(result.ok, false);
  assert.ok(result.error?.includes('Drain failed (500)'));
});

test('parseArgs: parses --event-file as payload file, not event type (fixes cloud-factory-cf-vc7)', () => {
  const parsed = parseArgs([
    'webhook',
    '--url',
    'http://x',
    '--secret',
    's',
    '--repo',
    'o/r',
    '--event-file',
    '/tmp/payload.json',
  ]);
  assert.equal(parsed.command, 'webhook');
  assert.equal(parsed.eventFile, '/tmp/payload.json');
  assert.equal(parsed.event, undefined);
});

test('runCli: review --strict returns exit code 1 when COMMENT has findings (fixes cloud-factory-cf-npo)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-cli-strict-'));
  await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'src', 'feature.ts'), 'export const x = 1;\n', 'utf8');

  const logs: string[] = [];
  const exitCode = await runCli(
    ['review', '--cwd', tmpDir, '--dry-run', '--strict'],
    {
      stdout: (m) => logs.push(m),
      stderr: (m) => logs.push(m),
    },
  );

  assert.equal(exitCode, 1);
  assert.ok(logs.some((l) => l.includes('Verdict: COMMENT')));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('runPrReview: empty git diff reports 0 files and APPROVE without whole-repo scan (fixes cloud-factory-cf-c7v)', async () => {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-empty-diff-'));
  await execAsync('git init -q -b main . && git config user.email "test@example.com" && git config user.name "Test"', { cwd: tmpDir });
  await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  await fs.writeFile(path.join(tmpDir, 'README.md'), '# hi\n', 'utf8');
  await execAsync('git add -A && git commit -qm "init"', { cwd: tmpDir });
  await execAsync('git update-ref refs/remotes/origin/main HEAD', { cwd: tmpDir });

  // When HEAD == origin/main, diff is empty
  const result = await runPrReview({
    cwd: tmpDir,
    dryRun: true,
    io: { stdout: () => {}, stderr: () => {} },
  });

  assert.equal(result.changedFiles.length, 0);
  assert.equal(result.findings.length, 0);
  assert.equal(result.verdict, 'APPROVE');

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('runPrReview: inspects uncommitted and untracked files on a dirty worktree (fixes cloud-factory-cf-e33)', async () => {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-dirty-diff-'));
  await execAsync('git init -q -b main . && git config user.email "test@example.com" && git config user.name "Test"', { cwd: tmpDir });
  await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  await execAsync('git add -A && git commit -qm "init"', { cwd: tmpDir });
  await execAsync('git update-ref refs/remotes/origin/main HEAD', { cwd: tmpDir });

  // Add untracked dirty file containing a token pattern
  await fs.writeFile(
    path.join(tmpDir, 'src', 'new-feature.ts'),
    'export const token = "ghp_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";\n',
    'utf8',
  );

  const result = await runPrReview({
    cwd: tmpDir,
    dryRun: true,
    io: { stdout: () => {}, stderr: () => {} },
  });

  assert.ok(result.changedFiles.some((f) => f.includes('new-feature.ts')));
  assert.equal(result.verdict, 'REQUEST_CHANGES');
  assert.ok(result.findings.some((f) => f.includes('Potential credential detected')));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('runPrReview: inspects uncommitted untracked directories and quoted paths (fixes cloud-factory-cf-sal)', async () => {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-untracked-dirs-'));
  await execAsync('git init -q -b main . && git config user.email "test@example.com" && git config user.name "Test"', { cwd: tmpDir });
  await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  await execAsync('git add -A && git commit -qm "init"', { cwd: tmpDir });
  await execAsync('git update-ref refs/remotes/origin/main HEAD', { cwd: tmpDir });

  // Add untracked NEW directory with token
  await fs.mkdir(path.join(tmpDir, 'src', 'features', 'billing'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'src', 'features', 'billing', 'index.ts'),
    'export const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";\n',
    'utf8',
  );

  // Add untracked file with space in path
  await fs.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'docs', 'my notes.md'),
    '# my notes\n',
    'utf8',
  );

  const result = await runPrReview({
    cwd: tmpDir,
    dryRun: true,
    io: { stdout: () => {}, stderr: () => {} },
  });

  assert.ok(result.changedFiles.some((f) => f.includes('billing/index.ts')));
  assert.ok(result.changedFiles.some((f) => f.includes('my notes.md')));
  assert.equal(result.verdict, 'REQUEST_CHANGES');
  assert.ok(result.findings.some((f) => f.includes('Potential credential detected in `src/features/billing/index.ts`')));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('runPrReview: inspects renamed files and subdirectory cwd (fixes cloud-factory-cf-8lf)', async () => {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-rename-test-'));
  await execAsync('git init -q -b main . && git config user.email "test@example.com" && git config user.name "Test"', { cwd: tmpDir });
  await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'src', 'config.ts'),
    'export const cfg = 1;\nexport const other = 2;\nexport const more = 3;\n',
    'utf8',
  );
  await execAsync('git add -A && git commit -qm "init"', { cwd: tmpDir });
  await execAsync('git update-ref refs/remotes/origin/main HEAD', { cwd: tmpDir });

  // Staged rename + token in renamed file
  await execAsync('git mv src/config.ts src/app-config.ts', { cwd: tmpDir });
  await fs.appendFile(
    path.join(tmpDir, 'src', 'app-config.ts'),
    'export const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";\n',
    'utf8',
  );
  await execAsync('git add -A', { cwd: tmpDir });

  // Also test subdirectory cwd invocation
  const subDir = path.join(tmpDir, 'src');
  const result = await runPrReview({
    cwd: subDir,
    dryRun: true,
    io: { stdout: () => {}, stderr: () => {} },
  });

  assert.ok(result.changedFiles.some((f) => f.includes('app-config.ts')));
  assert.equal(result.verdict, 'REQUEST_CHANGES');
  assert.ok(result.findings.some((f) => f.includes('Potential credential detected in `src/app-config.ts`')));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('runPrReview: inspects filenames containing literal " -> " using NUL delimiters (fixes cloud-factory-cf-a6v)', async () => {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-arrow-file-'));
  await execAsync('git init -q -b main . && git config user.email "test@example.com" && git config user.name "Test"', { cwd: tmpDir });
  await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  await execAsync('git add -A && git commit -qm "init"', { cwd: tmpDir });
  await execAsync('git update-ref refs/remotes/origin/main HEAD', { cwd: tmpDir });

  // Add file with literal " -> " in filename containing credential
  await fs.writeFile(
    path.join(tmpDir, 'src', 'a -> b.ts'),
    'export const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";\n',
    'utf8',
  );

  const result = await runPrReview({
    cwd: tmpDir,
    dryRun: true,
    io: { stdout: () => {}, stderr: () => {} },
  });

  assert.ok(result.changedFiles.some((f) => f.includes('a -> b.ts')));
  assert.equal(result.verdict, 'REQUEST_CHANGES');
  assert.ok(result.findings.some((f) => f.includes('Potential credential detected in `src/a -> b.ts`')));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('runPrReview: preserves paths with leading or trailing whitespace (fixes cloud-factory-cf-snj)', async () => {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-whitespace-file-'));
  await execAsync('git init -q -b main . && git config user.email "test@example.com" && git config user.name "Test"', { cwd: tmpDir });
  await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  await execAsync('git add -A && git commit -qm "init"', { cwd: tmpDir });
  await execAsync('git update-ref refs/remotes/origin/main HEAD', { cwd: tmpDir });

  // Add file with trailing space in filename containing credential
  await fs.writeFile(
    path.join(tmpDir, 'src', 'b.ts '),
    'export const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";\n',
    'utf8',
  );

  const result = await runPrReview({
    cwd: tmpDir,
    dryRun: true,
    io: { stdout: () => {}, stderr: () => {} },
  });

  assert.ok(result.changedFiles.includes('src/b.ts '));
  assert.equal(result.verdict, 'REQUEST_CHANGES');
  assert.ok(result.findings.some((f) => f.includes('Potential credential detected in `src/b.ts `')));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('runPrReview: degrades to step summary with notice without network calls (fixes cloud-factory-cf-e2c, isp, 156)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-readonly-token-'));
  await fs.writeFile(path.join(tmpDir, 'README.md'), '# hi\n', 'utf8');
  const outPath = path.join(tmpDir, 'step-summary.md');

  const logs: string[] = [];
  const mockFetch: typeof fetch = async () => {
    return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
      status: 403,
      statusText: 'Forbidden',
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await runPrReview({
    cwd: tmpDir,
    // Name the repository: a live post is refused outright when nothing names one
    // (cloud-factory-cf-n2h0), and this test is about the read-only-token degradation.
    repo: { owner: 'acme', name: 'widgets' },
    githubToken: 'ghp_readonly_fork_token',
    fetchFn: mockFetch,
    dryRun: false,
    outPath,
    io: { stdout: (m) => logs.push(m), stderr: (m) => logs.push(m) },
  });

  // Should not throw, should set posted to false, and preserve review body with notice
  assert.equal(result.posted, false);
  assert.ok(result.body.includes('Cloud Factory Dogfood Review'));
  assert.ok(result.body.includes('not submitted to the PR conversation (API status 403)'));
  assert.ok(logs.some((l) => l.includes('Degraded to step summary output')));

  const summaryContent = await fs.readFile(outPath, 'utf8');
  assert.ok(summaryContent.includes('not submitted to the PR conversation (API status 403)'));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('runCli: review command runs and succeeds with 0 exit code', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-cli-review-'));
  const eventFilePath = path.join(tmpDir, 'event.json');
  await fs.writeFile(
    eventFilePath,
    JSON.stringify({
      number: 77,
      pull_request: {
        number: 77,
        title: 'docs: update documentation',
        user: { login: 'writer' },
      },
      repository: { full_name: 'org/repo' },
    }),
    'utf8',
  );

  const logs: string[] = [];
  const exitCode = await runCli(
    ['review', '--cwd', tmpDir, '--event', eventFilePath, '--dry-run'],
    {
      stdout: (m) => logs.push(m),
      stderr: (m) => logs.push(m),
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(logs.some((l) => l.includes('[factory-cloud review] Verdict:')));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('runPrReview: posts to the repository named by the event instead of the local default (cloud-factory-cf-n2h0)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-event-repo-'));
  await fs.writeFile(path.join(tmpDir, 'README.md'), '# hi\n', 'utf8');

  const urls: string[] = [];
  const mockFetch: typeof fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ id: 4242 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await runPrReview({
    cwd: tmpDir,
    // No repo option: this is the Actions shape (--event, no --repo).
    eventPayload: {
      number: 42,
      pull_request: {
        number: 42,
        title: 'docs: describe the loop',
        user: { login: 'writer' },
        head: { ref: 'fleet/docs', sha: 'a'.repeat(40) },
        base: { ref: 'main' },
      },
      repository: { full_name: 'PaulKinlan/cloud-factory-cf' },
    },
    githubToken: 'ghp_actions_token',
    fetchFn: mockFetch,
    io: { stdout: () => {}, stderr: () => {} },
  });

  assert.deepEqual(result.repo, { owner: 'PaulKinlan', name: 'cloud-factory-cf' });
  assert.equal(result.prNumber, 42);
  assert.equal(result.posted, true);
  assert.deepEqual(urls, [
    'https://api.github.com/repos/PaulKinlan/cloud-factory-cf/pulls/42/reviews',
  ]);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('runPrReview: refuses to post when nothing names a repository, and says why (cloud-factory-cf-n2h0)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-no-repo-'));
  await fs.writeFile(path.join(tmpDir, 'README.md'), '# hi\n', 'utf8');

  let called = 0;
  const mockFetch: typeof fetch = async () => {
    called += 1;
    return new Response('{}', { status: 200 });
  };

  const logs: string[] = [];
  const savedEnv = process.env['GITHUB_REPOSITORY'];
  delete process.env['GITHUB_REPOSITORY'];
  try {
    const result = await runPrReview({
      cwd: tmpDir,
      githubToken: 'ghp_actions_token',
      fetchFn: mockFetch,
      io: { stdout: (m) => logs.push(m), stderr: (m) => logs.push(m) },
    });

    assert.equal(called, 0, 'no request may be sent to a repository nobody named');
    assert.equal(result.posted, false);
    assert.ok(logs.some((l) => l.includes('No repository in the event payload or environment')));
  } finally {
    if (savedEnv === undefined) delete process.env['GITHUB_REPOSITORY'];
    else process.env['GITHUB_REPOSITORY'] = savedEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('runCli: review takes the target from the event, not the local/local-repo default (cloud-factory-cf-n2h0)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-cli-event-repo-'));
  const eventFilePath = path.join(tmpDir, 'event.json');
  await fs.writeFile(
    eventFilePath,
    JSON.stringify({
      number: 9,
      pull_request: { number: 9, title: 'docs: x', user: { login: 'writer' } },
      repository: { full_name: 'PaulKinlan/cloud-factory-cf' },
    }),
    'utf8',
  );

  const logs: string[] = [];
  const exitCode = await runCli(
    ['review', '--cwd', tmpDir, '--event', eventFilePath, '--dry-run'],
    { stdout: (m) => logs.push(m), stderr: (m) => logs.push(m) },
  );

  assert.equal(exitCode, 0);
  const prepared = logs.find((l) => l.includes('(dry-run) Review prepared'));
  assert.ok(prepared, 'the dry run should say where the review was prepared for');
  assert.ok(prepared!.includes('PaulKinlan/cloud-factory-cf'), `expected the event's repository, got: ${prepared}`);
  assert.ok(!prepared!.includes('local/local-repo'), 'the CLI must not fall back to the offline default');

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('runPrReview: posts an approval as a COMMENT review on Actions, because GitHub refuses bot approvals (cloud-factory-cf-n2h0)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-actions-approve-'));
  await fs.writeFile(path.join(tmpDir, 'README.md'), '# hi\n', 'utf8');

  const calls: Array<{ url: string; event: string }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { event?: string };
    calls.push({ url: String(input), event: String(body.event) });
    return new Response(JSON.stringify({ id: 7 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const savedEnv = process.env['GITHUB_ACTIONS'];
  process.env['GITHUB_ACTIONS'] = 'true';
  try {
    const result = await runPrReview({
      cwd: tmpDir,
      repo: { owner: 'PaulKinlan', name: 'cloud-factory-cf' },
      prNumber: 1,
      githubToken: 'ghs_actions_token',
      fetchFn: mockFetch,
      io: { stdout: () => {}, stderr: () => {} },
    });

    assert.equal(result.verdict, 'APPROVE');
    assert.equal(result.posted, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.event, 'COMMENT', 'a bot approval must be sent as a comment review');
  } finally {
    if (savedEnv === undefined) delete process.env['GITHUB_ACTIONS'];
    else process.env['GITHUB_ACTIONS'] = savedEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('runPrReview: retries a refused review event as COMMENT so the verdict still lands (cloud-factory-cf-n2h0)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-422-retry-'));
  await fs.writeFile(path.join(tmpDir, 'README.md'), '# hi\n', 'utf8');

  const events: string[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { event?: string };
    events.push(String(body.event));
    if (events.length === 1) {
      return new Response(
        JSON.stringify({ message: 'Unprocessable Entity', errors: ['GitHub Actions is not permitted to approve pull requests.'] }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ id: 8 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const savedEnv = process.env['GITHUB_ACTIONS'];
  delete process.env['GITHUB_ACTIONS'];
  try {
    const result = await runPrReview({
      cwd: tmpDir,
      repo: { owner: 'PaulKinlan', name: 'cloud-factory-cf' },
      prNumber: 2,
      githubToken: 'ghs_actions_token',
      fetchFn: mockFetch,
      io: { stdout: () => {}, stderr: () => {} },
    });

    assert.deepEqual(events, ['APPROVE', 'COMMENT']);
    assert.equal(result.posted, true);
  } finally {
    if (savedEnv === undefined) delete process.env['GITHUB_ACTIONS'];
    else process.env['GITHUB_ACTIONS'] = savedEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
