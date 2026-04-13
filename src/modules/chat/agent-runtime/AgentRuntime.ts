import type {
  ChatMessage,
  ChatSession,
  StreamToolCallingCallbacks,
} from "../../../types/chat";
import type {
  PaperStructure,
  PaperStructureExtended,
  ToolCall,
  ToolDefinition,
} from "../../../types/tool";
import type { ToolCallingProvider } from "../../../types/provider";
import { getErrorMessage } from "../../../utils/common";
import { getContextManager } from "../ContextManager";
import { getPdfToolManager } from "../pdf-tools";
import type { SessionStorageService } from "../SessionStorageService";
import { ExecutionPlanManager } from "./ExecutionPlanManager";

interface AgentRuntimeCallbacks {
  isSessionActive: (session: ChatSession) => boolean;
  onStreamingUpdate?: (content: string) => void;
  onReasoningUpdate?: (reasoning: string) => void;
  onMessageUpdate?: (messages: ChatMessage[]) => void;
  onPdfAttached?: () => void;
  onMessageComplete?: () => void;
  formatToolCallCard: (
    toolName: string,
    args: string,
    status: "calling" | "completed" | "error",
    resultPreview?: string,
  ) => string;
  generateId: () => string;
}

interface RuntimeExecutionOptions {
  provider: ToolCallingProvider;
  currentMessages: ChatMessage[];
  assistantMessage: ChatMessage;
  pdfWasAttached: boolean;
  summaryTriggered: boolean;
  tools: ToolDefinition[];
  paperStructure?: PaperStructure | PaperStructureExtended | null;
  sendingSession: ChatSession;
}

interface StreamingRuntimeExecutionOptions extends RuntimeExecutionOptions {
  provider: ToolCallingProvider & {
    streamChatCompletionWithTools: NonNullable<
      ToolCallingProvider["streamChatCompletionWithTools"]
    >;
  };
}

export class AgentRuntime {
  private executionPlanManager = new ExecutionPlanManager();

  constructor(
    private sessionStorage: SessionStorageService,
    private callbacks: AgentRuntimeCallbacks,
  ) {}

