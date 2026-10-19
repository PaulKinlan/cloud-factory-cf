import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "@factory-cloud/sdk";
import { brokeredLlmClient, parseReviewModel, reviewRuntime } from "../src/review/model";

/**
 * The model half of the reviewer (cloud-factory-cf-7or graft): the SDK engine asks
 * for a review, this client fetches it through a closed policy action.
 */
function fakeBroker(response: { status?: number; body?: unknown } | Error): {
  broker: CredentialBroker;
  calls: Array<{ service: string; action: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ service: string; action: string; params: Record<string, unknown> }> = [];
  const broker = {
    hasPermission: async () => true,
    executeSignedRequest: async (request: { service: string; action: string; params?: Record<string, unknown> }) => {
      calls.push({ service: request.service, action: request.action, params: request.params ?? {} });
      if (response instanceof Error) throw response;
      return response as never;
    },
  } as unknown as CredentialBroker;
  return { broker, calls };
}

const CONFIG = { service: "anthropic", model: "claude-review-test", maxTokens: 256 };

describe("review model configuration", () => {
  it("reads service/model and refuses a guess", () => {
    expect(parseReviewModel("anthropic/claude-sonnet-4-5")).toMatchObject({
      service: "anthropic",
      model: "claude-sonnet-4-5",
    });
    expect(parseReviewModel(undefined)).toBeNull();
    expect(parseReviewModel("no-slash")).toBeNull();
    expect(parseReviewModel("/model")).toBeNull();
    expect(reviewRuntime({})).toBeUndefined();
    expect(reviewRuntime({ REVIEW_MODEL: "anthropic/claude-review-test" })).toBeTypeOf("function");
  });
});

describe("the brokered model client", () => {
  it("calls the declared action and returns the model's text", async () => {
    const { broker, calls } = fakeBroker({
      status: 200,
      body: JSON.stringify({ content: [{ type: "text", text: "Looks risky: eval on user input." }] }),
    });
    const answer = await brokeredLlmClient(broker, CONFIG)("review this diff", "you are a reviewer");
    expect(answer).toBe("Looks risky: eval on user input.");
    expect(calls[0]).toMatchObject({
      service: "anthropic",
      action: "messages.create",
      params: { model: "claude-review-test", max_tokens: 256 },
    });
    // The system prompt travels with the user prompt rather than being dropped.
    expect(String(calls[0]?.params["prompt"])).toContain("you are a reviewer");
  });

  it("reads the OpenAI shape and uses its action", async () => {
    const { broker, calls } = fakeBroker({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: "openai says no" } }] }),
    });
    const answer = await brokeredLlmClient(broker, { ...CONFIG, service: "openai", model: "gpt-test" })("p");
    expect(answer).toBe("openai says no");
    expect(calls[0]).toMatchObject({ service: "openai", action: "chat.completions" });
  });

  it("fails loudly when the model refuses or says nothing", async () => {
    const refused = fakeBroker({ status: 529, body: JSON.stringify({ error: { type: "overloaded" } }) });
    await expect(brokeredLlmClient(refused.broker, CONFIG)("p")).rejects.toThrow("anthropic refused the review (529)");

    const empty = fakeBroker({ status: 200, body: JSON.stringify({ content: [] }) });
    await expect(brokeredLlmClient(empty.broker, CONFIG)("p")).rejects.toThrow("returned no review text");

    // A broker that cannot reach the provider surfaces as a failure, never a review.
    await expect(brokeredLlmClient(fakeBroker(new Error("broker refused")).broker, CONFIG)("p")).rejects.toThrow(
      "broker refused",
    );
  });
});
