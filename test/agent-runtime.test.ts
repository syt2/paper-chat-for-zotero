import { assert } from "chai";
import { AgentRuntime } from "../src/modules/chat/agent-runtime/AgentRuntime.ts";
import { ExecutionPlanManager } from "../src/modules/chat/agent-runtime/ExecutionPlanManager.ts";
import {
  generateAgentRuntimeContextPrompt,
  generatePaperContextPrompt,
} from "../src/modules/chat/pdf-tools/promptGenerator.ts";
import type { ChatMessage, ChatSession } from "../src/types/chat";
import type { ToolCall, ToolExecutionResult } from "../src/types/tool";
import { createPdfPassageEvidenceRecord } from "../src/modules/chat/evidence/index.ts";
import { MAX_ITERATIONS_MESSAGE } from "../src/modules/chat/agent-runtime/messages.ts";

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
  it("fails the final round when a provider suppresses a prefixed tool call", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-max-iterations",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const persistedContent: string[] = [];
    const runtime = new AgentRuntime(
      {
        updateSessionMeta: async () => undefined,
        updateMessageContent: async (
          _sessionId: string,
          _messageId: string,
          content: string,
        ) => {
          persistedContent.push(content);
        },
      } as any,
      {
        isSessionActive: () => true,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => "generated-id",
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async () => [],
      },
    ) as any;
    runtime.getMaxIterations = () => 1;
    let receivedToolChoice = "";
    const provider = {
      config: {
        id: "deepseek",
        type: "openai-compatible",
        defaultModel: "deepseek-test",
      },
      chatCompletionWithTools: async (
        _messages: ChatMessage[],
        _tools: unknown[],
        _signal: AbortSignal | undefined,
        options: { toolChoice?: string },
      ) => {
        receivedToolChoice = options.toolChoice || "";
        return {
          content: "Let me inspect that.",
          suppressedToolCall: true,
        };
      },
    };

    try {
      await runtime.executeNonStreamingToolLoop({
        provider,
        currentMessages: session.messages,
        assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: [
          {
            type: "function",
            function: {
              name: "search_paper_content",
              description: "Search paper text",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        sendingSession: session,
      });

      assert.equal(receivedToolChoice, "none");
      assert.equal(session.executionPlan?.status, "failed");
      assert.equal(
        assistantMessage.content,
        `Let me inspect that.${MAX_ITERATIONS_MESSAGE}`,
      );
      assert.equal(persistedContent.at(-1), assistantMessage.content);
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("dedupes identical request_user_input calls in one model response", function () {
    const runtime = new AgentRuntime(
      {
        updateSessionUserInputRequestState: async () => undefined,
        updateSessionMeta: async () => undefined,
      } as any,
      {
        isSessionActive: () => true,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => "generated-id",
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async () => [],
      },
    ) as any;
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    const firstCall: ToolCall = {
      id: "ask-1",
      type: "function",
      function: {
        name: "request_user_input",
        arguments: JSON.stringify({
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which scope?",
              type: "single_choice",
              options: [
                { label: "Methods", description: "Read methods." },
                { label: "Results", description: "Read results." },
              ],
            },
          ],
        }),
      },
    };
    const secondCall: ToolCall = {
      ...firstCall,
      id: "ask-2",
    };

    const entries = runtime.createRuntimeToolIterationEntries(
      session,
      assistantMessage,
      [firstCall, secondCall],
      {
        maxWebSearchCallsPerTurn: 8,
        maxFullTextCallsPerTurn: 3,
      },
    );

    assert.equal(entries[0].kind, "user_input");
    assert.equal(entries[1].kind, "synthetic");
    assert.equal(entries[1].results[0].status, "failed");
    assert.include(entries[1].results[0].content, "Duplicate user input");
  });

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
    assert.include(prompt, "=== PARALLEL TOOL CALLING ===");
    assert.include(
      prompt,
      "request all independent read-only or network lookups in the same tool-calling turn",
    );
    assert.include(prompt, "Attribute claims to the correct paper");
    assert.include(prompt, "Trusted evidence IDs for inline citations");
    assert.include(prompt, '<evidence-ref ids="ev-0123456789abcdef"/>');
    assert.include(prompt, "Never invent, alter, or copy an ID");
    assert.include(
      prompt,
      "source: Zotero library, itemKey=ITEM-1, noteKey=NOTE-1",
    );
    assert.include(prompt, '<source-group label="Paper title or source name"');
    assert.include(
      prompt,
      'type="paper|item|note|annotation|web|collection|library|memory"',
    );
    assert.include(
      prompt,
      '<source-group label="Paper title" type="paper" key="ABCD1234" page="7">',
    );
    assert.include(
      prompt,
      '<source-group label="PaperChat Notes" type="note" key="ABCD1234">',
    );
    assert.include(prompt, "existing notes returned by get_item_notes");
    assert.include(
      prompt,
      '<source-group label="Highlighted passage" type="annotation" key="ABCD1234">',
    );
    assert.include(
      prompt,
      '<source-group label="Source title" type="web" url="https://example.com/source">',
    );
    assert.include(
      prompt,
      '<source-group label="Collection name" type="collection" key="ABCD1234">',
    );
    assert.include(prompt, "omit any unknown attribute");
    assert.include(prompt, "=== RETRY POLICY ===");
    assert.include(
      prompt,
      "Runtime already blocks unchanged failed or denied retries",
    );
    assert.include(prompt, "=== FAILURE RECOVERY STRATEGY ===");
    assert.include(prompt, "category=missing_context");
    assert.include(prompt, "tools=get_item_metadata, get_item_notes");
  });

  it("keeps dynamic runtime context separable from the stable paper prompt", function () {
    const stablePrompt = generatePaperContextPrompt(
      undefined,
      undefined,
      undefined,
      false,
    );
    const runtimePrompt = generateAgentRuntimeContextPrompt(undefined, {
      runtimeLimits: {
        hardIterationLimit: 4,
        currentIteration: 2,
        remainingIterations: 3,
        forceFinalAnswer: false,
      },
    });

    assert.include(stablePrompt, "=== NO PAPER SELECTED ===");
    assert.include(stablePrompt, "list_all_items");
    assert.include(stablePrompt, "=== PARALLEL TOOL CALLING ===");
    assert.notInclude(stablePrompt, "Current iteration:");
    assert.notInclude(stablePrompt, "FINAL ANSWER REQUIREMENTS");
    assert.include(runtimePrompt, "Current iteration: 2/4");
    assert.include(runtimePrompt, "FINAL ANSWER REQUIREMENTS");
  });

  it("persists only trusted evidence referenced by the final answer", async function () {
    const record = createPdfPassageEvidenceRecord({
      itemKey: "ITEM0001",
      page: 2,
      quote: "The verified passage supports the final answer.",
      toolCallId: "tool-search",
      resultIndex: 1,
    })!;
    let checkpoint:
      | {
          content: string;
          evidence?: (typeof record)[];
        }
      | undefined;
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async (
          _sessionId: string,
          _messageId: string,
          content: string,
          _reasoning: string | undefined,
          options: { evidence?: (typeof record)[] },
        ) => {
          checkpoint = { content, evidence: options.evidence };
        },
        updateSessionMeta: async () => undefined,
      } as any,
      {
        isSessionActive: () => true,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => "generated-id",
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async () => [],
      },
    ) as any;
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-final",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    runtime.executionPlanManager.startPlan(session, session.messages);
    session.toolExecutionState = {
      turnStartedAt: 1,
      updatedAt: 1,
      results: [
        {
          toolCall: {
            id: "tool-search",
            type: "function",
            function: {
              name: "search_paper_content",
              arguments: '{"query":"verified"}',
            },
          },
          status: "completed",
          content: "search result",
          evidence: [record],
        },
      ],
    };
    const forgedId = "ev-ffffffffffffffff";

    await runtime.finalizeCompletedTurn({
      sendingSession: session,
      currentMessages: session.messages,
      assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      accumulatedDisplay: `Trusted claim.<evidence-ref ids="${record.id},${forgedId}"/> Forged.<evidence-ref ids="${forgedId}"/>`,
      iteration: 2,
    });

    assert.equal(
      assistantMessage.content,
      `Trusted claim.<evidence-ref ids="${record.id}"/> Forged.`,
    );
    assert.deepEqual(assistantMessage.evidence, [record]);
    assert.deepEqual(checkpoint?.evidence, [record]);
    assert.equal(checkpoint?.content, assistantMessage.content);
  });
});
