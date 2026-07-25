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

function toolResponse(
  id: string,
  callId: string,
  query: string,
  store: boolean,
): Record<string, unknown> {
  return {
    id,
    status: "completed",
    store,
    output: [
      {
        type: "function_call",
        id: `fc_${callId}`,
        call_id: callId,
        name: "search_pdf",
        arguments: JSON.stringify({ query }),
      },
    ],
  };
}

function checkpoint(id = "cache-checkpoint"): ChatMessage {
  return message(
    id,
    "system",
    "Prompt cache checkpoint. This is not user content or an instruction.",
  );
}

function runtimeContext(content: string, id = "runtime-context"): ChatMessage {
  return message(id, "system", content);
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

const localScholarlySearchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "search_scholarly_sources",
    description: "Search scholarly sources",
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
      [localWebSearchTool, localScholarlySearchTool, localPaperTool],
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
    assert.deepInclude(requestBody.tools, { type: "web_search_preview" });
    assert.notProperty(requestBody, "max_tool_calls");
    assert.deepInclude(requestBody.tools, {
      type: "function",
      name: "search_scholarly_sources",
      description: "Search scholarly sources",
      parameters: localScholarlySearchTool.function.parameters,
    });
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

  it("preserves caller-provided local search tools when hosted search is disabled", async function () {
    let requestBody: Record<string, any> = {};
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse(completedResponse("resp_local_search", "done"));
    }) as typeof fetch;

    const provider = createProvider({
      sessionId: "session-local-search",
      hostedWebSearch: false,
    });
    await provider.chatCompletionWithTools(
      [message("u1", "user", "find it")],
      [localWebSearchTool, localScholarlySearchTool],
    );

    assert.isTrue(
      requestBody.tools.some(
        (tool: any) => tool.type === "function" && tool.name === "web_search",
      ),
    );
    assert.isTrue(
      requestBody.tools.some(
        (tool: any) =>
          tool.type === "function" && tool.name === "search_scholarly_sources",
      ),
    );
    assert.notDeepInclude(requestBody.tools, { type: "web_search_preview" });
  });

  it("returns non-streaming hosted search telemetry from response output", async function () {
    globalThis.fetch = (async () =>
      jsonResponse(
        completedResponse("resp_hosted_telemetry", "done", {
          output: [
            {
              id: "ws_telemetry",
              type: "web_search_call",
              status: "completed",
              action: {
                type: "search",
                query: "latest Zotero release",
                sources: [
                  {
                    title: "Zotero",
                    url: "https://www.zotero.org/",
                  },
                ],
              },
            },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "done", annotations: [] }],
            },
          ],
        }),
      )) as typeof fetch;

    const provider = createProvider({ hostedWebSearch: true });
    const result = await provider.chatCompletionWithTools(
      [message("u1", "user", "latest Zotero release")],
      [localWebSearchTool, localScholarlySearchTool],
    );

    assert.deepEqual(result.hostedWebSearches, [
      {
        index: 0,
        id: "ws_telemetry",
        status: "completed",
        actionType: "search",
        queries: ["latest Zotero release"],
        sources: [{ title: "Zotero", url: "https://www.zotero.org/" }],
      },
    ]);
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

  it("isolates two Responses model chains and invalidates A after B answers", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    const responses = [
      completedResponse("resp_a_1", "answer A1"),
      completedResponse("resp_a_2", "answer A2"),
      completedResponse("resp_b_1", "answer B1"),
      completedResponse("resp_a_3", "answer A3"),
    ];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(responses.shift()!);
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-two-responses" });
    await provider.chatCompletion([message("u1", "user", "first")]);

    provider.updateConfig({ defaultModel: "gpt-model-b" });
    provider.updateConfig({ defaultModel: "gpt-5.4" });
    await provider.chatCompletion([
      message("u1", "user", "first"),
      message("a1", "assistant", "answer A1"),
      message("u2", "user", "second on A"),
    ]);

    provider.updateConfig({ defaultModel: "gpt-model-b" });
    await provider.chatCompletion([
      message("u1", "user", "first"),
      message("a1", "assistant", "answer A1"),
      message("u2", "user", "second on A"),
      message("a2", "assistant", "answer A2"),
      message("u3", "user", "first on B"),
    ]);

    provider.updateConfig({ defaultModel: "gpt-5.4" });
    await provider.chatCompletion([
      message("u1", "user", "first"),
      message("a1", "assistant", "answer A1"),
      message("u2", "user", "second on A"),
      message("a2", "assistant", "answer A2"),
      message("u3", "user", "first on B"),
      message("b1", "assistant", "answer B1"),
      message("u4", "user", "back on A"),
    ]);

    assert.equal(requestBodies[1].previous_response_id, "resp_a_1");
    assert.deepEqual(requestBodies[1].input, [
      { role: "user", content: "second on A" },
    ]);
    assert.notProperty(requestBodies[2], "previous_response_id");
    assert.notProperty(requestBodies[3], "previous_response_id");
    assert.deepInclude(requestBodies[3].input, {
      role: "assistant",
      content: "answer B1",
    });
    assert.deepEqual(requestBodies[3].input.at(-1), {
      role: "user",
      content: "back on A",
    });
  });

  it("isolates store-false transcripts across Responses model switches", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    const rawAOutput = [
      {
        id: "reasoning-a1",
        type: "reasoning",
        encrypted_content: "encrypted-a1",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "answer A1", annotations: [] }],
      },
    ];
    const responses = [
      completedResponse("resp_a_1", "answer A1", {
        store: false,
        output: rawAOutput,
      }),
      completedResponse("resp_a_2", "answer A2", { store: false }),
      completedResponse("resp_b_1", "answer B1", { store: false }),
      completedResponse("resp_a_3", "answer A3", { store: false }),
    ];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(responses.shift()!);
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-two-stateless" });
    await provider.chatCompletion([message("u1", "user", "first")]);

    provider.updateConfig({ defaultModel: "gpt-model-b" });
    provider.updateConfig({ defaultModel: "gpt-5.4" });
    await provider.chatCompletion([
      message("u1", "user", "first"),
      message("a1", "assistant", "answer A1"),
      message("u2", "user", "second on A"),
    ]);

    provider.updateConfig({ defaultModel: "gpt-model-b" });
    await provider.chatCompletion([
      message("u1", "user", "first"),
      message("a1", "assistant", "answer A1"),
      message("u2", "user", "second on A"),
      message("a2", "assistant", "answer A2"),
      message("u3", "user", "first on B"),
    ]);

    provider.updateConfig({ defaultModel: "gpt-5.4" });
    await provider.chatCompletion([
      message("u1", "user", "first"),
      message("a1", "assistant", "answer A1"),
      message("u2", "user", "second on A"),
      message("a2", "assistant", "answer A2"),
      message("u3", "user", "first on B"),
      message("b1", "assistant", "answer B1"),
      message("u4", "user", "back on A"),
    ]);

    assert.notProperty(requestBodies[1], "previous_response_id");
    assert.deepInclude(requestBodies[1].input, rawAOutput[0]);
    assert.notProperty(requestBodies[2], "previous_response_id");
    assert.notProperty(requestBodies[3], "previous_response_id");
    assert.isFalse(
      requestBodies[3].input.some(
        (item: Record<string, unknown>) =>
          item.encrypted_content === "encrypted-a1",
      ),
    );
    assert.deepInclude(requestBodies[3].input, {
      role: "assistant",
      content: "answer B1",
    });
  });

  it("continues a normal user turn when new messages precede the synthetic context", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    const responses = [
      completedResponse("resp_1", "first answer"),
      completedResponse("resp_2", "second answer"),
    ];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(responses.shift()!);
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-normal-context" });
    await provider.chatCompletion([
      message("u1", "user", "first"),
      checkpoint(),
      runtimeContext("iteration 1"),
    ]);
    await provider.chatCompletion([
      message("u1", "user", "first"),
      message("a1", "assistant", "first answer"),
      message("u2", "user", "second"),
      checkpoint(),
      runtimeContext("iteration 2"),
    ]);

    assert.equal(requestBodies[1].previous_response_id, "resp_1");
    assert.deepEqual(requestBodies[1].input, [
      { role: "user", content: "second" },
      { role: "system", content: "iteration 2" },
    ]);
  });

  it("reuses a chain when the sole previous output has hosted tool-card markup", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(
        completedResponse(`resp_${requestBodies.length}`, "first answer"),
      );
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-decorated-output" });
    await provider.chatCompletion([message("u1", "user", "first")]);
    await provider.chatCompletion([
      message("u1", "user", "first"),
      message(
        "a1",
        "assistant",
        [
          '<tool-call status="completed" expand-key="hosted-web-search:ws_1">',
          "<tool-name>web_search</tool-name>",
          "</tool-call>",
          "first answer",
        ].join("\n"),
      ),
      message("u2", "user", "second"),
    ]);

    assert.equal(requestBodies[1].previous_response_id, "resp_1");
    assert.deepEqual(requestBodies[1].input, [
      { role: "user", content: "second" },
    ]);
  });

  it("does not mistake another model's sole assistant output for decoration", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(
        completedResponse(`resp_${requestBodies.length}`, "answer"),
      );
    }) as typeof fetch;

    const provider = createProvider({
      sessionId: "session-other-model-output",
    });
    await provider.chatCompletion([message("u1", "user", "first")]);
    await provider.chatCompletion([
      message("u1", "user", "first"),
      message("u-b", "user", "question answered by model B"),
      message("a-b", "assistant", "model B answer"),
      message("u-a", "user", "continue with model A"),
    ]);

    assert.notProperty(requestBodies[1], "previous_response_id");
    assert.deepEqual(requestBodies[1].input, [
      { role: "user", content: "first" },
      { role: "user", content: "question answered by model B" },
      { role: "assistant", content: "model B answer" },
      { role: "user", content: "continue with model A" },
    ]);
  });

  it("does not reuse a stale chain when another model replaces its answer", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(
        completedResponse(`resp_${requestBodies.length}`, "answer from A"),
      );
    }) as typeof fetch;

    const provider = createProvider({
      sessionId: "session-replaced-model-output",
    });
    await provider.chatCompletion([message("u1", "user", "first")]);
    await provider.chatCompletion([
      message("u1", "user", "first"),
      message("a-b", "assistant", "replacement answer from B"),
      message("u2", "user", "continue with A"),
    ]);

    assert.notProperty(requestBodies[1], "previous_response_id");
    assert.deepEqual(requestBodies[1].input, [
      { role: "user", content: "first" },
      { role: "assistant", content: "replacement answer from B" },
      { role: "user", content: "continue with A" },
    ]);
  });

  it("does not treat another model's containing answer as local decoration", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(
        completedResponse(`resp_${requestBodies.length}`, "base answer"),
      );
    }) as typeof fetch;

    const provider = createProvider({
      sessionId: "session-containing-model-output",
    });
    await provider.chatCompletion([message("u1", "user", "first")]);
    await provider.chatCompletion([
      message("u1", "user", "first"),
      message("a-b", "assistant", "prefix base answer extra"),
      message("u2", "user", "continue with A"),
    ]);

    assert.notProperty(requestBodies[1], "previous_response_id");
    assert.deepEqual(requestBodies[1].input, [
      { role: "user", content: "first" },
      { role: "assistant", content: "prefix base answer extra" },
      { role: "user", content: "continue with A" },
    ]);
  });

  it("preserves Markdown structure when matching a previous model output", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    const responses = [
      completedResponse("resp_a", "- alpha\n- beta"),
      completedResponse("resp_recovery", "recovered"),
    ];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(responses.shift()!);
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-markdown-identity" });
    await provider.chatCompletion([message("u1", "user", "first")]);
    await provider.chatCompletion([
      message("u1", "user", "first"),
      message("a-b", "assistant", "- alpha - beta"),
      message("u2", "user", "continue with A"),
    ]);

    assert.notProperty(requestBodies[1], "previous_response_id");
    assert.deepEqual(requestBodies[1].input, [
      { role: "user", content: "first" },
      { role: "assistant", content: "- alpha - beta" },
      { role: "user", content: "continue with A" },
    ]);
  });

  it("does not resume a stored answer that is missing from local history", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(
        completedResponse(`resp_${requestBodies.length}`, "stored answer"),
      );
    }) as typeof fetch;

    const provider = createProvider({
      sessionId: "session-missing-local-output",
    });
    await provider.chatCompletion([message("u1", "user", "first")]);
    await provider.chatCompletion([
      message("u1", "user", "first"),
      message("u2", "user", "continue after local deletion"),
    ]);

    assert.notProperty(requestBodies[1], "previous_response_id");
    assert.deepEqual(requestBodies[1].input, [
      { role: "user", content: "first" },
      { role: "user", content: "continue after local deletion" },
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

  it("keeps the Responses chain when search scope only updates runtime context", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      if (requestBodies.length === 1) {
        return jsonResponse({
          id: "resp_scope_1",
          status: "completed",
          store: true,
          output: [
            {
              type: "function_call",
              id: "fc_scope_1",
              call_id: "scope_1",
              name: "select_search_scope",
              arguments: JSON.stringify({
                scope: "web_allowed",
                reason: "The user permits web fallback.",
              }),
            },
          ],
        });
      }
      return jsonResponse(completedResponse("resp_scope_2", "continued"));
    }) as typeof fetch;

    const scopeTool: ToolDefinition = {
      type: "function",
      function: {
        name: "select_search_scope",
        description: "Select search scope",
        parameters: { type: "object", properties: {} },
      },
    };
    const provider = createProvider({
      sessionId: "session-search-scope",
      hostedWebSearch: true,
    });
    const paperContext = message(
      "paper-context",
      "system",
      "Stable paper and search permission instructions.",
    );
    const user = message("u1", "user", "Search, then use web fallback.");
    const first = await provider.chatCompletionWithTools(
      [paperContext, user, runtimeContext("scope pending")],
      [scopeTool],
    );

    await provider.chatCompletionWithTools(
      [
        paperContext,
        user,
        {
          ...message("a-scope", "assistant", ""),
          tool_calls: first.toolCalls,
        },
        {
          ...message("t-scope", "tool", "scope selected"),
          tool_call_id: "scope_1",
        },
        runtimeContext("scope web_allowed; do not select again"),
      ],
      [localScholarlySearchTool, localWebSearchTool],
    );

    assert.equal(requestBodies[1].previous_response_id, "resp_scope_1");
    assert.deepEqual(requestBodies[1].input, [
      {
        type: "function_call_output",
        call_id: "scope_1",
        output: "scope selected",
      },
      {
        role: "system",
        content: "scope web_allowed; do not select again",
      },
    ]);
    assert.notDeepInclude(requestBodies[1].input, {
      role: "system",
      content: paperContext.content,
    });
  });

  it("keeps a store-false scope exchange ordered without previous_response_id", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      if (requestBodies.length === 1) {
        return jsonResponse({
          id: "resp_scope_1",
          status: "completed",
          store: false,
          output: [
            {
              type: "function_call",
              id: "fc_scope_1",
              call_id: "scope_1",
              name: "select_search_scope",
              arguments: JSON.stringify({
                scope: "web_allowed",
                reason: "The user permits web fallback.",
              }),
            },
          ],
        });
      }
      return jsonResponse(
        completedResponse("resp_scope_2", "continued", { store: false }),
      );
    }) as typeof fetch;

    const scopeTool: ToolDefinition = {
      type: "function",
      function: {
        name: "select_search_scope",
        description: "Select search scope",
        parameters: { type: "object", properties: {} },
      },
    };
    const provider = createProvider({
      sessionId: "session-search-scope-stateless",
      hostedWebSearch: true,
    });
    const paperContext = message(
      "paper-context",
      "system",
      "Stable gated paper context.",
    );
    const user = message("u1", "user", "Search, then use web fallback.");
    const first = await provider.chatCompletionWithTools(
      [paperContext, user, runtimeContext("scope pending")],
      [scopeTool],
    );

    await provider.chatCompletionWithTools(
      [
        paperContext,
        user,
        {
          ...message("a-scope", "assistant", ""),
          tool_calls: first.toolCalls,
        },
        {
          ...message("t-scope", "tool", "scope selected"),
          tool_call_id: "scope_1",
        },
        runtimeContext("scope web_allowed; do not select again"),
      ],
      [localScholarlySearchTool, localWebSearchTool],
    );

    assert.notProperty(requestBodies[1], "previous_response_id");
    assert.deepEqual(requestBodies[1].input, [
      { role: "system", content: paperContext.content },
      { role: "user", content: user.content },
      { role: "system", content: "scope pending" },
      {
        type: "function_call",
        id: "fc_scope_1",
        call_id: "scope_1",
        name: "select_search_scope",
        arguments: JSON.stringify({
          scope: "web_allowed",
          reason: "The user permits web fallback.",
        }),
      },
      {
        type: "function_call_output",
        call_id: "scope_1",
        output: "scope selected",
      },
      {
        role: "system",
        content: "scope web_allowed; do not select again",
      },
    ]);
  });

  it("drops a pending function-call chain when the local tool exchange was cancelled", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    const responses = [
      toolResponse("resp_tool_1", "call_1", "first", true),
      completedResponse("resp_recovery", "recovered"),
    ];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(responses.shift()!);
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-cancelled-tool" });
    await provider.chatCompletionWithTools(
      [message("u1", "user", "search")],
      [localPaperTool],
    );
    await provider.chatCompletionWithTools(
      [
        message("u1", "user", "search"),
        message("u2", "user", "continue without that tool"),
      ],
      [localPaperTool],
    );

    assert.notProperty(requestBodies[1], "previous_response_id");
    assert.deepEqual(requestBodies[1].input, [
      { role: "user", content: "search" },
      { role: "user", content: "continue without that tool" },
    ]);
  });

  it("does not resume a cancelled function call from its visible text prefix", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    const responses = [
      {
        id: "resp_prefixed_tool",
        status: "completed",
        store: true,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "I will search.",
                annotations: [],
              },
            ],
          },
          {
            type: "function_call",
            id: "fc_call_1",
            call_id: "call_1",
            name: "search_pdf",
            arguments: JSON.stringify({ query: "first" }),
          },
        ],
      },
      completedResponse("resp_recovery", "recovered"),
    ];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(responses.shift()!);
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-prefixed-tool" });
    await provider.chatCompletionWithTools(
      [message("u1", "user", "search")],
      [localPaperTool],
    );
    await provider.chatCompletionWithTools(
      [
        message("u1", "user", "search"),
        message("a1", "assistant", "I will search."),
        message("u2", "user", "continue without that tool"),
      ],
      [localPaperTool],
    );

    assert.notProperty(requestBodies[1], "previous_response_id");
    assert.deepEqual(requestBodies[1].input, [
      { role: "user", content: "search" },
      { role: "assistant", content: "I will search." },
      { role: "user", content: "continue without that tool" },
    ]);
  });

  it("clears state when a non-streaming upstream ignores tool_choice none", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    const responses = [
      toolResponse("resp_forbidden_call", "call_1", "first", true),
      completedResponse("resp_recovery", "recovered"),
    ];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(responses.shift()!);
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-suppressed" });
    const first = await provider.chatCompletionWithTools(
      [message("u1", "user", "answer without tools")],
      [localPaperTool],
      undefined,
      { toolChoice: "none" },
    );
    assert.isTrue(first.suppressedToolCall);
    assert.isUndefined(first.toolCalls);

    await provider.chatCompletionWithTools(
      [
        message("u1", "user", "answer without tools"),
        message("u2", "user", "recover"),
      ],
      [localPaperTool],
    );
    assert.notProperty(requestBodies[1], "previous_response_id");
  });

  it("continues repeated AgentRuntime tool loops without replaying renamed history", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    const responses = [
      toolResponse("resp_tool_1", "call_1", "first", true),
      toolResponse("resp_tool_2", "call_2", "second", true),
      completedResponse("resp_tool_3", "done"),
      completedResponse("resp_tool_4", "follow-up done"),
    ];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(responses.shift()!);
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-tool-loop" });
    const firstMessages = [
      message("u1", "user", "search"),
      checkpoint(),
      runtimeContext("iteration 1"),
    ];
    const first = await provider.chatCompletionWithTools(firstMessages, [
      localPaperTool,
    ]);
    const secondMessages = [
      message("u1", "user", "search"),
      checkpoint("cache-checkpoint-history"),
      runtimeContext("iteration 1", "runtime-context-history"),
      { ...message("a1", "assistant", ""), tool_calls: first.toolCalls },
      { ...message("t1", "tool", "first result"), tool_call_id: "call_1" },
      checkpoint(),
      runtimeContext("iteration 2"),
    ];
    const second = await provider.chatCompletionWithTools(secondMessages, [
      localPaperTool,
    ]);
    const thirdMessages = [
      ...secondMessages.slice(0, -2),
      checkpoint("cache-checkpoint-history"),
      runtimeContext("iteration 2", "runtime-context-history"),
      { ...message("a2", "assistant", ""), tool_calls: second.toolCalls },
      { ...message("t2", "tool", "second result"), tool_call_id: "call_2" },
      checkpoint(),
      runtimeContext("iteration 3"),
    ];
    await provider.chatCompletionWithTools(thirdMessages, [localPaperTool]);
    await provider.chatCompletionWithTools(
      [
        message("u1", "user", "search"),
        {
          ...message("persisted-call-1", "assistant", ""),
          tool_calls: first.toolCalls,
          apiOnly: true,
        },
        {
          ...message("persisted-result-1", "tool", "first result"),
          tool_call_id: "call_1",
          apiOnly: true,
        },
        {
          ...message("persisted-call-2", "assistant", ""),
          tool_calls: second.toolCalls,
          apiOnly: true,
        },
        {
          ...message("persisted-result-2", "tool", "second result"),
          tool_call_id: "call_2",
          apiOnly: true,
        },
        message("visible-answer", "assistant", "done"),
        message("u2", "user", "follow up"),
        checkpoint(),
        runtimeContext("iteration 4"),
      ],
      [localPaperTool],
    );

    assert.equal(requestBodies[1].previous_response_id, "resp_tool_1");
    assert.deepEqual(requestBodies[1].input, [
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "first result",
      },
      { role: "system", content: checkpoint().content },
      { role: "system", content: "iteration 2" },
    ]);
    assert.equal(requestBodies[2].previous_response_id, "resp_tool_2");
    assert.deepEqual(requestBodies[2].input, [
      {
        type: "function_call_output",
        call_id: "call_2",
        output: "second result",
      },
      { role: "system", content: checkpoint().content },
      { role: "system", content: "iteration 3" },
    ]);
    assert.equal(requestBodies[3].previous_response_id, "resp_tool_3");
    assert.deepEqual(requestBodies[3].input, [
      { role: "user", content: "follow up" },
      { role: "system", content: "iteration 4" },
    ]);
  });

  it("keeps stateless AgentRuntime tool transcripts ordered without duplicated history", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    const firstResponse = toolResponse("resp_tool_1", "call_1", "first", false);
    const responses = [
      firstResponse,
      completedResponse("resp_tool_2", "done", { store: false }),
    ];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(responses.shift()!);
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-tool-stateless" });
    await provider.chatCompletionWithTools(
      [
        message("u1", "user", "search"),
        checkpoint(),
        runtimeContext("iteration 1"),
      ],
      [localPaperTool],
    );
    await provider.chatCompletionWithTools(
      [
        message("u1", "user", "search"),
        checkpoint("cache-checkpoint-history"),
        runtimeContext("iteration 1", "runtime-context-history"),
        {
          ...message("a1", "assistant", ""),
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "search_pdf",
                arguments: '{"query":"first"}',
              },
            },
          ],
        },
        {
          ...message("t1", "tool", "first result"),
          tool_call_id: "call_1",
        },
        checkpoint(),
        runtimeContext("iteration 2"),
      ],
      [localPaperTool],
    );

    assert.notProperty(requestBodies[1], "previous_response_id");
    assert.deepEqual(requestBodies[1].input, [
      { role: "user", content: "search" },
      { role: "system", content: checkpoint().content },
      { role: "system", content: "iteration 1" },
      ...(firstResponse.output as unknown[]),
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "first result",
      },
      { role: "system", content: checkpoint().content },
      { role: "system", content: "iteration 2" },
    ]);
  });

  it("continues the next user turn after runtime tool messages are persisted under new ids", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    const responses = [
      toolResponse("resp_tool_1", "call_1", "first", true),
      completedResponse("resp_tool_2", "tool answer"),
      completedResponse("resp_tool_3", "follow-up answer"),
    ];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(responses.shift()!);
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-tool-follow-up" });
    const first = await provider.chatCompletionWithTools(
      [
        message("u1", "user", "search"),
        checkpoint(),
        runtimeContext("iteration 1"),
      ],
      [localPaperTool],
    );
    await provider.chatCompletionWithTools(
      [
        message("u1", "user", "search"),
        checkpoint("cache-checkpoint-history"),
        runtimeContext("iteration 1", "runtime-context-history"),
        {
          ...message("temporary-tool-call", "assistant", ""),
          tool_calls: first.toolCalls,
        },
        {
          ...message("temporary-tool-result", "tool", "first result"),
          tool_call_id: "call_1",
        },
        checkpoint(),
        runtimeContext("iteration 2"),
      ],
      [localPaperTool],
    );
    await provider.chatCompletionWithTools(
      [
        message("u1", "user", "search"),
        {
          ...message("visible-api-context-call", "assistant", ""),
          tool_calls: first.toolCalls,
          apiOnly: true,
        },
        {
          ...message("visible-api-context-result", "tool", "first result"),
          tool_call_id: "call_1",
          apiOnly: true,
        },
        message("visible-assistant", "assistant", "tool answer"),
        message("u2", "user", "follow up"),
        checkpoint(),
        runtimeContext("iteration 3"),
      ],
      [localPaperTool],
    );

    assert.equal(requestBodies[2].previous_response_id, "resp_tool_2");
    assert.deepEqual(requestBodies[2].input, [
      { role: "user", content: "follow up" },
      { role: "system", content: "iteration 3" },
    ]);
  });

  it("falls back once and continues from the new stored response id", async function () {
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
    assert.equal(requestBodies[3].previous_response_id, "resp_2");
    assert.deepEqual(requestBodies[3].input, [
      { role: "user", content: "third" },
    ]);
  });

  it("stays stateless when invalid-id recovery does not confirm storage", async function () {
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
            error: { message: "Previous response with id resp_1 expired" },
          }),
          { status: 404 },
        );
      }
      if (call === 3) {
        return jsonResponse(
          completedResponse("resp_2", "second answer", {
            store: undefined,
          }),
        );
      }
      return jsonResponse(completedResponse("resp_3", "third answer"));
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-invalid-stateless" });
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

  it("emits hosted Web Search lifecycle events without creating function calls", async function () {
    const statuses: unknown[] = [];
    const functionStarts: unknown[] = [];
    const completed = completedResponse("resp_web_search", "Search result");
    const events = [
      {
        type: "response.web_search_call.in_progress",
        output_index: 0,
        item_id: "ws_123",
        sequence_number: 1,
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "web_search_call",
          id: "ws_123",
          status: "in_progress",
          action: {
            type: "search",
            query: "Zotero AI tools",
          },
        },
      },
      {
        type: "response.web_search_call.searching",
        output_index: 0,
        item_id: "ws_123",
        sequence_number: 2,
      },
      {
        type: "response.web_search_call.completed",
        output_index: 0,
        item_id: "ws_123",
        sequence_number: 3,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "web_search_call",
          id: "ws_123",
          status: "completed",
          action: {
            type: "search",
            queries: ["Zotero AI tools", "PaperChat Zotero"],
            sources: [
              {
                type: "url",
                title: "PaperChat",
                url: "https://example.test/paperchat",
              },
              "https://example.test/zotero-ai",
            ],
          },
        },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "web_search_call",
          id: "ws_failed",
          status: "failed",
          action: {
            type: "search",
            query: "failed query",
          },
        },
      },
      { type: "response.completed", response: completed },
    ];
    const sse = events.map(
      (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );

    await parseResponsesSSEStream(readerFromSSE(sse), {
      onToolCallStart: (toolCall) => functionStarts.push(toolCall),
      onHostedWebSearchStatus: (event) => statuses.push(event),
    });

    assert.deepEqual(statuses, [
      { index: 0, id: "ws_123", status: "searching" },
      {
        index: 0,
        id: "ws_123",
        status: "searching",
        actionType: "search",
        queries: ["Zotero AI tools"],
        sources: [],
      },
      { index: 0, id: "ws_123", status: "searching" },
      { index: 0, id: "ws_123", status: "completed" },
      {
        index: 0,
        id: "ws_123",
        status: "completed",
        actionType: "search",
        queries: ["Zotero AI tools", "PaperChat Zotero"],
        sources: [
          {
            title: "PaperChat",
            url: "https://example.test/paperchat",
          },
          { url: "https://example.test/zotero-ai" },
        ],
      },
      {
        index: 1,
        id: "ws_failed",
        status: "error",
        actionType: "search",
        queries: ["failed query"],
        sources: [],
      },
    ]);
    assert.deepEqual(functionStarts, []);
  });

  it("clears state when a streaming upstream ignores tool_choice none", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    let call = 0;
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      call++;
      if (call === 1) {
        const terminal = toolResponse(
          "resp_forbidden_stream_call",
          "call_1",
          "first",
          true,
        );
        const event = {
          type: "response.completed",
          response: terminal,
        };
        return new Response(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return jsonResponse(completedResponse("resp_recovery", "recovered"));
    }) as typeof fetch;

    const provider = createProvider({
      sessionId: "session-suppressed-stream",
    });
    let streamedResult: { suppressedToolCall?: boolean } | undefined;
    let streamedError: Error | undefined;
    await provider.streamChatCompletionWithTools(
      [message("u1", "user", "answer without tools")],
      [localPaperTool],
      {
        onTextDelta: () => undefined,
        onToolCallStart: () => undefined,
        onToolCallDelta: () => undefined,
        onComplete: (result) => {
          streamedResult = result;
        },
        onError: (error) => {
          streamedError = error;
        },
      },
      undefined,
      { toolChoice: "none" },
    );
    assert.isUndefined(streamedError);
    assert.isTrue(streamedResult?.suppressedToolCall);

    await provider.chatCompletionWithTools(
      [
        message("u1", "user", "answer without tools"),
        message("u2", "user", "recover"),
      ],
      [localPaperTool],
    );
    assert.notProperty(requestBodies[1], "previous_response_id");
  });

  it("extracts non-streaming refusal content", function () {
    assert.equal(
      extractResponsesText({
        id: "resp_refusal",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "refusal", refusal: "I cannot help with that." }],
          },
        ],
      }),
      "I cannot help with that.",
    );
  });

  it("streams refusal deltas and preserves the terminal refusal", async function () {
    const deltas: string[] = [];
    const terminal = {
      id: "resp_refusal",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "I cannot help." }],
        },
      ],
    };
    const response = await parseResponsesSSEStream(
      readerFromSSE(
        [
          { type: "response.refusal.delta", delta: "I cannot " },
          { type: "response.refusal.delta", delta: "help." },
          { type: "response.refusal.done", refusal: "I cannot help." },
          { type: "response.completed", response: terminal },
        ].map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        ),
      ),
      { onTextDelta: (delta) => deltas.push(delta) },
    );

    assert.deepEqual(deltas, ["I cannot ", "help."]);
    assert.equal(extractResponsesText(response), "I cannot help.");
  });

  it("reconstructs refusal output when the terminal stream omits output", async function () {
    const response = await parseResponsesSSEStream(
      readerFromSSE(
        [
          {
            type: "response.created",
            response: { id: "resp_refusal", store: false },
          },
          { type: "response.refusal.done", refusal: "Request refused." },
          {
            type: "response.completed",
            response: { status: "completed" },
          },
        ].map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        ),
      ),
      {},
    );

    assert.equal(response.id, "resp_refusal");
    assert.equal(response.store, false);
    assert.equal(extractResponsesText(response), "Request refused.");
  });

  it("returns visible max-token partial text when no function call is present", async function () {
    globalThis.fetch = (async () =>
      jsonResponse({
        id: "resp_incomplete",
        status: "incomplete",
        store: true,
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "partial answer", annotations: [] },
            ],
          },
        ],
      })) as typeof fetch;

    const result = await createProvider({
      sessionId: "session-partial",
    }).chatCompletionWithTools(
      [message("u1", "user", "answer")],
      [localPaperTool],
    );

    assert.equal(result.content, "partial answer");
    assert.isUndefined(result.toolCalls);
  });

  it("rejects an incomplete function call and does not commit its response id", async function () {
    const requestBodies: Array<Record<string, any>> = [];
    const responses = [
      {
        id: "resp_incomplete",
        status: "incomplete",
        store: true,
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "function_call",
            call_id: "call_truncated",
            name: "search_pdf",
            arguments: '{"query":"truncated',
          },
        ],
      },
      completedResponse("resp_recovery", "recovered"),
    ];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(responses.shift()!);
    }) as typeof fetch;

    const provider = createProvider({ sessionId: "session-incomplete-call" });
    let rejected: unknown;
    try {
      await provider.chatCompletionWithTools(
        [message("u1", "user", "search")],
        [localPaperTool],
      );
    } catch (error) {
      rejected = error;
    }
    assert.instanceOf(rejected, Error);
    assert.match((rejected as Error).message, /incomplete/i);

    await provider.chatCompletionWithTools(
      [message("u2", "user", "recover")],
      [localPaperTool],
    );
    assert.notProperty(requestBodies[1], "previous_response_id");
  });

  it("rejects empty incomplete responses, unfinished calls, and nonterminal statuses", async function () {
    const responses = [
      {
        id: "resp_empty",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      },
      {
        id: "resp_unfinished_call",
        status: "completed",
        output: [
          {
            type: "function_call",
            status: "in_progress",
            call_id: "call_1",
            name: "search_pdf",
            arguments: "{}",
          },
        ],
      },
      {
        id: "resp_cancelled",
        status: "cancelled",
        output: [],
      },
    ];
    globalThis.fetch = (async () =>
      jsonResponse(responses.shift()!)) as typeof fetch;
    const provider = createProvider();

    for (const expected of [
      /incomplete/i,
      /unfinished function call/i,
      /unexpected status: cancelled/i,
    ]) {
      let rejected: unknown;
      try {
        await provider.chatCompletionWithTools(
          [message("u1", "user", "search")],
          [localPaperTool],
        );
      } catch (error) {
        rejected = error;
      }
      assert.instanceOf(rejected, Error);
      assert.match((rejected as Error).message, expected);
    }
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
