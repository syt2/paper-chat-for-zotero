import { assert } from "chai";
import { ExecutionPlanManager } from "../src/modules/chat/agent-runtime/ExecutionPlanManager.ts";
import { generatePaperContextPrompt } from "../src/modules/chat/pdf-tools/promptGenerator.ts";
import type { ChatMessage, ChatSession } from "../src/types/chat";
import type { ToolExecutionResult } from "../src/types/tool";

function createSession(): ChatSession {
  const messages: ChatMessage[] = [
    {
      id: "user-1",
      role: "user",
      content: "Compare two papers and summarize the differences.",
      timestamp: 1,
    },
  ];

  return {
    id: "session-1",
    createdAt: 1,
    updatedAt: 1,
    lastActiveItemKey: null,
    messages,
  };
}

describe("agent runtime plan semantics", function () {
  it("uses user-task-oriented step titles instead of raw tool names", function () {
    const manager = new ExecutionPlanManager();
    const session = createSession();

    manager.startPlan(session, session.messages);
    manager.addOrUpdateToolStep(
      session,
      session.messages,
      "tool-1",
      "list_all_items",
      "in_progress",
      "page=1",
    );
    manager.addOrUpdateToolStep(
      session,
      session.messages,
      "tool-2",
      "get_note_content",
      "in_progress",
      "noteKey=NOTE-1",
    );

    assert.deepEqual(
      session.executionPlan?.steps.map((step) => step.title),
      ["Find relevant papers in Zotero", "Review notes and annotations"],
    );
  });

  it("adds an explicit recovery step and closes it when the next tool starts", function () {
    const manager = new ExecutionPlanManager();
    const session = createSession();

    manager.startPlan(session, session.messages);
    manager.recordRecoveryStep(session, session.messages, [
      {
        toolCall: {
          id: "tool-1",
          type: "function",
          function: {
            name: "web_search",
            arguments: JSON.stringify({ query: "latest benchmark" }),
          },
        },
        status: "denied",
        content: "Error: Permission denied",
        error: "Permission denied",
      },
    ]);

    const recoveryStep = session.executionPlan?.steps.at(-1);
    assert.equal(recoveryStep?.title, "Revise plan after blocked tool call");
    assert.equal(recoveryStep?.status, "in_progress");
    assert.equal(session.executionPlan?.activeStepId, recoveryStep?.id);

    manager.addOrUpdateToolStep(
      session,
      session.messages,
      "tool-2",
      "get_item_metadata",
      "in_progress",
      "itemKey=ITEM-1",
    );

    assert.equal(recoveryStep?.status, "completed");
    assert.equal(
      session.executionPlan?.steps.at(-1)?.title,
      "Inspect paper metadata",
    );
    assert.equal(session.executionPlan?.activeStepId, "tool-2");
  });

  it("injects source-grounding instructions and source hints into the agent prompt", function () {
    const prompt = generatePaperContextPrompt(
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      {
        executionPlan: {
          id: "plan-1",
          summary: "Compare papers",
          status: "in_progress",
          steps: [
            {
              id: "step-1",
              title: "Compare evidence across papers",
              status: "completed",
              detail: "Read the metadata for both papers",
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
        recentToolResults: [
          {
            toolCall: {
              id: "tool-1",
              type: "function",
              function: {
                name: "get_note_content",
                arguments: JSON.stringify({
                  noteKey: "NOTE-1",
                  itemKey: "ITEM-1",
                }),
              },
            },
            args: { noteKey: "NOTE-1", itemKey: "ITEM-1" },
            metadata: {
              name: "get_note_content",
              executionClass: "read",
              concurrency: "parallel_safe",
              targetScope: "library",
              mutatesState: false,
            },
            status: "completed",
            content: "Paper A notes mention a stronger ablation study.",
          } satisfies ToolExecutionResult,
          {
            toolCall: {
              id: "tool-2",
              type: "function",
              function: {
                name: "get_full_text",
                arguments: JSON.stringify({
                  itemKey: "ITEM-1",
                }),
              },
            },
            args: { itemKey: "ITEM-1" },
            status: "failed",
            content: [
              "Error: Required paper context is unavailable for get_full_text.",
              "Category: missing_context",
              "Retryable: yes",
            ].join("\n"),
          } satisfies ToolExecutionResult,
        ],
      },
    );

    assert.include(prompt, "FINAL ANSWER REQUIREMENTS");
    assert.include(prompt, "Attribute claims to the correct paper");
    assert.include(
      prompt,
      "source: Zotero library, itemKey=ITEM-1, noteKey=NOTE-1",
    );
    assert.include(prompt, '<source-group label="Paper title or source name"');
    assert.include(prompt, 'type="paper|note|annotation|web|library|memory"');
    assert.include(prompt, "=== RETRY POLICY ===");
    assert.include(prompt, "Runtime already blocks unchanged failed or denied retries");
    assert.include(prompt, "=== FAILURE RECOVERY STRATEGY ===");
    assert.include(prompt, "category=missing_context");
    assert.include(prompt, "tools=get_item_metadata, get_item_notes");
  });
});
