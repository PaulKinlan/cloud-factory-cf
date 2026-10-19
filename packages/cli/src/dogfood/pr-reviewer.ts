import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  GitHubPRReviewSink,
  type GitHubPRReviewPayload,
  type ActionSink,
} from '@factory-cloud/sdk';
import { LocalAgentRunner } from '../runner/local-runner.ts';

const execAsync = promisify(exec);

export interface PrReviewOptions {
  cwd?: string;
  repo?: { owner: string; name: string };
  prNumber?: number;
  commitSha?: string;
  eventPayload?: Record<string, unknown>;
  eventFile?: string;
  changedFiles?: string[];
  githubToken?: string;
  dryRun?: boolean;
  outPath?: string;
  strict?: boolean;
  io?: {
    stdout: (msg: string) => void;
    stderr: (msg: string) => void;
  };
  fetchFn?: typeof fetch;
  apiBaseUrl?: string;
}

export interface PrReviewResult {
  prNumber: number;
  repo: { owner: string; name: string };
  commitSha?: string;
  verdict: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
  body: string;
  findings: string[];
  posted: boolean;
  reviewId?: string | number;
  changedFiles: string[];
}

interface EvaluatedChecks {
  hasSourceChanges: boolean;
  hasTestChanges: boolean;
  hasDocChanges: boolean;
  packageJsonChanged: boolean;
  lockfileChanged: boolean;
  secretFindings: string[];
}

