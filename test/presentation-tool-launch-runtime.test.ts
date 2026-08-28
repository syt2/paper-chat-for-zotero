import { assert } from "chai";
import { AgentRuntime } from "../src/modules/chat/agent-runtime/AgentRuntime.ts";
import { createPresentationToolDefinition } from "../src/modules/presentation/PresentationCapability.ts";
import { PresentationLaunchCoordinator } from "../src/modules/presentation/PresentationLaunchCoordinator.ts";
import { DEFAULT_PRESENTATION_LAUNCH_SETTINGS } from "../src/modules/presentation/PresentationLaunchSettings.ts";
import {
  createPresentationLaunchToolDefinition,
  createPresentationToolLaunchSession,
} from "../src/modules/presentation/PresentationToolLaunchSession.ts";
import type { ChatMessage, ChatSession } from "../src/types/chat.ts";
import type { ToolCall, ToolDefinition } from "../src/types/tool.ts";

type RuntimeMode = "non-streaming" | "streaming";

async function runPresentationHandoff(
  mode: RuntimeMode,
  includeStableRequestTools = true,
): Promise<void> {
  const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
  (globalThis as { ztoolkit?: unknown }).ztoolkit = {
    log: () => undefined,
  };

  const userMessage: ChatMessage = {
    id: "user-ppt-launch",
    role: "user",
    content: "为这篇论文生成一个 PPT",
    timestamp: 1,
  };
  const assistantMessage: ChatMessage = {
    id: "assistant-ppt-launch",
    role: "assistant",
    content: "",
    timestamp: 2,
  };
  const session = {
    id: "session-ppt-launch",
    createdAt: 1,
    updatedAt: 1,
    lastActiveItemKey: "PAPER-A",
    lastActiveItemLibraryID: 1,
    messages: [userMessage, assistantMessage],
  } as ChatSession;
  const launchSession = createPresentationToolLaunchSession({
    coordinator: new PresentationLaunchCoordinator(1),
    source: { itemKey: "PAPER-A", libraryID: 1 },
    runGuard: async () => ({
      allowed: true,
      balance: {
        quota: 600_000,
        subscriptionRemaining: 0,
        available: 600_000,
      },
      settings: DEFAULT_PRESENTATION_LAUNCH_SETTINGS,
    }),
  });
  const toolsSeenByRound: string[][] = [];
  const executedCalls: ToolCall[] = [];
  const requestTools = [
    createPresentationLaunchToolDefinition(),
    createPresentationToolDefinition(),
  ].sort((left, right) =>
    left.function.name.localeCompare(right.function.name),
  );
  let providerRound = 0;

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
        let nextId = 0;
        return () => `ppt-launch-${++nextId}`;
      })(),
    } as any,
    {
      createExecutionBatches: (requests: any[]) => [requests],
      executeBatch: async (requests: any[]) => {
        const results = [];
        for (const request of requests) {
          executedCalls.push(request.toolCall);
          if (request.toolCall.function.name === "request_presentation") {
            const result =
              await request.executionContext.presentationLaunchSession.requestAuthorization();
            assert.isTrue(result.allowed);
            results.push({
              toolCall: request.toolCall,
              args: {},
              status: "completed" as const,
              content: "Native settings confirmed; call presentation.",
            });
            continue;
          }
          assert.equal(request.toolCall.function.name, "presentation");
          assert.strictEqual(
            request.executionContext.presentationAuthorization,
            launchSession.getAuthorization(),
          );
          results.push({
            toolCall: request.toolCall,
            args: { sourceItemKey: "PAPER-A" },
            status: "completed" as const,
            content: JSON.stringify({
              status: "completed",
              path: "/safe/paper-a.pptx",
              slideCount: 6,
            }),
          });
        }
        return results;
      },
    },
  ) as any;
  // Two is the lowest supported user preference. The launcher must extend
  // this bounded turn so confirmation cannot consume the only tool round.
  runtime.getMaxIterations = () => 2;

  try {
    const nextResponse = (tools: ToolDefinition[]) => {
      providerRound += 1;
      toolsSeenByRound.push(tools.map((tool) => tool.function.name).sort());
      if (providerRound === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: "launch-call",
              type: "function" as const,
              function: {
                name: "request_presentation",
                arguments: "{}",
              },
            },
            {
              id: "premature-presentation-call",
              type: "function" as const,
              function: {
                name: "presentation",
                arguments: JSON.stringify({
                  sourceItemKey: "PAPER-A",
                }),
              },
            },
          ],
        };
      }
      if (providerRound === 2) {
        return {
          content: "",
          toolCalls: [
            {
              id: "presentation-call",
              type: "function" as const,
              function: {
                name: "presentation",
                arguments: JSON.stringify({
                  sourceItemKey: "PAPER-A",
                }),
              },
            },
          ],
        };
      }
      return { content: "PPT 已生成。", toolCalls: undefined };
    };
    const provider = {
      config: { id: "paperchat", type: "paperchat" },
      chatCompletionWithTools: async (
        _messages: ChatMessage[],
        tools: ToolDefinition[],
      ) => nextResponse(tools),
      streamChatCompletionWithTools: async (
        _messages: ChatMessage[],
        tools: ToolDefinition[],
        callbacks: any,
      ) => {
        const response = nextResponse(tools);
        for (const [index, toolCall] of (response.toolCalls || []).entries()) {
          callbacks.onToolCallStart({
            index,
            id: toolCall.id,
            name: toolCall.function.name,
          });
          callbacks.onToolCallDelta(index, toolCall.function.arguments);
        }
        if (response.content) callbacks.onTextDelta(response.content);
        callbacks.onComplete({
          ...response,
          stopReason: response.toolCalls?.length ? "tool_calls" : "end_turn",
        });
      },
    };
    const options = {
      provider,
      currentMessages: session.messages,
      assistantMessage,
      pdfWasAttached: true,
      summaryTriggered: false,
      tools: [createPresentationLaunchToolDefinition()],
      ...(includeStableRequestTools ? { requestTools } : {}),
      sendingSession: session,
      currentItemKey: "PAPER-A",
      currentItemLibraryID: 1,
      presentationLaunchSession: launchSession,
    };

    if (mode === "streaming") {
      await runtime.executeStreamingToolLoop(options as any);
    } else {
      await runtime.executeNonStreamingToolLoop(options as any);
    }

    assert.deepEqual(
      toolsSeenByRound,
      includeStableRequestTools
        ? [
            ["presentation", "request_presentation"],
            ["presentation", "request_presentation"],
            ["presentation", "request_presentation"],
          ]
        : [["request_presentation"], ["presentation"], ["presentation"]],
    );
    assert.deepEqual(
      executedCalls.map((call) => call.function.name),
      ["request_presentation", "presentation"],
    );
    assert.equal(providerRound, 3);
    assert.include(assistantMessage.content, "PPT 已生成");
  } finally {
    launchSession.finish();
    (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
  }
}

