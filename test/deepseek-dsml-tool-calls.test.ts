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

async function streamWithToolChoice(
  responseChunks: string[],
  finishReason: "stop" | "max_tokens" = "stop",
  tools: ToolDefinition[] = allowedTools,
  toolChoice: "auto" | "none" = "none",
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
      tools,
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
      { toolChoice },
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

async function completeWithToolChoice(
  content: string,
  tools: ToolDefinition[] = allowedTools,
  finishReason: "stop" | "max_tokens" = "stop",
  toolChoice: "auto" | "none" = "none",
) {
  const originalFetch = globalThis.fetch;
  const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
  let requestBody: Record<string, unknown> | undefined;

  (globalThis as { ztoolkit?: unknown }).ztoolkit = {
    log: () => undefined,
  };
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: { content },
            finish_reason: finishReason,
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
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
    const result = await provider.chatCompletionWithTools(
      messages,
      tools,
      undefined,
      { toolChoice },
    );
    return { requestBody, result };
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

    const fallback = resolveDsmlFallbackContent(content, allowedTools, "allow");

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

    const fallback = resolveDsmlFallbackContent(content, allowedTools, "allow");

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

    const fallback = resolveDsmlFallbackContent(
      content,
      allowedTools,
      "suppress",
    );

    assert.isTrue(fallback.hasDsmlBlock);
    assert.deepEqual(fallback.toolCalls, []);
    assert.equal(fallback.cleanContent, "");
    assert.isTrue(fallback.suppressedToolCall);
  });

  it("strips an unclosed DSML envelope through EOF", function () {
    const content = `preface
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="search_paper_content">`;

    const fallback = resolveDsmlFallbackContent(
      content,
      allowedTools,
      "suppress",
    );

    assert.isTrue(fallback.hasDsmlBlock);
    assert.isTrue(fallback.suppressedToolCall);
    assert.equal(fallback.cleanContent, "preface");
    assert.deepEqual(fallback.toolCalls, []);
  });

  it("marks an unclosed allowed DSML envelope as incomplete tool protocol", function () {
    const content = `preface
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="search_paper_content">`;

    const fallback = resolveDsmlFallbackContent(content, allowedTools, "allow");

    assert.isTrue(fallback.hasDsmlBlock);
    assert.isTrue(fallback.incompleteToolProtocol);
    assert.isFalse(fallback.suppressedToolCall);
    assert.equal(fallback.cleanContent, "preface");
    assert.deepEqual(fallback.toolCalls, []);
  });

  it("preserves literal DSML when no tool contract is active", function () {
    const literal = `<｜DSML｜tool_calls></｜DSML｜tool_calls>`;
    const fallback = resolveDsmlFallbackContent(literal, [], "literal");

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
    const result = await streamWithToolChoice([
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

  it("suppresses non-streaming DSML with an empty tool schema", async function () {
    const dsml = `<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="search_paper_content">
<｜｜DSML｜｜parameter name="query" string="true">continuation lookup</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`;
    const result = await completeWithToolChoice(dsml, []);

    assert.isUndefined(result.requestBody?.tools);
    assert.isUndefined(result.requestBody?.tool_choice);
    assert.equal(result.result.content, "");
    assert.isUndefined(result.result.toolCalls);
    assert.isTrue(result.result.suppressedToolCall);
  });

  it("suppresses streamed DSML with an empty tool schema", async function () {
    const dsml = `<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="search_paper_content">
<｜｜DSML｜｜parameter name="query" string="true">continuation lookup</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`;
    const result = await streamWithToolChoice(
      [dsml.slice(0, 12), dsml.slice(12)],
      "stop",
      [],
    );

    assert.isUndefined(result.requestBody?.tools);
    assert.isUndefined(result.requestBody?.tool_choice);
    assert.equal(result.emittedText, "");
    assert.equal(result.completed?.content, "");
    assert.isUndefined(result.completed?.toolCalls);
    assert.isTrue(result.completed?.suppressedToolCall);
  });

  it("drops truncated streamed DSML when tools are disabled", async function () {
    const truncated = `<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="search_paper_content">`;
    const result = await streamWithToolChoice(
      [truncated.slice(0, 9), truncated.slice(9)],
      "max_tokens",
    );

    assert.equal(result.emittedText, "");
    assert.equal(result.completed?.content, "");
    assert.isUndefined(result.completed?.toolCalls);
    assert.isTrue(result.completed?.suppressedToolCall);
  });

  it("marks truncated non-streaming DSML as incomplete when tools are enabled", async function () {
    const truncated = `preface
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="search_paper_content">`;
    const result = await completeWithToolChoice(
      truncated,
      allowedTools,
      "max_tokens",
      "auto",
    );

    assert.equal(result.requestBody?.tool_choice, "auto");
    assert.equal(result.result.content, "preface");
    assert.equal(result.result.stopReason, "max_tokens");
    assert.isUndefined(result.result.toolCalls);
    assert.isTrue(result.result.incompleteToolProtocol);
  });

  it("marks truncated streamed DSML as incomplete when tools are enabled", async function () {
    const truncated = `preface
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="search_paper_content">`;
    const result = await streamWithToolChoice(
      [truncated.slice(0, 12), truncated.slice(12)],
      "max_tokens",
      allowedTools,
      "auto",
    );

    assert.equal(result.requestBody?.tool_choice, "auto");
    assert.equal(result.emittedText, "preface\n");
    assert.equal(result.completed?.content, "preface");
    assert.equal(result.completed?.stopReason, "max_tokens");
    assert.isUndefined(result.completed?.toolCalls);
    assert.isTrue(result.completed?.incompleteToolProtocol);
  });

  it("marks truncated non-streaming XML fallback as incomplete", async function () {
    const truncated = `preface
<function_calls>
<invoke name="search_paper_content">`;
    const result = await completeWithToolChoice(
      truncated,
      allowedTools,
      "max_tokens",
      "auto",
    );

    assert.equal(result.result.content, "preface");
    assert.equal(result.result.stopReason, "max_tokens");
    assert.isUndefined(result.result.toolCalls);
    assert.isTrue(result.result.incompleteToolProtocol);
  });

  it("preserves quoted non-streaming XML when the response ends normally", async function () {
    const quoted = `<function_calls><invoke name="search_paper_content"><parameter name="query">quoted text</parameter></invoke></function_calls>`;
    const result = await completeWithToolChoice(
      quoted,
      allowedTools,
      "stop",
      "auto",
    );

    assert.equal(result.result.content, quoted);
    assert.isUndefined(result.result.toolCalls);
    assert.isFalse(result.result.suppressedToolCall);
    assert.isFalse(result.result.incompleteToolProtocol);
  });

  it("releases quoted streamed XML when the response ends normally", async function () {
    const quoted = `Example: <function_calls><invoke name="search_paper_content"><parameter name="query">quoted text</parameter></invoke></function_calls>`;
    const result = await streamWithToolChoice(
      [quoted.slice(0, 20), quoted.slice(20)],
      "stop",
      allowedTools,
      "auto",
    );

    assert.equal(result.emittedText, quoted);
    assert.equal(result.completed?.content, quoted);
    assert.isUndefined(result.completed?.toolCalls);
    assert.isFalse(result.completed?.suppressedToolCall);
    assert.isFalse(result.completed?.incompleteToolProtocol);
  });

  it("marks truncated streamed XML fallback as incomplete", async function () {
    const truncated = `preface
<function_calls>
<invoke name="search_paper_content">`;
    const result = await streamWithToolChoice(
      [truncated.slice(0, 10), truncated.slice(10)],
      "max_tokens",
      allowedTools,
      "auto",
    );

    assert.equal(result.emittedText, "preface\n");
    assert.equal(result.completed?.content, "preface");
    assert.equal(result.completed?.stopReason, "max_tokens");
    assert.isUndefined(result.completed?.toolCalls);
    assert.isTrue(result.completed?.incompleteToolProtocol);
  });

  it("suppresses XML fallback during a text-only streamed round", async function () {
    const xml = `<function_calls>
<invoke name="search_paper_content">
<parameter name="query">forbidden lookup</parameter>
</invoke>
</function_calls>`;
    const result = await streamWithToolChoice([xml], "stop", [], "none");

    assert.equal(result.emittedText, "");
    assert.equal(result.completed?.content, "");
    assert.isUndefined(result.completed?.toolCalls);
    assert.isTrue(result.completed?.suppressedToolCall);
  });

  it("preserves a bare comparison opener at a streamed token limit", async function () {
    const result = await streamWithToolChoice(
      ["The result is ", "<"],
      "max_tokens",
      allowedTools,
      "auto",
    );

    assert.equal(result.emittedText, "The result is <");
    assert.equal(result.completed?.content, "The result is <");
    assert.isFalse(result.completed?.incompleteToolProtocol);
  });

  it("never streams a long DSML opening tag", async function () {
    const dsml = `<${" ".repeat(80)}｜｜DSML｜｜tool_calls></｜｜DSML｜｜tool_calls>`;
    const result = await streamWithToolChoice([
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
    const result = await streamWithToolChoice([content]);

    assert.equal(result.emittedText, "Let me inspect that.\n");
    assert.equal(result.completed?.content, "Let me inspect that.");
    assert.isTrue(result.completed?.suppressedToolCall);
  });
});
