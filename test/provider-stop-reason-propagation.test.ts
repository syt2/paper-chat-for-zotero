import { assert } from "chai";
import { AnthropicProvider } from "../src/modules/providers/AnthropicProvider.ts";
import { OpenAICompatibleProvider } from "../src/modules/providers/OpenAICompatibleProvider.ts";
import { OpenAIResponsesProvider } from "../src/modules/providers/OpenAIResponsesProvider.ts";
import type { ApiKeyProviderConfig } from "../src/types/provider";

const originalFetch = globalThis.fetch;
const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;

function config(type: ApiKeyProviderConfig["type"]): ApiKeyProviderConfig {
  return {
    id: `test-${type}`,
    name: `Test ${type}`,
    type,
    enabled: true,
    isBuiltin: false,
    order: 1,
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    defaultModel: "test-model",
    availableModels: ["test-model"],
  };
}

describe("non-streaming provider stop reason propagation", function () {
  beforeEach(function () {
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
  });

  after(function () {
    (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
  });

  it("propagates OpenAI finish_reason length", async function () {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "partial" },
              finish_reason: "length",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const result = await new OpenAICompatibleProvider(
      config("openai-compatible"),
    ).chatCompletionWithTools([
      { id: "user-1", role: "user", content: "hello", timestamp: 1 },
    ]);

    assert.equal(result.content, "partial");
    assert.equal(result.stopReason, "max_tokens");
  });

  it("uses the normalized function_call alias for the XML tool fallback", async function () {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '<function_calls><invoke name="search"><parameter name="query">paper</parameter></invoke></function_calls>',
              },
              finish_reason: "function_call",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const result = await new OpenAICompatibleProvider(
      config("openai-compatible"),
    ).chatCompletionWithTools(
      [{ id: "user-1", role: "user", content: "hello", timestamp: 1 }],
      [
        {
          type: "function",
          function: {
            name: "search",
            description: "Search",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    );

    assert.equal(result.content, "");
    assert.equal(result.toolCalls?.[0]?.function.name, "search");
    assert.equal(result.stopReason, "tool_calls");
  });

  it("propagates Anthropic stop_reason max_tokens", async function () {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "partial" }],
          stop_reason: "max_tokens",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const result = await new AnthropicProvider(
      config("anthropic"),
    ).chatCompletionWithTools([
      { id: "user-1", role: "user", content: "hello", timestamp: 1 },
    ]);

    assert.equal(result.content, "partial");
    assert.equal(result.stopReason, "max_tokens");
  });

  it("propagates Responses API max_output_tokens", async function () {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: "response-1",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                { type: "output_text", text: "partial", annotations: [] },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const result = await new OpenAIResponsesProvider(
      config("openai"),
    ).chatCompletionWithTools([
      { id: "user-1", role: "user", content: "hello", timestamp: 1 },
    ]);

    assert.equal(result.content, "partial");
    assert.equal(result.stopReason, "max_tokens");
  });

  it("propagates reasoning-only Responses API max_output_tokens", async function () {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: "response-reasoning-only",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            {
              type: "reasoning",
              summary: [{ type: "summary_text", text: "partial reasoning" }],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const result = await new OpenAIResponsesProvider(
      config("openai"),
    ).chatCompletionWithTools([
      { id: "user-1", role: "user", content: "hello", timestamp: 1 },
    ]);

    assert.equal(result.content, "");
    assert.equal(result.reasoning, "partial reasoning");
    assert.equal(result.stopReason, "max_tokens");
  });

  it("propagates streaming Responses API max_output_tokens", async function () {
    const events = [
      {
        type: "response.created",
        response: { id: "response-stream-1", store: false },
      },
      { type: "response.output_text.delta", delta: "partial" },
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
      },
    ];
    globalThis.fetch = async () =>
      new Response(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    let completed: { content: string; stopReason: string } | undefined;
    let streamError: Error | undefined;

    await new OpenAIResponsesProvider(
      config("openai"),
    ).streamChatCompletionWithTools(
      [{ id: "user-1", role: "user", content: "hello", timestamp: 1 }],
      [],
      {
        onTextDelta: () => undefined,
        onToolCallStart: () => undefined,
        onToolCallDelta: () => undefined,
        onComplete: (result) => {
          completed = result;
        },
        onError: (error) => {
          streamError = error;
        },
      },
    );

    assert.isUndefined(streamError);
    assert.equal(completed?.content, "partial");
    assert.equal(completed?.stopReason, "max_tokens");
  });

  it("propagates streaming reasoning-only Responses API max_output_tokens", async function () {
    const events = [
      {
        type: "response.created",
        response: { id: "response-reasoning-stream", store: false },
      },
      {
        type: "response.reasoning_summary_text.delta",
        delta: "partial reasoning",
      },
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
      },
    ];
    globalThis.fetch = async () =>
      new Response(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    let completed:
      | { content: string; reasoning?: string; stopReason: string }
      | undefined;
    let streamError: Error | undefined;

    await new OpenAIResponsesProvider(
      config("openai"),
    ).streamChatCompletionWithTools(
      [{ id: "user-1", role: "user", content: "hello", timestamp: 1 }],
      [],
      {
        onTextDelta: () => undefined,
        onReasoningDelta: () => undefined,
        onToolCallStart: () => undefined,
        onToolCallDelta: () => undefined,
        onComplete: (result) => {
          completed = result;
        },
        onError: (error) => {
          streamError = error;
        },
      },
    );

    assert.isUndefined(streamError);
    assert.equal(completed?.content, "");
    assert.equal(completed?.reasoning, "partial reasoning");
    assert.equal(completed?.stopReason, "max_tokens");
  });
});
