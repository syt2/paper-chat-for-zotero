import { assert } from "chai";
import {
  applyExtraRequestBody,
  OpenAICompatibleProvider,
} from "../src/modules/providers/OpenAICompatibleProvider.ts";
import {
  normalizePromptCacheUsage,
  normalizePromptCacheTools,
  stablePromptCacheStringify,
} from "../src/modules/providers/prompt-cache-diagnostics.ts";
import type { ChatMessage } from "../src/types/chat";
import type { ApiKeyProviderConfig } from "../src/types/provider";
import type { ToolDefinition } from "../src/types/tool";

class ExposedOpenAICompatibleProvider extends OpenAICompatibleProvider {
  formatForTest(messages: ChatMessage[]) {
    return this.formatOpenAIMessages(messages);
  }
}

function provider(id: string): ExposedOpenAICompatibleProvider {
  return new ExposedOpenAICompatibleProvider({
    id,
    name: id,
    type: "openai-compatible",
    enabled: true,
    isBuiltin: id === "paperchat",
    order: 1,
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    defaultModel: "test-model",
    availableModels: ["test-model"],
  } satisfies ApiKeyProviderConfig);
}

describe("OpenAI-compatible extra request body", function () {
  it("merges provider and model extra body while preserving protected fields", function () {
    const requestBody: Record<string, unknown> = {
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      temperature: 0.7,
      max_tokens: 8192,
      tools: [{ type: "function", function: { name: "search" } }],
      tool_choice: "auto",
    };

    applyExtraRequestBody(requestBody, {
      defaultModel: "gpt-5",
      extraRequestBody: {
        reasoning_effort: "low",
        max_tokens: 2048,
        temperature: 1.5,
        stream: false,
        model: "other-model",
        messages: [],
        tools: [],
        tool_choice: "none",
      },
      modelExtraRequestBody: {
        "gpt-5": {
          reasoning_effort: "high",
          reasoning: { effort: "high" },
          top_p: 0.9,
        },
        "gpt-5-mini": {
          reasoning_effort: "medium",
        },
      },
    });

    assert.equal(requestBody.model, "gpt-5");
    assert.deepEqual(requestBody.messages, [{ role: "user", content: "hello" }]);
    assert.equal(requestBody.stream, true);
    assert.deepEqual(requestBody.tools, [
      { type: "function", function: { name: "search" } },
    ]);
    assert.equal(requestBody.tool_choice, "auto");
    assert.equal(requestBody.max_tokens, 8192);
    assert.equal(requestBody.temperature, 0.7);
    assert.equal(requestBody.reasoning_effort, "high");
    assert.deepEqual(requestBody.reasoning, { effort: "high" });
    assert.equal(requestBody.top_p, 0.9);
  });

  it("canonicalizes extra request body fields for stable prompt cache keys", function () {
    const requestBody: Record<string, unknown> = {
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      temperature: 0.7,
    };

    applyExtraRequestBody(requestBody, {
      defaultModel: "gpt-5",
      extraRequestBody: {
        metadata: {
          z: 1,
          a: {
            y: true,
            b: "stable",
          },
        },
      },
    });

    assert.equal(
      stablePromptCacheStringify(requestBody),
      '{"messages":[{"content":"hello","role":"user"}],"metadata":{"a":{"b":"stable","y":true},"z":1},"model":"gpt-5","stream":true,"temperature":0.7}',
    );
  });

  it("sorts nested tool schemas without changing tool order", function () {
    const tools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "b_tool",
          description: "B",
          parameters: {
            type: "object",
            properties: {
              z: { type: "string", description: "last" },
              a: { description: "first", type: "string" },
            },
            required: ["z", "a"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "a_tool",
          description: "A",
          parameters: {
            required: [],
            properties: {},
            type: "object",
          },
        },
      },
    ];

    const normalized = normalizePromptCacheTools(tools);

    assert.equal(normalized[0].function.name, "b_tool");
    assert.equal(normalized[1].function.name, "a_tool");
    assert.equal(
      stablePromptCacheStringify(normalized[0].function.parameters),
      '{"properties":{"a":{"description":"first","type":"string"},"z":{"description":"last","type":"string"}},"required":["z","a"],"type":"object"}',
    );
  });

  it("normalizes cache usage fields from common OpenAI-compatible shapes", function () {
    assert.deepEqual(
      normalizePromptCacheUsage({
        prompt_tokens: 1000,
        completion_tokens: 25,
        prompt_tokens_details: {
          cached_tokens: 800,
        },
      }),
      {
        inputTokens: 1000,
        outputTokens: 25,
        cacheReadTokens: 800,
        cacheCreationTokens: undefined,
      },
    );

    assert.deepEqual(
      normalizePromptCacheUsage({
        input_tokens: 1200,
        output_tokens: 50,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
      }),
      {
        inputTokens: 1200,
        outputTokens: 50,
        cacheReadTokens: 900,
        cacheCreationTokens: 100,
      },
    );
  });

  it("marks only PaperChat cache checkpoints with cache_control", function () {
    const messages: ChatMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: "hello",
        timestamp: 1,
      },
      {
        id: "cache-checkpoint",
        role: "system",
        content:
          "Prompt cache checkpoint. This is not user content or an instruction.",
        timestamp: 2,
      },
    ];

    const paperchatMessages = provider("paperchat").formatForTest(messages);
    const customMessages = provider("custom-provider").formatForTest(messages);

    assert.deepEqual(paperchatMessages[1]?.content, [
      {
        type: "text",
        text: "Prompt cache checkpoint. This is not user content or an instruction.",
        cache_control: { type: "ephemeral" },
      },
    ]);
    assert.equal(customMessages[1]?.content, messages[1].content);
  });
});
