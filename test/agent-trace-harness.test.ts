import { assert } from "chai";
import {
  createToolCall,
  runAgentTraceScenario,
  summarizeAgentTrace,
} from "./helpers/agentTraceHarness.ts";

describe("agent trace eval harness", function () {
  it("replans after denied web_search and falls back to Zotero tools", async function () {
    const result = await runAgentTraceScenario({
      userContent: "Check whether this paper has a note summary.",
      decideTool: (toolCall) =>
        toolCall.function.name === "web_search"
          ? { verdict: "deny", reason: "Web access blocked in this scenario." }
          : "allow",
      rounds: [
        {
          content: "I will check outside Zotero first.",
          toolCalls: [
            createToolCall("tool-web-1", "web_search", {
              query: "paper summary site:arxiv.org",
            }),
          ],
        },
        {
          content: "Web access was blocked, so I will inspect the Zotero item.",
          expectMessages: (messages) => {
            const recovery = messages.find(
              (message) =>
                message.role === "system" &&
                message.content.includes("permission_denied"),
            );
            assert.isDefined(recovery);
            assert.include(recovery?.content || "", "Do not retry this tool");
          },
          toolCalls: [
            createToolCall("tool-meta-1", "get_item_metadata", {
              itemKey: "ITEM-1",
            }),
          ],
        },
        {
          content:
            "The Zotero metadata is available locally, so I can answer without web search.",
        },
      ],
      executeTool: (toolCall) => {
        if (toolCall.function.name === "get_item_metadata") {
          return "Title: Paper A\nYear: 2024\nNotes: summary available";
        }
        throw new Error(`Unexpected tool execution: ${toolCall.function.name}`);
      },
    });

    const trace = summarizeAgentTrace(result);
    assert.include(
      trace,
      "turn_started:Check whether this paper has a note summary.",
    );
    assert.include(trace, "tool_completed:web_search:denied");
    assert.include(trace, "tool_started:get_item_metadata");
    assert.include(trace, "tool_completed:get_item_metadata:completed");
    assert.match(
      trace[trace.length - 1] || "",
      /^turn_completed:I will check outside Zotero first\./,
    );
    assert.deepEqual(
      result.executedToolCalls.map((entry) => entry.toolName),
      ["get_item_metadata"],
    );
    assert.equal(result.session.executionPlan?.status, "completed");
    assert.include(
      result.assistantMessage.content,
      "answer without web search",
    );
    assert.include(
      result.session.toolExecutionState?.results[0]?.content || "",
      "permission_denied",
    );
  });

  it("replans after get_full_text is budget-blocked and uses a narrower paper tool", async function () {
    const result = await runAgentTraceScenario({
      userContent: "Read the full paper and tell me the method.",
      rounds: [
        {
          content: "I will fetch the full paper text.",
          toolCalls: [
            createToolCall("tool-full-1", "get_full_text", {
              itemKey: "ITEM-1",
            }),
          ],
        },
        {
          content: "Full text is too expensive first, so I will search the method section.",
          expectMessages: (messages) => {
            const recovery = messages.find(
              (message) =>
                message.role === "system" &&
                message.content.includes("budget_exhausted"),
            );
            assert.isDefined(recovery);
            assert.include(recovery?.content || "", "Suggested tools");
            assert.include(recovery?.content || "", "search_paper_content");
            assert.include(recovery?.content || "", "get_paper_section");
          },
          toolCalls: [
            createToolCall("tool-search-1", "search_paper_content", {
              itemKey: "ITEM-1",
              query: "method",
            }),
          ],
        },
        {
          content: "The method is described in the local paper search results.",
        },
      ],
      executeTool: (toolCall, args) => {
        if (toolCall.function.name === "search_paper_content") {
          assert.deepEqual(args, {
            itemKey: "ITEM-1",
            query: "method",
          });
          return "Method section: We fine-tune a retrieval encoder with hard negatives.";
        }
        throw new Error(`Unexpected tool execution: ${toolCall.function.name}`);
      },
    });

    const toolStatuses = result.runtimeEvents
      .filter((event) => event.type === "tool_completed")
      .map((event) => `${event.toolName}:${event.status}`);
    assert.deepEqual(toolStatuses, [
      "get_full_text:failed",
      "search_paper_content:completed",
    ]);
    assert.deepEqual(
      result.executedToolCalls.map((entry) => entry.toolName),
      ["search_paper_content"],
    );
    assert.include(
      result.session.toolExecutionState?.results[0]?.content || "",
      "Use narrower tools first",
    );
    assert.equal(
      result.session.executionPlan?.steps.at(-1)?.title,
      "Compose final answer",
    );
  });

  it("surfaces a denied write tool in the trace and still completes the turn", async function () {
    const result = await runAgentTraceScenario({
      userContent: "Create a note with the summary.",
      decideTool: (toolCall) =>
        toolCall.function.name === "create_note" ? "deny" : "allow",
      rounds: [
        {
          content: "I will save the summary to Zotero.",
          toolCalls: [
            createToolCall("tool-note-1", "create_note", {
              itemKey: "ITEM-1",
              content: "summary",
            }),
          ],
        },
        {
          content:
            "I cannot create the note under the current policy, so here is the summary inline instead.",
          expectMessages: (messages) => {
            const recovery = messages.find(
              (message) =>
                message.role === "system" &&
                message.content.includes("permission_denied"),
            );
            assert.isDefined(recovery);
          },
        },
      ],
    });

    const trace = summarizeAgentTrace(result);
    assert.deepEqual(trace.slice(0, 2), [
      "turn_started:Create a note with the summary.",
      "tool_completed:create_note:denied",
    ]);
    assert.match(
      trace[trace.length - 1] || "",
      /^turn_completed:I will save the summary to Zotero\./,
    );
    assert.deepEqual(result.executedToolCalls, []);
    assert.include(
      result.assistantMessage.content,
      "summary inline instead",
    );
    assert.equal(result.session.executionPlan?.status, "completed");
  });
});
