import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeUnifiedDiff,
  generatePrReview,
  generatePrReviewPrompt,
  createPrReviewerExecutionFn,
  AgentRuntime,
  createAgentContext,
  type ActionSink,
  type SinkAction,
} from '../src/index.ts';

const SAMPLE_DIFF = `
diff --git a/src/feature.ts b/src/feature.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/feature.ts
@@ -0,0 +1,5 @@
+export function add(a: number, b: number): number {
+  console.log("adding numbers");
+  return a + b;
+}
+
diff --git a/tests/feature.test.ts b/tests/feature.test.ts
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/tests/feature.test.ts
@@ -0,0 +1,4 @@
+import { add } from '../src/feature';
+assert.equal(add(1, 2), 3);
`;

const LEAKY_DIFF = `
diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,2 +1,3 @@
 export const config = {
+  token: "ghp_1234567890abcdef1234567890abcdef1234",
 };
`;

test('analyzeUnifiedDiff: parses files, additions, deletions, tests, and debug statements', () => {
  const analysis = analyzeUnifiedDiff(SAMPLE_DIFF);
  assert.equal(analysis.files.length, 2);
  assert.ok(analysis.files.includes('src/feature.ts'));
  assert.ok(analysis.files.includes('tests/feature.test.ts'));
  assert.equal(analysis.hasSourceChanges, true);
  assert.equal(analysis.hasTestChanges, true);
  assert.equal(analysis.hasPackageJsonChanges, false);
  assert.equal(analysis.secretFindings.length, 0);
  assert.equal(analysis.debugStatements.length, 1);
  assert.ok(analysis.debugStatements[0]?.includes('console.log'));
});

test('analyzeUnifiedDiff: detects credential leak in diff', () => {
  const analysis = analyzeUnifiedDiff(LEAKY_DIFF);
  assert.equal(analysis.secretFindings.length, 1);
  assert.ok(analysis.secretFindings[0]?.includes('GitHub Personal Access Token'));
});

test('generatePrReview: requests changes on credential leak', async () => {
  const review = await generatePrReview(
    { number: 42, title: 'Add feature', repository: 'acme/repo' },
    LEAKY_DIFF
  );

  assert.equal(review.verdict, 'REQUEST_CHANGES');
  assert.ok(review.findings.some((f) => f.category === 'security' && f.severity === 'error'));
  assert.ok(review.markdown.includes('REQUEST CHANGES'));
});

test('generatePrReview: generates structured markdown and integrates LLM client', async () => {
  let llmCalled = false;
  const mockLlm = async (userPrompt: string, systemPrompt?: string) => {
    llmCalled = true;
    assert.ok(userPrompt.includes('PR #100'));
    assert.ok(systemPrompt?.includes('strict code reviewer'));
    return JSON.stringify({
      verdict: 'APPROVE',
      summary: 'Excellent implementation of add function with comprehensive unit tests.',
      findings: [
        {
          category: 'quality',
          severity: 'info',
          message: 'Clean implementation; ensure debug log is removed before release.',
        },
      ],
    });
  };

  const review = await generatePrReview(
    { number: 100, title: 'Add math helpers', repository: 'acme/repo' },
    SAMPLE_DIFF,
    { llmClient: mockLlm, instruction: 'Verify strict typing' }
  );

  assert.equal(llmCalled, true);
  assert.equal(review.prNumber, 100);
  assert.ok(review.summary.includes('Excellent implementation'));
  assert.ok(review.markdown.includes('## 🤖 Cloud Factory PR Review: #100'));
  assert.ok(review.markdown.includes('Verify strict typing'));
});

test('createPrReviewerExecutionFn: end-to-end execution with diff fetch and review sink emission', async () => {
  const emittedActions: SinkAction[] = [];
  const testSink: ActionSink = {
    name: 'test-pr-review-sink',
    supportedActions: ['github:pr:review'],
    canHandle: (action) => action.type === 'github:pr:review',
    handle: async (action) => {
      emittedActions.push(action);
      return {
        sinkName: 'test-pr-review-sink',
        actionId: action.id,
        actionType: action.type,
        success: true,
        durationMs: 1,
      };
    },
  };

  const runtime = new AgentRuntime();
  runtime.registerSink(testSink);

  let signedRequestCalled = false;
  const mockCredentials = {
    hasPermission: async () => true,
    executeSignedRequest: async <T>(req: { service: string; action: string; params?: any }): Promise<T> => {
      if (req.service === 'github' && req.action === 'pr.diff') {
        signedRequestCalled = true;
        assert.equal(req.params?.number, 55);
        return SAMPLE_DIFF as unknown as T;
      }
      throw new Error(`Unexpected signed request: ${req.service}:${req.action}`);
    },
  };

  const ctx = createAgentContext({
    repo: { owner: 'acme', name: 'demo' },
    credentials: mockCredentials,
    sinks: runtime.sinks,
    state: {
      event: {
        event: 'pull_request',
        action: 'opened',
        number: 55,
        title: 'New Feature Pull Request',
        repository: 'acme/demo',
        payload: {
          number: 55,
          pull_request: { title: 'New Feature Pull Request', user: { login: 'alice' } },
        },
      },
    },
  });

  const execFn = createPrReviewerExecutionFn();
  const result = await runtime.runAgent('Review PR #55', ctx, execFn);

  assert.equal(result.status, 'success');
  assert.equal(signedRequestCalled, true);
  assert.equal(emittedActions.length, 1);
  const reviewAction = emittedActions[0];
  assert.equal(reviewAction?.type, 'github:pr:review');
  const payload = reviewAction?.payload as any;
  assert.equal(payload?.prNumber, 55);
  assert.ok(['APPROVE', 'COMMENT'].includes(payload?.event));
  assert.ok(payload?.body.includes('Cloud Factory PR Review: #55'));
});

test('createPrReviewerExecutionFn: skips closed pull request action without fetching diff', async () => {
  const runtime = new AgentRuntime();
  let signedRequestCalled = false;
  const mockBroker: CredentialBroker = {
    async requestCapability() {
      return { ok: true, capability: 'mock-cap' };
    },
    async executeSignedRequest() {
      signedRequestCalled = true;
      return { ok: true, status: 200, data: '' };
    },
    async checkPermission() {
      return true;
    },
  };

  const ctx = createAgentContext({
    id: 'test-run-closed',
    credentials: mockBroker,
    state: {
      event: {
        provider: 'github',
        event: 'pull_request',
        action: 'closed',
        number: 56,
        title: 'Closed Pull Request',
        repository: 'acme/demo',
        payload: {
          action: 'closed',
          number: 56,
          pull_request: { title: 'Closed Pull Request', user: { login: 'alice' } },
        },
      },
    },
  });

  const execFn = createPrReviewerExecutionFn();
  const result = await runtime.runAgent('Review PR #56', ctx, execFn);

  assert.equal(result.status, 'success');
  assert.equal(signedRequestCalled, false);
  assert.match(result.output ?? '', /Skipped non-open pull_request action: closed/);
});
