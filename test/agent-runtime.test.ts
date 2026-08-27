import { assert } from "chai";
import { createPresentationLaunchAuthorization } from "../src/modules/presentation/PresentationLaunchAuthorization.ts";
import {
  AgentRuntime,
  retainCompletedApiOnlyModelContextMessagesForTurn,
} from "../src/modules/chat/agent-runtime/AgentRuntime.ts";
import { ExecutionPlanManager } from "../src/modules/chat/agent-runtime/ExecutionPlanManager.ts";
import {
  generateAgentRuntimeContextPrompt,
  generatePaperContextPrompt,
} from "../src/modules/chat/pdf-tools/promptGenerator.ts";
import type {
  AgentRuntimeEvent,
  ChatMessage,
  ChatSession,
} from "../src/types/chat";
import type {
  ToolCall,
  ToolDefinition,
  ToolExecutionResult,
} from "../src/types/tool";
import { createPdfPassageEvidenceRecord } from "../src/modules/chat/evidence/index.ts";
import { AGENT_MAX_PLANNING_ITERATIONS_SETTINGS_HREF } from "../src/utils/internalLinks.ts";
import {
  createPendingSearchScopeTools,
  createSearchScopeToolDefinition,
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

function createStableSearchRequestTools(
  tools: ToolDefinition[],
): ToolDefinition[] {
  return [...tools, createSearchScopeToolDefinition()].sort((left, right) =>
    left.function.name.localeCompare(right.function.name),
  );
}

describe("agent runtime plan semantics", function () {
  it("rewrites tool item keys when a request locks paper context", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    session.lastActiveItemKey = "LOCKED-PAPER";
    const assistantMessage: ChatMessage = {
      id: "assistant-locked-paper",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const executedToolCalls: ToolCall[] = [];
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
          return () => `locked-paper-${++id}`;
        })(),
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async (requests: any[]) => {
          executedToolCalls.push(
            ...requests.map((request) => request.toolCall),
          );
          return requests.map((request) => ({
            toolCall: request.toolCall,
            args: JSON.parse(request.toolCall.function.arguments),
            status: "completed" as const,
            content: "locked paper result",
          }));
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 2;

    try {
      await runtime.executeNonStreamingToolLoop({
        provider: {
          config: { id: "openai", type: "openai", defaultModel: "gpt" },
          chatCompletionWithTools: async () => {
            providerCalls += 1;
            return providerCalls === 1
              ? {
                  content: "",
                  toolCalls: [
                    {
                      id: "wrong-paper-call",
                      type: "function" as const,
                      function: {
                        name: "get_outline",
                        arguments: JSON.stringify({
                          itemKey: "OTHER-PAPER",
                        }),
                      },
                    },
                  ],
                }
              : { content: "final summary" };
          },
        },
        currentMessages: session.messages,
        assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: [createToolDefinition("get_outline")],
        sendingSession: session,
        currentItemKey: session.lastActiveItemKey,
        lockedToolItemKey: session.lastActiveItemKey,
      });

      assert.lengthOf(executedToolCalls, 1);
      assert.deepEqual(JSON.parse(executedToolCalls[0].function.arguments), {
        itemKey: "LOCKED-PAPER",
      });
      assert.deepEqual(
        session.messages
          .find((message) => message.apiOnly && message.role === "assistant")
          ?.tool_calls?.map((call) => JSON.parse(call.function.arguments)),
        [{ itemKey: "LOCKED-PAPER" }],
      );
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

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
    const requestTools = createStableSearchRequestTools(allTools);
    const receivedToolNames: string[][] = [];
    const receivedToolChoices: string[] = [];
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
        _signal: AbortSignal | undefined,
        options: { toolChoice?: string } | undefined,
      ) => {
        providerCalls++;
        receivedToolNames.push(roundTools.map((tool) => tool.function.name));
        receivedToolChoices.push(options?.toolChoice || "");
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
        requestTools,
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
        requestTools.map((tool) => tool.function.name),
        requestTools.map((tool) => tool.function.name),
        requestTools.map((tool) => tool.function.name),
      ]);
      assert.deepEqual(receivedToolChoices, ["auto", "auto", "auto"]);
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
    const requestTools = createStableSearchRequestTools(allTools);
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
        requestTools,
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

      assert.deepEqual(
        receivedToolNames,
        Array.from({ length: 3 }, () =>
          requestTools.map((tool) => tool.function.name),
        ),
      );
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
    const requestTools = createStableSearchRequestTools(allTools);
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
        requestTools,
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

      assert.deepEqual(
        receivedToolNames,
        Array.from({ length: 4 }, () =>
          requestTools.map((tool) => tool.function.name),
        ),
      );
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

  it("refreshes request catalogs and execution permissions when rerouting across hosted-search capabilities", async function () {
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

    const runTransition = async (
      initialHosted: boolean,
      streaming: boolean,
    ) => {
      let hosted = initialHosted;
      let providerCalls = 0;
      const receivedToolNames: string[][] = [];
      const executedToolNames: string[] = [];
      const session = createSession();
      const assistantMessage: ChatMessage = {
        id: `assistant-capability-reroute-${initialHosted}-${streaming}`,
        role: "assistant",
        content: "",
        timestamp: 3,
      };
      session.messages.push(assistantMessage);
      const tools = filterSearchToolsForScope({
        tools: allTools,
        supportsHostedWebSearch: hosted,
        scope: undefined,
      }).slice();
      const requestTools = tools.slice();
      const createScholarlyToolCall = (): ToolCall => ({
        id: `scholarly-after-reroute-${initialHosted}-${streaming}`,
        type: "function",
        function: {
          name: "search_scholarly_sources",
          arguments: JSON.stringify({ query: "rerouted evidence" }),
        },
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
          if (providerCalls === 2) {
            return {
              content: "",
              toolCalls: [createScholarlyToolCall()],
            };
          }
          return { content: "final answer after reroute" };
        },
        streamChatCompletionWithTools: async (
          _messages: ChatMessage[],
          roundTools: ToolDefinition[],
          callbacks: any,
        ) => {
          providerCalls += 1;
          receivedToolNames.push(roundTools.map((tool) => tool.function.name));
          if (providerCalls === 1) {
            throw new Error("reroute this model");
          }
          if (providerCalls === 2) {
            const toolCall = createScholarlyToolCall();
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
          callbacks.onTextDelta("final answer after reroute");
          callbacks.onComplete({
            content: "final answer after reroute",
            stopReason: "end_turn",
          });
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
          generateId: () => `capability-reroute-${initialHosted}-${streaming}`,
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
              status: "completed" as const,
              content: "scholarly result after reroute",
            }));
          },
        },
      ) as any;
      runtime.getMaxIterations = () => 3;

      const executionOptions = {
        provider,
        currentMessages: session.messages,
        assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools,
        requestTools,
        sendingSession: session,
        executeProviderRequest: async (
          operation: () => Promise<unknown>,
          onProviderRerouted?: () => void,
        ) => {
          try {
            return await operation();
          } catch {
            hosted = !hosted;
            const reroutedTools = filterSearchToolsForScope({
              tools: allTools,
              supportsHostedWebSearch: hosted,
              scope: undefined,
            }).slice();
            tools.splice(0, tools.length, ...reroutedTools);
            requestTools.splice(0, requestTools.length, ...reroutedTools);
            onProviderRerouted?.();
            return operation();
          }
        },
      };
      if (streaming) {
        await runtime.executeStreamingToolLoop(executionOptions as any);
      } else {
        await runtime.executeNonStreamingToolLoop(executionOptions as any);
      }

      return {
        receivedToolNames,
        executedToolNames,
        results: session.toolExecutionState?.results || [],
      };
    };

    try {
      for (const streaming of [false, true]) {
        const nonHostedToHosted = await runTransition(false, streaming);
        assert.deepEqual(nonHostedToHosted.receivedToolNames, [
          ["web_search", "search_items"],
          ["web_search", "search_scholarly_sources", "search_items"],
          ["web_search", "search_scholarly_sources", "search_items"],
        ]);
        assert.deepEqual(nonHostedToHosted.executedToolNames, [
          "search_scholarly_sources",
        ]);
        assert.include(
          nonHostedToHosted.results.map((result) => result.status),
          "completed",
        );

        const hostedToNonHosted = await runTransition(true, streaming);
        assert.deepEqual(hostedToNonHosted.receivedToolNames, [
          ["web_search", "search_scholarly_sources", "search_items"],
          ["web_search", "search_items"],
          ["web_search", "search_items"],
        ]);
        assert.deepEqual(hostedToNonHosted.executedToolNames, []);
        assert.include(
          hostedToNonHosted.results.map((result) => result.status),
          "denied",
        );
      }
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("observes a provider catalog reroute that occurs during tool execution", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const allTools: ToolDefinition[] = [
      createToolDefinition("web_search"),
      createToolDefinition("search_scholarly_sources"),
      createToolDefinition("search_items"),
    ];

    const runMode = async (streaming: boolean) => {
      let hosted = false;
      let providerCalls = 0;
      const receivedToolNames: string[][] = [];
      const session = createSession();
      const assistantMessage: ChatMessage = {
        id: `assistant-nested-reroute-${streaming}`,
        role: "assistant",
        content: "",
        timestamp: 2,
      };
      session.messages.push(assistantMessage);
      const tools = filterSearchToolsForScope({
        tools: allTools,
        supportsHostedWebSearch: hosted,
        scope: undefined,
      }).slice();
      const requestTools = tools.slice();
      const localToolCall: ToolCall = {
        id: `search-items-before-nested-reroute-${streaming}`,
        type: "function",
        function: {
          name: "search_items",
          arguments: JSON.stringify({ query: "local paper" }),
        },
      };
      const provider = {
        config: { id: "paperchat", type: "paperchat", defaultModel: "gpt" },
        supportsHostedWebSearch: () => hosted,
        chatCompletionWithTools: async (
          _messages: ChatMessage[],
          roundTools: ToolDefinition[],
        ) => {
          providerCalls += 1;
          receivedToolNames.push(roundTools.map((tool) => tool.function.name));
          return providerCalls === 1
            ? { content: "", toolCalls: [localToolCall] }
            : { content: "final answer after nested reroute" };
        },
        streamChatCompletionWithTools: async (
          _messages: ChatMessage[],
          roundTools: ToolDefinition[],
          callbacks: any,
        ) => {
          providerCalls += 1;
          receivedToolNames.push(roundTools.map((tool) => tool.function.name));
          if (providerCalls === 1) {
            callbacks.onToolCallStart({
              index: 0,
              id: localToolCall.id,
              name: localToolCall.function.name,
            });
            callbacks.onToolCallDelta(0, localToolCall.function.arguments);
            callbacks.onComplete({
              content: "",
              toolCalls: [localToolCall],
              stopReason: "tool_calls",
            });
            return;
          }
          callbacks.onTextDelta("final answer after nested reroute");
          callbacks.onComplete({
            content: "final answer after nested reroute",
            stopReason: "end_turn",
          });
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
          generateId: () => `nested-reroute-${streaming}`,
        } as any,
        {
          createExecutionBatches: (requests: any[]) => [requests],
          executeBatch: async (requests: any[]) => {
            hosted = true;
            const reroutedTools = filterSearchToolsForScope({
              tools: allTools,
              supportsHostedWebSearch: hosted,
              scope: undefined,
            }).slice();
            tools.splice(0, tools.length, ...reroutedTools);
            requestTools.splice(0, requestTools.length, ...reroutedTools);
            return requests.map((request) => ({
              toolCall: request.toolCall,
              status: "completed" as const,
              content: "local paper result",
            }));
          },
        },
      ) as any;
      runtime.getMaxIterations = () => 2;
      const executionOptions = {
        provider,
        currentMessages: session.messages,
        assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools,
        requestTools,
        sendingSession: session,
      };

      if (streaming) {
        await runtime.executeStreamingToolLoop(executionOptions as any);
      } else {
        await runtime.executeNonStreamingToolLoop(executionOptions as any);
      }

      return receivedToolNames;
    };

    try {
      for (const streaming of [false, true]) {
        assert.deepEqual(await runMode(streaming), [
          ["web_search", "search_items"],
          ["web_search", "search_scholarly_sources", "search_items"],
        ]);
      }
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("disables provider-hosted and local tools during final synthesis", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const requestTools = [
      createToolDefinition("web_search"),
      createToolDefinition("search_items"),
    ];

    const runMode = async (streaming: boolean) => {
      const session = createSession();
      const assistantMessage: ChatMessage = {
        id: `assistant-final-synthesis-${streaming}`,
        role: "assistant",
        content: "",
        timestamp: 2,
      };
      session.messages.push(assistantMessage);
      const receivedToolNames: string[][] = [];
      const receivedToolChoices: string[] = [];
      let providerCalls = 0;
      let hostedWebSearchExecutions = 0;
      let localToolExecutions = 0;
      const localToolCall: ToolCall = {
        id: `local-before-final-${streaming}`,
        type: "function",
        function: {
          name: "search_items",
          arguments: JSON.stringify({ query: "local paper" }),
        },
      };
      const recordRequest = (
        roundTools: ToolDefinition[],
        options: { toolChoice?: string } | undefined,
      ) => {
        providerCalls += 1;
        receivedToolNames.push(roundTools.map((tool) => tool.function.name));
        receivedToolChoices.push(options?.toolChoice || "");
      };
      const provider = {
        config: { id: "paperchat", type: "paperchat", defaultModel: "gpt" },
        supportsHostedWebSearch: () => true,
        chatCompletionWithTools: async (
          _messages: ChatMessage[],
          roundTools: ToolDefinition[],
          _signal: AbortSignal | undefined,
          options: { toolChoice?: string } | undefined,
        ) => {
          recordRequest(roundTools, options);
          if (providerCalls === 1) {
            return { content: "", toolCalls: [localToolCall] };
          }
          if (options?.toolChoice !== "none") {
            hostedWebSearchExecutions += 1;
            return {
              content: "Answer produced after an unexpected hosted search.",
              hostedWebSearches: [
                {
                  index: 0,
                  id: `unexpected-hosted-${streaming}`,
                  status: "completed" as const,
                  queries: ["unexpected final search"],
                  sources: [],
                },
              ],
            };
          }
          return { content: "final answer without more tools" };
        },
        streamChatCompletionWithTools: async (
          _messages: ChatMessage[],
          roundTools: ToolDefinition[],
          callbacks: any,
          _signal: AbortSignal | undefined,
          options: { toolChoice?: string } | undefined,
        ) => {
          recordRequest(roundTools, options);
          if (providerCalls === 1) {
            callbacks.onToolCallStart({
              index: 0,
              id: localToolCall.id,
              name: localToolCall.function.name,
            });
            callbacks.onToolCallDelta(0, localToolCall.function.arguments);
            callbacks.onComplete({
              content: "",
              toolCalls: [localToolCall],
              stopReason: "tool_calls",
            });
            return;
          }
          if (options?.toolChoice !== "none") {
            hostedWebSearchExecutions += 1;
            callbacks.onHostedWebSearchStatus({
              index: 0,
              id: `unexpected-hosted-${streaming}`,
              status: "completed",
              queries: ["unexpected final search"],
              sources: [],
            });
            callbacks.onComplete({
              content: "Answer produced after an unexpected hosted search.",
              stopReason: "end_turn",
            });
            return;
          }
          callbacks.onTextDelta("final answer without more tools");
          callbacks.onComplete({
            content: "final answer without more tools",
            stopReason: "end_turn",
          });
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
          generateId: () => `final-synthesis-${streaming}`,
        } as any,
        {
          createExecutionBatches: (requests: any[]) => [requests],
          executeBatch: async (requests: any[]) => {
            localToolExecutions += requests.length;
            return requests.map((request) => ({
              toolCall: request.toolCall,
              status: "completed" as const,
              content: "local paper result",
            }));
          },
        },
      ) as any;
      runtime.getMaxIterations = () => 2;
      const executionOptions = {
        provider,
        currentMessages: session.messages,
        assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: requestTools.slice(),
        requestTools: requestTools.slice(),
        sendingSession: session,
      };

      if (streaming) {
        await runtime.executeStreamingToolLoop(executionOptions as any);
      } else {
        await runtime.executeNonStreamingToolLoop(executionOptions as any);
      }

      return {
        assistantMessage,
        hostedWebSearchExecutions,
        localToolExecutions,
        receivedToolChoices,
        receivedToolNames,
      };
    };

    try {
      for (const streaming of [false, true]) {
        const result = await runMode(streaming);
        assert.deepEqual(result.receivedToolChoices, ["auto", "none"]);
        assert.deepEqual(result.receivedToolNames, [
          ["web_search", "search_items"],
          ["web_search", "search_items"],
        ]);
        assert.equal(result.localToolExecutions, 1);
        assert.equal(result.hostedWebSearchExecutions, 0);
        assert.equal(
          result.assistantMessage.content,
          "final answer without more tools",
        );
      }
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
    const requestTools = createStableSearchRequestTools(allTools);
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
        requestTools,
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
        requestTools.map((tool) => tool.function.name),
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
    assert.include(
      entries[0].results[0].content,
      "not authorized for execution",
    );
    assert.notInclude(entries[0].results[0].content, "select_search_scope");
  });

  it("blocks a hallucinated non-search tool outside the authorized execution subset", function () {
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
    assert.include(
      entries[0].results[0].content,
      "not authorized for execution",
    );
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

  it("retains every completed duplicate-ID pair after an interrupted turn", function () {
    const duplicateId = "duplicate-presentation-call";
    const session = createSession();
    session.messages.push(
      {
        id: "assistant-duplicate-api-context-request",
        role: "assistant",
        content: "",
        tool_calls: ["first", "second"].map((sourceItemKey) => ({
          id: duplicateId,
          type: "function" as const,
          function: {
            name: "presentation",
            arguments: JSON.stringify({ sourceItemKey }),
          },
        })),
        apiOnly: true,
        timestamp: 2,
      },
      {
        id: "assistant-duplicate-api-context-result-1",
        role: "tool",
        content: "first presentation result",
        tool_call_id: duplicateId,
        apiOnly: true,
        timestamp: 3,
      },
      {
        id: "assistant-duplicate-api-context-result-2",
        role: "tool",
        content: "second presentation result",
        tool_call_id: duplicateId,
        apiOnly: true,
        timestamp: 4,
      },
      {
        id: "assistant-duplicate",
        role: "assistant",
        content: "Two generated PPTX files remain available.",
        streamingState: "interrupted",
        timestamp: 5,
      },
    );

    assert.isTrue(
      retainCompletedApiOnlyModelContextMessagesForTurn(
        session,
        "assistant-duplicate",
      ),
    );
    assert.deepEqual(
      session.messages[1].tool_calls?.map((toolCall) => ({
        id: toolCall.id,
        args: toolCall.function.arguments,
      })),
      [
        {
          id: duplicateId,
          args: JSON.stringify({ sourceItemKey: "first" }),
        },
        {
          id: duplicateId,
          args: JSON.stringify({ sourceItemKey: "second" }),
        },
      ],
    );
    assert.deepEqual(
      session.messages
        .filter((message) => message.role === "tool")
        .map((message) => ({
          toolCallId: message.tool_call_id,
          content: message.content,
        })),
      [
        {
          toolCallId: duplicateId,
          content: "first presentation result",
        },
        {
          toolCallId: duplicateId,
          content: "second presentation result",
        },
      ],
    );
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
      supportsHostedWebSearch: () => true,
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
        tools: [createToolDefinition("web_search")],
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
        supportsHostedWebSearch: () => true,
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
      tools: [createToolDefinition("web_search")],
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
      supportsHostedWebSearch: () => true,
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
          tools: [createToolDefinition("web_search")],
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

  it("does not turn a user-aborted tool into a failed turn while the run is still tracked", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-aborted-tool-tracked",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const abortController = new AbortController();
    abortController.abort();
    let failedTurnEvents = 0;
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        // ChatManager deliberately keeps the run tracked while it waits for
        // a mutating tool to unwind after the cancel button is pressed.
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => "aborted-tool-generated",
        onRuntimeEvent: (event: AgentRuntimeEvent) => {
          if (event.type === "turn_failed") failedTurnEvents += 1;
        },
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async () => {
          const error = new Error("Operation aborted.");
          error.name = "AbortError";
          throw error;
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 2;

    try {
      await runtime.executeNonStreamingToolLoop({
        provider: {
          config: { id: "openai", type: "openai", defaultModel: "gpt" },
          chatCompletionWithTools: async () => ({
            content: "",
            toolCalls: [
              {
                id: "aborted-tool-call",
                type: "function" as const,
                function: {
                  name: "get_item_metadata",
                  arguments: JSON.stringify({ itemKey: "ABORTED" }),
                },
              },
            ],
          }),
        },
        currentMessages: session.messages,
        assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: [createToolDefinition("get_item_metadata")],
        sendingSession: session,
        abortSignal: abortController.signal,
      });

      assert.equal(failedTurnEvents, 0);
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
      assert.deepEqual(receivedToolNames[1], [
        "web_search",
        "search_scholarly_sources",
      ]);
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
      ["web_search", "search_scholarly_sources", "search_items"],
    );
    assert.deepEqual([...control.allowedToolNames], ["search_items"]);
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

  it("treats a short current-paper PPT request as sufficient tool intent", function () {
    const prompt = generatePaperContextPrompt(
      undefined,
      "ITEM-1",
      "Current paper",
      true,
    );

    assert.include(prompt, "=== PRESENTATION TOOL ===");
    assert.include(
      prompt,
      'Treat a short request such as "为这篇论文生成一个 PPT" as complete intent',
    );
    assert.include(
      prompt,
      'call presentation with only {"sourceItemKey":"<current itemKey>"}',
    );
    assert.include(prompt, "call presentation with {}");
    assert.include(
      prompt,
      "the tool resolves the one currently selected Zotero item",
    );
    assert.include(
      prompt,
      "Do not call request_user_input merely to ask which paper or source",
    );
    assert.include(
      prompt,
      "only after presentation itself returns an explicit source-missing or multiple-selection ambiguity",
    );
    assert.include(prompt, "never invent optional arguments");
    assert.include(prompt, "exactly the same arguments as the first attempt");
    assert.include(prompt, "Do not ask the user to provide a long prompt");
    assert.include(prompt, "call presentation again in this same turn");
    assert.include(prompt, "bounded presentation retry allowance");
    assert.include(
      prompt,
      "Never claim that presentation is subject to the unchanged-call retry restriction",
    );
    assert.include(
      prompt,
      "report that the attempts failed instead of changing language or designSystem",
    );
  });

  it("tells the model to retry a failed presentation without advertising the unchanged-call block", function () {
    const prompt = generateAgentRuntimeContextPrompt(undefined, {
      recentToolResults: [
        {
          toolCall: {
            id: "presentation-1",
            type: "function",
            function: {
              name: "presentation",
              arguments: JSON.stringify({ sourceItemKey: "ITEM-1" }),
            },
          },
          args: { sourceItemKey: "ITEM-1" },
          status: "failed",
          content: [
            "Error: Presentation generation failed.",
            "Category: execution_failed",
            "Retryable: yes",
            "Cause: Slide 2 render verification failed.",
            "Fix hint: Retry the presentation request.",
          ].join("\n"),
        } satisfies ToolExecutionResult,
      ],
    });

    assert.notInclude(prompt, "=== RETRY POLICY ===");
    assert.include(prompt, "=== FAILURE RECOVERY STRATEGY ===");
    assert.include(prompt, "Retry the presentation request");
    assert.notInclude(prompt, "avoid repeating the same call unchanged");
  });

  it("keeps a tool-capable recovery round after a late presentation failure", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    session.messages[0].content =
      "请直接使用 presentation 工具，基于当前论文生成一份 PPT。";
    const assistantMessage: ChatMessage = {
      id: "assistant-presentation-recovery-window",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    let providerCalls = 0;
    let presentationExecutions = 0;
    const executedPresentationArgs: Array<Record<string, unknown>> = [];
    const toolChoices: string[] = [];
    const providerMessageSnapshots: ChatMessage[][] = [];
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "<presentation />",
        generateId: (() => {
          let id = 0;
          return () => `presentation-recovery-${++id}`;
        })(),
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async (requests: any[]) => {
          presentationExecutions += 1;
          executedPresentationArgs.push(
            JSON.parse(requests[0].toolCall.function.arguments),
          );
          return [
            {
              toolCall: requests[0].toolCall,
              status: presentationExecutions === 1 ? "failed" : "completed",
              content:
                presentationExecutions === 1
                  ? [
                      "Error: Presentation generation failed.",
                      "Category: execution_failed",
                      "Retryable: yes",
                      "Cause: Slide 2 render verification failed.",
                      "Fix hint: Retry the presentation request.",
                    ].join("\n")
                  : JSON.stringify({
                      status: "completed",
                      path: "/tmp/recovered.pptx",
                    }),
            },
          ];
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 2;
    const provider = {
      config: {
        id: "paperchat",
        type: "paperchat",
        defaultModel: "gpt-5.6-terra",
      },
      chatCompletionWithTools: async (
        _messages: ChatMessage[],
        _tools: unknown[],
        _signal: AbortSignal | undefined,
        options: { toolChoice?: string },
      ) => {
        providerCalls += 1;
        providerMessageSnapshots.push(
          _messages.map((message) => ({ ...message })),
        );
        toolChoices.push(options.toolChoice || "");
        if (providerCalls <= 2) {
          return {
            content: "",
            toolCalls: [
              {
                id: `presentation-call-${providerCalls}`,
                type: "function" as const,
                function: {
                  name: "presentation",
                  arguments: JSON.stringify({
                    sourceItemKey: "ITEM-1",
                    designSystem:
                      providerCalls === 1
                        ? "teal-green-academic-defense"
                        : "dark-editorial",
                    instructions:
                      providerCalls === 1
                        ? "Invented academic plan"
                        : "Try a different English style",
                  }),
                },
              },
            ],
          };
        }
        return { content: "PPT 已生成。" };
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
              name: "presentation",
              description: "Create a presentation",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        sendingSession: session,
      });

      assert.equal(providerCalls, 3);
      assert.equal(presentationExecutions, 2);
      assert.deepEqual(executedPresentationArgs, [
        { sourceItemKey: "ITEM-1" },
        { sourceItemKey: "ITEM-1" },
      ]);
      assert.deepEqual(toolChoices, ["auto", "auto", "none"]);
      const finalPrompt = providerMessageSnapshots[2]
        .map((message) => message.content)
        .join("\n");
      assert.include(finalPrompt, "successfully wrote a PPTX file");
      assert.include(finalPrompt, "/tmp/recovered.pptx");
      assert.include(
        finalPrompt,
        "Treat completed_with_warnings as a successful export",
      );
      assert.equal(
        assistantMessage.content,
        "<presentation /><presentation />PPT 已生成。",
      );
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("does not accept a terminal no-retry apology after a retryable presentation failure", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-presentation-retry-nudge",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    let providerCalls = 0;
    let presentationExecutions = 0;
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "<presentation />",
        generateId: (() => {
          let id = 0;
          return () => `presentation-nudge-${++id}`;
        })(),
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async (requests: any[]) => {
          presentationExecutions += 1;
          return [
            {
              toolCall: requests[0].toolCall,
              status: presentationExecutions === 1 ? "failed" : "completed",
              content:
                presentationExecutions === 1
                  ? [
                      "Error: Presentation generation failed.",
                      "Category: execution_failed",
                      "Retryable: yes",
                      "Cause: Slide 2 text and caption verification failed.",
                      "Fix hint: Retry the presentation request.",
                    ].join("\n")
                  : JSON.stringify({
                      status: "completed",
                      path: "/tmp/recovered-after-nudge.pptx",
                    }),
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
        defaultModel: "gpt-5.6-terra",
      },
      chatCompletionWithTools: async () => {
        providerCalls += 1;
        if (providerCalls === 1 || providerCalls === 3) {
          return {
            content: "",
            toolCalls: [
              {
                id: `presentation-call-${providerCalls}`,
                type: "function" as const,
                function: {
                  name: "presentation",
                  arguments: JSON.stringify({ sourceItemKey: "ITEM-1" }),
                },
              },
            ],
          };
        }
        if (providerCalls === 2) {
          return {
            content: "抱歉，按工具限制本轮不能重复调用 presentation。",
          };
        }
        return { content: "PPT 已生成。" };
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
              name: "presentation",
              description: "Create a presentation",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        sendingSession: session,
      });

      assert.equal(providerCalls, 4);
      assert.equal(presentationExecutions, 2);
      assert.notInclude(assistantMessage.content, "不能重复调用");
      assert.equal(
        assistantMessage.content,
        "<presentation /><presentation />PPT 已生成。",
      );
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("ends with a clean synthesis after three failed presentation attempts", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-presentation-attempt-budget",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    let providerCalls = 0;
    let presentationExecutions = 0;
    const toolChoices: string[] = [];
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "<presentation />",
        generateId: (() => {
          let id = 0;
          return () => `presentation-budget-${++id}`;
        })(),
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async (requests: any[]) => {
          presentationExecutions += 1;
          return [
            {
              toolCall: requests[0].toolCall,
              status: "failed",
              content: [
                "Error: Presentation generation failed.",
                "Category: execution_failed",
                "Retryable: yes",
                `Cause: Visual attempt ${presentationExecutions} failed.`,
                "Fix hint: Retry the presentation request.",
              ].join("\n"),
            },
          ];
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 6;
    const provider = {
      config: {
        id: "paperchat",
        type: "paperchat",
        defaultModel: "gpt-5.6-terra",
      },
      chatCompletionWithTools: async (
        _messages: ChatMessage[],
        _tools: unknown[],
        _signal: AbortSignal | undefined,
        options: { toolChoice?: string },
      ) => {
        providerCalls += 1;
        toolChoices.push(options.toolChoice || "");
        if (options.toolChoice === "none") {
          return {
            content: "三次生成均未通过质量校验，本轮未写出 PPTX。",
          };
        }
        return {
          content: "",
          toolCalls: [
            {
              id: `presentation-budget-call-${providerCalls}`,
              type: "function" as const,
              function: {
                name: "presentation",
                arguments: JSON.stringify({ sourceItemKey: "ITEM-1" }),
              },
            },
          ],
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
              name: "presentation",
              description: "Create a presentation",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        sendingSession: session,
      });

      assert.equal(providerCalls, 4);
      assert.equal(presentationExecutions, 3);
      assert.deepEqual(toolChoices, ["auto", "auto", "auto", "none"]);
      assert.equal(
        assistantMessage.content,
        "<presentation /><presentation /><presentation />三次生成均未通过质量校验，本轮未写出 PPTX。",
      );
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
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

  it("runs presentation planning as an isolated model job with paper evidence", async function () {
    const runtime = new AgentRuntime(
      { updateSessionMeta: async () => undefined } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => `presentation-${Math.random()}`,
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async () => [],
      },
    ) as any;
    let capturedMessages: ChatMessage[] = [];
    let capturedOptions: Record<string, unknown> | undefined;
    const provider = {
      chatCompletionWithTools: async (
        messages: ChatMessage[],
        _tools: unknown,
        _signal: AbortSignal | undefined,
        options: Record<string, unknown>,
      ) => {
        capturedMessages = messages;
        capturedOptions = options;
        return {
          content: JSON.stringify({
            title: "Evidence-first deck",
            sourceItemKey: "SBZ2M99R",
            slides: [
              {
                title: "The benchmark changes",
                metrics: [{ value: "1", label: "result" }],
              },
            ],
          }),
        };
      },
    };
    const planner = runtime.createPresentationPlanner(
      provider,
      async (operation: () => Promise<unknown>) => operation(),
    );

    const result = await planner({
      intent: {
        sourceItemKey: "SBZ2M99R",
        language: "zh-CN",
        instructions: "面向组会，突出消融实验。",
      },
      paper: {
        metadata: { title: "ImageNet classification", year: 2012 },
        sections: [],
        fullText: "Figure 1 evidence",
        pages: [
          {
            pageNumber: 1,
            startIndex: 0,
            endIndex: 17,
            content: "Fig. 1. Network architecture and benchmark evidence.",
          },
        ],
        pageCount: 1,
      },
    });

    assert.equal(result.title, "Evidence-first deck");
    assert.deepEqual(capturedOptions, {
      toolChoice: "none",
      stateless: true,
    });
    assert.lengthOf(capturedMessages, 2);
    assert.notInclude(capturedMessages[0].content, "SBZ2M99R");
    assert.notInclude(capturedMessages[0].content, "面向组会");
    assert.include(capturedMessages[1].content, "SBZ2M99R");
    assert.include(capturedMessages[1].content, "面向组会，突出消融实验。");
    assert.include(capturedMessages[1].content, "Fig. 1. Network architecture");
    assert.include(capturedMessages[1].content, "Internal output JSON schema");
  });

  it("streams presentation progress into the same calling card and execution plan", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-presentation-progress",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const streamingUpdates: string[] = [];
    const progressEvents: AgentRuntimeEvent[] = [];
    let paperSource: { itemKey?: string; libraryID?: number } | undefined;
    const persistedPresentationArtifacts: Array<
      NonNullable<ChatMessage["presentationArtifacts"]>
    > = [];
    const formattedCards: Array<{
      status: string;
      result?: string;
      path?: string;
      phase?: string;
      stage?: string;
      startedAt?: number;
      updatedAt?: number;
    }> = [];
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async (
          _sessionId: string,
          _messageId: string,
          _content: string,
          _reasoning?: string,
          options?: {
            presentationArtifacts?: ChatMessage["presentationArtifacts"];
          },
        ) => {
          if (options?.presentationArtifacts?.length) {
            persistedPresentationArtifacts.push(
              structuredClone(options.presentationArtifacts),
            );
          }
        },
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => true,
        isSessionTracked: () => true,
        onStreamingUpdate: (content: string) => streamingUpdates.push(content),
        onRuntimeEvent: (event: AgentRuntimeEvent) =>
          progressEvents.push(event),
        formatToolCallCard: (
          _name: string,
          _args: string,
          status: string,
          result?: string,
          options?: {
            presentationArtifact?: { path?: string };
            presentationProgress?: {
              phase: string;
              stage: string;
              startedAt: number;
              updatedAt: number;
            };
          },
        ) => {
          formattedCards.push({
            status,
            result,
            path: options?.presentationArtifact?.path,
            phase: options?.presentationProgress?.phase,
            stage: options?.presentationProgress?.stage,
            startedAt: options?.presentationProgress?.startedAt,
            updatedAt: options?.presentationProgress?.updatedAt,
          });
          return `<presentation status="${status}">${result || ""}</presentation>`;
        },
        generateId: () => `presentation-progress-${Math.random()}`,
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async (requests: any[]) => {
          paperSource = requests[0].executionContext.paperSource;
          await requests[0].executionContext.presentationProgress({
            phase: "planning",
            message: "正在规划 6 页结构",
            current: 2,
            total: 9,
          });
          await requests[0].executionContext.presentationProgress({
            phase: "resolving_media",
            message: "正在提取论文证据图",
            current: 3,
            total: 9,
          });
          await requests[0].executionContext.presentationProgress({
            phase: "rendering",
            message: "已生成可打开的 PPTX 草稿",
            pptxPath: "/safe/presentation-draft.pptx",
            previewPaths: ["/safe/slide-01.png"],
            isDraft: true,
          });
          assert.isTrue(
            persistedPresentationArtifacts
              .flat()
              .some(
                (artifact) =>
                  artifact.toolCallId === "presentation-progress-call" &&
                  artifact.localId ===
                    "presentation-progress-call:presentation:1:1" &&
                  artifact.path === "/safe/presentation-draft.pptx" &&
                  JSON.stringify(artifact.previewPaths) ===
                    JSON.stringify(["/safe/slide-01.png"]) &&
                  artifact.sourceItemKey === "ITEM-1" &&
                  artifact.sourceLibraryID === 5 &&
                  artifact.isDraft === true,
              ),
            "the file milestone must reach storage before the renderer continues",
          );
          await requests[0].executionContext.presentationProgress({
            phase: "reviewing",
            message: "正在进行视觉检查",
            pptxPath: "/safe/presentation-draft.pptx",
            isDraft: true,
          });
          await requests[0].executionContext.presentationProgress({
            phase: "repairing",
            message: "正在改进版式与内容",
            pptxPath: "/safe/presentation-draft.pptx",
            isDraft: true,
          });
          await requests[0].executionContext.presentationProgress({
            phase: "rendering",
            message: "正在生成改进版 PPT",
            pptxPath: "/safe/presentation-draft.pptx",
            isDraft: true,
          });
          await requests[0].executionContext.presentationProgress({
            phase: "attaching",
            message: "正在挂载到 Zotero",
            pptxPath: "/safe/presentation-draft.pptx",
            isDraft: true,
          });
          return [
            {
              toolCall: requests[0].toolCall,
              status: "completed",
              content: JSON.stringify({
                status: "completed",
                path: "/safe/presentation-final.pptx",
              }),
            },
          ];
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 2;
    let providerCalls = 0;
    const provider = {
      config: {
        id: "paperchat",
        type: "paperchat",
        defaultModel: "gpt-5.6-terra",
      },
      chatCompletionWithTools: async () => {
        providerCalls += 1;
        return providerCalls === 1
          ? {
              content: "",
              toolCalls: [
                {
                  id: "presentation-progress-call",
                  type: "function" as const,
                  function: {
                    name: "presentation",
                    arguments: JSON.stringify({ sourceItemKey: "ITEM-1" }),
                  },
                },
              ],
            }
          : { content: "PPT 已生成。" };
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
              name: "presentation",
              description: "Create a presentation",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        sendingSession: session,
        currentItemKey: "ITEM-1",
        currentItemLibraryID: 5,
        presentationAuthorization: createPresentationLaunchAuthorization({
          itemKey: "ITEM-1",
          libraryID: 5,
        }),
      });

      assert.isTrue(
        formattedCards.some(
          (card) =>
            card.status === "calling" && card.result === "正在规划 6 页结构",
        ),
      );
      assert.isTrue(
        formattedCards.some(
          (card) => card.path === "/safe/presentation-draft.pptx",
        ),
      );
      assert.isTrue(
        streamingUpdates.some((content) =>
          content.includes("已生成可打开的 PPTX 草稿"),
        ),
      );
      const toolProgressEvents = progressEvents.filter(
        (event) => event.type === "tool_progress",
      );
      assert.deepEqual(
        toolProgressEvents.map((event) =>
          event.type === "tool_progress" ? event.phase : "",
        ),
        [
          "planning",
          "resolving_media",
          "rendering",
          "reviewing",
          "repairing",
          "rendering",
          "attaching",
        ],
      );
      assert.deepEqual(
        toolProgressEvents.map((event) =>
          event.type === "tool_progress" ? event.stage : undefined,
        ),
        [
          "planning",
          "extracting",
          "drafting",
          "refining",
          "refining",
          "refining",
          "saving",
        ],
      );
      const callingStages = formattedCards
        .filter((card) => card.status === "calling" && card.stage)
        .map((card) => card.stage);
      const stageOrder = [
        "preparing",
        "planning",
        "extracting",
        "drafting",
        "refining",
        "saving",
      ];
      assert.isTrue(
        callingStages.every(
          (stage, index) =>
            index === 0 ||
            stageOrder.indexOf(stage || "") >=
              stageOrder.indexOf(callingStages[index - 1] || ""),
        ),
      );
      assert.isTrue(
        toolProgressEvents.every(
          (event) =>
            event.type !== "tool_progress" ||
            (typeof event.startedAt === "number" &&
              typeof event.updatedAt === "number" &&
              event.updatedAt >= event.startedAt),
        ),
      );
      assert.equal(
        session.executionPlan?.steps.find(
          (step) => step.id === "presentation-progress-call:presentation:1:1",
        )?.status,
        "completed",
      );
      assert.deepEqual(paperSource, {
        itemKey: "ITEM-1",
        libraryID: 5,
      });
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("executes only the first presentation call in one model response", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    const session = createSession();
    const assistantMessage: ChatMessage = {
      id: "assistant-presentation-multiple-progress",
      role: "assistant",
      content: "",
      timestamp: 2,
    };
    session.messages.push(assistantMessage);
    const renderedArtifacts: Array<{
      status?: string;
      expandStateId?: string;
      toolCallId?: string;
      localId?: string;
      path?: string;
      result?: string;
    }> = [];
    const providerMessageSnapshots: ChatMessage[][] = [];
    const runtime = new AgentRuntime(
      {
        updateMessageContent: async () => undefined,
        updateSessionMeta: async () => undefined,
        saveSession: async () => undefined,
      } as any,
      {
        isSessionActive: () => true,
        isSessionTracked: () => true,
        formatToolCallCard: (
          _name: string,
          _args: string,
          status: string,
          result?: string,
          options?: {
            expandStateId?: string;
            presentationArtifact?: {
              toolCallId: string;
              localId?: string;
              path?: string;
            };
          },
        ) => {
          renderedArtifacts.push({
            status,
            result,
            expandStateId: options?.expandStateId,
            toolCallId: options?.presentationArtifact?.toolCallId,
            localId: options?.presentationArtifact?.localId,
            path: options?.presentationArtifact?.path,
          });
          return "<presentation />";
        },
        generateId: () => `presentation-multiple-${Math.random()}`,
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async (requests: any[]) => {
          assert.lengthOf(requests, 1);
          await requests[0].executionContext.presentationProgress({
            phase: "rendering",
            message: "first draft",
            pptxPath: "/safe/first.pptx",
            isDraft: true,
          });
          return requests.map((request: any) => ({
            toolCall: request.toolCall,
            status: "completed",
            content: JSON.stringify({
              status: "completed",
              path: "/safe/final-1.pptx",
            }),
          }));
        },
      },
    ) as any;
    runtime.getMaxIterations = () => 2;
    let providerCalls = 0;
    const provider = {
      config: { id: "paperchat", type: "paperchat" },
      chatCompletionWithTools: async (messages: ChatMessage[]) => {
        providerCalls += 1;
        providerMessageSnapshots.push(structuredClone(messages));
        return providerCalls === 1
          ? {
              content: "",
              toolCalls: ["first", "second"].map((sourceItemKey) => ({
                id: "duplicate-presentation-call",
                type: "function" as const,
                function: {
                  name: "presentation",
                  arguments: JSON.stringify({ sourceItemKey }),
                },
              })),
            }
          : { content: "The PPT file was generated." };
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
              name: "presentation",
              description: "Create a presentation",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        sendingSession: session,
        currentItemKey: "ITEM-1",
        currentItemLibraryID: 5,
        presentationAuthorization: createPresentationLaunchAuthorization({
          itemKey: "ITEM-1",
          libraryID: 5,
        }),
      });

      assert.isTrue(
        renderedArtifacts.some(
          (artifact) =>
            artifact.result === "first draft" &&
            artifact.toolCallId === "duplicate-presentation-call" &&
            artifact.path === "/safe/first.pptx",
        ),
      );
      assert.isFalse(
        renderedArtifacts.some(
          (artifact) =>
            artifact.result === "second draft" &&
            artifact.toolCallId === "duplicate-presentation-call" &&
            artifact.path === "/safe/second.pptx",
        ),
      );
      assert.lengthOf(assistantMessage.presentationArtifacts || [], 1);
      assert.deepEqual(
        assistantMessage.presentationArtifacts?.map(
          (artifact) => artifact.toolCallId,
        ),
        ["duplicate-presentation-call"],
      );
      assert.deepEqual(
        assistantMessage.presentationArtifacts?.map(
          (artifact) => artifact.path,
        ),
        ["/safe/final-1.pptx"],
      );
      const localIds = assistantMessage.presentationArtifacts?.map(
        (artifact) => artifact.localId,
      );
      assert.lengthOf(new Set(localIds), 1);
      assert.isTrue(localIds?.every(Boolean));
      assert.deepEqual(
        session.executionPlan?.steps
          .filter((step) => localIds?.includes(step.id))
          .map((step) => step.status),
        ["completed"],
      );
      assert.sameMembers(
        renderedArtifacts
          .filter((card) => card.status === "completed")
          .map((card) => card.expandStateId),
        localIds || [],
      );
      assert.sameMembers(
        [
          ...new Set(
            renderedArtifacts
              .filter((card) => card.result?.includes("draft"))
              .map((card) => card.localId),
          ),
        ],
        localIds || [],
      );

      const secondProviderMessages = providerMessageSnapshots[1];
      const protocolCalls = secondProviderMessages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.tool_calls || []);
      const protocolResults = secondProviderMessages.filter(
        (message) => message.role === "tool",
      );
      assert.isAtLeast(protocolCalls.length, 2);
      assert.isTrue(
        protocolCalls.every(
          (toolCall) => toolCall.id === "duplicate-presentation-call",
        ),
      );
      assert.isAtLeast(protocolResults.length, 2);
      assert.isTrue(
        protocolResults.every(
          (message) => message.tool_call_id === "duplicate-presentation-call",
        ),
      );
      const deniedResults = session.toolExecutionState?.results.filter(
        (result) =>
          result.toolCall.function.name === "presentation" &&
          result.status === "denied",
      );
      assert.lengthOf(deniedResults || [], 1);
      assert.include(
        deniedResults?.[0].content || "",
        "Additional presentation generation was blocked",
      );
      assert.isFalse(
        session.executionPlan?.steps.some(
          (step) => step.title === "Revise plan after blocked tool call",
        ),
      );
      const providerPrompt = secondProviderMessages
        .map((message) => message.content)
        .join("\n");
      assert.notInclude(providerPrompt, "Tool recovery notice");
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("repairs an invalid planner protocol once inside the presentation job", async function () {
    const runtime = new AgentRuntime(
      { updateSessionMeta: async () => undefined } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => `planner-repair-${Math.random()}`,
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async () => [],
      },
    ) as any;
    const capturedMessages: ChatMessage[][] = [];
    let callCount = 0;
    const provider = {
      chatCompletionWithTools: async (messages: ChatMessage[]) => {
        callCount += 1;
        capturedMessages.push(messages);
        return callCount === 1
          ? { content: "not-json" }
          : {
              content: JSON.stringify({
                title: "Repaired deck",
                sourceItemKey: "SBZ2M99R",
                slides: [{ title: "Evidence" }],
              }),
            };
      },
    };
    const planner = runtime.createPresentationPlanner(
      provider,
      async (operation: () => Promise<unknown>) => operation(),
    );

    const result = await planner({
      intent: { sourceItemKey: "SBZ2M99R" },
      paper: {
        metadata: { title: "ImageNet classification" },
        sections: [],
        fullText: "Evidence",
        pages: [],
        pageCount: 0,
      },
    });

    assert.equal(callCount, 2);
    assert.equal(result.title, "Repaired deck");
    assert.equal(
      capturedMessages[0][0].content,
      capturedMessages[1][0].content,
    );
    assert.notInclude(capturedMessages[1][0].content, "not-json");
    assert.include(
      capturedMessages[1][1].content,
      "Repair the previous internal",
    );
    assert.include(capturedMessages[1][1].content, "not-json");
  });

  it("runs visual review statelessly and rejects suppressed tool protocol", async function () {
    const runtime = new AgentRuntime(
      { updateSessionMeta: async () => undefined } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => `review-${Math.random()}`,
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async () => [],
      },
    ) as any;
    let capturedOptions: Record<string, unknown> | undefined;
    const capturedMessageSnapshots: ChatMessage[][] = [];
    let callCount = 0;
    const provider = {
      chatCompletionWithTools: async (
        messages: ChatMessage[],
        _tools: unknown,
        _signal: AbortSignal | undefined,
        options: Record<string, unknown>,
      ) => {
        callCount += 1;
        capturedMessageSnapshots.push(messages);
        capturedOptions = options;
        return { content: "", suppressedToolCall: true };
      },
    };
    const reviewer = runtime.createPresentationVisualReviewer(
      provider,
      async (operation: () => Promise<unknown>) => operation(),
    );

    let rejected: unknown;
    try {
      await reviewer({
        stage: "draft",
        title: "Deck",
        outline: "Six slides",
        previewSlides: ["data:image/png;base64,AAAA"],
      });
    } catch (error) {
      rejected = error;
    }
    assert.instanceOf(rejected, Error);
    assert.match((rejected as Error).message, /tool call instead of JSON/);
    assert.equal(callCount, 2);
    assert.deepEqual(capturedOptions, {
      toolChoice: "none",
      stateless: true,
    });
    const capturedMessages = capturedMessageSnapshots[1];
    assert.notEqual(
      capturedMessageSnapshots[0][0].content,
      capturedMessageSnapshots[1][0].content,
    );
    assert.include(capturedMessages[0].content, "This is the draft gate");
    assert.include(capturedMessages[0].content, "slideNumber 2-2");
    assert.include(
      capturedMessages[0].content,
      "previous reviewer response violated the JSON protocol",
    );
    assert.include(capturedMessages[1].content, "Review stage: draft");
    assert.include(capturedMessages[1].content, "Protocol issue:");
    assert.include(
      capturedMessages[0].content,
      "quoted Figure/Table captions are source evidence",
    );
    assert.include(
      capturedMessages[0].content,
      "must not be treated as language mixing",
    );
    assert.include(
      capturedMessages[0].content,
      "bibliographic year in the outline as authoritative Zotero metadata",
    );
    assert.include(
      capturedMessages[0].content,
      "pass means the deck is genuinely presentation-ready",
    );
    assert.include(
      capturedMessages[0].content,
      "Never revise or reject only for subjective preference or micro-polish",
    );
    assert.include(
      capturedMessages[0].content,
      "every visual-review verdict is advisory and the best successfully rendered deck is still exported",
    );
    assert.include(
      capturedMessages[0].content,
      "only deterministic schema, renderer, PPTX integrity, or filesystem failures may prevent writing",
    );
    assert.include(
      capturedMessages[0].content,
      "one category label correctly names a cluster",
    );
  });

  it("keeps final-review policy in the visual-review system prompt", async function () {
    const runtime = new AgentRuntime(
      { updateSessionMeta: async () => undefined } as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => `final-review-${Math.random()}`,
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async () => [],
      },
    ) as any;
    let capturedMessages: ChatMessage[] = [];
    const provider = {
      chatCompletionWithTools: async (messages: ChatMessage[]) => {
        capturedMessages = messages;
        return {
          content: JSON.stringify({ verdict: "pass", summary: "ready" }),
        };
      },
    };
    const reviewer = runtime.createPresentationVisualReviewer(
      provider,
      async (operation: () => Promise<unknown>) => operation(),
    );

    await reviewer({
      stage: "final",
      title: "Deck",
      outline: "Six slides",
      previewSlides: [
        "data:image/png;base64,AAAA",
        "data:image/png;base64,BBBB",
        "data:image/png;base64,CCCC",
      ],
    });

    assert.include(capturedMessages[0].content, "final internal review");
    assert.include(capturedMessages[0].content, "Never return revise");
    assert.include(capturedMessages[0].content, "slideNumber 2-3");
    assert.include(capturedMessages[1].content, "Review stage: final");
  });
});
