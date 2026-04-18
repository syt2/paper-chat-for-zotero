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

  function createToolCall(id: string, itemKey: string): ToolCall {
    return {
      id,
      type: "function",
      function: {
        name: "get_item_metadata",
        arguments: JSON.stringify({ itemKey }),
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
});
