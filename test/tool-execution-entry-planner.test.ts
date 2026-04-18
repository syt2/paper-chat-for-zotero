import { assert } from "chai";
import type { ChatMessage } from "../src/types/chat";
import type { ToolCall, ToolExecutionResult } from "../src/types/tool";

describe("tool execution entry planner", function () {
  const assistantMessage: ChatMessage = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    timestamp: 1,
  };

  function createToolCall(
    id: string,
    itemKey: string,
    toolName: string = "get_item_metadata",
    extraArgs?: Record<string, unknown>,
  ): ToolCall {
    return {
      id,
      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify({ itemKey, ...(extraArgs || {}) }),
      },
    };
  }

  function createWebSearchCall(id: string, query: string): ToolCall {
    return {
      id,
      type: "function",
      function: {
        name: "web_search",
        arguments: JSON.stringify({ query }),
      },
    };
  }

  it("blocks unchanged retries as synthetic entries", async function () {
    const { planToolExecutionEntries } = await import(
      "../src/modules/chat/agent-runtime/ToolExecutionEntryPlanner.ts"
    );

    const previousResults: ToolExecutionResult[] = [
      {
        toolCall: createToolCall("tool-1", "ITEM-1"),
        args: { itemKey: "ITEM-1" },
        status: "failed",
        content: [
          "Error: Required paper context is unavailable for get_item_metadata.",
          "Category: missing_context",
          "Retryable: yes",
        ].join("\n"),
      },
    ];

    const entries = planToolExecutionEntries({
      sessionId: "session-1",
      assistantMessage,
      toolCalls: [createToolCall("tool-2", "ITEM-1")],
      previousResults,
      createExecutionBatches: (requests) => [requests],
    });

    assert.lengthOf(entries, 1);
    assert.equal(entries[0].kind, "synthetic");
    if (entries[0].kind === "synthetic") {
      assert.equal(entries[0].results[0].status, "failed");
      assert.include(entries[0].results[0].content, "Repeated unchanged tool call blocked");
    }
  });

  it("keeps changed retries executable and passes them into batching", async function () {
    const { planToolExecutionEntries } = await import(
      "../src/modules/chat/agent-runtime/ToolExecutionEntryPlanner.ts"
    );

    const previousResults: ToolExecutionResult[] = [
      {
        toolCall: createToolCall("tool-1", "ITEM-1"),
        args: { itemKey: "ITEM-1" },
        status: "failed",
        content: "Error: Tool execution failed for get_item_metadata.",
      },
    ];
    const batchCalls: string[][] = [];

    const entries = planToolExecutionEntries({
      sessionId: "session-1",
      assistantMessage,
      toolCalls: [createToolCall("tool-2", "ITEM-2")],
      previousResults,
      createExecutionBatches: (requests) => {
        batchCalls.push(requests.map((request) => request.toolCall.id));
        return [requests];
      },
    });

    assert.lengthOf(entries, 1);
    assert.equal(entries[0].kind, "execute");
    assert.deepEqual(batchCalls, [["tool-2"]]);
    if (entries[0].kind === "execute") {
      assert.equal(entries[0].requests[0].assistantMessageId, "assistant-1");
      assert.equal(entries[0].requests[0].sessionId, "session-1");
    }
  });

  it("blocks get_full_text until a narrower paper tool has been used in the turn", async function () {
    const { planToolExecutionEntries } = await import(
      "../src/modules/chat/agent-runtime/ToolExecutionEntryPlanner.ts"
    );

    const entries = planToolExecutionEntries({
      sessionId: "session-1",
      assistantMessage,
      toolCalls: [createToolCall("tool-1", "ITEM-1", "get_full_text")],
      previousResults: [],
      createExecutionBatches: (requests) => [requests],
    });

    assert.lengthOf(entries, 1);
    assert.equal(entries[0].kind, "synthetic");
    if (entries[0].kind === "synthetic") {
      assert.include(entries[0].results[0].content, "Category: budget_exhausted");
      assert.include(entries[0].results[0].content, "Use narrower tools first");
    }
  });

  it("blocks a fourth get_full_text call in the same turn after three already ran", async function () {
    const { planToolExecutionEntries } = await import(
      "../src/modules/chat/agent-runtime/ToolExecutionEntryPlanner.ts"
    );

    const previousResults: ToolExecutionResult[] = [
      {
        toolCall: createToolCall(
          "tool-narrow",
          "ITEM-1",
          "search_paper_content",
          { query: "method" },
        ),
        args: { itemKey: "ITEM-1", query: "method" },
        status: "completed",
        content: "Found method section references.",
      },
      {
        toolCall: createToolCall("tool-fulltext-1", "ITEM-1", "get_full_text"),
        args: { itemKey: "ITEM-1" },
        status: "completed",
        content: "Full text content",
      },
      {
        toolCall: createToolCall("tool-fulltext-2", "ITEM-2", "get_full_text"),
        args: { itemKey: "ITEM-2" },
        status: "completed",
        content: "Full text content 2",
      },
      {
        toolCall: createToolCall("tool-fulltext-3", "ITEM-3", "get_full_text"),
        args: { itemKey: "ITEM-3" },
        status: "completed",
        content: "Full text content 3",
      },
    ];

    const entries = planToolExecutionEntries({
      sessionId: "session-1",
      assistantMessage,
      toolCalls: [createToolCall("tool-2", "ITEM-4", "get_full_text")],
      previousResults,
      createExecutionBatches: (requests) => [requests],
    });

    assert.lengthOf(entries, 1);
    assert.equal(entries[0].kind, "synthetic");
    if (entries[0].kind === "synthetic") {
      assert.include(entries[0].results[0].content, "Category: budget_exhausted");
      assert.include(entries[0].results[0].content, "may only run 3 times per user turn");
    }
  });

  it("blocks obviously repeated web searches in the same turn", async function () {
    const { planToolExecutionEntries } = await import(
      "../src/modules/chat/agent-runtime/ToolExecutionEntryPlanner.ts"
    );

    const previousResults: ToolExecutionResult[] = [
      {
        toolCall: createWebSearchCall("tool-1", "transformer interpretability"),
        args: { query: "transformer interpretability" },
        status: "completed",
        content: "web result",
      },
    ];

    const entries = planToolExecutionEntries({
      sessionId: "session-1",
      assistantMessage,
      toolCalls: [
        createWebSearchCall("tool-2", "transformer interpretability summary"),
      ],
      previousResults,
      createExecutionBatches: (requests) => [requests],
    });

    assert.lengthOf(entries, 1);
    assert.equal(entries[0].kind, "synthetic");
    if (entries[0].kind === "synthetic") {
      assert.include(entries[0].results[0].content, "Category: budget_exhausted");
      assert.include(entries[0].results[0].content, "similar web_search query already used");
    }
  });

  it("blocks web_search after the turn budget is exhausted", async function () {
    const { planToolExecutionEntries } = await import(
      "../src/modules/chat/agent-runtime/ToolExecutionEntryPlanner.ts"
    );

    const previousResults: ToolExecutionResult[] = [
      {
        toolCall: createWebSearchCall("tool-1", "query one"),
        args: { query: "query one" },
        status: "completed",
        content: "web result 1",
      },
      {
        toolCall: createWebSearchCall("tool-2", "query two"),
        args: { query: "query two" },
        status: "completed",
        content: "web result 2",
      },
      {
        toolCall: createWebSearchCall("tool-3", "query three"),
        args: { query: "query three" },
        status: "completed",
        content: "web result 3",
      },
      {
        toolCall: createWebSearchCall("tool-4", "query four"),
        args: { query: "query four" },
        status: "completed",
        content: "web result 4",
      },
      {
        toolCall: createWebSearchCall("tool-5", "query five"),
        args: { query: "query five" },
        status: "completed",
        content: "web result 5",
      },
    ];

    const entries = planToolExecutionEntries({
      sessionId: "session-1",
      assistantMessage,
      toolCalls: [createWebSearchCall("tool-6", "query six")],
      previousResults,
      createExecutionBatches: (requests) => [requests],
    });

    assert.lengthOf(entries, 1);
    assert.equal(entries[0].kind, "synthetic");
    if (entries[0].kind === "synthetic") {
      assert.include(entries[0].results[0].content, "Category: budget_exhausted");
      assert.include(entries[0].results[0].content, "may only run 5 times per user turn");
    }
  });
});