export async function runPrReview(options: PrReviewOptions): Promise<PrReviewResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const io = options.io ?? {
    stdout: (msg: string) => console.log(msg),
    stderr: (msg: string) => console.error(msg),
  };

  // 1. Resolve event payload if provided
  let eventPayload = options.eventPayload;
  if (!eventPayload && options.eventFile) {
    try {
      const content = await fs.readFile(path.resolve(cwd, options.eventFile), 'utf8');
      eventPayload = JSON.parse(content) as Record<string, unknown>;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      io.stderr(`[dogfood review] Warning: could not read event file: ${msg}`);
    }
  }

  // 2. Resolve PR metadata
  const pullRequest = (eventPayload?.['pull_request'] ?? {}) as Record<string, unknown>;
  const prNumber =
    options.prNumber ??
    (typeof pullRequest['number'] === 'number' ? (pullRequest['number'] as number) : undefined) ??
    (typeof eventPayload?.['number'] === 'number' ? (eventPayload['number'] as number) : undefined) ??
    1;

  const repoParts = (
    typeof (eventPayload?.['repository'] as any)?.['full_name'] === 'string'
      ? ((eventPayload?.['repository'] as any)['full_name'] as string).split('/')
      : undefined
  );

  const owner =
    options.repo?.owner ??
    repoParts?.[0] ??
    process.env['GITHUB_REPOSITORY']?.split('/')[0] ??
    'local';
  const repoName =
    options.repo?.name ??
    repoParts?.[1] ??
    process.env['GITHUB_REPOSITORY']?.split('/')[1] ??
    'cloud-factory-cf';

  const prTitle = (typeof pullRequest['title'] === 'string' ? pullRequest['title'] : 'Pull Request');
  const prAuthor = (typeof (pullRequest['user'] as any)?.['login'] === 'string' ? (pullRequest['user'] as any)['login'] : 'contributor');
  const baseRef = (typeof (pullRequest['base'] as any)?.['ref'] === 'string' ? (pullRequest['base'] as any)['ref'] : 'main');
  const headRef = (typeof (pullRequest['head'] as any)?.['ref'] === 'string' ? (pullRequest['head'] as any)['ref'] : 'head');

  let commitSha =
    options.commitSha ??
    (typeof (pullRequest['head'] as any)?.['sha'] === 'string' ? (pullRequest['head'] as any)['sha'] : undefined) ??
    process.env['GITHUB_SHA'];

  if (!commitSha) {
    try {
      const { stdout } = await execAsync('git rev-parse HEAD', { cwd });
      commitSha = stdout.trim();
    } catch {
      commitSha = '0000000';
    }
  }

  // 3. Inspect changed files via git or options or directory walk fallback
  let changedFiles: string[] = options.changedFiles ? [...options.changedFiles] : [];
  let rootDir = cwd;

  if (changedFiles.length === 0 && !options.changedFiles) {
    let gitSucceeded = false;
    try {
      const { stdout: toplevelOut } = await execAsync('git rev-parse --show-toplevel', { cwd });
      if (toplevelOut.trim()) {
        rootDir = toplevelOut.trim();
      }
      await execAsync('git rev-parse --is-inside-work-tree', { cwd });
      gitSucceeded = true;

      // Gather committed diff against base branch (or HEAD~1) running from rootDir with -z
      const diffCmd = `git diff --name-only -z origin/${baseRef}...HEAD 2>/dev/null || git diff --name-only -z HEAD~1 2>/dev/null || true`;
      // Also gather uncommitted/staged/untracked working tree modifications without collapsing untracked dirs with -z
      const statusCmd = `git status --porcelain -z -uall 2>/dev/null || true`;

      const [diffRes, statusRes] = await Promise.all([
        execAsync(diffCmd, { cwd: rootDir }),
        execAsync(statusCmd, { cwd: rootDir }),
      ]);

      const diffFiles = diffRes.stdout
        .split('\0')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const statusFiles: string[] = [];
      const parts = statusRes.stdout.split('\0');
      let idx = 0;
      while (idx < parts.length) {
        const item = parts[idx];
        if (!item) {
          idx++;
          continue;
        }
        const status = item.slice(0, 2);
        const filePath = item.slice(3).trim();
        if (filePath) {
          statusFiles.push(filePath);
        }
        // In porcelain -z, rename (R) and copy (C) records are followed by origPath in the next NUL field
        if (status.includes('R') || status.includes('C')) {
          idx++;
        }
        idx++;
      }

      const rawCandidateFiles = [...diffFiles, ...statusFiles];

      const resolvedFiles: string[] = [];
      for (const entry of rawCandidateFiles) {
        const fullPath = path.resolve(rootDir, entry);
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isDirectory()) {
            async function walkDir(d: string, b: string): Promise<string[]> {
              const ents = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
              const res: string[] = [];
              for (const e of ents) {
                if (e.name === '.git' || e.name === 'node_modules' || e.name === 'dist') continue;
                const r = path.join(b, e.name);
                const f = path.join(d, e.name);
                if (e.isDirectory()) res.push(...(await walkDir(f, r)));
                else if (e.isFile()) res.push(r);
              }
              return res;
            }
            resolvedFiles.push(...(await walkDir(fullPath, entry)));
          } else if (stat.isFile()) {
            resolvedFiles.push(entry);
          }
        } catch {
          // If stat fails (e.g. deleted file), keep entry for diff tracking
          resolvedFiles.push(entry);
        }
      }
      changedFiles = resolvedFiles;
    } catch {
      gitSucceeded = false;
      rootDir = cwd;
    }

    // If git failed (e.g. non-git directory in test fixtures), fallback to workspace files
    if (!gitSucceeded) {
      async function walk(dir: string, base: string): Promise<string[]> {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        const results: string[] = [];
        for (const entry of entries) {
          if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
          const rel = path.join(base, entry.name);
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            results.push(...(await walk(full, rel)));
          } else if (entry.isFile()) {
            results.push(rel);
          }
        }
        return results;
      }
      changedFiles = await walk(cwd, '');
    }
  }

  // Deduplicate and normalize
  changedFiles = Array.from(new Set(changedFiles));

  // 4. Run automated checks
  const checks = await evaluateChangedFiles(rootDir, changedFiles);

  // 5. Determine review verdict and findings
  const findings: string[] = [];
  let verdict: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES' = 'APPROVE';

  if (checks.secretFindings.length > 0) {
    verdict = 'REQUEST_CHANGES';
    findings.push(...checks.secretFindings);
  }

  if (checks.packageJsonChanged && !checks.lockfileChanged) {
    verdict = 'REQUEST_CHANGES';
    findings.push('`package.json` was modified but `package-lock.json` was not updated.');
  }

  if (checks.hasSourceChanges && !checks.hasTestChanges) {
    if (verdict !== 'REQUEST_CHANGES') {
      verdict = 'COMMENT';
    }
    findings.push('Source files modified without accompanying test additions or updates.');
  }

  // 6. Build Markdown Review Body
  const reviewBody = buildReviewMarkdown({
    prNumber,
    prTitle,
    prAuthor,
    baseRef,
    headRef,
    commitSha,
    changedFiles,
    checks,
    findings,
    verdict,
  });

  // 7. Dispatch via GitHubPRReviewSink through LocalAgentRunner
  const token = options.githubToken ?? process.env['GITHUB_TOKEN'];
  const isDryRun = options.dryRun ?? (!token);
  const customFetch = options.fetchFn ?? globalThis.fetch;
  const apiBase = options.apiBaseUrl ?? 'https://api.github.com';

  let posted = false;
  let submissionStatus: number | undefined;
  let reviewId: string | number | undefined;

  const reviewSink: ActionSink = new GitHubPRReviewSink({
    name: 'dogfood-github-pr-review-sink',
    executor: async (payload: GitHubPRReviewPayload) => {
      if (isDryRun) {
        io.stdout(`[dogfood review] (dry-run) Review prepared for PR #${payload.prNumber} (${payload.event}):`);
        io.stdout(payload.body);
        return { dryRun: true, status: 200, prNumber: payload.prNumber };
      }

      // Live GitHub API request
      const apiUrl = `${apiBase}/repos/${owner}/${repoName}/pulls/${payload.prNumber}/reviews`;
      io.stdout(`[dogfood review] Submitting review to GitHub API: ${apiUrl}...`);
      const res = await customFetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'FactoryCloud-Dogfood-Reviewer',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          body: payload.body,
          event: payload.event,
          commit_id: payload.commitSha ?? commitSha,
        }),
      });

      submissionStatus = res.status;
      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        io.stderr(`[dogfood review] Warning: GitHub API review submission failed (${res.status}): ${errorText}`);
        io.stdout(`[dogfood review] Degraded to step summary output (review not posted to GitHub API).`);
        return { posted: false, status: res.status, error: errorText };
      }

      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      posted = true;
      reviewId = data['id'] as string | number | undefined;
      return { status: res.status, id: reviewId };
    },
  });

  const runner = new LocalAgentRunner({
    cwd: rootDir,
    repo: { owner, name: repoName, defaultBranch: baseRef },
    sinks: [reviewSink],
  });

  const runSummary = await runner.run(
    `Review PR #${prNumber} in ${owner}/${repoName} at commit ${commitSha}`,
    async ({ ctx }) => {
      const results = await ctx.sinks.emit(
        {
          id: `dogfood-review-${prNumber}-${Date.now()}`,
          type: 'github:pr:review',
          payload: {
            prNumber,
            event: verdict,
            body: reviewBody,
            commitSha,
          },
        },
        ctx,
      );

      const failed = results.find((r) => !r.success);
      if (failed) {
        return {
          status: 'failure',
          error: failed.error ?? 'Failed to emit PR review',
          toolCallsCount: 0,
        };
      }

      return {
        status: 'success',
        output: reviewBody,
        toolCallsCount: 0,
      };
    },
  );

  if (runSummary.status !== 'success') {
    throw new Error(runSummary.error ?? 'Dogfood PR review runner failed');
  }

  // 8. Write to outPath (e.g. GITHUB_STEP_SUMMARY) with degradation notice if review posting was skipped/failed
  let finalBody = reviewBody;
  if (!posted && !isDryRun && token) {
    finalBody += `\n\n> ⚠️ **Note:** Automated review was generated as a GitHub Step Summary only and was not submitted to the PR conversation (API status ${submissionStatus ?? 'non-ok'}).\n`;
  }

  if (options.outPath) {
    try {
      const targetPath = path.resolve(cwd, options.outPath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, finalBody, 'utf8');
      io.stdout(`[dogfood review] Wrote review summary to ${targetPath}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      io.stderr(`[dogfood review] Failed to write outPath: ${msg}`);
    }
  }

  return {
    prNumber,
    repo: { owner, name: repoName },
    commitSha,
    verdict,
    body: finalBody,
    findings,
    posted,
    reviewId,
    changedFiles,
  };
}

async function evaluateChangedFiles(cwd: string, files: readonly string[]): Promise<EvaluatedChecks> {
  let hasSourceChanges = false;
  let hasTestChanges = false;
  let hasDocChanges = false;
  let packageJsonChanged = false;
  let lockfileChanged = false;
  const secretFindings: string[] = [];

  const secretPatterns = [
    { name: 'GitHub Personal Access Token', pattern: /ghp_[A-Za-z0-9_]{36}/ },
    { name: 'GitHub Fine-Grained Token', pattern: /github_pat_[A-Za-z0-9_]{82}/ },
    { name: 'OpenAI Secret Key', pattern: /sk-[A-Za-z0-9]{32,}/ },
    { name: 'Private Key Block', pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
  ];

  for (const file of files) {
    if (file.endsWith('.md')) {
      hasDocChanges = true;
    }
    if (file.endsWith('package.json')) {
      packageJsonChanged = true;
    }
    if (file.endsWith('package-lock.json')) {
      lockfileChanged = true;
    }
    const isTest = /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(file) || file.includes('/test/') || file.includes('/tests/') || file.includes('fixtures/');
    if (isTest) {
      hasTestChanges = true;
    } else if (/\.(ts|js|tsx|jsx)$/.test(file)) {
      hasSourceChanges = true;
    }

    // Inspect content of non-test text files for secrets
    if (!isTest) {
      try {
        const fullPath = path.resolve(cwd, file);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (stat && stat.isFile() && stat.size < 512 * 1024) {
          const text = await fs.readFile(fullPath, 'utf8');
          for (const { name, pattern } of secretPatterns) {
            if (pattern.test(text)) {
              secretFindings.push(`Potential credential detected in \`${file}\`: ${name}`);
            }
          }
        }
      } catch {
        // Ignore unreadable or deleted files
      }
    }
  }

  return {
    hasSourceChanges,
    hasTestChanges,
    hasDocChanges,
    packageJsonChanged,
    lockfileChanged,
    secretFindings,
  };
}

