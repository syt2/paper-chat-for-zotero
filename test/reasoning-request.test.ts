import { assert } from "chai";
import {
  applyReasoningRequestOptions,
  normalizeReasoningEffortPreference,
} from "../src/modules/providers/reasoning-request.ts";
import { OpenAICompatibleProvider } from "../src/modules/providers/OpenAICompatibleProvider.ts";
import type { ChatMessage } from "../src/types/chat.ts";
import type { ApiKeyProviderConfig } from "../src/types/provider.ts";

function config(
  overrides: Partial<ApiKeyProviderConfig> = {},
): ApiKeyProviderConfig {
  return {
    id: "paperchat",
    name: "PaperChat",
    type: "openai-compatible",
    enabled: true,
    isBuiltin: true,
    order: 0,
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    defaultModel: "gpt-5.6-sol",
    availableModels: ["gpt-5.6-sol"],
    reasoningEffort: "high",
    reasoningCapability: {
      protocol: "openai",
      efforts: ["none", "low", "medium", "high", "xhigh", "max"],
      default: "medium",
    },
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;
const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;

describe("reasoning request options", function () {
  beforeEach(function () {
    (globalThis as { ztoolkit?: unknown }).ztoolkit = { log: () => undefined };
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
  });

  it("normalizes invalid persisted preferences to default", function () {
    assert.equal(normalizeReasoningEffortPreference("high"), "high");
    assert.equal(normalizeReasoningEffortPreference("invalid"), "default");
    assert.equal(normalizeReasoningEffortPreference(null), "default");
  });

  it("adds the selected effort to Responses requests", function () {
    const body: Record<string, unknown> = {};
    applyReasoningRequestOptions(body, config(), "responses");
    assert.deepEqual(body.reasoning, { effort: "high" });
  });

  it("leaves Responses requests unchanged for provider default", function () {
    const body: Record<string, unknown> = {};
    applyReasoningRequestOptions(
      body,
      config({ reasoningEffort: "default" }),
      "responses",
    );
    assert.notProperty(body, "reasoning");
  });

  it("keeps OpenAI Chat Completions unchanged", function () {
    const body: Record<string, unknown> = {};
    applyReasoningRequestOptions(body, config(), "chat_completions");
    assert.deepEqual(body, {});
  });

  it("uses DeepSeek Chat Completions fields for enabled reasoning", function () {
    const body: Record<string, unknown> = {};
    applyReasoningRequestOptions(
      body,
      config({
        defaultModel: "deepseek-v4-flash",
        reasoningCapability: {
          protocol: "deepseek",
          efforts: ["none", "low", "medium", "high", "xhigh", "max"],
          default: "high",
        },
      }),
      "chat_completions",
    );
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.reasoning_effort, "high");
  });

  it("disables DeepSeek thinking without sending reasoning_effort", function () {
    const body: Record<string, unknown> = {};
    applyReasoningRequestOptions(
      body,
      config({
        defaultModel: "deepseek-v4-pro",
        reasoningEffort: "none",
        reasoningCapability: {
          protocol: "deepseek",
          efforts: ["none", "high", "max"],
          default: "high",
        },
      }),
      "chat_completions",
    );
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.notProperty(body, "reasoning_effort");
  });

  it("supports known built-in DeepSeek v4 models without model metadata", function () {
    const body: Record<string, unknown> = {};
    applyReasoningRequestOptions(
      body,
      config({
        id: "deepseek",
        defaultModel: "deepseek-v4-pro-20260801",
        reasoningCapability: undefined,
      }),
      "chat_completions",
    );
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.reasoning_effort, "high");
  });

  it("does not send unsupported efforts or fields for unknown models", function () {
    const unsupportedBody: Record<string, unknown> = {};
    applyReasoningRequestOptions(
      unsupportedBody,
      config({
        reasoningEffort: "max",
        reasoningCapability: {
          protocol: "deepseek",
          efforts: ["none", "high"],
          default: "high",
        },
      }),
      "responses",
    );
    assert.deepEqual(unsupportedBody, {});

    const unknownBody: Record<string, unknown> = {};
    applyReasoningRequestOptions(
      unknownBody,
      config({ reasoningCapability: undefined }),
      "responses",
    );
    assert.deepEqual(unknownBody, {});
  });

  it("keeps the full OpenAI Chat Completions request unchanged", async function () {
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = new OpenAICompatibleProvider(config());
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "hello", timestamp: 1 },
    ];
    await provider.chatCompletion(messages);

    assert.notProperty(requestBody, "reasoning");
    assert.notProperty(requestBody, "reasoning_effort");
    assert.notProperty(requestBody, "thinking");
  });

  it("adds DeepSeek reasoning fields to the full Chat Completions request", async function () {
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = new OpenAICompatibleProvider(
      config({
        defaultModel: "deepseek-v4-pro",
        reasoningCapability: {
          protocol: "deepseek",
          efforts: ["none", "high", "max"],
          default: "high",
        },
      }),
    );
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "hello", timestamp: 1 },
    ];
    await provider.chatCompletion(messages);

    assert.deepEqual(requestBody.thinking, { type: "enabled" });
    assert.equal(requestBody.reasoning_effort, "high");
  });
});