  async executeStreamingToolLoop(
    options: StreamingRuntimeExecutionOptions,
  ): Promise<void> {
    const {
      provider,
      currentMessages,
      assistantMessage,
      pdfWasAttached,
      summaryTriggered,
      tools,
      paperStructure,
      sendingSession,
    } = options;
    const pdfToolManager = getPdfToolManager();
    const contextManager = getContextManager();
    const maxIterations = 10;
    let iteration = 0;
    let accumulatedDisplay = "";
    this.executionPlanManager.startPlan(sendingSession, currentMessages);
    await this.sessionStorage.updateSessionMeta(sendingSession);

    try {
      while (iteration < maxIterations) {
        iteration++;
        ztoolkit.log(
          `[Streaming Tool Calling] Iteration ${iteration}, messages: ${currentMessages.length}`,
        );

        const pendingToolCalls = new Map<
          number,
          { id: string; name: string; arguments: string }
        >();
        const displayBeforeThisRound = accumulatedDisplay;

        const result = await new Promise<{
          content: string;
          toolCalls?: ToolCall[];
          stopReason: string;
        }>((resolve, reject) => {
          let roundContent = "";
          let stopReason = "end_turn";

          const callbacks: StreamToolCallingCallbacks = {
            onTextDelta: (text) => {
              roundContent += text;
              assistantMessage.content = displayBeforeThisRound + roundContent;
              if (this.callbacks.isSessionActive(sendingSession)) {
                this.callbacks.onStreamingUpdate?.(assistantMessage.content);
              }
            },
            onReasoningDelta: (text) => {
              assistantMessage.reasoning =
                (assistantMessage.reasoning || "") + text;
              if (this.callbacks.isSessionActive(sendingSession)) {
                this.callbacks.onReasoningUpdate?.(assistantMessage.reasoning);
              }
            },
            onToolCallStart: ({ index, id, name }) => {
              pendingToolCalls.set(index, { id, name, arguments: "" });
              ztoolkit.log(
                `[Streaming Tool Calling] Tool call started: ${name} (${id})`,
              );
            },
            onToolCallDelta: (index, argumentsDelta) => {
              const tc = pendingToolCalls.get(index);
              if (tc) {
                tc.arguments += argumentsDelta;
              }
            },
            onComplete: (result) => {
              stopReason = result.stopReason;
              const toolCalls: ToolCall[] = [];
              for (const [, tc] of pendingToolCalls) {
                toolCalls.push({
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.name,
                    arguments: tc.arguments,
                  },
                });
              }
              resolve({
                content: roundContent,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                stopReason,
              });
            },
            onError: (error) => {
              reject(error);
            },
          };

          provider
            .streamChatCompletionWithTools(currentMessages, tools, callbacks)
            .catch(reject);
        });

        ztoolkit.log(
          "[Streaming Tool Calling] Response:",
          result.content ? result.content.substring(0, 100) : "(no content)",
          "toolCalls:",
          result.toolCalls?.length || 0,
          "stopReason:",
          result.stopReason,
        );

        if (result.toolCalls && result.toolCalls.length > 0) {
          const assistantToolMessage: ChatMessage = {
            id: this.callbacks.generateId(),
            role: "assistant",
            content: result.content || "",
            tool_calls: result.toolCalls,
            timestamp: Date.now(),
          };
          currentMessages.push(assistantToolMessage);

          if (result.content) {
            accumulatedDisplay += result.content;
          }

          for (const toolCall of result.toolCalls) {
            const toolName = toolCall.function.name;
            const toolArgs = toolCall.function.arguments;

            ztoolkit.log(`[Streaming Tool Calling] Executing: ${toolName}`);

            const callingDisplay =
              accumulatedDisplay +
              this.callbacks.formatToolCallCard(toolName, toolArgs, "calling");
            assistantMessage.content = callingDisplay;
            this.executionPlanManager.addOrUpdateToolStep(
              sendingSession,
              currentMessages,
              toolCall.id,
              toolName,
              "in_progress",
              truncateToolDetail(toolArgs),
            );
            await this.sessionStorage.updateSessionMeta(sendingSession);
            if (this.callbacks.isSessionActive(sendingSession)) {
              this.callbacks.onStreamingUpdate?.(callingDisplay);
            }

            let toolResult: string;
            try {
              toolResult = await pdfToolManager.executeToolCall(
                toolCall,
                paperStructure || undefined,
              );
            } catch (error) {
              toolResult = `Error: Tool execution failed: ${getErrorMessage(error)}`;
              ztoolkit.log(
                `[Streaming Tool Calling] Tool ${toolName} threw error:`,
                error,
              );
            }

            ztoolkit.log(
              `[Streaming Tool Calling] Result (truncated): ${toolResult.substring(0, 200)}...`,
            );

            const toolResultMessage: ChatMessage = {
              id: this.callbacks.generateId(),
              role: "tool",
              content: toolResult,
              tool_call_id: toolCall.id,
              timestamp: Date.now(),
            };
            currentMessages.push(toolResultMessage);

            const toolFailed = isToolResultError(toolResult);
            const toolDisplayStatus = toolFailed ? "error" : "completed";
            const planStepStatus = toolFailed ? "failed" : "completed";

            accumulatedDisplay += this.callbacks.formatToolCallCard(
              toolName,
              toolArgs,
              toolDisplayStatus,
              toolResult,
            );
            assistantMessage.content = accumulatedDisplay;
            this.executionPlanManager.addOrUpdateToolStep(
              sendingSession,
              currentMessages,
              toolCall.id,
              toolName,
              planStepStatus,
              truncateToolDetail(toolResult),
            );
            await this.sessionStorage.updateSessionMeta(sendingSession);
            if (this.callbacks.isSessionActive(sendingSession)) {
              this.callbacks.onStreamingUpdate?.(accumulatedDisplay);
            }
          }

          const thinkingDisplay = accumulatedDisplay + "\n\n···";
          assistantMessage.content = thinkingDisplay;
          if (this.callbacks.isSessionActive(sendingSession)) {
            this.callbacks.onStreamingUpdate?.(thinkingDisplay);
          }

          continue;
        }

        accumulatedDisplay += result.content || "";
        assistantMessage.content = accumulatedDisplay;
        assistantMessage.timestamp = Date.now();
        sendingSession.updatedAt = Date.now();

        if (!assistantMessage.reasoning) {
          delete assistantMessage.reasoning;
        }

        this.executionPlanManager.completeRespondStep(
          sendingSession,
          currentMessages,
          truncateToolDetail(accumulatedDisplay),
        );

        await this.sessionStorage.updateMessageContent(
          sendingSession.id,
          assistantMessage.id,
          accumulatedDisplay,
          assistantMessage.reasoning,
        );
        await this.sessionStorage.updateSessionMeta(sendingSession);
        if (this.callbacks.isSessionActive(sendingSession)) {
          this.callbacks.onMessageUpdate?.(sendingSession.messages);

          if (pdfWasAttached) {
            this.callbacks.onPdfAttached?.();
          }
          this.callbacks.onMessageComplete?.();
        }

        if (summaryTriggered) {
          contextManager
            .generateSummaryAsync(sendingSession, async () => {
              await this.sessionStorage.updateSessionMeta(sendingSession);
            })
            .catch((err) => {
              ztoolkit.log("[AgentRuntime] Summary generation failed:", err);
            });
        }

        return;
      }

      ztoolkit.log("[Streaming Tool Calling] Max iterations reached");
      accumulatedDisplay +=
        "\n\nI apologize, but I was unable to complete the request within the allowed number of iterations.";
      assistantMessage.content = accumulatedDisplay;
      assistantMessage.timestamp = Date.now();
      sendingSession.updatedAt = Date.now();
      this.executionPlanManager.failPlan(
        sendingSession,
        currentMessages,
        "Maximum tool-calling iterations reached.",
      );
      if (!assistantMessage.reasoning) {
        delete assistantMessage.reasoning;
      }
      await this.sessionStorage.updateMessageContent(
        sendingSession.id,
        assistantMessage.id,
        accumulatedDisplay,
        assistantMessage.reasoning,
      );
      await this.sessionStorage.updateSessionMeta(sendingSession);
      if (this.callbacks.isSessionActive(sendingSession)) {
        this.callbacks.onMessageUpdate?.(sendingSession.messages);
        this.callbacks.onMessageComplete?.();
      }
    } catch (error) {
      this.executionPlanManager.failPlan(
        sendingSession,
        currentMessages,
        getErrorMessage(error),
      );
      await this.sessionStorage.updateSessionMeta(sendingSession);
      ztoolkit.log("[Streaming Tool Calling] Error:", error);
      throw error;
    }
  }

  async executeNonStreamingToolLoop(
    options: RuntimeExecutionOptions,
  ): Promise<void> {
    const {
      provider,
      currentMessages,
      assistantMessage,
      pdfWasAttached,
      summaryTriggered,
      tools,
      paperStructure,
      sendingSession,
    } = options;
    const pdfToolManager = getPdfToolManager();
    const contextManager = getContextManager();
    const maxIterations = 10;
    let iteration = 0;
    let accumulatedDisplay = "";
    this.executionPlanManager.startPlan(sendingSession, currentMessages);
    await this.sessionStorage.updateSessionMeta(sendingSession);

    try {
      while (iteration < maxIterations) {
        iteration++;
        ztoolkit.log(
          `[Tool Calling] Iteration ${iteration}, messages: ${currentMessages.length}`,
        );

        const result = await provider.chatCompletionWithTools(
          currentMessages,
          tools,
        );

        ztoolkit.log(
          "[Tool Calling] Response:",
          result.content ? result.content.substring(0, 100) : "(no content)",
          "toolCalls:",
          result.toolCalls?.length || 0,
        );

        if (result.toolCalls && result.toolCalls.length > 0) {
          const assistantToolMessage: ChatMessage = {
            id: this.callbacks.generateId(),
            role: "assistant",
            content: result.content || "",
            tool_calls: result.toolCalls,
            timestamp: Date.now(),
          };
          currentMessages.push(assistantToolMessage);

          if (result.content) {
            accumulatedDisplay += result.content;
          }

          for (const toolCall of result.toolCalls) {
            const toolName = toolCall.function.name;
            const toolArgs = toolCall.function.arguments;

            ztoolkit.log(`[Tool Calling] Executing tool: ${toolName}`, toolArgs);

            const callingDisplay =
              accumulatedDisplay +
              this.callbacks.formatToolCallCard(toolName, toolArgs, "calling");
            assistantMessage.content = callingDisplay;
            this.executionPlanManager.addOrUpdateToolStep(
              sendingSession,
              currentMessages,
              toolCall.id,
              toolName,
              "in_progress",
              truncateToolDetail(toolArgs),
            );
            await this.sessionStorage.updateSessionMeta(sendingSession);
            if (this.callbacks.isSessionActive(sendingSession)) {
              this.callbacks.onStreamingUpdate?.(callingDisplay);
            }

            let toolResult: string;
            try {
              toolResult = await pdfToolManager.executeToolCall(
                toolCall,
                paperStructure || undefined,
              );
            } catch (error) {
              toolResult = `Error: Tool execution failed: ${getErrorMessage(error)}`;
              ztoolkit.log(
                `[Tool Calling] Tool ${toolName} threw error:`,
                error,
              );
            }

            ztoolkit.log(
              `[Tool Calling] Tool result (truncated): ${toolResult.substring(0, 200)}...`,
            );

            const toolResultMessage: ChatMessage = {
              id: this.callbacks.generateId(),
              role: "tool",
              content: toolResult,
              tool_call_id: toolCall.id,
              timestamp: Date.now(),
            };
            currentMessages.push(toolResultMessage);

            const toolFailed = isToolResultError(toolResult);
            const toolDisplayStatus = toolFailed ? "error" : "completed";
            const planStepStatus = toolFailed ? "failed" : "completed";

            accumulatedDisplay += this.callbacks.formatToolCallCard(
              toolName,
              toolArgs,
              toolDisplayStatus,
              toolResult,
            );
            assistantMessage.content = accumulatedDisplay;
            this.executionPlanManager.addOrUpdateToolStep(
              sendingSession,
              currentMessages,
              toolCall.id,
              toolName,
              planStepStatus,
              truncateToolDetail(toolResult),
            );
            await this.sessionStorage.updateSessionMeta(sendingSession);
            if (this.callbacks.isSessionActive(sendingSession)) {
              this.callbacks.onStreamingUpdate?.(accumulatedDisplay);
            }
          }

          const thinkingDisplay = accumulatedDisplay + "\n\n···";
          assistantMessage.content = thinkingDisplay;
          if (this.callbacks.isSessionActive(sendingSession)) {
            this.callbacks.onStreamingUpdate?.(thinkingDisplay);
          }

          continue;
        }

        accumulatedDisplay += result.content || "";
        assistantMessage.content = accumulatedDisplay;
        assistantMessage.timestamp = Date.now();
        sendingSession.updatedAt = Date.now();
        this.executionPlanManager.completeRespondStep(
          sendingSession,
          currentMessages,
          truncateToolDetail(accumulatedDisplay),
        );

        await this.sessionStorage.updateMessageContent(
          sendingSession.id,
          assistantMessage.id,
          accumulatedDisplay,
        );
        await this.sessionStorage.updateSessionMeta(sendingSession);
        if (this.callbacks.isSessionActive(sendingSession)) {
          this.callbacks.onMessageUpdate?.(sendingSession.messages);

          if (pdfWasAttached) {
            this.callbacks.onPdfAttached?.();
          }
          this.callbacks.onMessageComplete?.();
        }

        if (summaryTriggered) {
          contextManager
            .generateSummaryAsync(sendingSession, async () => {
              await this.sessionStorage.updateSessionMeta(sendingSession);
            })
            .catch((err) => {
              ztoolkit.log("[AgentRuntime] Summary generation failed:", err);
            });
        }

        return;
      }

      ztoolkit.log("[Tool Calling] Max iterations reached");
      accumulatedDisplay +=
        "\n\nI apologize, but I was unable to complete the request within the allowed number of iterations.";
      assistantMessage.content = accumulatedDisplay;
      assistantMessage.timestamp = Date.now();
      sendingSession.updatedAt = Date.now();
      this.executionPlanManager.failPlan(
        sendingSession,
        currentMessages,
        "Maximum tool-calling iterations reached.",
      );
      await this.sessionStorage.updateMessageContent(
        sendingSession.id,
        assistantMessage.id,
        accumulatedDisplay,
      );
      await this.sessionStorage.updateSessionMeta(sendingSession);
      if (this.callbacks.isSessionActive(sendingSession)) {
        this.callbacks.onMessageUpdate?.(sendingSession.messages);
        this.callbacks.onMessageComplete?.();
      }
    } catch (error) {
      this.executionPlanManager.failPlan(
        sendingSession,
        currentMessages,
        getErrorMessage(error),
      );
      await this.sessionStorage.updateSessionMeta(sendingSession);
      ztoolkit.log("[Tool Calling] Error:", error);
      throw error;
    }
  }
}

function truncateToolDetail(text: string): string {
  if (text.length <= 160) {
    return text;
  }
  return text.slice(0, 157) + "...";
}

function isToolResultError(toolResult: string): boolean {
  return toolResult.trimStart().startsWith("Error:");
}
