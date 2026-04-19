import { assert } from "chai";
import {
  assertAssistantContentMatches,
  assertExecutedTools,
  assertExecutionPlanTerminalState,
  assertRecoveryNoticeIncludes,
  assertToolResultContains,
  assertTraceContainsSequence,
  createToolCall,
  getToolCompletionPolicies,
  getToolCompletionStatuses,
  runAgentTraceScenario,
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

    assertTraceContainsSequence(result, [
      "turn_started:Check whether this paper has a note summary.",
      "tool_completed:web_search:denied",
      "tool_started:get_item_metadata",
      "tool_completed:get_item_metadata:completed",
      /^turn_completed:I will check outside Zotero first\./,
    ]);
    assertExecutedTools(result, ["get_item_metadata"]);
    assertExecutionPlanTerminalState(result, "completed", "Compose final answer");
    assertRecoveryNoticeIncludes(result, "permission_denied", [
      "Do not retry this tool",
      "permission_denied",
    ]);
    assert.includeMembers(getToolCompletionPolicies(result), [
      "web_search:denied:scheduler:permission_decision",
      "get_item_metadata:completed:executor:none",
    ]);
    assertAssistantContentMatches(result, "answer without web search");
    assertToolResultContains(result, "web_search", "permission_denied");
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

    assertTraceContainsSequence(result, [
      "turn_started:Read the full paper and tell me the method.",
      "tool_completed:get_full_text:failed",
      "tool_started:search_paper_content",
      "tool_completed:search_paper_content:completed",
      /^turn_completed:I will fetch the full paper text\./,
    ]);
    assert.deepEqual(getToolCompletionStatuses(result), [
      "get_full_text:failed",
      "search_paper_content:completed",
    ]);
    assert.includeMembers(getToolCompletionPolicies(result), [
      "get_full_text:failed:planner:budget_block",
      "search_paper_content:completed:executor:none",
    ]);
    assertExecutedTools(result, ["search_paper_content"]);
    assertExecutionPlanTerminalState(result, "completed", "Compose final answer");
    assertRecoveryNoticeIncludes(result, "budget_exhausted", [
      "search_paper_content",
      "get_paper_section",
    ]);
    assertToolResultContains(result, "get_full_text", "Use narrower tools first");
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

    assertTraceContainsSequence(result, [
      "turn_started:Create a note with the summary.",
      "tool_completed:create_note:denied",
      /^turn_completed:I will save the summary to Zotero\./,
    ]);
    assertExecutedTools(result, []);
    assertExecutionPlanTerminalState(result, "completed", "Compose final answer");
    assertRecoveryNoticeIncludes(result, "permission_denied", [
      "Replan around read-only or already-allowed tools",
    ]);
    assertAssistantContentMatches(result, "summary inline instead");
  });

  it("provides stable plan and trace helpers for generic failure scenes", async function () {
    const result = await runAgentTraceScenario({
      userContent: "Find the key claim from the paper.",
      rounds: [
        {
          content: "I will search the paper for the main claim.",
          toolCalls: [
            createToolCall("tool-search-1", "search_paper_content", {
              itemKey: "ITEM-1",
              query: "claim",
            }),
          ],
        },
        {
          content:
            "The search tool failed, so I will explain the limitation instead of guessing.",
        },
      ],
      executeTool: (toolCall) => {
        if (toolCall.function.name === "search_paper_content") {
          return [
            "Error: Search index unavailable for search_paper_content.",
            "Category: execution_failed",
            "Retryable: yes",
          ].join("\n");
        }
        throw new Error(`Unexpected tool execution: ${toolCall.function.name}`);
      },
    });

    assertTraceContainsSequence(result, [
      "turn_started:Find the key claim from the paper.",
      "tool_started:search_paper_content",
      "tool_completed:search_paper_content:failed",
      /^turn_completed:I will search the paper for the main claim\./,
    ]);
    assertExecutedTools(result, ["search_paper_content"]);
    assertExecutionPlanTerminalState(result, "completed", "Compose final answer");
    assertRecoveryNoticeIncludes(result, "execution_failed", [
      "avoid repeating the same call unchanged",
    ]);
    assertAssistantContentMatches(result, "explain the limitation instead");
  });

  it("emits a matching completion event when a started tool is interrupted by session invalidation", async function () {
    let tracked = true;
    const result = await runAgentTraceScenario({
      userContent: "Search the paper once.",
      rounds: [
        {
          content: "I will search the paper.",
          toolCalls: [
            createToolCall("tool-search-interrupted", "search_paper_content", {
              itemKey: "ITEM-1",
              query: "method",
            }),
          ],
        },
      ],
      afterToolStarted: () => {
        tracked = false;
      },
      isSessionTracked: () => tracked,
      executeTool: () => "Method section: interrupted after start.",
    });

    assertTraceContainsSequence(result, [
      "turn_started:Search the paper once.",
      "tool_started:search_paper_content",
      "tool_completed:search_paper_content:failed",
    ]);
    assert.includeMembers(getToolCompletionPolicies(result), [
      "search_paper_content:failed:executor:none",
    ]);
  });
});
