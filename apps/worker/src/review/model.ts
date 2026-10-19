/**
 * The model half of the reviewer: an `LlmClient` for the SDK review engine that
 * calls a model **through the credential broker** (cloud-factory-cf-7or graft).
 *
 * The SDK engine decides what to review and how to render it; this file only answers
 * "what does the model say", through a closed policy action, so no key ever enters
 * the worker or the agent context.
 */
import {
  createPrReviewerExecutionFn,
  type AgentExecutionFn,
  type CredentialBroker,
  type CredentialCapabilityRequest,
  type LlmClient,
} from "@factory-cloud/sdk";

/** `service/model`; the service must be a policy service (anthropic, openai). */
export interface ReviewModelConfig {
  service: string;
  model: string;
  maxTokens: number;
}

export const DEFAULT_REVIEW_MAX_TOKENS = 1_200;

/** The SDK request shape plus the status flag this worker's broker understands. */
type ModelRequest = CredentialCapabilityRequest & { readonly includeStatus?: boolean };

/**
 * Reads `REVIEW_MODEL` (`anthropic/claude-…`, `openai/gpt-…`). A value without a
 * service and a model is refused: the reviewer stays deterministic rather than
 * guessing a model name the operator's account may not have.
 */
export function parseReviewModel(value: string | undefined, maxTokens = DEFAULT_REVIEW_MAX_TOKENS): ReviewModelConfig | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  const service = trimmed.slice(0, separator).trim();
  const model = trimmed.slice(separator + 1).trim();
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(service) || model.length === 0 || model.length > 128) return null;
  return { service, model, maxTokens };
}

/**
 * The model's answer through the broker. Anthropic and OpenAI shapes are both read
 * here, so choosing a provider is configuration rather than a code path.
 */
export function brokeredLlmClient(credentials: CredentialBroker, config: ReviewModelConfig): LlmClient {
  return async (prompt: string, systemPrompt?: string): Promise<string> => {
    const action = config.service === "openai" ? "chat.completions" : "messages.create";
    const request: ModelRequest = {
      service: config.service,
      action,
      params: {
        model: config.model,
        max_tokens: config.maxTokens,
        prompt: systemPrompt === undefined ? prompt : `${systemPrompt}\n\n${prompt}`,
      },
      includeStatus: true,
    };
    const response = await credentials.executeSignedRequest<{ status?: number; body?: unknown }>(request);
    const status = typeof response?.status === "number" ? response.status : 0;
    const parsed = typeof response?.body === "string" ? safeJson(response.body) : response?.body;
    if (status < 200 || status >= 300) {
      // The upstream text can name billing state or an org, so it is summarised.
      throw new Error(`${config.service} refused the review (${status || "no status"})`);
    }
    const text = textOf(parsed);
    if (text === null || text.trim().length === 0) {
      throw new Error(`${config.service} returned no review text`);
    }
    return text.trim();
  };
}

/** Anthropic `content[]` or OpenAI `choices[0].message.content`. */
function textOf(body: unknown): string | null {
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

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * The SDK review engine with a model behind it. The client is built from the run's
 * own credentials, so a capability is issued for that repository and that run.
 */
export function llmReviewer(config: ReviewModelConfig): AgentExecutionFn {
  return async (input) => {
    const client = brokeredLlmClient(input.ctx.credentials, config);
    return createPrReviewerExecutionFn({ llmClient: client, model: config.model })(input);
  };
}

/**
 * What a deployment gets: the model-backed reviewer when `REVIEW_MODEL` is set, and
 * nothing (so the caller keeps its own default) when it is not.
 */
export function reviewRuntime(env: { REVIEW_MODEL?: string }): AgentExecutionFn | undefined {
  const config = parseReviewModel(env.REVIEW_MODEL);
  return config === null ? undefined : llmReviewer(config);
}
