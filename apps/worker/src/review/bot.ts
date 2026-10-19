/**
 * The LLM pull-request reviewer (cloud-factory-cf-7or).
 *
 * The whole job, in one runtime:
 *   webhook → queue → claim → diff (through the broker) → model (through the broker)
 *   → a PR review comment (through the broker).
 *
 * Nothing here holds a credential. The diff and the model call are broker actions
 * from the closed policy table (`github:pr.diff`, `anthropic:messages.create` /
 * `openai:chat.completions`), so an agent prompt cannot aim them anywhere else.
 *
 * The runtime is deterministic about *what* it does and the model only writes the
 * review text: a model that is unavailable fails the run (and the queue retries it)
 * rather than silently posting a template comment as if it were a review.
 */
import type { AgentExecutionFn, CredentialBroker, CredentialCapabilityRequest } from "@factory-cloud/sdk";
import { canonicalView, type Decision, type EventFacts } from "../pipeline";

/** How the review call is configured; `REVIEW_MODEL` is `service/model`. */
export interface ReviewModelConfig {
  service: string;
  model: string;
  maxTokens: number;
  /** A diff bigger than this is cut with a marker, not silently truncated. */
  maxDiffChars: number;
}

export const DEFAULT_REVIEW_MAX_TOKENS = 1_200;
export const DEFAULT_REVIEW_MAX_DIFF_CHARS = 60_000;

/**
 * Reads `REVIEW_MODEL` (`anthropic/claude-…`, `openai/gpt-…`). Anything without a
 * service and a model is refused: the runtime is off rather than guessing a model
 * name that may not exist in the operator's account.
 */
export function parseReviewModel(
  value: string | undefined,
  options: { maxTokens?: number; maxDiffChars?: number } = {},
): ReviewModelConfig | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  const service = trimmed.slice(0, separator).trim();
  const model = trimmed.slice(separator + 1).trim();
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(service) || model.length === 0 || model.length > 128) return null;
  return {
    service,
    model,
    maxTokens: options.maxTokens ?? DEFAULT_REVIEW_MAX_TOKENS,
    maxDiffChars: options.maxDiffChars ?? DEFAULT_REVIEW_MAX_DIFF_CHARS,
  };
}

export type ReviewResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The SDK request shape plus the status flag this worker's broker understands
 * (`includeStatus`), so an upstream 404 is distinguishable from an empty body.
 */
type ReviewRequest = CredentialCapabilityRequest & { readonly includeStatus?: boolean };

/**
 * The unified diff of a pull request. `pr.diff` is the same GitHub route as the
 * pull request itself with the diff media type, so it needs no second credential.
 */
export async function fetchPullRequestDiff(
  credentials: CredentialBroker,
  number: number,
): Promise<ReviewResult<string>> {
  try {
    const request: ReviewRequest = {
      service: "github",
      action: "pr.diff",
      params: { number },
      includeStatus: true,
    };
    const response = await credentials.executeSignedRequest<{ status?: number; body?: unknown }>(request);
    const status = typeof response?.status === "number" ? response.status : 0;
    const body = typeof response?.body === "string" ? response.body : "";
    if (status < 200 || status >= 300) {
      return { ok: false, error: `github refused the diff (${status || "no status"})` };
    }
    if (body.trim().length === 0) return { ok: false, error: "github returned an empty diff" };
    return { ok: true, value: body };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/**
 * The model's answer. Both provider shapes are read here so the deployment
 * chooses a service with `REVIEW_MODEL` and nothing else changes.
 */
export async function reviewWithModel(
  credentials: CredentialBroker,
  config: ReviewModelConfig,
  prompt: string,
): Promise<ReviewResult<string>> {
  const action = config.service === "openai" ? "chat.completions" : "messages.create";
  try {
    const request: ReviewRequest = {
      service: config.service,
      action,
      params: { model: config.model, max_tokens: config.maxTokens, prompt },
      includeStatus: true,
    };
    const response = await credentials.executeSignedRequest<{ status?: number; body?: unknown }>(request);
    const status = typeof response?.status === "number" ? response.status : 0;
    const parsed = typeof response?.body === "string" ? safeJson(response.body) : response?.body;
    if (status < 200 || status >= 300) {
      // The upstream error text can name the organisation's billing state, so it is
      // summarised rather than echoed into the run record.
      return { ok: false, error: `${config.service} refused the review (${status || "no status"})` };
    }
    const text = reviewTextOf(parsed);
    if (text === null || text.trim().length === 0) {
      return { ok: false, error: `${config.service} returned no review text` };
    }
    return { ok: true, value: text.trim() };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** Anthropic `content[]` or OpenAI `choices[0].message.content`. */
function reviewTextOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const content = record["content"];
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => (typeof part === "object" && part !== null ? (part as Record<string, unknown>)["text"] : null))
      .filter((part): part is string => typeof part === "string");
    if (parts.length > 0) return parts.join("\n");
  }
  const choices = record["choices"];
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    const message = typeof first === "object" && first !== null ? (first as Record<string, unknown>)["message"] : null;
    const text = typeof message === "object" && message !== null ? (message as Record<string, unknown>)["content"] : null;
    if (typeof text === "string") return text;
  }
  return null;
}