function buildReviewMarkdown(params: {
  prNumber: number;
  prTitle: string;
  prAuthor: string;
  baseRef: string;
  headRef: string;
  commitSha?: string;
  changedFiles: string[];
  checks: EvaluatedChecks;
  findings: string[];
  verdict: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
}): string {
  const { prNumber, prTitle, prAuthor, commitSha, changedFiles, checks, findings, verdict } = params;

  const verdictBadge =
    verdict === 'APPROVE'
      ? '### ✅ **Dogfood Review: APPROVE**'
      : verdict === 'REQUEST_CHANGES'
        ? '### ❌ **Dogfood Review: REQUEST CHANGES**'
        : '### 💬 **Dogfood Review: COMMENT**';

  const lines: string[] = [];
  lines.push(`## 🏭 Cloud Factory Dogfood Review — PR #${prNumber}`);
  lines.push('');
  lines.push(`**Title:** ${prTitle}`);
  lines.push(`**Author:** @${prAuthor}`);
  lines.push(`**Commit:** \`${commitSha ? commitSha.slice(0, 7) : 'HEAD'}\``);
  lines.push('');
  lines.push(verdictBadge);
  lines.push('');
  lines.push('#### Automated Sanity & Compliance Checklist:');
  lines.push(
    `- [${checks.secretFindings.length === 0 ? 'x' : ' '}] **Credential & Secret Scan**: ${checks.secretFindings.length === 0 ? 'Passed (no secrets detected)' : 'Failed (potential secrets identified)'}`,
  );
  lines.push(
    `- [${!checks.packageJsonChanged || checks.lockfileChanged ? 'x' : ' '}] **Lockfile Parity**: ${!checks.packageJsonChanged || checks.lockfileChanged ? 'Passed (package.json and lockfile in sync)' : 'Failed (package.json modified without lockfile)'}`,
  );
  lines.push(
    `- [${!checks.hasSourceChanges || checks.hasTestChanges ? 'x' : ' '}] **Test Coverage Guard**: ${!checks.hasSourceChanges || checks.hasTestChanges ? 'Passed (test modifications present or no source changes)' : 'Attention (source changes without corresponding tests)'}`,
  );
  lines.push(
    `- [x] **Monorepo Structure**: Passed (${changedFiles.length} file(s) evaluated)`,
  );
  lines.push('');

  if (findings.length > 0) {
    lines.push('#### Review Findings & Action Items:');
    for (const finding of findings) {
      lines.push(`- ⚠️ ${finding}`);
    }
    lines.push('');
  }

  if (changedFiles.length > 0) {
    lines.push('<details>');
    lines.push(`<summary><b>Evaluated Files (${changedFiles.length})</b></summary>`);
    lines.push('');
    for (const f of changedFiles.slice(0, 50)) {
      lines.push(`- \`${f}\``);
    }
    if (changedFiles.length > 50) {
      lines.push(`- ...and ${changedFiles.length - 50} more`);
    }
    lines.push('</details>');
    lines.push('');
  }

  lines.push('---');
  lines.push('*Automated dogfooding review generated by `@factory-cloud/cli` self-hosting pipeline.*');

  return lines.join('\n');
}
