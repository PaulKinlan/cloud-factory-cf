/**
 * Types for the Core PR Reviewer Bot and LLM Review Engine.
 */

import type { AgentExecutionFn } from '../runtime/agent-runtime.ts';

export type ReviewVerdict = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

export interface PullRequestInfo {
  readonly number: number;
  readonly title: string;
  readonly author?: string;
  readonly repository?: string;
  readonly baseRef?: string;
  readonly headRef?: string;
  readonly commitSha?: string;
  readonly description?: string;
}

export interface ReviewFinding {
  readonly category: 'security' | 'test' | 'dependency' | 'quality' | 'general';
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
}

export interface DiffAnalysis {
  readonly files: readonly string[];
  readonly additions: number;
  readonly deletions: number;
  readonly hasSourceChanges: boolean;
  readonly hasTestChanges: boolean;
  readonly hasPackageJsonChanges: boolean;
  readonly hasLockfileChanges: boolean;
  readonly secretFindings: readonly string[];
  readonly debugStatements: readonly string[];
  readonly fileSummaries: ReadonlyArray<{
    readonly file: string;
    readonly additions: number;
    readonly deletions: number;
    readonly status: 'added' | 'modified' | 'deleted';
  }>;
}

export type LlmClient = (prompt: string, systemPrompt?: string) => Promise<string>;

export interface PrReviewerOptions {
  readonly llmClient?: LlmClient;
  readonly model?: string;
  readonly strict?: boolean;
  readonly instruction?: string;
  readonly defaultVerdict?: ReviewVerdict;
}

export interface ReviewResult {
  readonly prNumber: number;
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  readonly markdown: string;
  readonly diffAnalysis: DiffAnalysis;
}