/** What the model is asked. The diff is the evidence; the facts are the context. */
export function reviewPrompt(facts: EventFacts, diff: string, maxDiffChars: number): string {
  const view = canonicalView(facts);
  const cut =
    diff.length > maxDiffChars
      ? `${diff.slice(0, maxDiffChars)}\n\n[diff truncated after ${maxDiffChars} characters]`
      : diff;
  return [
    `You are reviewing pull request #${facts.number ?? "?"} in ${facts.repository}${facts.title ? ` ("${facts.title}")` : ""}.`,
    `The ${facts.provider} event was ${view.kind}/${view.action ?? "unknown"} by ${facts.actor ?? "an unknown actor"}.`,
    "",
    "Review the diff below. Call out correctness or security problems you can see, and say plainly when you find none.",
    "Be specific: name the file and what is wrong. Do not restate the diff. Keep it under 200 words.",
    "",
    "```diff",
    cut,
    "```",
  ].join("\n");
}

/** The review body posted to the pull request, with its provenance. */
export function reviewCommentBody(text: string, config: ReviewModelConfig): string {
  return `${text}\n\n_Reviewed by cloud-factory with ${config.service}/${config.model}._`;
}

/**
 * The runtime: one run reviews one pull request. A non-review event is a clean
 * skip (the queue acks it) rather than a failure, so the factory does not burn
 * retries on pushes and issue comments.
 */
export function llmReviewer(config: ReviewModelConfig): AgentExecutionFn {
  return async ({ ctx }) => {
    const facts = ctx.state["event"] as EventFacts | undefined;
    if (!facts) {
      return { status: "failure", error: "no event facts in the run context", toolCallsCount: 0 };
    }

    const view = canonicalView(facts);
    if (view.kind !== "merge_request" || facts.number === null) {
      return {
        status: "success",
        output: `no review for ${view.kind}/${view.action ?? "-"}: only merge requests are reviewed`,
        toolCallsCount: 0,
      };
    }

    const diff = await fetchPullRequestDiff(ctx.credentials, facts.number);
    if (!diff.ok) {
      // Retryable: a provider blip must not settle the event as a code judgement.
      return { status: "failure", error: `could not read the diff: ${diff.error}`, toolCallsCount: 1 };
    }

    const answer = await reviewWithModel(
      ctx.credentials,
      config,
      reviewPrompt(facts, diff.value, config.maxDiffChars),
    );
    if (!answer.ok) {
      return { status: "failure", error: `could not review: ${answer.error}`, toolCallsCount: 1 };
    }

    const decision: Decision = {
      type: "github:pr:review",
      payload: {
        prNumber: facts.number,
        event: "COMMENT",
        body: reviewCommentBody(answer.value, config),
      },
    };
    const emitted = await ctx.sinks.emit(decision, ctx);
    const failed = emitted.find((result) => !result.success);
    if (failed !== undefined || emitted.length === 0) {
      return {
        status: "failure",
        error: failed?.error ?? "no sink accepted the review",
        toolCallsCount: 2,
      };
    }
    return {
      status: "success",
      output: `posted a review of #${facts.number} (${answer.value.length} chars)`,
      toolCallsCount: 2,
    };
  };
}

/**
 * The runtime selected for a deployment: the LLM reviewer when `REVIEW_MODEL` is
 * set, otherwise `undefined` so the pipeline keeps its deterministic default.
 */
export function reviewRuntime(env: { REVIEW_MODEL?: string; REVIEW_MAX_DIFF_CHARS?: string; REVIEW_MAX_TOKENS?: string }): AgentExecutionFn | undefined {
  const config = parseReviewModel(env.REVIEW_MODEL, {
    ...(numberOr(env.REVIEW_MAX_TOKENS) === null ? {} : { maxTokens: numberOr(env.REVIEW_MAX_TOKENS) as number }),
    ...(numberOr(env.REVIEW_MAX_DIFF_CHARS) === null ? {} : { maxDiffChars: numberOr(env.REVIEW_MAX_DIFF_CHARS) as number }),
  });
  return config === null ? undefined : llmReviewer(config);
}

function numberOr(value: string | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
