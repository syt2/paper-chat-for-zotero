import { assert } from "chai";
import {
  applyReasoningRequestOptions,
  needsThinkingDisabledForHistory,
  normalizeReasoningEffortPreference,
  shouldSuppressTemperatureForReasoning,
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

  it("adds reasoning_effort to OpenAI Chat Completions requests", function () {
    const body: Record<string, unknown> = {};
    applyReasoningRequestOptions(body, config(), "chat_completions");
    assert.equal(body.reasoning_effort, "high");
    assert.notProperty(body, "reasoning");
    assert.notProperty(body, "thinking");
  });

  it("leaves Chat Completions unchanged without capability metadata", function () {
    const body: Record<string, unknown> = {};
    applyReasoningRequestOptions(
      body,
      config({ reasoningCapability: undefined }),
      "chat_completions",
    );
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

  it("disables thinking when tool history lacks reasoning_content", function () {
    const deepseekConfig = config({
      defaultModel: "deepseek-flash",
      reasoningCapability: {
        protocol: "deepseek",
        efforts: ["none", "low", "medium", "high", "xhigh", "max"],
        default: "high",
      },
    });
    const withGap: ChatMessage[] = [
      { id: "u1", role: "user", content: "hi", timestamp: 1 },
      { id: "a1", role: "assistant", content: "hello", timestamp: 2 },
    ];
    const withReasoning: ChatMessage[] = [
      { id: "u1", role: "user", content: "hi", timestamp: 1 },
      {
        id: "a1",
        role: "assistant",
        content: "hello",
        reasoning: "thinking",
        timestamp: 2,
      },
    ];

    assert.isTrue(
      needsThinkingDisabledForHistory(withGap, deepseekConfig, true),
    );
    assert.isFalse(
      needsThinkingDisabledForHistory(withReasoning, deepseekConfig, true),
    );
    assert.isFalse(
      needsThinkingDisabledForHistory(withGap, deepseekConfig, false),
    );
    assert.isFalse(needsThinkingDisabledForHistory(withGap, config(), true));

    const body: Record<string, unknown> = {};
    applyReasoningRequestOptions(body, deepseekConfig, "chat_completions", {
      disableThinking: true,
    });
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.notProperty(body, "reasoning_effort");
  });

  it("suppresses temperature while reasoning is enabled", function () {
    assert.isTrue(shouldSuppressTemperatureForReasoning(config()));
    assert.isFalse(
      shouldSuppressTemperatureForReasoning(
        config({
          id: "deepseek",
          defaultModel: "deepseek-v4-pro",
          reasoningCapability: undefined,
        }),
      ),
    );
    assert.isFalse(
      shouldSuppressTemperatureForReasoning(
        config({
          reasoningCapability: {
            protocol: "openai",
            efforts: ["none", "low", "medium", "high", "xhigh", "max"],
            default: "medium",
            omitTemperature: false,
          },
        }),
      ),
    );
    assert.isFalse(
      shouldSuppressTemperatureForReasoning(
        config({ reasoningEffort: "none" }),
      ),
    );
    assert.isFalse(
      shouldSuppressTemperatureForReasoning(
        config({ reasoningCapability: undefined }),
      ),
    );
  });

  it("omits temperature from Chat Completions while reasoning is on", async function () {
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "hello", timestamp: 1 },
    ];

    await new OpenAICompatibleProvider(config()).chatCompletion(messages);
    assert.notProperty(requestBody, "temperature");
    assert.equal(requestBody.reasoning_effort, "high");

    await new OpenAICompatibleProvider(
      config({ reasoningEffort: "none" }),
    ).chatCompletion(messages);
    assert.equal(requestBody.temperature, 0.7);
    assert.equal(requestBody.reasoning_effort, "none");
  });

  it("replays assistant reasoning_content for DeepSeek tool requests", async function () {
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
        defaultModel: "deepseek-flash",
        reasoningCapability: {
          protocol: "deepseek",
          efforts: ["none", "low", "medium", "high", "xhigh", "max"],
          default: "high",
        },
      }),
    );
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "hi", timestamp: 1 },
      {
        id: "a1",
        role: "assistant",
        content: "hello",
        reasoning: "prior chain of thought",
        timestamp: 2,
      },
      { id: "u2", role: "user", content: "again", timestamp: 3 },
    ];
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "noop",
          description: "noop",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    await provider.chatCompletionWithTools(messages, tools);

    const sentMessages = requestBody.messages as Array<Record<string, unknown>>;
    assert.equal(sentMessages[1].reasoning_content, "prior chain of thought");
    assert.deepEqual(requestBody.thinking, { type: "enabled" });
    assert.equal(requestBody.reasoning_effort, "high");
  });

  it("replays reasoning produced by another model after switching to DeepSeek", async function () {
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
        defaultModel: "deepseek-flash",
        reasoningCapability: {
          protocol: "deepseek",
          efforts: ["none", "low", "high", "max"],
          default: "high",
        },
      }),
    );
    // History produced by an OpenAI model before the switch.
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "hi", timestamp: 1 },
      {
        id: "a1",
        role: "assistant",
        content: "hello",
        reasoning: "reasoning written by gpt-6-luna",
        timestamp: 2,
      },
      { id: "u2", role: "user", content: "again", timestamp: 3 },
    ];
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "noop",
          description: "noop",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    await provider.chatCompletionWithTools(messages, tools);

    const sentMessages = requestBody.messages as Array<Record<string, unknown>>;
    assert.equal(
      sentMessages[1].reasoning_content,
      "reasoning written by gpt-6-luna",
    );
    assert.deepEqual(requestBody.thinking, { type: "enabled" });
  });

  it("drops stored reasoning when switching from DeepSeek to another model", async function () {
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = new OpenAICompatibleProvider(
      config({ defaultModel: "gpt-5.6-terra" }),
    );
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "hi", timestamp: 1 },
      {
        id: "a1",
        role: "assistant",
        content: "hello",
        reasoning: "reasoning written by deepseek",
        timestamp: 2,
      },
      { id: "u2", role: "user", content: "again", timestamp: 3 },
    ];
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "noop",
          description: "noop",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    await provider.chatCompletionWithTools(messages, tools);

    const sentMessages = requestBody.messages as Array<Record<string, unknown>>;
    assert.notProperty(sentMessages[1], "reasoning_content");
    assert.notProperty(requestBody, "thinking");
    assert.equal(requestBody.reasoning_effort, "high");
  });

  it("downgrades DeepSeek tool requests whose history has no reasoning", async function () {
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
        defaultModel: "deepseek-flash",
        reasoningCapability: {
          protocol: "deepseek",
          efforts: ["none", "low", "medium", "high", "xhigh", "max"],
          default: "high",
        },
      }),
    );
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "hi", timestamp: 1 },
      { id: "a1", role: "assistant", content: "hello", timestamp: 2 },
      { id: "u2", role: "user", content: "again", timestamp: 3 },
    ];
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "noop",
          description: "noop",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    await provider.chatCompletionWithTools(messages, tools);

    assert.deepEqual(requestBody.thinking, { type: "disabled" });
    assert.notProperty(requestBody, "reasoning_effort");
  });

  it("adds reasoning_effort to the full OpenAI Chat Completions request", async function () {
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
    assert.equal(requestBody.reasoning_effort, "high");
    assert.notProperty(requestBody, "thinking");
  });

  it("keeps the full Chat Completions request unchanged without capability", async function () {
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = new OpenAICompatibleProvider(
      config({ reasoningCapability: undefined }),
    );
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
