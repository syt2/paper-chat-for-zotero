import { assert } from "chai";
import { AgentRuntime } from "../src/modules/chat/agent-runtime/AgentRuntime.ts";
import { OUTPUT_TRUNCATION_NOTICE } from "../src/modules/chat/agent-runtime/messages.ts";
import { OUTPUT_CONTINUATION_TOOL_PROTOCOL_ERROR } from "../src/modules/chat/agent-runtime/outputTruncationContinuation.ts";
import type { ChatMessage, ChatSession } from "../src/types/chat";
import type { ToolDefinition } from "../src/types/tool";

const searchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "search",
    description: "Search",
    parameters: { type: "object", properties: {} },
  },
};

const webSearchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web",
    parameters: { type: "object", properties: {} },
  },
};

const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;

function createFourAttemptExecutor() {
  let executorCalls = 0;
  return {
    execute: async <T>(operation: () => Promise<T>): Promise<T> => {
      executorCalls += 1;
      let lastError: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          return await operation();
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
    getExecutorCalls: () => executorCalls,
  };
}

function createHarness(
  isSessionTracked: () => boolean = () => true,
  isSessionActive: () => boolean = () => false,
) {
  const userMessage: ChatMessage = {
    id: "user-1",
    role: "user",
    content: "Give me a long answer.",
    timestamp: 1,
  };
  const assistantMessage: ChatMessage = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    timestamp: 2,
  };
  const session: ChatSession = {
    id: "session-1",
    createdAt: 1,
    updatedAt: 1,
    lastActiveItemKey: null,
    messages: [userMessage, assistantMessage],
  };
  let generatedId = 0;
  const checkpoints: string[] = [];
  const streamingUpdates: string[] = [];
  const runtimeEvents: unknown[] = [];
  const runtime = new AgentRuntime(
    {
      updateMessageContent: async (
        _sessionId: string,
        _messageId: string,
        content: string,
      ) => {
        checkpoints.push(content);
      },
      updateSessionMeta: async () => undefined,
      saveSession: async () => undefined,
    } as any,
    {
      isSessionActive,
      isSessionTracked,
      onStreamingUpdate: (content: string) => streamingUpdates.push(content),
      onRuntimeEvent: (event: unknown) => runtimeEvents.push(event),
      formatToolCallCard: () => "",
      generateId: () => `generated-${++generatedId}`,
    },
    {
      createExecutionBatches: () => [],
      executeBatch: async () => [],
    },
  ) as any;
  runtime.getMaxIterations = () => 4;

  return {
    runtime,
    session,
    assistantMessage,
    currentMessages: [userMessage],
    checkpoints,
    streamingUpdates,
    runtimeEvents,
  };
}

