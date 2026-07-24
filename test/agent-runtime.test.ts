import { assert } from "chai";
import {
  AgentRuntime,
  retainCompletedApiOnlyModelContextMessagesForTurn,
} from "../src/modules/chat/agent-runtime/AgentRuntime.ts";
import { ExecutionPlanManager } from "../src/modules/chat/agent-runtime/ExecutionPlanManager.ts";
import {
  generateAgentRuntimeContextPrompt,
  generatePaperContextPrompt,
} from "../src/modules/chat/pdf-tools/promptGenerator.ts";
import type { ChatMessage, ChatSession } from "../src/types/chat";
import type { ToolCall, ToolExecutionResult } from "../src/types/tool";
import { createPdfPassageEvidenceRecord } from "../src/modules/chat/evidence/index.ts";
import { AGENT_MAX_PLANNING_ITERATIONS_SETTINGS_HREF } from "../src/utils/internalLinks.ts";

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
  it("keeps completed pairs while removing pending calls and orphan results", function () {
    const visibleContent = [
      '<tool-call status="completed">',
      "<tool-name>search_paper_content</tool-name>",
      "<tool-result>visible preview</tool-result>",
      "</tool-call>",
    ].join("\n");
    const session: ChatSession = {
      id: "session-interrupted-tools",
      createdAt: 1,
      updatedAt: 7,
      lastActiveItemKey: null,
      messages: [
        { id: "user-1", role: "user", content: "question", timestamp: 1 },
        {
          id: "assistant-1-api-context-request",
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-completed",
              type: "function",
              function: {
                name: "search_paper_content",
                arguments: '{"query":"IDR"}',
              },
            },
            {
              id: "call-pending",
              type: "function",
              function: {
                name: "search_paper_content",
                arguments: '{"query":"disorder"}',
              },
            },
          ],
          apiOnly: true,
          timestamp: 2,
        },
        {
          id: "assistant-1-api-context-result",
          role: "tool",
          content: "trusted completed result",
          tool_call_id: "call-completed",
          apiOnly: true,
          timestamp: 3,
        },
        {
          id: "assistant-1-api-context-orphan",
          role: "tool",
          content: "orphan result",
          tool_call_id: "call-orphan",
          apiOnly: true,
          timestamp: 4,
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: visibleContent,
          streamingState: "interrupted",
          timestamp: 5,
        },
        { id: "error-1", role: "error", content: "cancelled", timestamp: 6 },
        {
          id: "user-2",
          role: "user",
          content: "请基于刚才结果直接回答",
          timestamp: 7,
        },
      ],
    };

    assert.isTrue(
      retainCompletedApiOnlyModelContextMessagesForTurn(session, "assistant-1"),
    );
    assert.deepEqual(
      session.messages.map((message) => message.id),
      [
        "user-1",
        "assistant-1-api-context-request",
        "assistant-1-api-context-result",
        "assistant-1",
        "error-1",
        "user-2",
      ],
    );
    assert.deepEqual(
      session.messages[1].tool_calls?.map((call) => call.id),
      ["call-completed"],
    );
    assert.equal(session.messages[2].content, "trusted completed result");
    assert.equal(session.messages[3].content, visibleContent);
    assert.equal(session.messages[3].streamingState, "interrupted");
  });

  it("removes an entirely incomplete transcript and reports that storage changed", function () {
    const session = createSession();
    session.messages.push(
      {
        id: "assistant-incomplete-api-context-request",
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-pending",
            type: "function",
            function: { name: "search_paper_content", arguments: "{}" },
          },
        ],
        apiOnly: true,
        timestamp: 2,
      },
      {
        id: "assistant-incomplete",
        role: "assistant",
        content: "",
        streamingState: "interrupted",
        timestamp: 3,
      },
    );

    assert.isTrue(
      retainCompletedApiOnlyModelContextMessagesForTurn(
        session,
        "assistant-incomplete",
      ),
    );
    assert.deepEqual(
      session.messages.map((message) => message.id),
      ["user-1", "assistant-incomplete"],
    );
  });

  it("persists structured history for non-OpenAI tool providers", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-anthropic-tools",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const toolCall: ToolCall = {
      id: "call-1",
      type: "function",
      function: { name: "list_all_items", arguments: "{}" },
    };
    const savedSessions: ChatSession[] = [];
    let providerCalls = 0;
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async (saved: ChatSession) => {
          savedSessions.push(saved);
        },
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "<tool-call />",
        generateId: (() => {
          let id = 0;
          return () => `generated-${++id}`;
        })(),
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async (requests: any[]) => [
          {
            toolCall: requests[0].toolCall,
            status: "completed",
            content: "recent paper result",
          },
        ],
      },
    ) as any;
    runtime.getMaxIterations = () => 2;
    const provider = {
      config: {
        id: "anthropic",
        type: "anthropic",
        defaultModel: "claude-test",
      },
      chatCompletionWithTools: async () => {
        providerCalls++;
        return providerCalls === 1
          ? { content: "", toolCalls: [toolCall] }
          : { content: "done" };
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
              name: "list_all_items",
              description: "List Zotero items",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        sendingSession: session,
      });

      assert.lengthOf(savedSessions, 1);
      assert.deepEqual(
        session.messages
          .filter((message) => message.apiOnly)
          .map((message) => message.role),
        ["assistant", "tool"],
      );
      assert.equal(
        session.messages.find((message) => message.role === "tool")?.content,
        "recent paper result",
      );
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("retries only the failed model request after a tool result", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-request-retry",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const toolCall: ToolCall = {
      id: "call-create-note",
      type: "function",
      function: { name: "create_note", arguments: '{"content":"note"}' },
    };
    let providerCalls = 0;
    let toolExecutions = 0;
    const requestSnapshots: ChatMessage[][] = [];
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "<tool-call />",
        generateId: (() => {
          let id = 0;
          return () => `request-retry-${++id}`;
        })(),
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async (requests: any[]) => {
          toolExecutions += 1;
          return [
            {
              toolCall: requests[0].toolCall,
              status: "completed",
              content: "created note NOTE-1",
            },
          ];
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 3;
    const provider = {
      config: {
        id: "paperchat",
        type: "paperchat",
        defaultModel: "test-model",
      },
      chatCompletionWithTools: async (messages: ChatMessage[]) => {
        providerCalls += 1;
        requestSnapshots.push(messages.map((message) => ({ ...message })));
        if (providerCalls === 1) {
          return { content: "", toolCalls: [toolCall] };
        }
        if (providerCalls === 2) {
          throw new Error("API Error: 503 Service Unavailable");
        }
        return { content: "note created successfully" };
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
              name: "create_note",
              description: "Create a note",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        sendingSession: session,
        executeProviderRequest: async (operation) => {
          try {
            return await operation();
          } catch {
            return operation();
          }
        },
      });

      assert.equal(providerCalls, 3);
      assert.equal(toolExecutions, 1);
      for (const snapshot of requestSnapshots.slice(1)) {
        assert.include(
          snapshot.map((message) => message.role),
          "tool",
        );
        assert.include(
          snapshot.map((message) => message.content),
          "created note NOTE-1",
        );
      }
      assert.equal(
        assistantMessage.content,
        "<tool-call />note created successfully",
      );
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("does not replay a completed tool when later non-streaming retries are exhausted", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-request-exhausted",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const toolCall: ToolCall = {
      id: "call-create-note-exhausted",
      type: "function",
      function: { name: "create_note", arguments: '{"content":"note"}' },
    };
    let providerCalls = 0;
    let toolExecutions = 0;
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "<tool-call />",
        generateId: (() => {
          let id = 0;
          return () => `request-exhausted-${++id}`;
        })(),
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async (requests: any[]) => {
          toolExecutions += 1;
          return [
            {
              toolCall: requests[0].toolCall,
              status: "completed",
              content: "created note NOTE-EXHAUSTED",
            },
          ];
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 3;
    const provider = {
      config: {
        id: "paperchat",
        type: "paperchat",
        defaultModel: "test-model",
      },
      chatCompletionWithTools: async () => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return { content: "", toolCalls: [toolCall] };
        }
        throw new Error("API Error: 503 Service Unavailable");
      },
    };

    try {
      let finalError: unknown;
      try {
        await runtime.executeNonStreamingToolLoop({
          provider,
          currentMessages: session.messages,
          assistantMessage,
          pdfWasAttached: false,
          summaryTriggered: false,
          tools: [],
          sendingSession: session,
          executeProviderRequest: async (operation) => {
            let lastError: unknown;
            for (let attempt = 0; attempt < 3; attempt += 1) {
              try {
                return await operation();
              } catch (error) {
                lastError = error;
              }
            }
            throw lastError;
          },
        });
      } catch (error) {
        finalError = error;
      }

      assert.instanceOf(finalError, Error);
      assert.equal(providerCalls, 4);
      assert.equal(toolExecutions, 1);
      assert.equal(session.toolExecutionState?.results.length, 1);
      assert.include(
        session.messages.map((message) => message.content),
        "created note NOTE-EXHAUSTED",
      );
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("retries a failed streaming model request without replaying its tool", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-stream-request-retry",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const toolCall: ToolCall = {
      id: "call-create-note-stream",
      type: "function",
      function: { name: "create_note", arguments: '{"content":"note"}' },
    };
    let providerCalls = 0;
    let toolExecutions = 0;
    const requestSnapshots: ChatMessage[][] = [];
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "<tool-call />",
        generateId: (() => {
          let id = 0;
          return () => `stream-request-retry-${++id}`;
        })(),
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async (requests: any[]) => {
          toolExecutions += 1;
          return [
            {
              toolCall: requests[0].toolCall,
              status: "completed",
              content: "created note NOTE-2",
            },
          ];
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 3;
    const provider = {
      config: {
        id: "paperchat",
        type: "paperchat",
        defaultModel: "test-model",
      },
      chatCompletionWithTools: async () => ({ content: "unused" }),
      streamChatCompletionWithTools: async (
        messages: ChatMessage[],
        _tools: unknown[],
        callbacks: any,
      ) => {
        providerCalls += 1;
        requestSnapshots.push(messages.map((message) => ({ ...message })));
        if (providerCalls === 1) {
          callbacks.onToolCallStart({
            index: 0,
            id: toolCall.id,
            name: toolCall.function.name,
          });
          callbacks.onToolCallDelta(0, toolCall.function.arguments);
          callbacks.onComplete({
            content: "",
            toolCalls: [toolCall],
            stopReason: "tool_calls",
          });
          return;
        }
        if (providerCalls === 2) {
          callbacks.onTextDelta("discarded partial");
          throw new Error("API Error: 503 Service Unavailable");
        }
        callbacks.onTextDelta("note created successfully");
        callbacks.onComplete({
          content: "note created successfully",
          stopReason: "end_turn",
        });
      },
    };

    try {
      await runtime.executeStreamingToolLoop({
        provider,
        currentMessages: session.messages,
        assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: [
          {
            type: "function",
            function: {
              name: "create_note",
              description: "Create a note",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        sendingSession: session,
        executeProviderRequest: async (operation) => {
          try {
            return await operation();
          } catch {
            return operation();
          }
        },
      });

      assert.equal(providerCalls, 3);
      assert.equal(toolExecutions, 1);
      for (const snapshot of requestSnapshots.slice(1)) {
        assert.include(
          snapshot.map((message) => message.content),
          "created note NOTE-2",
        );
      }
      assert.equal(
        assistantMessage.content,
        "<tool-call />note created successfully",
      );
      assert.notInclude(assistantMessage.content, "discarded partial");
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("renders hosted Web Search as transient UI without executing or persisting a tool", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-hosted-web-search",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const streamingUpdates: string[] = [];
    let toolExecutions = 0;
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => true,
        isSessionTracked: () => true,
        onStreamingUpdate: (content: string) => {
          streamingUpdates.push(content);
        },
        formatToolCallCard: (name: string, _args: string, status: string) =>
          `<tool name="${name}" status="${status}" />`,
        generateId: () => "generated-hosted-web-search",
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async () => {
          toolExecutions += 1;
          return [];
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 2;
    const provider = {
      config: {
        id: "paperchat",
        type: "paperchat",
        defaultModel: "test-model",
      },
      chatCompletionWithTools: async () => ({ content: "unused" }),
      streamChatCompletionWithTools: async (
        _messages: ChatMessage[],
        _tools: unknown[],
        callbacks: any,
      ) => {
        callbacks.onHostedWebSearchStatus({
          index: 0,
          id: "ws_123",
          status: "searching",
        });
        callbacks.onHostedWebSearchStatus({
          index: 0,
          id: "ws_123",
          status: "completed",
        });
        callbacks.onTextDelta("Answer from web");
        callbacks.onComplete({
          content: "Answer from web",
          stopReason: "end_turn",
        });
      },
    };

    try {
      await runtime.executeStreamingToolLoop({
        provider,
        currentMessages: session.messages,
        assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: [],
        sendingSession: session,
      });

      assert.include(
        streamingUpdates,
        '<tool name="web_search" status="calling" />',
      );
      assert.include(
        streamingUpdates,
        '<tool name="web_search" status="completed" />',
      );
      assert.include(
        streamingUpdates,
        '<tool name="web_search" status="completed" />Answer from web',
      );
      assert.equal(toolExecutions, 0);
      assert.equal(assistantMessage.content, "Answer from web");
      assert.isUndefined(assistantMessage.tool_calls);
      assert.notInclude(assistantMessage.content, "web_search");
      assert.isFalse(session.messages.some((message) => message.apiOnly));
      assert.deepEqual(session.toolExecutionState?.results, []);
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("does not replay a completed tool when later streaming retries are exhausted", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-stream-exhausted",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const toolCall: ToolCall = {
      id: "call-create-note-stream-exhausted",
      type: "function",
      function: { name: "create_note", arguments: '{"content":"note"}' },
    };
    let providerCalls = 0;
    let toolExecutions = 0;
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "<tool-call />",
        generateId: (() => {
          let id = 0;
          return () => `stream-exhausted-${++id}`;
        })(),
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async (requests: any[]) => {
          toolExecutions += 1;
          return [
            {
              toolCall: requests[0].toolCall,
              status: "completed",
              content: "created note NOTE-STREAM-EXHAUSTED",
            },
          ];
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 3;
    const provider = {
      config: {
        id: "paperchat",
        type: "paperchat",
        defaultModel: "test-model",
      },
      chatCompletionWithTools: async () => ({ content: "unused" }),
      streamChatCompletionWithTools: async (
        _messages: ChatMessage[],
        _tools: unknown[],
        callbacks: any,
      ) => {
        providerCalls += 1;
        if (providerCalls === 1) {
          callbacks.onComplete({
            content: "",
            toolCalls: [toolCall],
            stopReason: "tool_calls",
          });
          return;
        }
        if (providerCalls === 2) {
          callbacks.onTextDelta("longest visible partial");
        } else if (providerCalls === 3) {
          callbacks.onReasoningDelta("r".repeat(100));
        } else {
          callbacks.onTextDelta("short");
        }
        throw new Error("API Error: 503 Service Unavailable");
      },
    };

    try {
      let finalError: unknown;
      try {
        await runtime.executeStreamingToolLoop({
          provider,
          currentMessages: session.messages,
          assistantMessage,
          pdfWasAttached: false,
          summaryTriggered: false,
          tools: [],
          sendingSession: session,
          executeProviderRequest: async (operation) => {
            let lastError: unknown;
            for (let attempt = 0; attempt < 3; attempt += 1) {
              try {
                return await operation();
              } catch (error) {
                lastError = error;
              }
            }
            throw lastError;
          },
        });
      } catch (error) {
        finalError = error;
      }

      assert.instanceOf(finalError, Error);
      assert.equal(providerCalls, 4);
      assert.equal(toolExecutions, 1);
      assert.equal(session.toolExecutionState?.results.length, 1);
      assert.equal(
        assistantMessage.content,
        "<tool-call />longest visible partial",
      );
      assert.include(
        session.messages.map((message) => message.content),
        "created note NOTE-STREAM-EXHAUSTED",
      );
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("keeps the longest visible partial when streaming retries are exhausted", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-stream-partial-priority",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    let providerCalls = 0;
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "<tool-call />",
        generateId: () => "stream-partial-priority-id",
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async () => [],
      },
    ) as any;
    runtime.getMaxIterations = () => 2;
    const provider = {
      config: {
        id: "paperchat",
        type: "paperchat",
        defaultModel: "test-model",
      },
      chatCompletionWithTools: async () => ({ content: "unused" }),
      streamChatCompletionWithTools: async (
        _messages: ChatMessage[],
        _tools: unknown[],
        callbacks: any,
      ) => {
        providerCalls += 1;
        if (providerCalls === 1) {
          callbacks.onTextDelta("visible partial answer");
        } else {
          callbacks.onReasoningDelta("r".repeat(100));
        }
        throw new Error("API Error: 503 Service Unavailable");
      },
    };

    try {
      let finalError: unknown;
      try {
        await runtime.executeStreamingToolLoop({
          provider,
          currentMessages: session.messages,
          assistantMessage,
          pdfWasAttached: false,
          summaryTriggered: false,
          tools: [],
          sendingSession: session,
          executeProviderRequest: async (operation) => {
            try {
              return await operation();
            } catch {
              return operation();
            }
          },
        });
      } catch (error) {
        finalError = error;
      }

      assert.instanceOf(finalError, Error);
      assert.equal(providerCalls, 2);
      assert.equal(assistantMessage.content, "visible partial answer");
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("keeps completed tool results when resuming a failed turn", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const priorToolCall: ToolCall = {
      id: "prior-create-note",
      type: "function",
      function: { name: "create_note", arguments: '{"content":"note"}' },
    };
    session.toolExecutionState = {
      turnStartedAt: 1,
      updatedAt: 2,
      results: [
        {
          toolCall: priorToolCall,
          status: "completed",
          content: "created note NOTE-1",
        },
      ],
    };
    const assistantMessage: ChatMessage = {
      id: "assistant-resumed-turn",
      role: "assistant",
      content: "",
      timestamp: 3,
    };
    session.messages.push(assistantMessage);
    let providerCalls = 0;
    let toolExecutions = 0;
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "<tool-call />",
        generateId: (() => {
          let id = 0;
          return () => `resumed-turn-${++id}`;
        })(),
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async () => {
          toolExecutions += 1;
          return [];
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 3;
    const provider = {
      config: {
        id: "paperchat",
        type: "paperchat",
        defaultModel: "test-model",
      },
      chatCompletionWithTools: async () => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return {
            content: "",
            toolCalls: [
              {
                ...priorToolCall,
                id: "model-repeated-create-note",
              },
            ],
          };
        }
        return { content: "continued without rewriting the note" };
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
              name: "create_note",
              description: "Create a note",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        sendingSession: session,
        preserveToolExecutionState: true,
      });

      assert.equal(providerCalls, 2);
      assert.equal(toolExecutions, 0);
      assert.equal(session.toolExecutionState?.results.length, 1);
      assert.equal(
        assistantMessage.content,
        "continued without rewriting the note",
      );
      assert.include(
        session.messages.map((message) => message.content),
        "created note NOTE-1",
      );
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("persists completed tool context when a turn reaches the iteration limit", async function () {
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-max-tools",
      role: "assistant",
      content: "",
      timestamp: 4,
    };
    session.messages.push(
      {
        id: "assistant-max-tools-api-context-request",
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-completed",
            type: "function",
            function: { name: "search_paper_content", arguments: "{}" },
          },
          {
            id: "call-pending",
            type: "function",
            function: { name: "search_paper_content", arguments: "{}" },
          },
        ],
        apiOnly: true,
        timestamp: 2,
      },
      {
        id: "assistant-max-tools-api-context-result",
        role: "tool",
        content: "completed result",
        tool_call_id: "call-completed",
        apiOnly: true,
        timestamp: 3,
      },
      assistantMessage,
    );
    session.toolExecutionState = {
      turnStartedAt: 1,
      updatedAt: 1,
      results: [],
    };
    const savedSessions: ChatSession[] = [];
    let metadataUpdates = 0;
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => {
          metadataUpdates++;
        },
        saveSession: async (saved: ChatSession) => {
          savedSessions.push(saved);
        },
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => "generated-id",
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async () => [],
      },
    ) as any;

    await runtime.finalizeMaxIterationsTurn(
      session,
      1,
      session.messages,
      assistantMessage,
      "Maximum iterations reached.",
      30,
    );

    assert.equal(metadataUpdates, 0);
    assert.deepEqual(savedSessions, [session]);
    assert.deepEqual(
      session.messages.map((message) => message.id),
      [
        "user-1",
        "assistant-max-tools-api-context-request",
        "assistant-max-tools-api-context-result",
        "assistant-max-tools",
      ],
    );
    assert.deepEqual(
      session.messages[1].tool_calls?.map((call) => call.id),
      ["call-completed"],
    );
    assert.equal(assistantMessage.content, "Maximum iterations reached.");
  });

  it("fails the final round when a provider suppresses a prefixed tool call", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    const originalAddon = (globalThis as { addon?: unknown }).addon;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    (globalThis as { addon?: unknown }).addon = {
      data: {
        locale: {
          current: {
            formatMessagesSync: (requests: Array<{ id: string }>) => {
              assert.equal(
                requests[0]?.id,
                "paperchat-chat-max-planning-iterations-reached",
              );
              return [
                { value: "抱歉，我未能在允许的最大规划轮次内完成此请求。" },
              ];
            },
          },
        },
      },
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
        `Let me inspect that.\n\n[抱歉，我未能在允许的最大规划轮次内完成此请求。](${AGENT_MAX_PLANNING_ITERATIONS_SETTINGS_HREF})`,
      );
      assert.equal(persistedContent.at(-1), assistantMessage.content);
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
      (globalThis as { addon?: unknown }).addon = originalAddon;
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

  it("reuses a completed request_user_input result when resuming a failed turn", function () {
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
      id: "assistant-user-input-recovery",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    const previousCall: ToolCall = {
      id: "ask-previous",
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
    session.toolExecutionState = {
      turnStartedAt: 1,
      updatedAt: 2,
      results: [
        {
          toolCall: previousCall,
          status: "completed",
          content: '{"scope":"Methods"}',
        },
      ],
    };

    const entries = runtime.createRuntimeToolIterationEntries(
      session,
      assistantMessage,
      [{ ...previousCall, id: "ask-replayed" }],
      {
        maxWebSearchCallsPerTurn: 8,
        maxFullTextCallsPerTurn: 3,
      },
      undefined,
      true,
    );

    assert.equal(entries[0].kind, "reused");
    assert.equal(entries[0].results[0].toolCall.id, "ask-replayed");
    assert.equal(entries[0].results[0].content, '{"scope":"Methods"}');
    assert.isUndefined(session.userInputRequestState);
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
