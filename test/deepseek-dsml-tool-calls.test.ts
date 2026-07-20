import { assert } from "chai";
import {
  OpenAICompatibleProvider,
  parseDsmlToolCallsFromContent,
  resolveDsmlFallbackContent,
  stripDsmlToolCallBlocks,
} from "../src/modules/providers/OpenAICompatibleProvider.ts";
import type { ChatMessage } from "../src/types/chat.ts";
import type { StreamToolCallingResult } from "../src/types/chat.ts";
import type { ApiKeyProviderConfig } from "../src/types/provider.ts";
import type { ToolDefinition } from "../src/types/tool.ts";

const allowedTools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_paper_content",
      description: "Search paper text",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
        },
      },
    },
  },
];

async function streamWithToolsDisabled(
  responseChunks: string[],
  finishReason: "stop" | "max_tokens" = "stop",
): Promise<{
  emittedText: string;
  requestBody: Record<string, unknown> | undefined;
  completed: StreamToolCallingResult | undefined;
}> {
  const originalFetch = globalThis.fetch;
  const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
  const emittedText: string[] = [];
  let requestBody: Record<string, unknown> | undefined;
  let completed: StreamToolCallingResult | undefined;
  const encoder = new TextEncoder();

  (globalThis as { ztoolkit?: unknown }).ztoolkit = {
    log: () => undefined,
  };
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const content of responseChunks) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [
                  {
                    index: 0,
                    delta: { content },
                    finish_reason: null,
                  },
                ],
              })}\n\n`,
            ),
          );
        }
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: finishReason,
                },
              ],
            })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const provider = new OpenAICompatibleProvider({
    id: "deepseek",
    name: "DeepSeek",
    type: "openai-compatible",
    enabled: true,
    isBuiltin: true,
    order: 0,
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    defaultModel: "deepseek-test",
    availableModels: ["deepseek-test"],
  } satisfies ApiKeyProviderConfig);
  const messages: ChatMessage[] = [
    { id: "user-1", role: "user", content: "answer now", timestamp: 1 },
  ];

  try {
    await provider.streamChatCompletionWithTools(
      messages,
      allowedTools,
      {
        onTextDelta: (text) => emittedText.push(text),
        onToolCallStart: () => undefined,
        onToolCallDelta: () => undefined,
        onComplete: (result) => {
          completed = result;
        },
        onError: (error) => {
          throw error;
        },
      },
      undefined,
      { toolChoice: "none" },
    );
    return {
      emittedText: emittedText.join(""),
      requestBody,
      completed,
    };
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
  }
}

describe("DeepSeek DSML tool call fallback", function () {
  it("parses leaked DSML tool calls from message content", function () {
    const content = `before
<｜DSML｜tool_calls>
<｜DSML｜invoke name="search_paper_content">
<｜DSML｜parameter name="query" string="true">high-val[ue]*t nickel</｜DSML｜parameter>
<｜DSML｜parameter name="context_lines" string="false">2</｜DSML｜parameter>
<｜DSML｜parameter name="max_results" string="false">10</｜DSML｜parameter>
</｜DSML｜invoke>
<｜DSML｜invoke name="get_pages">
<｜DSML｜parameter name="itemKey" string="true">VAG2KY98</｜DSML｜parameter>
<｜DSML｜parameter name="pages" string="true">2</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
after`;

    const toolCalls = parseDsmlToolCallsFromContent(content);

    assert.lengthOf(toolCalls, 2);
    assert.equal(toolCalls[0].id, "dsml_call_0");
    assert.equal(toolCalls[0].function.name, "search_paper_content");
    assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), {
      query: "high-val[ue]*t nickel",
      context_lines: "2",
      max_results: "10",
    });
    assert.equal(toolCalls[1].function.name, "get_pages");
    assert.deepEqual(JSON.parse(toolCalls[1].function.arguments), {
      itemKey: "VAG2KY98",
      pages: "2",
    });
  });

  it("strips DSML tool call blocks from display content", function () {
    const content = `intro
<｜DSML｜tool_calls>
<｜DSML｜invoke name="get_pages">
<｜DSML｜parameter name="pages" string="true">2</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
outro`;

    assert.equal(stripDsmlToolCallBlocks(content), "intro\n\noutro");
  });

  it("recovers doubled fullwidth delimiters and typographic quotes", function () {
    const content = `before
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name=“get_pages”>
<｜｜DSML｜｜parameter name=“pages” string=“true”>3-5</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>
after`;

    const toolCalls = parseDsmlToolCallsFromContent(content);

    assert.lengthOf(toolCalls, 1);
    assert.equal(toolCalls[0].function.name, "get_pages");
    assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), {
      pages: "3-5",
    });
    assert.equal(stripDsmlToolCallBlocks(content), "before\n\nafter");
  });

  it("accepts simple unquoted DSML attributes", function () {
    const content = `<||DSML||tool_calls>