describe("AgentRuntime output truncation continuation", function () {
  beforeEach(function () {
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
  });

  after(function () {
    (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
  });

  it("continues a streamed response without tools in the same planning iteration", async function () {
    const harness = createHarness();
    const calls: Array<{
      tools: ToolDefinition[];
      toolChoice?: string;
      messages: ChatMessage[];
    }> = [];

    await harness.runtime.executeStreamingToolLoop({
      provider: {
        config: {
          id: "test",
          type: "openai-compatible",
          defaultModel: "test-model",
        },
        supportsHostedWebSearch: () => false,
        chatCompletionWithTools: async () => ({ content: "unused" }),
        streamChatCompletionWithTools: async (
          messages: ChatMessage[],
          tools: ToolDefinition[],
          callbacks: any,
          _signal: AbortSignal | undefined,
          options: { toolChoice?: string } | undefined,
        ) => {
          calls.push({
            tools: [...tools],
            toolChoice: options?.toolChoice,
            messages: messages.map((message) => ({ ...message })),
          });
          const content = calls.length === 1 ? "Alpha " : "Beta";
          callbacks.onTextDelta(content);
          callbacks.onComplete({
            content,
            stopReason: calls.length === 1 ? "max_tokens" : "end_turn",
          });
        },
      } as any,
      currentMessages: harness.currentMessages,
      assistantMessage: harness.assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      tools: [searchTool],
      sendingSession: harness.session,
    });

    assert.equal(harness.assistantMessage.content, "Alpha Beta");
    assert.lengthOf(calls, 2);
    assert.deepEqual(calls[0].tools, [searchTool]);
    assert.deepEqual(calls[1].tools, []);
    assert.equal(calls[1].toolChoice, "none");
    assert.deepEqual(
      calls[1].messages.slice(-2).map((message) => message.role),
      ["assistant", "user"],
    );
    assert.isTrue(calls[1].messages.at(-1)?.apiOnly);
  });

  it("continues non-streaming output at most three times", async function () {
    const harness = createHarness();
    const calls: Array<{
      tools: ToolDefinition[] | undefined;
      toolChoice?: string;
    }> = [];

    await harness.runtime.executeNonStreamingToolLoop({
      provider: {
        config: {
          id: "test",
          type: "openai-compatible",
          defaultModel: "test-model",
        },
        supportsHostedWebSearch: () => false,
        chatCompletionWithTools: async (
          _messages: ChatMessage[],
          tools: ToolDefinition[] | undefined,
          _signal: AbortSignal | undefined,
          options: { toolChoice?: string } | undefined,
        ) => {
          calls.push({ tools, toolChoice: options?.toolChoice });
          return {
            content: `part-${calls.length}`,
            stopReason: "max_tokens",
          };
        },
      } as any,
      currentMessages: harness.currentMessages,
      assistantMessage: harness.assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      tools: [searchTool],
      sendingSession: harness.session,
    });

    assert.lengthOf(calls, 4);
    assert.equal(
      harness.assistantMessage.content,
      `part-1part-2part-3part-4${OUTPUT_TRUNCATION_NOTICE}`,
    );
    assert.deepEqual(calls[0].tools, [searchTool]);
    for (const call of calls.slice(1)) {
      assert.deepEqual(call.tools, []);
      assert.equal(call.toolChoice, "none");
    }
  });

  it("continues reasoning-only output without an empty assistant context message", async function () {
    const harness = createHarness();
    const callMessages: ChatMessage[][] = [];
    let calls = 0;

    await harness.runtime.executeNonStreamingToolLoop({
      provider: {
        config: {
          id: "test",
          type: "openai-compatible",
          defaultModel: "test-model",
        },
        supportsHostedWebSearch: () => false,
        chatCompletionWithTools: async (messages: ChatMessage[]) => {
          calls += 1;
          callMessages.push(messages.map((message) => ({ ...message })));
          return calls === 1
            ? {
                content: "",
                reasoning: "reasoning-1",
                stopReason: "max_tokens",
              }
            : {
                content: "answer",
                reasoning: "reasoning-2",
                stopReason: "end_turn",
              };
        },
      } as any,
      currentMessages: harness.currentMessages,
      assistantMessage: harness.assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      tools: [searchTool],
      sendingSession: harness.session,
    });

    assert.equal(harness.assistantMessage.content, "answer");
    assert.equal(harness.assistantMessage.reasoning, "reasoning-1reasoning-2");
    assert.lengthOf(callMessages, 2);
    assert.deepEqual(
      callMessages[1].slice(1).map((message) => message.role),
      ["user"],
    );
    assert.match(
      callMessages[1].at(-1)?.content || "",
      /Continue your reasoning/,
    );
  });

  it("continues reasoning-only truncation on a non-streaming final synthesis round", async function () {
    const harness = createHarness();
    harness.runtime.getMaxIterations = () => 1;
    let calls = 0;

    await harness.runtime.executeNonStreamingToolLoop({
      provider: {
        config: {
          id: "test",
          type: "openai-compatible",
          defaultModel: "test-model",
        },
        supportsHostedWebSearch: () => false,
        chatCompletionWithTools: async () => {
          calls += 1;
          return calls === 1
            ? {
                content: "",
                reasoning: "final reasoning",
                stopReason: "max_tokens",
              }
            : { content: "final answer", stopReason: "end_turn" };
        },
      } as any,
      currentMessages: harness.currentMessages,
      assistantMessage: harness.assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      tools: [searchTool],
      sendingSession: harness.session,
    });

    assert.equal(calls, 2);
    assert.equal(harness.assistantMessage.content, "final answer");
    assert.equal(harness.assistantMessage.reasoning, "final reasoning");
  });

  it("continues reasoning-only truncation on a streamed final synthesis round", async function () {
    const harness = createHarness();
    harness.runtime.getMaxIterations = () => 1;
    let calls = 0;

    await harness.runtime.executeStreamingToolLoop({
      provider: {
        config: {
          id: "test",
          type: "openai-compatible",
          defaultModel: "test-model",
        },
        supportsHostedWebSearch: () => false,
        chatCompletionWithTools: async () => ({ content: "unused" }),
        streamChatCompletionWithTools: async (
          _messages: ChatMessage[],
          _tools: ToolDefinition[],
          callbacks: any,
        ) => {
          calls += 1;
          if (calls === 1) {
            callbacks.onReasoningDelta("final reasoning");
            callbacks.onComplete({
              content: "",
              reasoning: "final reasoning",
              stopReason: "max_tokens",
            });
            return;
          }
          callbacks.onTextDelta("final answer");
          callbacks.onComplete({
            content: "final answer",
            stopReason: "end_turn",
          });
        },
      } as any,
      currentMessages: harness.currentMessages,
      assistantMessage: harness.assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      tools: [searchTool],
      sendingSession: harness.session,
    });

    assert.equal(calls, 2);
    assert.equal(harness.assistantMessage.content, "final answer");
    assert.equal(harness.assistantMessage.reasoning, "final reasoning");
  });

  it("rejects tool protocol leaked by a text-only continuation", async function () {
    const harness = createHarness();
    let calls = 0;
    let rejected: unknown;

    try {
      await harness.runtime.executeNonStreamingToolLoop({
        provider: {
          config: {
            id: "test",
            type: "openai-compatible",
            defaultModel: "test-model",
          },
          supportsHostedWebSearch: () => false,
          chatCompletionWithTools: async () => {
            calls += 1;
            return calls === 1
              ? {
                  content: "partial answer",
                  stopReason: "max_tokens",
                }
              : {
                  content: "",
                  suppressedToolCall: true,
                  stopReason: "tool_calls",
                };
          },
        } as any,
        currentMessages: harness.currentMessages,
        assistantMessage: harness.assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: [searchTool],
        sendingSession: harness.session,
      });
    } catch (error) {
      rejected = error;
    }

    assert.instanceOf(rejected, Error);
    assert.equal(
      (rejected as Error).message,
      OUTPUT_CONTINUATION_TOOL_PROTOCOL_ERROR,
    );
    assert.equal(harness.assistantMessage.content, "partial answer");
    assert.equal(calls, 2);
  });

  it("rejects structured tool calls leaked by a text-only continuation", async function () {
    const harness = createHarness();
    let calls = 0;
    let rejected: unknown;

    try {
      await harness.runtime.executeNonStreamingToolLoop({
        provider: {
          config: {
            id: "test",
            type: "openai-compatible",
            defaultModel: "test-model",
          },
          supportsHostedWebSearch: () => false,
          chatCompletionWithTools: async () => {
            calls += 1;
            return calls === 1
              ? {
                  content: "accepted partial",
                  stopReason: "max_tokens",
                }
              : {
                  content: "forbidden continuation",
                  toolCalls: [
                    {
                      id: "forbidden-call",
                      type: "function",
                      function: { name: "search", arguments: "{}" },
                    },
                  ],
                  stopReason: "end_turn",
                };
          },
        } as any,
        currentMessages: harness.currentMessages,
        assistantMessage: harness.assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: [searchTool],
        sendingSession: harness.session,
      });
    } catch (error) {
      rejected = error;
    }

    assert.instanceOf(rejected, Error);
    assert.equal(
      (rejected as Error).message,
      OUTPUT_CONTINUATION_TOOL_PROTOCOL_ERROR,
    );
    assert.equal(harness.assistantMessage.content, "accepted partial");
    assert.deepEqual(harness.session.toolExecutionState?.results || [], []);
    assert.equal(calls, 2);
  });

  it("rejects hosted web search leaked by a non-streaming continuation without persisting it", async function () {
    const harness = createHarness();
    let calls = 0;
    let rejected: unknown;

    try {
      await harness.runtime.executeNonStreamingToolLoop({
        provider: {
          config: {
            id: "test",
            type: "openai-compatible",
            defaultModel: "test-model",
          },
          supportsHostedWebSearch: () => false,
          chatCompletionWithTools: async () => {
            calls += 1;
            return calls === 1
              ? {
                  content: "accepted partial",
                  stopReason: "max_tokens",
                }
              : {
                  content: "forbidden continuation",
                  hostedWebSearches: [
                    {
                      id: "forbidden-search",
                      index: 0,
                      status: "completed",
                      queries: ["should not persist"],
                      sources: [
                        {
                          title: "Forbidden source",
                          url: "https://example.test/forbidden",
                        },
                      ],
                    },
                  ],
                  stopReason: "end_turn",
                };
          },
        } as any,
        currentMessages: harness.currentMessages,
        assistantMessage: harness.assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: [searchTool],
        sendingSession: harness.session,
      });
    } catch (error) {
      rejected = error;
    }

    assert.instanceOf(rejected, Error);
    assert.equal(
      (rejected as Error).message,
      OUTPUT_CONTINUATION_TOOL_PROTOCOL_ERROR,
    );
    assert.equal(harness.assistantMessage.content, "accepted partial");
    assert.deepEqual(harness.session.toolExecutionState?.results || [], []);
    assert.equal(calls, 2);
  });

  it("rejects hosted web search leaked by a streamed continuation without persisting it", async function () {
    const harness = createHarness(
      () => true,
      () => true,
    );
    const scheduledSnapshots: string[] = [];
    harness.runtime.messageCheckpointer.schedule = (
      _session: ChatSession,
      _sessionRunId: number | undefined,
      message: ChatMessage,
    ) => {
      scheduledSnapshots.push(message.content);
    };
    let calls = 0;
    let rejected: unknown;

    try {
      await harness.runtime.executeStreamingToolLoop({
        provider: {
          config: {
            id: "test",
            type: "openai-compatible",
            defaultModel: "test-model",
          },
          supportsHostedWebSearch: () => false,
          chatCompletionWithTools: async () => ({ content: "unused" }),
          streamChatCompletionWithTools: async (
            _messages: ChatMessage[],
            _tools: ToolDefinition[],
            callbacks: any,
          ) => {
            calls += 1;
            if (calls === 1) {
              callbacks.onReasoningDelta?.("accepted reasoning");
              callbacks.onTextDelta("accepted partial");
              callbacks.onComplete({
                content: "accepted partial",
                reasoning: "accepted reasoning",
                stopReason: "max_tokens",
              });
              return;
            }
            const hostedWebSearch = {
              id: "forbidden-stream-search",
              index: 0,
              status: "completed" as const,
              queries: ["should not persist"],
              sources: [
                {
                  title: "Forbidden source",
                  url: "https://example.test/forbidden-stream",
                },
              ],
            };
            callbacks.onHostedWebSearchStatus?.(hostedWebSearch);
            callbacks.onReasoningDelta?.("forbidden reasoning");
            callbacks.onTextDelta("forbidden continuation");
            callbacks.onComplete({
              content: "forbidden continuation",
              reasoning: "forbidden reasoning",
              hostedWebSearches: [hostedWebSearch],
              stopReason: "end_turn",
            });
          },
        } as any,
        currentMessages: harness.currentMessages,
        assistantMessage: harness.assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: [searchTool],
        sendingSession: harness.session,
      });
    } catch (error) {
      rejected = error;
    }

    assert.instanceOf(rejected, Error);
    assert.equal(
      (rejected as Error).message,
      OUTPUT_CONTINUATION_TOOL_PROTOCOL_ERROR,
    );
    assert.equal(harness.assistantMessage.content, "accepted partial");
    assert.equal(harness.assistantMessage.reasoning, "accepted reasoning");
    assert.deepEqual(harness.session.toolExecutionState?.results || [], []);
    assert.notInclude(
      harness.streamingUpdates.join("\n"),
      "forbidden continuation",
    );
    assert.notInclude(scheduledSnapshots.join("\n"), "forbidden continuation");
    assert.equal(calls, 2);
  });

  it("continues streamed output at most three times", async function () {
    const harness = createHarness();
    let calls = 0;

    await harness.runtime.executeStreamingToolLoop({
      provider: {
        config: {
          id: "test",
          type: "openai-compatible",
          defaultModel: "test-model",
        },
        supportsHostedWebSearch: () => false,
        chatCompletionWithTools: async () => ({ content: "unused" }),
        streamChatCompletionWithTools: async (
          _messages: ChatMessage[],
          _tools: ToolDefinition[],
          callbacks: any,
        ) => {
          calls += 1;
          const content = `part-${calls}`;
          callbacks.onTextDelta(content);
          callbacks.onComplete({ content, stopReason: "max_tokens" });
        },
      } as any,
      currentMessages: harness.currentMessages,
      assistantMessage: harness.assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      tools: [searchTool],
      sendingSession: harness.session,
    });

    assert.equal(calls, 4);
    assert.equal(
      harness.assistantMessage.content,
      `part-1part-2part-3part-4${OUTPUT_TRUNCATION_NOTICE}`,
    );
  });

  it("marks an empty max-token response as incomplete without retrying", async function () {
    const harness = createHarness();
    let calls = 0;

    await harness.runtime.executeNonStreamingToolLoop({
      provider: {
        config: {
          id: "test",
          type: "openai-compatible",
          defaultModel: "test-model",
        },
        supportsHostedWebSearch: () => false,
        chatCompletionWithTools: async () => {
          calls += 1;
          return { content: "", stopReason: "max_tokens" };
        },
      } as any,
      currentMessages: harness.currentMessages,
      assistantMessage: harness.assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      tools: [searchTool],
      sendingSession: harness.session,
    });

    assert.equal(calls, 1);
    assert.equal(harness.assistantMessage.content, OUTPUT_TRUNCATION_NOTICE);
  });

  it("does not auto-continue an incomplete fallback tool protocol", async function () {
    const harness = createHarness();
    let calls = 0;

    await harness.runtime.executeNonStreamingToolLoop({
      provider: {
        config: {
          id: "test",
          type: "openai-compatible",
          defaultModel: "test-model",
        },
        supportsHostedWebSearch: () => false,
        chatCompletionWithTools: async () => {
          calls += 1;
          return {
            content: "safe preface",
            incompleteToolProtocol: true,
            stopReason: "max_tokens",
          };
        },
      } as any,
      currentMessages: harness.currentMessages,
      assistantMessage: harness.assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      tools: [searchTool],
      sendingSession: harness.session,
    });

    assert.equal(calls, 1);
    assert.equal(
      harness.assistantMessage.content,
      `safe preface${OUTPUT_TRUNCATION_NOTICE}`,
    );
  });

  it("does not auto-continue an incomplete streamed fallback tool protocol", async function () {
    const harness = createHarness();
    let calls = 0;

    await harness.runtime.executeStreamingToolLoop({
      provider: {
        config: {
          id: "test",
          type: "openai-compatible",
          defaultModel: "test-model",
        },
        supportsHostedWebSearch: () => false,
        chatCompletionWithTools: async () => ({ content: "unused" }),
        streamChatCompletionWithTools: async (
          _messages: ChatMessage[],
          _tools: ToolDefinition[],
          callbacks: any,
        ) => {
          calls += 1;
          callbacks.onTextDelta("safe preface");
          callbacks.onComplete({
            content: "safe preface",
            incompleteToolProtocol: true,
            stopReason: "max_tokens",
          });
        },
      } as any,
      currentMessages: harness.currentMessages,
      assistantMessage: harness.assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      tools: [searchTool],
      sendingSession: harness.session,
    });

    assert.equal(calls, 1);
    assert.equal(
      harness.assistantMessage.content,
      `safe preface${OUTPUT_TRUNCATION_NOTICE}`,
    );
  });

  it("does not persist hosted search leaked by a non-streaming final synthesis", async function () {
    const harness = createHarness();
    harness.runtime.getMaxIterations = () => 1;

    await harness.runtime.executeNonStreamingToolLoop({
      provider: {
        config: {
          id: "test",
          type: "openai-compatible",
          defaultModel: "test-model",
        },
        supportsHostedWebSearch: () => true,
        chatCompletionWithTools: async () => ({
          content: "forbidden final search",
          hostedWebSearches: [
            {
              id: "forbidden-final-search",
              index: 0,
              status: "completed",
              queries: ["forbidden"],
              sources: [{ url: "https://example.test/forbidden-final" }],
            },
          ],
          stopReason: "end_turn",
        }),
      } as any,
      currentMessages: harness.currentMessages,
      assistantMessage: harness.assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      tools: [webSearchTool],
      sendingSession: harness.session,
    });

    assert.deepEqual(harness.session.toolExecutionState?.results || [], []);
    assert.notInclude(
      harness.assistantMessage.content,
      "https://example.test/forbidden-final",
    );
  });

  it("does not display or persist hosted search leaked by a streamed final synthesis", async function () {
    const harness = createHarness(
      () => true,
      () => true,
    );
    harness.runtime.getMaxIterations = () => 1;
    harness.runtime.callbacks.formatToolCallCard = () =>
      "FORBIDDEN_HOSTED_SEARCH_CARD";

    await harness.runtime.executeStreamingToolLoop({
      provider: {
        config: {
          id: "test",
          type: "openai-compatible",
          defaultModel: "test-model",
        },
        supportsHostedWebSearch: () => true,
        chatCompletionWithTools: async () => ({ content: "unused" }),
        streamChatCompletionWithTools: async (
          _messages: ChatMessage[],
          _tools: ToolDefinition[],
          callbacks: any,
        ) => {
          const hostedSearch = {
            id: "forbidden-final-stream-search",
            index: 0,
            status: "completed" as const,
            queries: ["forbidden"],
            sources: [{ url: "https://example.test/forbidden-final-stream" }],
          };
          callbacks.onHostedWebSearchStatus(hostedSearch);
          callbacks.onTextDelta("forbidden final stream search");
          callbacks.onComplete({
            content: "forbidden final stream search",
            hostedWebSearches: [hostedSearch],
            stopReason: "end_turn",
          });
        },
      } as any,
      currentMessages: harness.currentMessages,
      assistantMessage: harness.assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      tools: [webSearchTool],
      sendingSession: harness.session,
    });

    assert.deepEqual(harness.session.toolExecutionState?.results || [], []);
    assert.notInclude(
      harness.streamingUpdates.join("\n"),
      "FORBIDDEN_HOSTED_SEARCH_CARD",
    );
    assert.notInclude(
      harness.assistantMessage.content,
      "https://example.test/forbidden-final-stream",
    );
  });

  it("does not display or persist hosted search omitted from an auto round", async function () {
    const harness = createHarness();
    harness.runtime.callbacks.formatToolCallCard = () =>
      "FORBIDDEN_HOSTED_SEARCH_CARD";

    await harness.runtime.executeNonStreamingToolLoop({
      provider: {
        config: {
          id: "test",
          type: "openai-compatible",
          defaultModel: "test-model",
        },
        supportsHostedWebSearch: () => true,
        chatCompletionWithTools: async () => ({
          content: "answer without authorized web evidence",
          hostedWebSearches: [
            {
              id: "unoffered-auto-search",
              index: 0,
              status: "completed",
              queries: ["unoffered"],
              sources: [{ url: "https://example.test/unoffered-auto" }],
            },
          ],
          stopReason: "end_turn",
        }),
      } as any,
      currentMessages: harness.currentMessages,
      assistantMessage: harness.assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      tools: [searchTool],
      sendingSession: harness.session,
    });

    assert.deepEqual(harness.session.toolExecutionState?.results || [], []);
    assert.notInclude(
      harness.assistantMessage.content,
      "FORBIDDEN_HOSTED_SEARCH_CARD",
    );
    assert.notInclude(
      harness.assistantMessage.content,
      "https://example.test/unoffered-auto",
    );
  });

  it("does not stream or persist hosted search omitted from an auto round", async function () {
    const harness = createHarness(
      () => true,
      () => true,
    );
    harness.runtime.callbacks.formatToolCallCard = () =>
      "FORBIDDEN_HOSTED_SEARCH_CARD";

    await harness.runtime.executeStreamingToolLoop({
      provider: {
        config: {
          id: "test",
          type: "openai-compatible",
          defaultModel: "test-model",
        },
        supportsHostedWebSearch: () => true,
        chatCompletionWithTools: async () => ({ content: "unused" }),
        streamChatCompletionWithTools: async (
          _messages: ChatMessage[],
          _tools: ToolDefinition[],
          callbacks: any,
        ) => {
          const hostedSearch = {
            id: "unoffered-auto-stream-search",
            index: 0,
            status: "completed" as const,
            queries: ["unoffered"],
            sources: [{ url: "https://example.test/unoffered-auto-stream" }],
          };
          callbacks.onHostedWebSearchStatus(hostedSearch);
          callbacks.onTextDelta("answer without authorized web evidence");
          callbacks.onComplete({
            content: "answer without authorized web evidence",
            hostedWebSearches: [hostedSearch],
            stopReason: "end_turn",
          });
        },
      } as any,
      currentMessages: harness.currentMessages,
      assistantMessage: harness.assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      tools: [searchTool],
      sendingSession: harness.session,
    });

    assert.deepEqual(harness.session.toolExecutionState?.results || [], []);
    assert.notInclude(
      harness.streamingUpdates.join("\n"),
      "FORBIDDEN_HOSTED_SEARCH_CARD",
    );
    assert.notInclude(
      harness.assistantMessage.content,
      "FORBIDDEN_HOSTED_SEARCH_CARD",
    );
    assert.notInclude(
      harness.assistantMessage.content,
      "https://example.test/unoffered-auto-stream",
    );
  });

  it("does not multiply non-streaming continuation failures through the generic retry executor", async function () {
    const harness = createHarness();
    const retryExecutor = createFourAttemptExecutor();
    let providerCalls = 0;
    let rejected: unknown;

    try {
      await harness.runtime.executeNonStreamingToolLoop({
        provider: {
          config: {
            id: "test",
            type: "openai-compatible",
            defaultModel: "test-model",
          },
          supportsHostedWebSearch: () => false,
          chatCompletionWithTools: async () => {
            providerCalls += 1;
            if (providerCalls === 1) {
              return { content: "accepted partial", stopReason: "max_tokens" };
            }
            throw new Error("429 rate limit");
          },
        } as any,
        currentMessages: harness.currentMessages,
        assistantMessage: harness.assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: [searchTool],
        sendingSession: harness.session,
        executeProviderRequest: retryExecutor.execute,
      });
    } catch (error) {
      rejected = error;
    }

    assert.equal((rejected as Error).message, "429 rate limit");
    assert.equal(retryExecutor.getExecutorCalls(), 1);
    assert.equal(providerCalls, 2);
    assert.equal(harness.assistantMessage.content, "accepted partial");
  });

  it("does not multiply streamed continuation failures through the generic retry executor", async function () {
    const harness = createHarness();
    const retryExecutor = createFourAttemptExecutor();
    let providerCalls = 0;
    let rejected: unknown;

    try {
      await harness.runtime.executeStreamingToolLoop({
        provider: {
          config: {
            id: "test",
            type: "openai-compatible",
            defaultModel: "test-model",
          },
          supportsHostedWebSearch: () => false,
          chatCompletionWithTools: async () => ({ content: "unused" }),
          streamChatCompletionWithTools: async (
            _messages: ChatMessage[],
            _tools: ToolDefinition[],
            callbacks: any,
          ) => {
            providerCalls += 1;
            if (providerCalls === 1) {
              callbacks.onTextDelta("accepted partial");
              callbacks.onComplete({
                content: "accepted partial",
                stopReason: "max_tokens",
              });
              return;
            }
            callbacks.onError(new Error("503 service unavailable"));
          },
        } as any,
        currentMessages: harness.currentMessages,
        assistantMessage: harness.assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: [searchTool],
        sendingSession: harness.session,
        executeProviderRequest: retryExecutor.execute,
      });
    } catch (error) {
      rejected = error;
    }

    assert.equal((rejected as Error).message, "503 service unavailable");
    assert.equal(retryExecutor.getExecutorCalls(), 1);
    assert.equal(providerCalls, 2);
    assert.equal(harness.assistantMessage.content, "accepted partial");
  });

  it("keeps partial non-streaming output when a continuation fails", async function () {
    const harness = createHarness();
    let calls = 0;

    try {
      await harness.runtime.executeNonStreamingToolLoop({
        provider: {
          config: {
            id: "test",
            type: "openai-compatible",
            defaultModel: "test-model",
          },
          supportsHostedWebSearch: () => false,
          chatCompletionWithTools: async () => {
            calls += 1;
            if (calls === 1) {
              return {
                content: "partial answer",
                stopReason: "max_tokens",
              };
            }
            throw new Error("continuation failed");
          },
        } as any,
        currentMessages: harness.currentMessages,
        assistantMessage: harness.assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: [searchTool],
        sendingSession: harness.session,
      });
      assert.fail("Expected the continuation request to fail");
    } catch (error) {
      assert.equal((error as Error).message, "continuation failed");
    }

    assert.equal(harness.assistantMessage.content, "partial answer");
    assert.include(harness.checkpoints, "partial answer");
  });

  it("keeps the best streamed continuation partial when it fails", async function () {
    const harness = createHarness();
    let calls = 0;
    let rejected: unknown;

    try {
      await harness.runtime.executeStreamingToolLoop({
        provider: {
          config: {
            id: "test",
            type: "openai-compatible",
            defaultModel: "test-model",
          },
          supportsHostedWebSearch: () => false,
          chatCompletionWithTools: async () => ({ content: "unused" }),
          streamChatCompletionWithTools: async (
            _messages: ChatMessage[],
            _tools: ToolDefinition[],
            callbacks: any,
          ) => {
            calls += 1;
            if (calls === 1) {
              callbacks.onTextDelta("partial");
              callbacks.onComplete({
                content: "partial",
                stopReason: "max_tokens",
              });
              return;
            }
            callbacks.onTextDelta(" plus-more");
            callbacks.onError(new Error("stream continuation failed"));
          },
        } as any,
        currentMessages: harness.currentMessages,
        assistantMessage: harness.assistantMessage,
        pdfWasAttached: false,
        summaryTriggered: false,
        tools: [searchTool],
        sendingSession: harness.session,
      });
    } catch (error) {
      rejected = error;
    }

    assert.instanceOf(rejected, Error);
    assert.equal((rejected as Error).message, "stream continuation failed");
    assert.equal(harness.assistantMessage.content, "partial plus-more");
    assert.include(harness.checkpoints, "partial plus-more");
  });

  it("ignores a continuation result after the session run is invalidated", async function () {
    let tracked = true;
    const harness = createHarness(() => tracked);
    let calls = 0;
    let resolveContinuationStarted!: () => void;
    const continuationStarted = new Promise<void>((resolve) => {
      resolveContinuationStarted = resolve;
    });
    let resolveContinuation!: (value: {
      content: string;
      stopReason: "end_turn";
      hostedWebSearches: Array<{
        id: string;
        index: number;
        status: "completed";
        queries: string[];
        sources: Array<{ title: string; url: string }>;
      }>;
    }) => void;

    const execution = harness.runtime.executeNonStreamingToolLoop({
      provider: {
        config: {
          id: "test",
          type: "openai-compatible",
          defaultModel: "test-model",
        },
        supportsHostedWebSearch: () => false,
        chatCompletionWithTools: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              content: "partial answer",
              stopReason: "max_tokens" as const,
            };
          }
          resolveContinuationStarted();
          return await new Promise((resolve) => {
            resolveContinuation = resolve;
          });
        },
      } as any,
      currentMessages: harness.currentMessages,
      assistantMessage: harness.assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      tools: [searchTool],
      sendingSession: harness.session,
    });

    await continuationStarted;
    const sessionBeforeInvalidatedResult = structuredClone(harness.session);
    const assistantBeforeInvalidatedResult = structuredClone(
      harness.assistantMessage,
    );
    tracked = false;
    resolveContinuation({
      content: "late continuation",
      stopReason: "end_turn",
      hostedWebSearches: [
        {
          id: "late-search",
          index: 0,
          status: "completed",
          queries: ["late query"],
          sources: [{ title: "Late source", url: "https://example.test/late" }],
        },
      ],
    });

    await execution;

    assert.equal(calls, 2);
    assert.deepEqual(harness.session, sessionBeforeInvalidatedResult);
    assert.deepEqual(
      harness.assistantMessage,
      assistantBeforeInvalidatedResult,
    );
    assert.equal(harness.assistantMessage.content, "partial answer");
    assert.notInclude(harness.checkpoints, "partial answerlate continuation");
  });

  it("ignores streamed continuation deltas after the session run is invalidated", async function () {
    let tracked = true;
    const harness = createHarness(() => tracked);
    let calls = 0;
    let resolveContinuationStarted!: () => void;
    const continuationStarted = new Promise<void>((resolve) => {
      resolveContinuationStarted = resolve;
    });
    let releaseContinuation!: () => void;
    const continuationRelease = new Promise<void>((resolve) => {
      releaseContinuation = resolve;
    });

    const execution = harness.runtime.executeStreamingToolLoop({
      provider: {
        config: {
          id: "test",
          type: "openai-compatible",
          defaultModel: "test-model",
        },
        supportsHostedWebSearch: () => false,
        chatCompletionWithTools: async () => ({ content: "unused" }),
        streamChatCompletionWithTools: async (
          _messages: ChatMessage[],
          _tools: ToolDefinition[],
          callbacks: any,
        ) => {
          calls += 1;
          if (calls === 1) {
            callbacks.onReasoningDelta?.("accepted reasoning");
            callbacks.onTextDelta("partial answer");
            callbacks.onComplete({
              content: "partial answer",
              reasoning: "accepted reasoning",
              stopReason: "max_tokens",
            });
            return;
          }

          resolveContinuationStarted();
          await continuationRelease;
          callbacks.onReasoningDelta?.("late reasoning");
          callbacks.onTextDelta("late continuation");
          callbacks.onComplete({
            content: "late continuation",
            reasoning: "late reasoning",
            stopReason: "end_turn",
          });
        },
      } as any,
      currentMessages: harness.currentMessages,
      assistantMessage: harness.assistantMessage,
      pdfWasAttached: false,
      summaryTriggered: false,
      tools: [searchTool],
      sendingSession: harness.session,
    });

    await continuationStarted;
    const sessionBeforeInvalidatedResult = structuredClone(harness.session);
    const assistantBeforeInvalidatedResult = structuredClone(
      harness.assistantMessage,
    );
    const eventsBeforeInvalidatedResult = structuredClone(
      harness.runtimeEvents,
    );
    tracked = false;
    releaseContinuation();

    await execution;

    assert.equal(calls, 2);
    assert.deepEqual(harness.session, sessionBeforeInvalidatedResult);
    assert.deepEqual(
      harness.assistantMessage,
      assistantBeforeInvalidatedResult,
    );
    assert.deepEqual(harness.runtimeEvents, eventsBeforeInvalidatedResult);
    assert.equal(harness.assistantMessage.content, "partial answer");
    assert.equal(harness.assistantMessage.reasoning, "accepted reasoning");
    assert.notInclude(harness.checkpoints, "partial answerlate continuation");
  });
});
