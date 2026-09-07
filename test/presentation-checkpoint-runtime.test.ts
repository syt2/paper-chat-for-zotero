import { assert } from "chai";
import { AgentRuntime } from "../src/modules/chat/agent-runtime/AgentRuntime.ts";
import { createPresentationToolDefinition } from "../src/modules/presentation/PresentationCapability.ts";
import { DEFAULT_PRESENTATION_LAUNCH_SETTINGS } from "../src/modules/presentation/PresentationLaunchSettings.ts";
import type { ChatMessage, ChatSession } from "../src/types/chat.ts";

describe("presentation checkpoint runtime resume", function () {
  for (const mode of ["streaming", "non-streaming"] as const) {
    it(`directly resumes the saved tool and reuses its card in ${mode} mode`, async function () {
      const { createPresentationLaunchAuthorization } =
        await import("../src/modules/presentation/PresentationLaunchAuthorization.ts");
      const previous = (globalThis as any).ztoolkit;
      (globalThis as any).ztoolkit = { log: () => undefined };
      const source = { itemKey: "PAPER-A", libraryID: 1 };
      const checkpoint = {
        id: "ppt-runtime-check",
        args: { sourceItemKey: "PAPER-A" },
      } as any;
      const authorization = createPresentationLaunchAuthorization(
        source,
        DEFAULT_PRESENTATION_LAUNCH_SETTINGS,
        checkpoint,
      );
      const assistant: ChatMessage = {
        id: "assistant",
        role: "assistant",
        content: "Prior partial reply",
        timestamp: 2,
        presentationArtifacts: [
          {
            toolCallId: "old-call",
            localId: "original-card",
            checkpointId: checkpoint.id,
            isDraft: true,
            interruptedAt: 10,
          },
        ],
      };
      const session: ChatSession = {
        id: "resume-session",
        createdAt: 1,
        updatedAt: 2,
        lastActiveItemKey: source.itemKey,
        lastActiveItemLibraryID: 1,
        messages: [
          { id: "user", role: "user", content: "Make PPT", timestamp: 1 },
          assistant,
        ],
      };
      let toolCalls = 0,
        providerCalls = 0;
      const persisted: any[] = [];
      const runtime = new AgentRuntime(
        {
          updateMessageContent: async (...args: any[]) => {
            persisted.push(structuredClone(args));
          },
          updateSessionMeta: async () => undefined,
          saveSession: async () => undefined,
        } as any,
        {
          isSessionActive: () => false,
          isSessionTracked: () => true,
          formatToolCallCard: () => "PPT card",
          generateId: () => `message-${Math.random()}`,
        } as any,
        {
          createExecutionBatches: (requests: any[]) => [requests],
          executeBatch: async (requests: any[]) => {
            assert.equal(
              providerCalls,
              0,
              "must execute checkpoint before making an outer model request",
            );
            return Promise.all(
              requests.map(async (request) => {
                toolCalls++;
                assert.equal(request.toolCall.function.name, "presentation");
                assert.strictEqual(
                  request.executionContext.presentationAuthorization,
                  authorization,
                );
                await request.executionContext.presentationProgress({
                  phase: "planning",
                  message: "Resuming",
                  checkpointId: checkpoint.id,
                  isDraft: true,
                });
                assert.lengthOf(assistant.presentationArtifacts!, 1);
                assert.equal(
                  assistant.presentationArtifacts![0].localId,
                  "original-card",
                );
                assert.isUndefined(
                  assistant.presentationArtifacts![0].interruptedAt,
                );
                assert.isTrue(
                  persisted.some((args) =>
                    JSON.stringify(args).includes(checkpoint.id),
                  ),
                );
                return {
                  toolCall: request.toolCall,
                  args: checkpoint.args,
                  status: "completed" as const,
                  content: JSON.stringify({
                    status: "completed",
                    path: "/safe/result.pptx",
                    slideCount: 6,
                  }),
                };
              }),
            );
          },
        },
      ) as any;
      runtime.getMaxIterations = () => 2;
      const provider = {
        config: { id: "paperchat", type: "paperchat" },
        chatCompletionWithTools: async () => {
          providerCalls++;
          return { content: "PPT completed", stopReason: "end_turn" };
        },
        streamChatCompletionWithTools: async (
          _messages: unknown,
          _tools: unknown,
          callbacks: any,
        ) => {
          providerCalls++;
          callbacks.onTextDelta("PPT completed");
          callbacks.onComplete({
            content: "PPT completed",
            stopReason: "end_turn",
          });
        },
      };
      try {
        const options = {
          provider,
          currentMessages: session.messages,
          assistantMessage: assistant,
          sendingSession: session,
          pdfWasAttached: true,
          summaryTriggered: false,
          tools: [createPresentationToolDefinition()],
          currentItemKey: source.itemKey,
          currentItemLibraryID: 1,
          presentationAuthorization: authorization,
          preserveToolExecutionState: true,
        };
        if (mode === "streaming")
          await runtime.executeStreamingToolLoop(options);
        else await runtime.executeNonStreamingToolLoop(options);
        assert.equal(toolCalls, 1);
        assert.equal(providerCalls, 1);
        assert.lengthOf(
          session.messages.filter(
            (message) => message.role === "user" && !message.apiOnly,
          ),
          1,
        );
        assert.equal(assistant.presentationArtifacts![0].isDraft, false);
        assert.equal(
          assistant.presentationArtifacts![0].checkpointId,
          checkpoint.id,
        );
      } finally {
        (globalThis as any).ztoolkit = previous;
      }
    });
  }
});
