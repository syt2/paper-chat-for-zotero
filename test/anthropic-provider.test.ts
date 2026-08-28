import { assert } from "chai";
import { AnthropicProvider } from "../src/modules/providers/AnthropicProvider.ts";
import type { ChatMessage } from "../src/types/chat";
import type { ApiKeyProviderConfig } from "../src/types/provider";
import type { ToolDefinition } from "../src/types/tool";

function createProvider(): AnthropicProvider {
  return new AnthropicProvider({
    id: "anthropic",
    name: "Anthropic",
    type: "anthropic",
    enabled: true,
    isBuiltin: true,
    order: 1,
    apiKey: "test-key",
    baseUrl: "https://api.anthropic.test/v1",
    defaultModel: "claude-test",
    availableModels: ["claude-test"],
    systemPrompt: "Configured system prompt",
  } satisfies ApiKeyProviderConfig);
}

function createMessages(): ChatMessage[] {
  return [
    {
      id: "paper-context",
      role: "system",
      content: "Stable paper context",
      timestamp: 1,
    },
    {
      id: "user-1",
      role: "user",
      content: "Summarize the paper",
      timestamp: 2,
    },
    {
      id: "cache-checkpoint",
      role: "system",
      content: "Cache checkpoint",
      timestamp: 3,
    },
    {
      id: "runtime-context",
      role: "system",
      content: "Runtime iteration context",
      timestamp: 4,
    },
  ];
}

const expectedSystemPrompt = [
  "Configured system prompt",
  "Stable paper context",
  "Cache checkpoint",
  "Runtime iteration context",
].join("\n\n");

describe("Anthropic provider request formatting", function () {
  let originalFetch: typeof globalThis.fetch;
  let originalZtoolkit: unknown;
  let requestBodies: Array<Record<string, unknown>>;

  beforeEach(function () {
    originalFetch = globalThis.fetch;
    originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    requestBodies = [];
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    globalThis.fetch = (async (_input, init) => {
      const requestBody = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      requestBodies.push(requestBody);
      if (requestBody.stream === true) {
        const sse = [
          `data: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "done" },
          })}\n\n`,
          `data: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
          })}\n\n`,
        ].join("");
        return new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof globalThis.fetch;
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
  });

  it("preserves chat system context in ordinary requests", async function () {
    await createProvider().chatCompletion(createMessages());

    assert.lengthOf(requestBodies, 1);
    assert.equal(requestBodies[0].system, expectedSystemPrompt);
    assert.deepEqual(requestBodies[0].messages, [
      { role: "user", content: "Summarize the paper" },
    ]);
  });

  it("preserves chat system context in ordinary streaming requests", async function () {
    let completedContent = "";
    const errors: Error[] = [];

    await createProvider().streamChatCompletion(createMessages(), {
      onChunk: () => undefined,
      onComplete: (content) => {
        completedContent = content;
      },
      onError: (error) => errors.push(error),
    });

    assert.lengthOf(requestBodies, 1);
    assert.equal(requestBodies[0].system, expectedSystemPrompt);
    assert.isTrue(requestBodies[0].stream);
    assert.equal(completedContent, "done");
    assert.deepEqual(errors, []);
  });

  it("preserves chat system context in tool-calling requests", async function () {
    const tools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "search_items",
          description: "Search Zotero items",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    for (const toolChoice of ["auto", "none"] as const) {
      await createProvider().chatCompletionWithTools(
        createMessages(),
        tools,
        undefined,
        { toolChoice },
      );
    }

    assert.lengthOf(requestBodies, 2);
    for (const requestBody of requestBodies) {
      assert.equal(requestBody.system, expectedSystemPrompt);
      assert.deepEqual(requestBody.messages, [
        { role: "user", content: "Summarize the paper" },
      ]);
    }
    assert.deepEqual(
      requestBodies.map((requestBody) => requestBody.tool_choice),
      [{ type: "auto" }, { type: "none" }],
    );
  });

  it("preserves chat system context in streaming tool requests", async function () {
    const tools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "search_items",
          description: "Search Zotero items",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    let completedContent = "";
    const errors: Error[] = [];

    for (const toolChoice of ["auto", "none"] as const) {
      await createProvider().streamChatCompletionWithTools(
        createMessages(),
        tools,
        {
          onTextDelta: () => undefined,
          onToolCallStart: () => undefined,
          onToolCallDelta: () => undefined,
          onComplete: (result) => {
            completedContent = result.content;
          },
          onError: (error) => errors.push(error),
        },
        undefined,
        { toolChoice },
      );
    }

    assert.lengthOf(requestBodies, 2);
    for (const requestBody of requestBodies) {
      assert.equal(requestBody.system, expectedSystemPrompt);
      assert.isTrue(requestBody.stream);
    }
    assert.deepEqual(
      requestBodies.map((requestBody) => requestBody.tool_choice),
      [{ type: "auto" }, { type: "none" }],
    );
    assert.equal(completedContent, "done");
    assert.deepEqual(errors, []);
  });
});
