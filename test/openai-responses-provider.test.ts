import { assert } from "chai";
import {
  createResponsesPromptCacheKey,
  extractResponsesText,
  OpenAIResponsesProvider,
  parseResponsesSSEStream,
  resetOpenAIResponsesStateForTests,
} from "../src/modules/providers/OpenAIResponsesProvider.ts";
import type { ChatMessage } from "../src/types/chat";
import type { ApiKeyProviderConfig } from "../src/types/provider";
import type { ToolDefinition } from "../src/types/tool";

function createProvider(
  runtime: { sessionId?: string; hostedWebSearch?: boolean } = {},
): OpenAIResponsesProvider {
  return new OpenAIResponsesProvider(
    {
      id: "paperchat",
      name: "PaperChat",
      type: "openai-compatible",
      enabled: true,
      isBuiltin: true,
      order: 0,
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      defaultModel: "gpt-5.4",
      availableModels: ["gpt-5.4"],
      temperature: 0.7,
      maxTokens: 4096,
    } satisfies ApiKeyProviderConfig,
    runtime,
  );
}

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
): ChatMessage {
  return { id, role, content, timestamp: 1 };
}

function completedResponse(
  id: string,
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    status: "completed",
    store: true,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    ...overrides,
  };
}

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function readerFromSSE(
  chunks: string[],
): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  }).getReader();
}

const localWebSearchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Query" },
      },
      required: ["query"],
    },
  },
};

const localPaperTool: ToolDefinition = {
  type: "function",
  function: {
    name: "search_pdf",
    description: "Search the current PDF",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Query" },
      },
      required: ["query"],
    },
  },
};

const originalFetch = globalThis.fetch;

