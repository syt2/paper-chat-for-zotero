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
import type {
  ToolCall,
  ToolDefinition,
  ToolExecutionResult,
} from "../src/types/tool";
import { createPdfPassageEvidenceRecord } from "../src/modules/chat/evidence/index.ts";
import { AGENT_MAX_PLANNING_ITERATIONS_SETTINGS_HREF } from "../src/utils/internalLinks.ts";
import {
  createPendingSearchScopeTools,
  filterSearchToolsForScope,
} from "../src/modules/chat/agent-runtime/SearchScopeGate.ts";

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

function createToolDefinition(name: string): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: `${name} test tool`,
      parameters: { type: "object", properties: {} },
    },
  };
}

describe("agent runtime plan semantics", function () {
  it("allows a scholarly query to fall back once through the local web tool", async function () {
    const { applyToolBudgetPolicy, createToolBudgetState } =
      await import("../src/modules/chat/tool-budget/ToolBudgetPolicy.ts");
    const query = "PaperChat nonexistent scholarly test 987654321";
    const previousResults: ToolExecutionResult[] = [
      {
        toolCall: {
          id: "scholarly-first",
          type: "function",
          function: {
            name: "search_scholarly_sources",
            arguments: JSON.stringify({ query }),
          },
        },
        args: { query },
        status: "failed",
        content: [
          "Error: No scholarly results found.",
          "Category: not_found",
          "Retryable: no",
        ].join("\n"),
      },
    ];
    const state = createToolBudgetState(previousResults);
    const firstWebFallback: ToolCall = {
      id: "web-fallback",
      type: "function",
      function: {
        name: "web_search",
        arguments: JSON.stringify({ query }),
      },
    };
    const limits = {
      maxFullTextCallsPerTurn: 1,
      maxWebSearchCallsPerTurn: 2,
    };

    assert.isNull(applyToolBudgetPolicy(firstWebFallback, state, limits));

    const repeatedWebFallback = applyToolBudgetPolicy(
      { ...firstWebFallback, id: "web-fallback-repeat" },
      state,
      limits,
    );
    assert.equal(repeatedWebFallback?.status, "failed");
    assert.include(repeatedWebFallback?.content || "", "budget_exhausted");
  });

  it("opens web fallback only after the model completes the required scholarly attempt", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-search-scope-gate",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const allTools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Hosted web search",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "search_scholarly_sources",
          description: "Local scholarly search",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "search_items",
          description: "Search Zotero",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const tools = createPendingSearchScopeTools(allTools);
    const receivedToolNames: string[][] = [];
    const executedToolNames: string[] = [];
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
        formatToolCallCard: () => "",
        generateId: (() => {
          let id = 0;
          return () => `scope-generated-${++id}`;
        })(),
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async (requests: any[]) => {
          executedToolNames.push(
            ...requests.map(
              (request) => request.toolCall.function.name as string,
            ),
          );
          return requests.map((request) => ({
            toolCall: request.toolCall,
            status: "failed",
            content: [
              "Error: No scholarly results found.",
              "Category: not_found",
              "Retryable: no",
            ].join("\n"),
          }));
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 2;
    const provider = {
      config: { id: "paperchat", type: "paperchat", defaultModel: "gpt" },
      chatCompletionWithTools: async (
        _messages: ChatMessage[],
        roundTools: ToolDefinition[],
      ) => {
        providerCalls++;
        receivedToolNames.push(roundTools.map((tool) => tool.function.name));
        if (providerCalls === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "scope-call",
                type: "function" as const,
                function: {
                  name: "select_search_scope",
                  arguments: JSON.stringify({
                    scope: "scholarly_then_web",
                    reason:
                      "The user requested Scholar first and ordinary web as fallback.",
                  }),
                },
              },
            ],
          };
        }
        if (providerCalls === 2) {
          return {
            content: "",
            toolCalls: [
              {
                id: "scholarly-call",
                type: "function" as const,
                function: {
                  name: "search_scholarly_sources",
                  arguments: JSON.stringify({ query: "related DOI papers" }),
                },
              },
            ],
          };
        }
        return { content: "final answer" };
      },
    };

    try {
      await runtime.executeNonStreamingToolLoop({
        provider,
        currentMessages: session.messages,
        assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools,
        sendingSession: session,
        searchScopeGate: {
          onScopeSelected: (scope) => {
            const nextTools = filterSearchToolsForScope({
              tools: allTools,
              supportsHostedWebSearch: true,
              scope,
            });
            tools.splice(0, tools.length, ...nextTools);
          },
        },
      });

      assert.deepEqual(receivedToolNames[0], [
        "search_items",
        "select_search_scope",
      ]);
      assert.deepEqual(receivedToolNames[1], [
        "search_scholarly_sources",
        "search_items",
      ]);
      assert.deepEqual(receivedToolNames[2], [
        "web_search",
        "search_scholarly_sources",
        "search_items",
      ]);
      assert.deepEqual(executedToolNames, ["search_scholarly_sources"]);
      assert.equal(providerCalls, 3);
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("does not restore a scope result after cancellation during its calling checkpoint", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    let tracked = true;
    let providerCalls = 0;
    let scopeSelections = 0;
    let sessionMetaUpdates = 0;
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-cancelled-search-scope",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const tools = createPendingSearchScopeTools([
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Hosted web search",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "search_scholarly_sources",
          description: "Local scholarly search",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => {
          tracked = false;
          session.toolExecutionState = undefined;
          session.executionPlan = undefined;
          assistantMessage.content = "";
        },
        updateSessionMeta: async () => {
          sessionMetaUpdates += 1;
        },
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => tracked,
        formatToolCallCard: () => "scope calling",
        generateId: () => "cancelled-scope-generated",
      } as any,
      {
        createExecutionBatches: () => [],
        executeBatch: async () => [],
      },
    ) as any;
    runtime.getMaxIterations = () => 3;

    try {
      await runtime.executeNonStreamingToolLoop({
        provider: {
          config: { id: "paperchat", type: "paperchat", defaultModel: "gpt" },
          supportsHostedWebSearch: () => true,
          chatCompletionWithTools: async () => {
            providerCalls += 1;
            return {
              content: "",
              toolCalls: [
                {
                  id: "cancelled-scope-call",
                  type: "function" as const,
                  function: {
                    name: "select_search_scope",
                    arguments: JSON.stringify({
                      scope: "web_allowed",
                      reason: "The user requested ordinary web search.",
                    }),
                  },
                },
              ],
            };
          },
        },
        currentMessages: session.messages,
        assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools,
        sendingSession: session,
        searchScopeGate: {
          onScopeSelected: () => {
            scopeSelections += 1;
          },
        },
      });

      assert.equal(providerCalls, 1);
      assert.equal(scopeSelections, 0);
      assert.equal(sessionMetaUpdates, 1);
      assert.isUndefined(session.toolExecutionState);
      assert.equal(assistantMessage.content, "");
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("streams gate then scholarly search before exposing hosted web fallback", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-stream-search-scope-fallback",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const allTools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Hosted web search",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "search_scholarly_sources",
          description: "Local scholarly search",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "search_items",
          description: "Search Zotero",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const tools = createPendingSearchScopeTools(allTools);
    const receivedToolNames: string[][] = [];
    const executedToolNames: string[] = [];
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
        formatToolCallCard: () => "",
        generateId: (() => {
          let id = 0;
          return () => `stream-search-scope-${++id}`;
        })(),
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async (requests: any[]) => {
          executedToolNames.push(
            ...requests.map(
              (request) => request.toolCall.function.name as string,
            ),
          );
          return requests.map((request) => ({
            toolCall: request.toolCall,
            status: "failed",
            content: [
              "Error: No scholarly results found.",
              "Category: not_found",
              "Retryable: no",
            ].join("\n"),
          }));
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 2;

    try {
      await runtime.executeStreamingToolLoop({
        provider: {
          config: {
            id: "paperchat",
            type: "paperchat",
            defaultModel: "gpt",
          },
          chatCompletionWithTools: async () => ({ content: "unused" }),
          streamChatCompletionWithTools: async (
            _messages: ChatMessage[],
            roundTools: ToolDefinition[],
            callbacks: any,
          ) => {
            providerCalls += 1;
            receivedToolNames.push(
              roundTools.map((tool) => tool.function.name),
            );
            if (providerCalls === 1) {
              const toolCall: ToolCall = {
                id: "stream-fallback-scope-call",
                type: "function",
                function: {
                  name: "select_search_scope",
                  arguments: JSON.stringify({
                    scope: "scholarly_then_web",
                    reason:
                      "The user requested scholarly search before web fallback.",
                  }),
                },
              };
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
              const toolCall: ToolCall = {
                id: "stream-fallback-scholarly-call",
                type: "function",
                function: {
                  name: "search_scholarly_sources",
                  arguments: JSON.stringify({ query: "missing paper" }),
                },
              };
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
            callbacks.onHostedWebSearchStatus({
              index: 0,
              id: "stream-fallback-web-search",
              status: "completed",
              actionType: "search",
              queries: ["missing paper"],
              sources: [
                {
                  title: "Fallback result",
                  url: "https://example.test/fallback",
                },
              ],
            });
            callbacks.onTextDelta("Answer from fallback web");
            callbacks.onComplete({
              content: "Answer from fallback web",
              stopReason: "end_turn",
            });
          },
        },
        currentMessages: session.messages,
        assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools,
        sendingSession: session,
        searchScopeGate: {
          onScopeSelected: (scope) => {
            const nextTools = filterSearchToolsForScope({
              tools: allTools,
              supportsHostedWebSearch: true,
              scope,
            });
            tools.splice(0, tools.length, ...nextTools);
          },
        },
      });

      assert.deepEqual(receivedToolNames, [
        ["search_items", "select_search_scope"],
        ["search_scholarly_sources", "search_items"],
        ["web_search", "search_scholarly_sources", "search_items"],
      ]);
      assert.deepEqual(executedToolNames, ["search_scholarly_sources"]);
      assert.equal(providerCalls, 3);
      assert.equal(assistantMessage.content, "Answer from fallback web");
      assert.include(
        session.toolExecutionState?.results.map(
          (result) => result.toolCall.function.name,
        ) || [],
        "web_search",
      );
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("keeps the unlocked web fallback across a provider retry without rerunning scholarly search", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-search-scope-retry",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const allTools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Hosted web search",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "search_scholarly_sources",
          description: "Local scholarly search",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const tools = createPendingSearchScopeTools(allTools);
    const receivedToolNames: string[][] = [];
    let providerCalls = 0;
    let providerRetries = 0;
    let selectedScopeCallbacks = 0;
    let scholarlyExecutions = 0;
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: (() => {
          let id = 0;
          return () => `scope-retry-${++id}`;
        })(),
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async (requests: any[]) => {
          scholarlyExecutions += requests.length;
          return requests.map((request) => ({
            toolCall: request.toolCall,
            status: "completed",
            content: "scholarly result",
          }));
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 2;

    try {
      await runtime.executeNonStreamingToolLoop({
        provider: {
          config: { id: "paperchat", type: "paperchat", defaultModel: "gpt" },
          chatCompletionWithTools: async (
            _messages: ChatMessage[],
            roundTools: ToolDefinition[],
          ) => {
            providerCalls += 1;
            receivedToolNames.push(
              roundTools.map((tool) => tool.function.name),
            );
            if (providerCalls === 1) {
              return {
                content: "",
                toolCalls: [
                  {
                    id: "scope-retry-call",
                    type: "function" as const,
                    function: {
                      name: "select_search_scope",
                      arguments: JSON.stringify({
                        scope: "scholarly_then_web",
                        reason:
                          "The user requested scholarly search before web fallback.",
                      }),
                    },
                  },
                ],
              };
            }
            if (providerCalls === 2) {
              return {
                content: "",
                toolCalls: [
                  {
                    id: "scope-retry-scholarly-call",
                    type: "function" as const,
                    function: {
                      name: "search_scholarly_sources",
                      arguments: JSON.stringify({ query: "missing paper" }),
                    },
                  },
                ],
              };
            }
            if (providerCalls === 3) {
              throw new Error("temporary upstream failure");
            }
            return { content: "final answer" };
          },
        },
        currentMessages: session.messages,
        assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools,
        sendingSession: session,
        executeProviderRequest: async (operation) => {
          try {
            return await operation();
          } catch {
            providerRetries += 1;
            return operation();
          }
        },
        searchScopeGate: {
          onScopeSelected: (scope) => {
            selectedScopeCallbacks += 1;
            const nextTools = filterSearchToolsForScope({
              tools: allTools,
              supportsHostedWebSearch: true,
              scope,
            });
            tools.splice(0, tools.length, ...nextTools);
          },
        },
      });

      assert.deepEqual(receivedToolNames, [
        ["select_search_scope"],
        ["search_scholarly_sources"],
        ["web_search", "search_scholarly_sources"],
        ["web_search", "search_scholarly_sources"],
      ]);
      assert.equal(providerRetries, 1);
      assert.equal(selectedScopeCallbacks, 2);
      assert.equal(scholarlyExecutions, 1);
      assert.lengthOf(
        session.toolExecutionState?.results.filter(
          (result) =>
            result.toolCall.function.name === "select_search_scope" &&
            result.status === "completed",
        ) || [],
        1,
      );
      assert.lengthOf(
        session.toolExecutionState?.results.filter(
          (result) =>
            result.toolCall.function.name === "search_scholarly_sources",
        ) || [],
        1,
      );
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("refreshes exhausted-budget tools when rerouting across hosted-search capabilities", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const allTools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Web search",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "search_scholarly_sources",
          description: "Scholarly search",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "search_items",
          description: "Zotero search",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    const runTransition = async (initialHosted: boolean) => {
      let hosted = initialHosted;
      let providerCalls = 0;
      const receivedToolNames: string[][] = [];
      const session = createSession();
      session.toolExecutionState = {
        turnStartedAt: 1,
        updatedAt: 2,
        results: [
          {
            toolCall: {
              id: `scope-${initialHosted}`,
              type: "function",
              function: {
                name: "select_search_scope",
                arguments: JSON.stringify({
                  scope: "web_allowed",
                  reason: "Ordinary web evidence is allowed.",
                }),
              },
            },
            args: {
              scope: "web_allowed",
              reason: "Ordinary web evidence is allowed.",
            },
            status: "completed",
            content: "scope selected",
          },
          {
            toolCall: {
              id: `local-budget-${initialHosted}`,
              type: "function",
              function: {
                name: "search_scholarly_sources",
                arguments: JSON.stringify({ query: "local evidence" }),
              },
            },
            args: { query: "local evidence" },
            status: "completed",
            content: "local result",
          },
        ],
      };
      const assistantMessage: ChatMessage = {
        id: `assistant-capability-budget-${initialHosted}`,
        role: "assistant",
        content: "",
        timestamp: 3,
      };
      session.messages.push(assistantMessage);
      const tools = filterSearchToolsForScope({
        tools: allTools,
        supportsHostedWebSearch: hosted,
        scope: "web_allowed",
      });
      const provider = {
        config: { id: "paperchat", type: "paperchat", defaultModel: "gpt" },
        supportsHostedWebSearch: () => hosted,
        chatCompletionWithTools: async (
          _messages: ChatMessage[],
          roundTools: ToolDefinition[],
        ) => {
          providerCalls += 1;
          receivedToolNames.push(roundTools.map((tool) => tool.function.name));
          if (providerCalls === 1) {
            throw new Error("reroute this model");
          }
          return { content: "final answer" };
        },
      };
      const runtime = new AgentRuntime(
        {
          updateMessageContent: async () => undefined,
          updateSessionMeta: async () => undefined,
          saveSession: async () => undefined,
        } as any,
        {
          isSessionActive: () => false,
          isSessionTracked: () => true,
          formatToolCallCard: () => "",
          generateId: () => `capability-budget-${initialHosted}`,
        } as any,
        {
          createExecutionBatches: () => [],
          executeBatch: async () => [],
        },
      ) as any;
      runtime.getMaxIterations = () => 3;

      await runtime.executeNonStreamingToolLoop({
        provider,
        currentMessages: session.messages,
        assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools,
        sendingSession: session,
        preserveToolExecutionState: true,
        executeProviderRequest: async (operation, onProviderRerouted) => {
          try {
            return await operation();
          } catch {
            hosted = !hosted;
            const reroutedTools = filterSearchToolsForScope({
              tools: allTools,
              supportsHostedWebSearch: hosted,
              scope: "web_allowed",
            });
            tools.splice(0, tools.length, ...reroutedTools);
            onProviderRerouted?.();
            return operation();
          }
        },
        searchScopeGate: {
          onScopeSelected: (scope) => {
            const scopedTools = filterSearchToolsForScope({
              tools: allTools,
              supportsHostedWebSearch: hosted,
              scope,
            });
            tools.splice(0, tools.length, ...scopedTools);
          },
        },
      });

      return receivedToolNames;
    };

    try {
      assert.deepEqual(await runTransition(false), [
        ["search_items"],
        ["web_search", "search_items"],
      ]);
      assert.deepEqual(await runTransition(true), [
        ["web_search", "search_items"],
        ["search_items"],
      ]);
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("restores an unlocked scholarly-then-web fallback after a failed turn", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    session.toolExecutionState = {
      turnStartedAt: 1,
      updatedAt: 2,
      results: [
        {
          toolCall: {
            id: "restored-fallback-scope",
            type: "function",
            function: {
              name: "select_search_scope",
              arguments: JSON.stringify({
                scope: "scholarly_then_web",
                reason: "Scholar first, then ordinary web fallback.",
              }),
            },
          },
          args: {
            scope: "scholarly_then_web",
            reason: "Scholar first, then ordinary web fallback.",
          },
          status: "completed",
          content: "scope selected",
        },
        {
          toolCall: {
            id: "restored-fallback-scholarly",
            type: "function",
            function: {
              name: "search_scholarly_sources",
              arguments: JSON.stringify({ query: "missing paper" }),
            },
          },
          args: { query: "missing paper" },
          status: "failed",
          content: [
            "Error: No scholarly results found.",
            "Category: not_found",
            "Retryable: no",
          ].join("\n"),
        },
      ],
    };
    const assistantMessage: ChatMessage = {
      id: "assistant-restored-web-fallback",
      role: "assistant",
      content: "",
      timestamp: 3,
    };
    session.messages.push(assistantMessage);
    const allTools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Hosted web search",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "search_scholarly_sources",
          description: "Local scholarly search",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const tools = createPendingSearchScopeTools(allTools);
    const receivedToolNames: string[][] = [];
    const restoredScopes: string[] = [];
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => "restored-fallback-generated",
      } as any,
      {
        createExecutionBatches: () => [],
        executeBatch: async () => {
          throw new Error("The completed scholarly search must not rerun");
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 2;

    try {
      await runtime.executeNonStreamingToolLoop({
        provider: {
          config: { id: "paperchat", type: "paperchat", defaultModel: "gpt" },
          chatCompletionWithTools: async (
            _messages: ChatMessage[],
            roundTools: ToolDefinition[],
          ) => {
            receivedToolNames.push(
              roundTools.map((tool) => tool.function.name),
            );
            return { content: "fallback answer" };
          },
        },
        currentMessages: session.messages,
        assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools,
        sendingSession: session,
        preserveToolExecutionState: true,
        searchScopeGate: {
          onScopeSelected: (scope) => {
            restoredScopes.push(scope);
            const nextTools = filterSearchToolsForScope({
              tools: allTools,
              supportsHostedWebSearch: true,
              scope,
            });
            tools.splice(0, tools.length, ...nextTools);
          },
        },
      });

      assert.deepEqual(restoredScopes, ["web_allowed"]);
      assert.deepEqual(receivedToolNames, [
        ["web_search", "search_scholarly_sources"],
      ]);
      assert.lengthOf(session.toolExecutionState.results, 2);
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("blocks a hallucinated search tool that was not exposed in the round", function () {
    const runtime = new AgentRuntime({} as any, {} as any, {
      createExecutionBatches: () => [],
      executeBatch: async () => [],
    }) as any;
    const toolCall: ToolCall = {
      id: "hidden-web-search",
      type: "function",
      function: {
        name: "web_search",
        arguments: JSON.stringify({ query: "should not run" }),
      },
    };
    const entries = runtime.createRuntimeToolIterationEntries(
      createSession(),
      { id: "assistant", role: "assistant", content: "", timestamp: 2 },
      [toolCall],
      { maxFullTextCallsPerTurn: 1, maxWebSearchCallsPerTurn: 2 },
      undefined,
      false,
      null,
      new Set(["search_scholarly_sources"]),
    );

    assert.equal(entries[0].kind, "synthetic");
    assert.equal(entries[0].results[0].status, "denied");
    assert.include(entries[0].results[0].content, "not available");
  });

  it("blocks a hallucinated non-search tool that was not exposed in the round", function () {
    const runtime = new AgentRuntime({} as any, {} as any, {
      createExecutionBatches: () => [],
      executeBatch: async () => [],
    }) as any;
    const toolCall: ToolCall = {
      id: "hidden-append-note",
      type: "function",
      function: {
        name: "append_to_note",
        arguments: JSON.stringify({ content: "should not run" }),
      },
    };
    const entries = runtime.createRuntimeToolIterationEntries(
      createSession(),
      { id: "assistant", role: "assistant", content: "", timestamp: 2 },
      [toolCall],
      { maxFullTextCallsPerTurn: 1, maxWebSearchCallsPerTurn: 2 },
      undefined,
      false,
      null,
      new Set(["create_note"]),
    );

    assert.equal(entries[0].kind, "synthetic");
    assert.equal(entries[0].results[0].status, "denied");
    assert.include(entries[0].results[0].content, "not available");
  });

  it("does not persist an unavailable tool call in the api-only transcript", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-unavailable-tool",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const unavailableToolCall: ToolCall = {
      id: "call-unavailable-append",
      type: "function",
      function: {
        name: "append_to_note",
        arguments: JSON.stringify({ content: "must not run" }),
      },
    };
    let providerCalls = 0;
    let schedulerCalls = 0;
    let executorCalls = 0;
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
          return () => `unavailable-${++id}`;
        })(),
      } as any,
      {
        createExecutionBatches: () => {
          schedulerCalls += 1;
          return [];
        },
        executeBatch: async () => {
          executorCalls += 1;
          return [];
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 2;
    const provider = {
      config: {
        id: "anthropic",
        type: "anthropic",
        defaultModel: "claude-test",
      },
      chatCompletionWithTools: async (messages: ChatMessage[]) => {
        providerCalls += 1;
        requestSnapshots.push(messages.map((message) => ({ ...message })));
        return providerCalls === 1
          ? { content: "", toolCalls: [unavailableToolCall] }
          : { content: "continued safely" };
      },
    };

    try {
      await runtime.executeNonStreamingToolLoop({
        provider,
        currentMessages: [session.messages[0]],
        assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: [createToolDefinition("create_note")],
        sendingSession: session,
      });

      assert.equal(providerCalls, 2);
      assert.equal(schedulerCalls, 0);
      assert.equal(executorCalls, 0);
      assert.isTrue(
        requestSnapshots[1].some(
          (message) =>
            message.role === "assistant" &&
            message.tool_calls?.[0]?.id === unavailableToolCall.id,
        ),
      );
      assert.isTrue(
        requestSnapshots[1].some(
          (message) =>
            message.role === "tool" &&
            message.tool_call_id === unavailableToolCall.id,
        ),
      );
      assert.isFalse(
        session.messages.some(
          (message) =>
            message.apiOnly &&
            (message.tool_call_id === unavailableToolCall.id ||
              message.tool_calls?.some(
                (toolCall) => toolCall.id === unavailableToolCall.id,
              )),
        ),
      );
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("adds a planning iteration only when a pending search gate is selected", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };

    try {
      for (const restoredScope of [false, true]) {
        const session = createSession();
        if (restoredScope) {
          session.toolExecutionState = {
            turnStartedAt: 1,
            updatedAt: 1,
            results: [
              {
                toolCall: {
                  id: "restored-scope",
                  type: "function",
                  function: {
                    name: "select_search_scope",
                    arguments: JSON.stringify({
                      scope: "scholarly_only",
                      reason: "restored",
                    }),
                  },
                },
                args: { scope: "scholarly_only", reason: "restored" },
                status: "completed",
                content: "scope restored",
              },
            ],
          };
        }
        const assistantMessage: ChatMessage = {
          id: `assistant-unused-search-gate-${restoredScope}`,
          role: "assistant",
          content: "",
          timestamp: 2,
        };
        session.messages.push(assistantMessage);
        let providerCalls = 0;
        let executedCalls = 0;
        let generatedId = 0;
        const runtime = new AgentRuntime(
          {
            updateMessageContent: async () => undefined,
            updateSessionMeta: async () => undefined,
            saveSession: async () => undefined,
          } as any,
          {
            isSessionActive: () => false,
            isSessionTracked: () => true,
            formatToolCallCard: () => "",
            generateId: () => `unused-gate-${++generatedId}`,
          } as any,
          {
            createExecutionBatches: (requests: any[]) => [requests],
            executeBatch: async (requests: any[]) => {
              executedCalls += requests.length;
              return requests.map((request) => ({
                toolCall: request.toolCall,
                status: "completed",
                content: "local result",
              }));
            },
          },
        ) as any;
        runtime.getMaxIterations = () => 2;

        await runtime.executeNonStreamingToolLoop({
          provider: {
            config: { id: "provider", type: "openai", defaultModel: "model" },
            chatCompletionWithTools: async (
              _messages: ChatMessage[],
              _tools: ToolDefinition[],
              _signal: AbortSignal | undefined,
              options: { toolChoice?: string } | undefined,
            ) => {
              providerCalls += 1;
              if (options?.toolChoice === "none") {
                return { content: "final answer" };
              }
              return {
                content: "",
                toolCalls: [
                  {
                    id: `local-call-${providerCalls}`,
                    type: "function" as const,
                    function: { name: "search_items", arguments: "{}" },
                  },
                ],
              };
            },
          },
          currentMessages: session.messages,
          assistantMessage,
          pdfWasAttached: false,
          summaryTriggered: false,
          tools: [
            {
              type: "function",
              function: {
                name: "search_items",
                description: "Search Zotero",
                parameters: { type: "object", properties: {} },
              },
            },
            ...createPendingSearchScopeTools([]),
          ],
          sendingSession: session,
          preserveToolExecutionState: restoredScope,
          searchScopeGate: { onScopeSelected: () => undefined },
        });

        assert.equal(providerCalls, 2);
        assert.equal(executedCalls, 1);
      }
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

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
          tools: [createToolDefinition("create_note")],
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

  it("renders hosted Web Search without local execution and records one hosted result", async function () {
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
        formatToolCallCard: (
          name: string,
          _args: string,
          status: string,
          resultPreview?: string,
          options?: {
            expandStateId?: string;
            resultPreviewMaxLength?: number;
            showResultWhileCalling?: boolean;
          },
        ) =>
          `<tool name="${name}" status="${status}" details="${resultPreview || ""}" expand-key="${options?.expandStateId || ""}" show-while-calling="${String(options?.showResultWhileCalling)}" />`,
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
          actionType: "search",
          queries: ["Zotero AI tools"],
          sources: [
            {
              title: "PaperChat",
              url: "https://example.test/paperchat",
            },
          ],
        });
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
        '<tool name="web_search" status="calling" details="query: Zotero AI tools\naction: search\nsources:\n- PaperChat — https://example.test/paperchat" expand-key="hosted-web-search:ws_123" show-while-calling="true" />',
      );
      assert.include(
        streamingUpdates,
        '<tool name="web_search" status="completed" details="query: Zotero AI tools\naction: search\nsources:\n- PaperChat — https://example.test/paperchat" expand-key="hosted-web-search:ws_123" show-while-calling="true" />',
      );
      assert.include(
        streamingUpdates,
        '<tool name="web_search" status="completed" details="query: Zotero AI tools\naction: search\nsources:\n- PaperChat — https://example.test/paperchat" expand-key="hosted-web-search:ws_123" show-while-calling="true" />Answer from web',
      );
      assert.equal(toolExecutions, 0);
      assert.equal(
        assistantMessage.content,
        '<tool name="web_search" status="completed" details="query: Zotero AI tools\naction: search\nsources:\n- PaperChat — https://example.test/paperchat" expand-key="hosted-web-search:ws_123" show-while-calling="true" />Answer from web',
      );
      assert.isUndefined(assistantMessage.tool_calls);
      assert.include(assistantMessage.content, "web_search");
      assert.isFalse(session.messages.some((message) => message.apiOnly));
      assert.lengthOf(session.toolExecutionState?.results || [], 1);
      assert.equal(
        session.toolExecutionState?.results[0]?.toolCall.id,
        "hosted-web-search:ws_123",
      );
      assert.equal(
        session.toolExecutionState?.results[0]?.toolCall.function.name,
        "web_search",
      );
      assert.deepEqual(session.toolExecutionState?.results[0]?.args, {
        query: "Zotero AI tools",
      });
      assert.deepInclude(session.toolExecutionState?.results[0]?.references, {
        type: "web",
        url: "https://example.test/paperchat",
      });
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("persists hosted Web Search cards for non-streaming responses", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-hosted-web-search-non-streaming",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: (
          name: string,
          _args: string,
          status: string,
          details?: string,
        ) =>
          `<tool name="${name}" status="${status}" details="${details || ""}" />`,
        generateId: () => "generated-hosted-web-search-non-streaming",
      } as any,
    ) as any;
    runtime.getMaxIterations = () => 2;

    await runtime.executeNonStreamingToolLoop({
      provider: {
        config: {
          id: "paperchat",
          type: "paperchat",
          defaultModel: "test-model",
        },
        chatCompletionWithTools: async () => ({
          content: "Answer from web",
          hostedWebSearches: [
            {
              index: 0,
              id: "ws_non_streaming",
              status: "completed",
              actionType: "search",
              queries: ["no-source query"],
              sources: [],
            },
          ],
        }),
      } as any,
      currentMessages: session.messages,
      assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      tools: [],
      sendingSession: session,
    });
    (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;

    assert.equal(
      assistantMessage.content,
      '<tool name="web_search" status="completed" details="query: no-source query\naction: search" />Answer from web',
    );
  });

  it("strips persisted hosted Web Search cards from replayed model context", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    session.messages.push(
      {
        id: "assistant-previous-hosted-search",
        role: "assistant",
        content:
          '\n<tool-call status="completed" expand-key="hosted-web-search:ws_previous">\n<tool-name>✓ web_search</tool-name>\n<tool-result>query: previous search</tool-result>\n</tool-call>\nPrevious answer',
        timestamp: 2,
      },
      {
        id: "user-2",
        role: "user",
        content: "Follow up",
        timestamp: 3,
      },
    );
    const assistantMessage: ChatMessage = {
      id: "assistant-replay-check",
      role: "assistant",
      content: "",
      timestamp: 4,
    };
    session.messages.push(assistantMessage);
    const currentMessages = session.messages.map((message) => ({ ...message }));
    let replayedPreviousAnswer = "";
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => "generated-replay-check",
      } as any,
    ) as any;
    runtime.getMaxIterations = () => 2;

    await runtime.executeNonStreamingToolLoop({
      provider: {
        config: {
          id: "paperchat",
          type: "paperchat",
          defaultModel: "test-model",
        },
        chatCompletionWithTools: async (messages: ChatMessage[]) => {
          replayedPreviousAnswer =
            messages.find(
              (message) => message.id === "assistant-previous-hosted-search",
            )?.content || "";
          return { content: "Follow-up answer" };
        },
      } as any,
      currentMessages,
      assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      tools: [],
      sendingSession: session,
    });
    (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;

    assert.equal(replayedPreviousAnswer, "Previous answer");
    assert.notInclude(replayedPreviousAnswer, "web_search");
  });

  it("records a hosted search that started before the stream failed", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-hosted-search-error",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: (name: string, _args: string, status: string) =>
          `<tool name="${name}" status="${status}" />`,
        generateId: () => "generated-hosted-search-error",
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
        callbacks.onHostedWebSearchStatus({
          index: 0,
          id: "ws_failed_stream",
          status: "searching",
          queries: ["paid hosted query"],
        });
        callbacks.onError(new Error("API Error: 503 Service Unavailable"));
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
        });
      } catch (error) {
        finalError = error;
      }

      assert.instanceOf(finalError, Error);
      assert.lengthOf(session.toolExecutionState?.results || [], 1);
      assert.equal(
        session.toolExecutionState?.results[0]?.toolCall.id,
        "hosted-web-search:ws_failed_stream",
      );
      assert.equal(session.toolExecutionState?.results[0]?.status, "failed");
      assert.deepEqual(session.toolExecutionState?.results[0]?.args, {
        query: "paid hosted query",
      });
      assert.include(
        assistantMessage.content,
        '<tool name="web_search" status="error" />',
      );
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("does not restore a hosted-search error card after the turn is cancelled", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    let tracked = true;
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-hosted-search-cancelled",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => tracked,
        formatToolCallCard: (name: string, _args: string, status: string) =>
          `<tool name="${name}" status="${status}" />`,
        generateId: () => "generated-hosted-search-cancelled",
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async () => [],
      },
    ) as any;
    runtime.getMaxIterations = () => 2;
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";

    try {
      await runtime.executeStreamingToolLoop({
        provider: {
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
              id: "ws_cancelled_stream",
              status: "searching",
              queries: ["cancelled hosted query"],
            });
            callbacks.onError(abortError);
            tracked = false;
            session.toolExecutionState = undefined;
            assistantMessage.content = "";
          },
        } as any,
        currentMessages: session.messages,
        assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: [],
        sendingSession: session,
      });

      assert.equal(assistantMessage.content, "");
      assert.isUndefined(session.toolExecutionState);
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("keeps hosted web_search available after the local search budget is exhausted", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-shared-search-budget",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const receivedToolNames: string[][] = [];
    let providerCalls = 0;
    let localExecutions = 0;
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => true,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => `generated-${Date.now()}`,
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async (requests: any[]) => {
          localExecutions += 1;
          return requests.map((request) => ({
            toolCall: request.toolCall,
            args: request.args,
            status: "completed",
            content: "Scholarly search completed.",
          }));
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 3;
    const scholarlyCall: ToolCall = {
      id: "scholarly-after-hosted",
      type: "function",
      function: {
        name: "search_scholarly_sources",
        arguments: JSON.stringify({ query: "same evidence" }),
      },
    };
    const provider = {
      config: {
        id: "paperchat",
        type: "paperchat",
        defaultModel: "test-model",
      },
      supportsHostedWebSearch: () => true,
      chatCompletionWithTools: async () => ({ content: "unused" }),
      streamChatCompletionWithTools: async (
        _messages: ChatMessage[],
        tools: Array<{ function: { name: string } }>,
        callbacks: any,
        _signal: AbortSignal | undefined,
        _options: unknown,
      ) => {
        providerCalls += 1;
        receivedToolNames.push(tools.map((tool) => tool.function.name));
        if (providerCalls === 1) {
          callbacks.onHostedWebSearchStatus({
            index: 0,
            id: "ws-budget-1",
            status: "completed",
            queries: ["hosted evidence"],
          });
          callbacks.onComplete({
            content: "",
            toolCalls: [scholarlyCall],
            stopReason: "tool_calls",
          });
          return;
        }
        callbacks.onTextDelta("final answer");
        callbacks.onComplete({
          content: "final answer",
          stopReason: "end_turn",
        });
      },
    };
    const searchTools = [
      {
        type: "function" as const,
        function: {
          name: "web_search",
          description: "Web",
          parameters: { type: "object" as const, properties: {} },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "search_scholarly_sources",
          description: "Scholarly",
          parameters: { type: "object" as const, properties: {} },
        },
      },
    ];

    try {
      await runtime.executeStreamingToolLoop({
        provider,
        currentMessages: session.messages,
        assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: searchTools,
        sendingSession: session,
      });

      assert.equal(providerCalls, 2);
      assert.deepEqual(receivedToolNames[0], [
        "web_search",
        "search_scholarly_sources",
      ]);
      assert.deepEqual(receivedToolNames[1], ["web_search"]);
      assert.equal(localExecutions, 1);
      assert.include(assistantMessage.content, "final answer");
      assert.equal(
        session.toolExecutionState?.results.filter(
          (result) => result.toolCall.id === "hosted-web-search:ws-budget-1",
        ).length,
        1,
      );
      assert.equal(
        session.toolExecutionState?.results.find(
          (result) => result.toolCall.id === "scholarly-after-hosted",
        )?.status,
        "completed",
      );
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("removes both local search tools for a non-hosted provider after local budget exhaustion", function () {
    const runtime = new AgentRuntime({} as any, {} as any, {} as any) as any;
    const session = createSession();
    session.toolExecutionState = {
      turnStartedAt: 1,
      updatedAt: 1,
      results: [
        {
          toolCall: {
            id: "local-scholarly-budget",
            type: "function",
            function: {
              name: "search_scholarly_sources",
              arguments: JSON.stringify({ query: "local evidence" }),
            },
          },
          args: { query: "local evidence" },
          status: "completed",
          content: "Local scholarly result.",
        },
      ],
    };
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "web_search",
          description: "Local web",
          parameters: { type: "object" as const, properties: {} },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "search_scholarly_sources",
          description: "Local scholarly",
          parameters: { type: "object" as const, properties: {} },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "search_items",
          description: "Zotero",
          parameters: { type: "object" as const, properties: {} },
        },
      },
    ];

    const control = runtime.createIterationControl(
      1,
      tools,
      3,
      session,
      { maxFullTextCallsPerTurn: 1, maxWebSearchCallsPerTurn: 1 },
      false,
    );

    assert.deepEqual(
      control.toolsForRound.map((tool: ToolDefinition) => tool.function.name),
      ["search_items"],
    );
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
          tools: [createToolDefinition("create_note")],
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
      content: "partial answer. ",
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
        "partial answer. continued without rewriting the note",
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
      searchScope: "web_allowed",
      searchToolMode: "split",
      runtimeLimits: {
        hardIterationLimit: 4,
        currentIteration: 2,
        remainingIterations: 3,
        forceFinalAnswer: false,
      },
      toolBudget: {
        webSearchUsed: 1,
        webSearchLimit: 2,
        webSearchRemaining: 1,
        getFullTextUsed: 0,
        getFullTextLimit: 1,
        getFullTextRemaining: 1,
      },
    });

    assert.include(stablePrompt, "=== NO PAPER SELECTED ===");
    assert.include(stablePrompt, "list_all_items");
    assert.include(stablePrompt, "=== PARALLEL TOOL CALLING ===");
    assert.notInclude(stablePrompt, "Current iteration:");
    assert.notInclude(stablePrompt, "FINAL ANSWER REQUIREMENTS");
    assert.include(runtimePrompt, "Current iteration: 2/4");
    assert.include(runtimePrompt, "FINAL ANSWER REQUIREMENTS");
    assert.include(runtimePrompt, "EXTERNAL SEARCH SCOPE");
    assert.include(runtimePrompt, "Do not call select_search_scope again");
    assert.include(runtimePrompt, "call web_search before answering");
    assert.include(runtimePrompt, "local external-search budget");
    assert.include(runtimePrompt, "vendor-hosted web_search is not counted");
  });

  it("routes hosted web and local scholarly search by evidence type", function () {
    const prompt = generatePaperContextPrompt(
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      "split",
    );

    assert.include(
      prompt,
      "For papers, authors, DOI, citations, or related work, use search_scholarly_sources before web_search",
    );
    assert.include(
      prompt,
      "For current events, news, official websites, policies, products, or real-time facts, use web_search directly",
    );
    assert.include(
      prompt,
      "Do not call both search tools for the same query initially",
    );
    assert.include(
      prompt,
      "This turn's selected scope permits ordinary web evidence",
    );
    assert.include(
      prompt,
      "call web_search before answering; do not stop after reporting the scholarly-search failure",
    );
    assert.include(
      prompt,
      "If the user requires Scholar, OpenAlex, or scholarly-only sources, do not downgrade",
    );
  });

  it("asks the model to select a per-turn search scope before searching", function () {
    const prompt = generatePaperContextPrompt(
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      "gated",
    );

    assert.include(prompt, "call select_search_scope");
    assert.include(prompt, "do not claim that external search is unavailable");
    assert.include(prompt, "permission boundary, not a search preference");
    assert.include(prompt, "choose scholarly_then_web");
    assert.include(prompt, "scholarly search is required first");
    assert.include(prompt, "previous turn's scope does not apply");
    assert.notInclude(prompt, "- web_search:");
    assert.notInclude(prompt, "- search_scholarly_sources:");
  });

  it("removes hosted web search from scholarly-only prompt guidance", function () {
    const prompt = generatePaperContextPrompt(
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      "scholarly_only",
    );

    assert.include(
      prompt,
      "this is the only external-search tool available in this turn",
    );
    assert.include(
      prompt,
      "Hosted or ordinary web search is intentionally unavailable",
    );
    assert.notInclude(prompt, "use web_search directly");
  });

  it("does not advertise external search when the user prohibited it", function () {
    const prompt = generatePaperContextPrompt(
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      "none",
    );

    assert.include(prompt, "External search is unavailable in this turn");
    assert.notInclude(prompt, "- web_search:");
    assert.notInclude(prompt, "- search_scholarly_sources:");
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
          sourceItemKeys?: string[];
        }
      | undefined;
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async (
          _sessionId: string,
          _messageId: string,
          content: string,
          _reasoning: string | undefined,
          options: {
            evidence?: (typeof record)[];
            sourceItemKeys?: string[];
          },
        ) => {
          checkpoint = {
            content,
            evidence: options.evidence,
            sourceItemKeys: options.sourceItemKeys,
          };
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
    assert.deepEqual(assistantMessage.sourceItemKeys, ["ITEM0001"]);
    assert.deepEqual(checkpoint?.evidence, [record]);
    assert.deepEqual(checkpoint?.sourceItemKeys, ["ITEM0001"]);
    assert.equal(checkpoint?.content, assistantMessage.content);
  });

  it("merges the bound paper with trusted tool sources on the AI reply", async function () {
    let checkpointSources: string[] | undefined;
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async (
          _sessionId: string,
          _messageId: string,
          _content: string,
          _reasoning: string | undefined,
          options: { sourceItemKeys?: string[] },
        ) => {
          checkpointSources = options.sourceItemKeys;
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
      id: "assistant-sources",
      role: "assistant",
      content: "",
      sourceItemKeys: ["ITEM0001"],
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
            id: "tool-paper-b",
            type: "function",
            function: {
              name: "get_item_metadata",
              arguments: '{"itemKey":"PAPER002"}',
            },
          },
          status: "completed",
          content: "Paper B metadata",
          references: [{ type: "item", key: "PAPER002" }],
        },
      ],
    };

    await runtime.finalizeCompletedTurn({
      sendingSession: session,
      currentMessages: session.messages,
      assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      accumulatedDisplay: "Comparison complete.",
      iteration: 2,
    });

    assert.deepEqual(assistantMessage.sourceItemKeys, ["ITEM0001", "PAPER002"]);
    assert.deepEqual(checkpointSources, ["ITEM0001", "PAPER002"]);
  });
});