<||DSML||invoke name=get_pages>
<||DSML||parameter name=pages string=true>7</||DSML||parameter>
</||DSML||invoke>
</||DSML||tool_calls>`;

    const toolCalls = parseDsmlToolCallsFromContent(content);

    assert.lengthOf(toolCalls, 1);
    assert.equal(toolCalls[0].function.name, "get_pages");
    assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), {
      pages: "7",
    });
    assert.equal(stripDsmlToolCallBlocks(content), "");
  });

  it("strips disallowed DSML blocks without executing them", function () {
    const content = `before
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name=“search_with_regex”>
<｜｜DSML｜｜parameter name=“pattern” string=“true”>scores based on 100 utterances</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>
after`;

    const fallback = resolveDsmlFallbackContent(content, allowedTools, true);

    assert.isTrue(fallback.hasDsmlBlock);
    assert.deepEqual(fallback.toolCalls, []);
    assert.equal(fallback.cleanContent, "before\n\nafter");
  });

  it("keeps allowed DSML tool calls while stripping display content", function () {
    const content = `before
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name=“search_paper_content”>
<｜｜DSML｜｜parameter name=“query” string=“true”>neural activity</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>
after`;

    const fallback = resolveDsmlFallbackContent(content, allowedTools, true);

    assert.isTrue(fallback.hasDsmlBlock);
    assert.lengthOf(fallback.toolCalls, 1);
    assert.equal(fallback.toolCalls[0].function.name, "search_paper_content");
    assert.deepEqual(JSON.parse(fallback.toolCalls[0].function.arguments), {
      query: "neural activity",
    });
    assert.equal(fallback.cleanContent, "before\n\nafter");
  });

  it("strips DSML without executing it when tool choice is none", function () {
    const content = `<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="search_paper_content">
<｜｜DSML｜｜parameter name="query" string="true">final-round lookup</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`;

    const fallback = resolveDsmlFallbackContent(content, allowedTools, false);

    assert.isTrue(fallback.hasDsmlBlock);
    assert.deepEqual(fallback.toolCalls, []);
    assert.equal(fallback.cleanContent, "");
    assert.isTrue(fallback.suppressedToolCall);
  });

  it("strips an unclosed DSML envelope through EOF", function () {
    const content = `preface
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="search_paper_content">`;

    const fallback = resolveDsmlFallbackContent(content, allowedTools, false);

    assert.isTrue(fallback.hasDsmlBlock);
    assert.isTrue(fallback.suppressedToolCall);
    assert.equal(fallback.cleanContent, "preface");
    assert.deepEqual(fallback.toolCalls, []);
  });

  it("preserves literal DSML when no tool contract is active", function () {
    const literal = `<｜DSML｜tool_calls></｜DSML｜tool_calls>`;
    const fallback = resolveDsmlFallbackContent(literal, [], false);

    assert.isFalse(fallback.hasDsmlBlock);
    assert.isFalse(fallback.suppressedToolCall);
    assert.equal(fallback.cleanContent, literal);
  });

  it("suppresses streamed DSML when the final round disables tools", async function () {
    const dsml = `<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="search_paper_content">
<｜｜DSML｜｜parameter name="query" string="true">final-round lookup</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`;
    const result = await streamWithToolsDisabled([
      dsml.slice(0, 11),
      dsml.slice(11, 83),
      dsml.slice(83),
    ]);

    assert.equal(result.requestBody?.tool_choice, "none");
    assert.equal(result.emittedText, "");
    assert.equal(result.completed?.content, "");
    assert.isUndefined(result.completed?.toolCalls);
    assert.isTrue(result.completed?.suppressedToolCall);
  });

  it("drops truncated streamed DSML when tools are disabled", async function () {
    const truncated = `<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="search_paper_content">`;
    const result = await streamWithToolsDisabled(
      [truncated.slice(0, 9), truncated.slice(9)],
      "max_tokens",
    );

    assert.equal(result.emittedText, "");
    assert.equal(result.completed?.content, "");
    assert.isUndefined(result.completed?.toolCalls);
    assert.isTrue(result.completed?.suppressedToolCall);
  });

  it("never streams a long DSML opening tag", async function () {
    const dsml = `<${" ".repeat(80)}｜｜DSML｜｜tool_calls></｜｜DSML｜｜tool_calls>`;
    const result = await streamWithToolsDisabled([
      dsml.slice(0, 50),
      dsml.slice(50, 95),
      dsml.slice(95),
    ]);

    assert.equal(result.emittedText, "");
    assert.equal(result.completed?.content, "");
    assert.isTrue(result.completed?.suppressedToolCall);
  });

  it("marks prefixed forbidden DSML as a suppressed tool call", async function () {
    const content = `Let me inspect that.
<｜｜DSML｜｜tool_calls></｜｜DSML｜｜tool_calls>`;
    const result = await streamWithToolsDisabled([content]);

    assert.equal(result.emittedText, "Let me inspect that.\n");
    assert.equal(result.completed?.content, "Let me inspect that.");
    assert.isTrue(result.completed?.suppressedToolCall);
  });
});