describe("OpenAIResponsesProvider", function () {
  beforeEach(function () {
    resetOpenAIResponsesStateForTests();
    (globalThis as any).ztoolkit = { log: () => undefined };
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
  });

  it("uses Responses request shape and replaces local web_search with hosted search", async function () {
    let requestUrl = "";
    let requestBody: Record<string, any> = {};
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse(completedResponse("resp_1", "done"));
    }) as typeof fetch;

    const provider = createProvider({
      sessionId: "session-1",
      hostedWebSearch: true,
    });
    const result = await provider.chatCompletionWithTools(
      [message("u1", "user", "find it")],
      [localWebSearchTool, localPaperTool],
    );

    assert.equal(result.content, "done");
    assert.equal(requestUrl, "https://example.test/v1/responses");
    assert.equal(requestBody.model, "gpt-5.4");
    assert.notProperty(requestBody, "messages");
    assert.notProperty(requestBody, "temperature");
    assert.equal(requestBody.max_output_tokens, 4096);
    assert.equal(
      requestBody.prompt_cache_key,
      createResponsesPromptCacheKey("session-1", "gpt-5.4"),
    );
    assert.deepInclude(requestBody.tools, { type: "web_search" });
    assert.deepInclude(requestBody.tools, {
      type: "function",
      name: "search_pdf",
      description: "Search the current PDF",
      parameters: localPaperTool.function.parameters,
    });
    assert.notDeepInclude(requestBody.tools, {
      type: "function",
      name: "web_search",
    });
  });

  it("continues the same model with previous_response_id and only new input", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    const responses = [
      completedResponse("resp_1", "first answer"),
      completedResponse("resp_2", "second answer"),
    ];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(responses.shift()!);
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-1" });
    await provider.chatCompletion([message("u1", "user", "first")]);
    await provider.chatCompletion([
      message("u1", "user", "first"),
      message("a1", "assistant", "first answer"),
      message("u2", "user", "second"),
    ]);

    assert.notProperty(requestBodies[0], "previous_response_id");
    assert.equal(requestBodies[1].previous_response_id, "resp_1");
    assert.deepEqual(requestBodies[1].input, [
      { role: "user", content: "second" },
    ]);
  });

  it("starts a fresh chain when previously sent local context changes", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    const responses = [
      completedResponse("resp_1", "first answer"),
      completedResponse("resp_2", "revised answer"),
    ];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(responses.shift()!);
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-1" });
    await provider.chatCompletion([message("u1", "user", "original")]);
    await provider.chatCompletion([
      message("u1", "user", "edited"),
      message("u2", "user", "continue"),
    ]);

    assert.notProperty(requestBodies[1], "previous_response_id");
    assert.deepEqual(requestBodies[1].input, [
      { role: "user", content: "edited" },
      { role: "user", content: "continue" },
    ]);
  });

  it("continues function calls with function_call_output and the original call_id", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    const responses = [
      {
        id: "resp_tool_1",
        status: "completed",
        store: true,
        output: [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "search_pdf",
            arguments: '{"query":"cache"}',
          },
        ],
      },
      completedResponse("resp_tool_2", "tool answer"),
    ];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(responses.shift()!);
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-tool" });
    const first = await provider.chatCompletionWithTools(
      [message("u1", "user", "search")],
      [localPaperTool],
    );
    assert.deepEqual(first.toolCalls, [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "search_pdf",
          arguments: '{"query":"cache"}',
        },
      },
    ]);

    await provider.chatCompletionWithTools(
      [
        message("u1", "user", "search"),
        {
          ...message("a1", "assistant", ""),
          tool_calls: first.toolCalls,
        },
        {
          ...message("t1", "tool", "found passage"),
          tool_call_id: "call_1",
        },
      ],
      [localPaperTool],
    );

    assert.equal(requestBodies[1].previous_response_id, "resp_tool_1");
    assert.deepEqual(requestBodies[1].input, [
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "found passage",
      },
    ]);
  });

  it("falls back once to full local history when previous_response_id is invalid", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    let call = 0;
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      call++;
      if (call === 1) {
        return jsonResponse(completedResponse("resp_1", "first answer"));
      }
      if (call === 2) {
        return new Response(
          JSON.stringify({
            error: { message: "Previous response with id resp_1 not found" },
          }),
          { status: 400 },
        );
      }
      if (call === 3) {
        return jsonResponse(completedResponse("resp_2", "second answer"));
      }
      return jsonResponse(completedResponse("resp_3", "third answer"));
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-1" });
    await provider.chatCompletion([message("u1", "user", "first")]);
    await provider.chatCompletion([
      message("u1", "user", "first"),
      message("a1", "assistant", "first answer"),
      message("u2", "user", "second"),
    ]);
    await provider.chatCompletion([
      message("u1", "user", "first"),
      message("a1", "assistant", "first answer"),
      message("u2", "user", "second"),
      message("a2", "assistant", "second answer"),
      message("u3", "user", "third"),
    ]);

    assert.equal(requestBodies[1].previous_response_id, "resp_1");
    assert.notProperty(requestBodies[2], "previous_response_id");
    assert.deepEqual(requestBodies[2].input, [
      { role: "user", content: "first" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second" },
    ]);
    assert.notProperty(requestBodies[3], "previous_response_id");
    assert.deepInclude(requestBodies[3].input, {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "second answer", annotations: [] },
      ],
    });
    assert.deepEqual(requestBodies[3].input.at(-1), {
      role: "user",
      content: "third",
    });
  });

  it("replays complete output items when the upstream returns store false", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    const firstOutput = [
      {
        id: "rs_1",
        type: "reasoning",
        encrypted_content: "encrypted-reasoning",
      },
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "first answer", annotations: [] },
        ],
      },
    ];
    const responses = [
      completedResponse("resp_1", "first answer", {
        store: false,
        output: firstOutput,
      }),
      completedResponse("resp_2", "second answer", { store: false }),
    ];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(responses.shift()!);
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-1" });
    await provider.chatCompletion([message("u1", "user", "first")]);
    await provider.chatCompletion([
      message("u1", "user", "first"),
      message("a1", "assistant", "first answer"),
      message("u2", "user", "second"),
    ]);

    assert.notProperty(requestBodies[1], "previous_response_id");
    assert.deepEqual(requestBodies[1].input, [
      { role: "user", content: "first" },
      ...firstOutput,
      { role: "user", content: "second" },
    ]);
  });

  it("parses streaming text, function calls, and final citations", async function () {
    const starts: unknown[] = [];
    const argumentDeltas: string[] = [];
    const textDeltas: string[] = [];
    const completed = completedResponse("resp_stream", "A sourced answer", {
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "search_pdf",
          arguments: '{"query":"cache"}',
        },
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "A sourced answer",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.test/source",
                  title: "Example source",
                  start_index: 2,
                  end_index: 9,
                },
              ],
            },
          ],
        },
      ],
    });
    const events = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          call_id: "call_1",
          name: "search_pdf",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '{"query":"cache"}',
      },
      { type: "response.output_text.delta", delta: "A sourced answer" },
      { type: "response.completed", response: completed },
    ];
    const sse = events.map(
      (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );

    const response = await parseResponsesSSEStream(readerFromSSE(sse), {
      onTextDelta: (delta) => textDeltas.push(delta),
      onToolCallStart: (toolCall) => starts.push(toolCall),
      onToolCallDelta: (_index, delta) => argumentDeltas.push(delta),
    });

    assert.deepEqual(textDeltas, ["A sourced answer"]);
    assert.deepEqual(starts, [{ index: 0, id: "call_1", name: "search_pdf" }]);
    assert.deepEqual(argumentDeltas, ['{"query":"cache"}']);
    assert.equal(
      extractResponsesText(response),
      "A [sourced](https://example.test/source) answer\n\nSources:\n1. [Example source](https://example.test/source)",
    );
  });

  it("accepts response.incomplete and reconstructs omitted terminal output from deltas", async function () {
    const events = [
      {
        type: "response.created",
        response: { id: "resp_incomplete", store: false },
      },
      { type: "response.output_text.delta", delta: "partial answer" },
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        },
      },
    ];
    const response = await parseResponsesSSEStream(
      readerFromSSE(
        events.map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        ),
      ),
      {},
    );

    assert.equal(response.id, "resp_incomplete");
    assert.equal(response.store, false);
    assert.equal(response.status, "incomplete");
    assert.equal(extractResponsesText(response), "partial answer");
  });
});
