import { assert } from "chai";
import type { ToolCall, ToolExecutionResult } from "../src/types/tool";

describe("tool retry policy", function () {
  it("builds the same fingerprint for semantically identical calls", async function () {
    const { fingerprintToolCall } = await import(
      "../src/modules/chat/tool-retry/ToolRetryPolicy.ts"
    );

    const firstCall: ToolCall = {
      id: "tool-1",
      type: "function",
      function: {
        name: "web_search",
        arguments: JSON.stringify({
          query: "attention heads",
          maxResults: "2",
          includeContent: "true",
          domainFilter: "arxiv.org, aclanthology.org",
        }),
      },
    };
    const secondCall: ToolCall = {
      id: "tool-2",
      type: "function",
      function: {
        name: "web_search",
        arguments: JSON.stringify({
          max_results: 2,
          include_content: true,
          domain_filter: ["arxiv.org", "aclanthology.org"],
          query: "attention heads",
        }),
      },
    };

    assert.equal(fingerprintToolCall(firstCall), fingerprintToolCall(secondCall));
  });

  it("creates a non-retryable synthetic result for unchanged repeated failures", async function () {
    const { createBlockedRetryResult, findBlockedRetryMatch } = await import(
      "../src/modules/chat/tool-retry/ToolRetryPolicy.ts"
    );

    const previousResult: ToolExecutionResult = {
      toolCall: {
        id: "tool-prev",
        type: "function",
        function: {
          name: "get_full_text",
          arguments: JSON.stringify({ itemKey: "ITEM-1" }),
        },
      },
      args: { itemKey: "ITEM-1" },
      status: "failed",
      content: [
        "Error: Required paper context is unavailable for get_full_text.",
        "Category: missing_context",
        "Retryable: yes",
        "Fix hint: Retry with a valid itemKey.",
      ].join("\n"),
      error: "Required paper context is unavailable.",
    };
    const repeatedCall: ToolCall = {
      id: "tool-next",
      type: "function",
      function: {
        name: "get_full_text",
        arguments: JSON.stringify({ itemKey: "ITEM-1" }),
      },
    };

    const blocked = createBlockedRetryResult(repeatedCall, previousResult);
    const match = findBlockedRetryMatch(repeatedCall, [previousResult]);

    assert.equal(match?.previousResult, previousResult);
    assert.equal(blocked.status, "failed");
    assert.equal(blocked.toolCall.id, "tool-next");
    assert.include(blocked.content, "Repeated unchanged tool call blocked");
    assert.include(blocked.content, "Retryable: no");
    assert.include(blocked.content, "Do not retry unchanged");
    assert.deepInclude(blocked.policyTrace?.[0], {
      stage: "planner",
      policy: "retry_block",
      outcome: "blocked",
    });
  });

  it("does not block a retry when the arguments change", async function () {
    const { findBlockedRetryMatch } = await import(
      "../src/modules/chat/tool-retry/ToolRetryPolicy.ts"
    );

    const previousResult: ToolExecutionResult = {
      toolCall: {
        id: "tool-prev",
        type: "function",
        function: {
          name: "get_item_metadata",
          arguments: JSON.stringify({ itemKey: "ITEM-1" }),
        },
      },
      args: { itemKey: "ITEM-1" },
      status: "failed",
      content: "Error: Tool execution failed for get_item_metadata.",
    };
    const changedCall: ToolCall = {
      id: "tool-next",
      type: "function",
      function: {
        name: "get_item_metadata",
        arguments: JSON.stringify({ itemKey: "ITEM-2" }),
      },
    };

    assert.isNull(findBlockedRetryMatch(changedCall, [previousResult]));
  });
});
