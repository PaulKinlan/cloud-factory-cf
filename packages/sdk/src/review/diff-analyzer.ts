/**
 * Unified diff analyzer for PR code review.
 * Inspects diffs for structural changes, test coverage deficit,
 * dependency synchronization, and secret leaks.
 */

import type { DiffAnalysis } from './types.ts';

const SECRET_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: 'GitHub Personal Access Token', pattern: /ghp_[A-Za-z0-9_]{36}/ },
  { name: 'GitHub Fine-Grained Token', pattern: /github_pat_[A-Za-z0-9_]{82}/ },
  { name: 'OpenAI API Key', pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'Slack Token', pattern: /xox[baprs]-[0-9a-zA-Z]{10,}/ },
  { name: 'AWS Access Key ID', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private Key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Generic Hardcoded Secret', pattern: /(?:api[_-]?key|client[_-]?secret|auth[_-]?token|bearer[_-]?token)\s*[:=]\s*["'][a-zA-Z0-9_\-]{20,}["']/i },
];

const DEBUG_PATTERNS: ReadonlyArray<RegExp> = [
  /\bconsole\.log\s*\(/,
  /\bconsole\.debug\s*\(/,
  /\bdebugger\s*;?/,
];

function isTestFile(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.includes('.test.') ||
    lower.includes('.spec.') ||
    lower.includes('/test/') ||
    lower.includes('/tests/') ||
    lower.includes('/__tests__/')
  );
}

function isSourceFile(path: string): boolean {
  if (isTestFile(path)) return false;
  return /\.(?:[jt]sx?|m[jt]s|c[jt]s|py|rs|go|rb|php|java|cpp|c|cs)$/i.test(path);
}

export function analyzeUnifiedDiff(diff: string): DiffAnalysis {
  if (!diff || typeof diff !== 'string') {
    return {
      files: [],
      additions: 0,
      deletions: 0,
      hasSourceChanges: false,
      hasTestChanges: false,
      hasPackageJsonChanges: false,
      hasLockfileChanges: false,
      secretFindings: [],
      debugStatements: [],
      fileSummaries: [],
    };
  }

  const lines = diff.split('\n');
  const files: string[] = [];
  const fileSummaries: Array<{
    file: string;
    additions: number;
    deletions: number;
    status: 'added' | 'modified' | 'deleted';
  }> = [];

  let currentFile: string | null = null;
  let currentAdditions = 0;
  let currentDeletions = 0;
  let isNewFile = false;
  let isDeletedFile = false;

  let totalAdditions = 0;
  let totalDeletions = 0;

  const secretFindings: string[] = [];
  const debugStatements: string[] = [];

  const finalizeFile = () => {
    if (currentFile) {
      files.push(currentFile);
      const status = isNewFile ? 'added' : isDeletedFile ? 'deleted' : 'modified';
      fileSummaries.push({
        file: currentFile,
        additions: currentAdditions,
        deletions: currentDeletions,
        status,
      });
    }
    currentFile = null;
    currentAdditions = 0;
    currentDeletions = 0;
    isNewFile = false;
    isDeletedFile = false;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finalizeFile();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (match) {
        currentFile = match[2] ?? match[1] ?? 'unknown';
      }
      continue;
    }

    if (line.startsWith('new file mode')) {
      isNewFile = true;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      isDeletedFile = true;
      continue;
    }

    if (line.startsWith('+++ b/')) {
      const f = line.slice(6).trim();
      if (f && f !== '/dev/null') {
        currentFile = f;
      }
      continue;
    }
    if (line.startsWith('--- a/')) {
      const f = line.slice(6).trim();
      if (!currentFile && f && f !== '/dev/null') {
        currentFile = f;
      }
      continue;
    }

    // Only inspect added lines for secrets, debugs, and additions
    if (line.startsWith('+') && !line.startsWith('+++')) {
      totalAdditions++;
      currentAdditions++;
      const addedContent = line.slice(1);

      // Check secrets
      for (const { name, pattern } of SECRET_PATTERNS) {
        if (pattern.test(addedContent)) {
          const finding = `Detected potential ${name} in ${currentFile ?? 'modified file'}`;
          if (!secretFindings.includes(finding)) {
            secretFindings.push(finding);
          }
        }
      }

      // Check debug statements in non-test source files
      if (currentFile && isSourceFile(currentFile)) {
        for (const pattern of DEBUG_PATTERNS) {
          if (pattern.test(addedContent)) {
            const statement = `Possible leftover debug statement in ${currentFile}: \`${addedContent.trim()}\``;
            if (!debugStatements.includes(statement)) {
              debugStatements.push(statement);
            }
          }
        }
      }
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      totalDeletions++;
      currentDeletions++;
      continue;
    }
  }

  finalizeFile();

  const uniqueFiles = Array.from(new Set(files));
  const hasSourceChanges = uniqueFiles.some(isSourceFile);
  const hasTestChanges = uniqueFiles.some(isTestFile);
  const hasPackageJsonChanges = uniqueFiles.some((f) => f.endsWith('package.json'));
  const hasLockfileChanges = uniqueFiles.some((f) =>
    f.endsWith('package-lock.json') || f.endsWith('pnpm-lock.yaml') || f.endsWith('yarn.lock')
  );

  return {
    files: uniqueFiles,
    additions: totalAdditions,
    deletions: totalDeletions,
    hasSourceChanges,
    hasTestChanges,
    hasPackageJsonChanges,
    hasLockfileChanges,
    secretFindings,
    debugStatements,
    fileSummaries,
  };
}