async function runBlockedPresentationHandoff(
  mode: RuntimeMode,
  guardOutcome: "cancelled" | "throws",
): Promise<void> {
  const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
  (globalThis as { ztoolkit?: unknown }).ztoolkit = {
    log: () => undefined,
  };

  const userMessage: ChatMessage = {
    id: `user-ppt-${guardOutcome}`,
    role: "user",
    content: "为这篇论文生成一个 PPT",
    timestamp: 1,
  };
  const assistantMessage: ChatMessage = {
    id: `assistant-ppt-${guardOutcome}`,
    role: "assistant",
    content: "",
    timestamp: 2,
  };
  const chatSession = {
    id: `session-ppt-${guardOutcome}`,
    createdAt: 1,
    updatedAt: 1,
    lastActiveItemKey: "PAPER-A",
    lastActiveItemLibraryID: 1,
    messages: [userMessage, assistantMessage],
  } as ChatSession;
  const coordinator = new PresentationLaunchCoordinator(1);
  const launchSession = createPresentationToolLaunchSession({
    coordinator,
    source: { itemKey: "PAPER-A", libraryID: 1 },
    runGuard: async () => {
      if (guardOutcome === "throws") {
        throw new Error("native guard failed");
      }
      return { allowed: false as const, reason: "cancelled" as const };
    },
  });
  const toolsSeenByRound: string[][] = [];
  const executedToolNames: string[] = [];
  const requestTools = [
    createPresentationLaunchToolDefinition(),
    createPresentationToolDefinition(),
  ].sort((left, right) =>
    left.function.name.localeCompare(right.function.name),
  );
  let providerRound = 0;

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
        let nextId = 0;
        return () => `ppt-blocked-${++nextId}`;
      })(),
    } as any,
    {
      createExecutionBatches: (requests: any[]) => [requests],
      executeBatch: async (requests: any[]) => {
        const results = [];
        for (const request of requests) {
          executedToolNames.push(request.toolCall.function.name);
          assert.equal(request.toolCall.function.name, "request_presentation");
          const result =
            await request.executionContext.presentationLaunchSession.requestAuthorization();
          assert.isFalse(result.allowed);
          results.push({
            toolCall: request.toolCall,
            args: {},
            status: "completed" as const,
            content: result.allowed
              ? "unexpected authorization"
              : `Launcher stopped: ${result.reason}`,
          });
        }
        return results;
      },
    },
  ) as any;
  runtime.getMaxIterations = () => 2;

  try {
    const nextResponse = (tools: ToolDefinition[]) => {
      providerRound += 1;
      toolsSeenByRound.push(tools.map((tool) => tool.function.name).sort());
      if (providerRound === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: `launch-${guardOutcome}`,
              type: "function" as const,
              function: {
                name: "request_presentation",
                arguments: "{}",
              },
            },
          ],
        };
      }
      return {
        content: "未开始生成 PPT。",
        toolCalls: undefined,
      };
    };
    const provider = {
      config: { id: "paperchat", type: "paperchat" },
      chatCompletionWithTools: async (
        _messages: ChatMessage[],
        tools: ToolDefinition[],
      ) => nextResponse(tools),
      streamChatCompletionWithTools: async (
        _messages: ChatMessage[],
        tools: ToolDefinition[],
        callbacks: any,
      ) => {
        const response = nextResponse(tools);
        for (const [index, toolCall] of (response.toolCalls || []).entries()) {
          callbacks.onToolCallStart({
            index,
            id: toolCall.id,
            name: toolCall.function.name,
          });
          callbacks.onToolCallDelta(index, toolCall.function.arguments);
        }
        if (response.content) callbacks.onTextDelta(response.content);
        callbacks.onComplete({
          ...response,
          stopReason: response.toolCalls?.length ? "tool_calls" : "end_turn",
        });
      },
    };
    const options = {
      provider,
      currentMessages: chatSession.messages,
      assistantMessage,
      pdfWasAttached: true,
      summaryTriggered: false,
      tools: [createPresentationLaunchToolDefinition()],
      requestTools,
      sendingSession: chatSession,
      currentItemKey: "PAPER-A",
      currentItemLibraryID: 1,
      presentationLaunchSession: launchSession,
    };

    if (mode === "streaming") {
      await runtime.executeStreamingToolLoop(options as any);
    } else {
      await runtime.executeNonStreamingToolLoop(options as any);
    }

    assert.equal(providerRound, 2);
    assert.deepEqual(executedToolNames, ["request_presentation"]);
    assert.deepEqual(toolsSeenByRound, [
      ["presentation", "request_presentation"],
      ["presentation", "request_presentation"],
    ]);
    assert.include(assistantMessage.content, "未开始生成 PPT");

    const replacement = createPresentationToolLaunchSession({
      coordinator,
      source: { itemKey: "PAPER-A", libraryID: 1 },
      runGuard: async () => ({
        allowed: true as const,
        balance: {
          quota: 300_000,
          subscriptionRemaining: 0,
          available: 300_000,
        },
        settings: DEFAULT_PRESENTATION_LAUNCH_SETTINGS,
      }),
    });
    assert.isTrue((await replacement.requestAuthorization()).allowed);
    replacement.finish();
  } finally {
    launchSession.finish();
    (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
  }
}

describe("presentation launcher runtime handoff", function () {
  for (const mode of ["non-streaming", "streaming"] as const) {
    it(`reserves private-tool and final-answer rounds in ${mode} mode`, async function () {
      await runPresentationHandoff(mode);
    });

    it(`keeps the optional request catalog in sync during ${mode} presentation handoff`, async function () {
      await runPresentationHandoff(mode, false);
    });

    for (const guardOutcome of ["cancelled", "throws"] as const) {
      it(`keeps presentation execution blocked after ${guardOutcome} guard in ${mode} mode`, async function () {
        await runBlockedPresentationHandoff(mode, guardOutcome);
      });
    }
  }
});
