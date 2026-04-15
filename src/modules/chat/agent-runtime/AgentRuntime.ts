import type {
  AgentRuntimeEvent,
  AgentRuntimeEventType,
  ChatMessage,
  ChatMessageStreamingState,
  ChatSession,
  ExecutionPlan,
  StreamToolCallingCallbacks,
} from "../../../types/chat";
import type {
  PaperStructure,
  PaperStructureExtended,
  ToolCall,
  ToolDefinition,
  ToolExecutionResult,
} from "../../../types/tool";
import type { ToolCallingProvider } from "../../../types/provider";
import { getErrorMessage } from "../../../utils/common";
import { getContextManager } from "../ContextManager";
import type { SessionStorageService } from "../SessionStorageService";
import { getToolScheduler } from "../tool-scheduler";
import { ExecutionPlanManager } from "./ExecutionPlanManager";

interface AgentRuntimeCallbacks {
  isSessionActive: (session: ChatSession) => boolean;
  isSessionTracked: (session: ChatSession) => boolean;
  onRuntimeEvent?: (event: AgentRuntimeEvent) => void;
  onStreamingUpdate?: (content: string) => void;
  onReasoningUpdate?: (reasoning: string) => void;
  onMessageUpdate?: (messages: ChatMessage[]) => void;
  onPdfAttached?: () => void;
  onMessageComplete?: () => void;
  onExecutionPlanUpdate?: (plan?: ExecutionPlan) => void;
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
  refreshSystemPrompt?: (
    currentMessages: ChatMessage[],
    session: ChatSession,
  ) => string;
}

interface StreamingRuntimeExecutionOptions extends RuntimeExecutionOptions {
  provider: ToolCallingProvider & {
    streamChatCompletionWithTools: NonNullable<
      ToolCallingProvider["streamChatCompletionWithTools"]
    >;
  };
}

type RuntimeEventPayload<T extends AgentRuntimeEventType> = Omit<
  Extract<AgentRuntimeEvent, { type: T }>,
  "sessionId" | "assistantMessageId" | "timestamp" | "planId"
>;

class SessionRunInvalidatedError extends Error {
  constructor() {
    super("Session run invalidated");
  }
}

export class AgentRuntime {
  private executionPlanManager = new ExecutionPlanManager();
  private toolScheduler = getToolScheduler();
  private messageCheckpointTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private messageCheckpointQueues = new Map<string, Promise<void>>();

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
      refreshSystemPrompt,
    } = options;
    const contextManager = getContextManager();
    const maxIterations = 10;
    let iteration = 0;
    let accumulatedDisplay = "";
    const plan = this.executionPlanManager.startPlan(sendingSession, currentMessages);
    this.initializeToolExecutionState(sendingSession);
    await this.sessionStorage.updateSessionMeta(sendingSession);
    this.emitPlanUpdate(sendingSession);
    this.emitRuntimeEvent<"turn_started">(sendingSession, assistantMessage, {
      type: "turn_started",
      summary: plan.summary,
      streaming: true,
    });

    try {
      while (iteration < maxIterations) {
        iteration++;
        this.refreshSystemPrompt(currentMessages, sendingSession, refreshSystemPrompt);
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
              if (!this.callbacks.isSessionTracked(sendingSession)) {
                return;
              }
              roundContent += text;
              assistantMessage.content = displayBeforeThisRound + roundContent;
              assistantMessage.streamingState = "in_progress";
              this.scheduleAssistantMessageCheckpoint(sendingSession, assistantMessage);
              this.emitRuntimeEvent<"text_delta">(sendingSession, assistantMessage, {
                type: "text_delta",
                delta: text,
                content: assistantMessage.content,
                iteration,
              });
              if (this.callbacks.isSessionActive(sendingSession)) {
                this.callbacks.onStreamingUpdate?.(assistantMessage.content);
              }
            },
            onReasoningDelta: (text) => {
              if (!this.callbacks.isSessionTracked(sendingSession)) {
                return;
              }
              assistantMessage.reasoning =
                (assistantMessage.reasoning || "") + text;
              assistantMessage.streamingState = "in_progress";
              this.scheduleAssistantMessageCheckpoint(sendingSession, assistantMessage);
              this.emitRuntimeEvent<"reasoning_delta">(sendingSession, assistantMessage, {
                type: "reasoning_delta",
                delta: text,
                reasoning: assistantMessage.reasoning,
                iteration,
              });
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

        this.ensureSessionTracked(sendingSession);

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

          const executionBatches = this.toolScheduler.createExecutionBatches(
            result.toolCalls.map((toolCall) => ({
              toolCall,
              sessionId: sendingSession.id,
              fallbackStructure: paperStructure || undefined,
            })),
          );

          for (const batch of executionBatches) {
            let callingDisplay = accumulatedDisplay;

            for (const request of batch) {
              const toolCall = request.toolCall;
              const toolName = toolCall.function.name;
              const toolArgs = toolCall.function.arguments;
              ztoolkit.log(`[Streaming Tool Calling] Executing: ${toolName}`);

              callingDisplay += this.callbacks.formatToolCallCard(
                toolName,
                toolArgs,
                "calling",
              );
              this.executionPlanManager.addOrUpdateToolStep(
                sendingSession,
                currentMessages,
                toolCall.id,
                toolName,
                "in_progress",
                truncateToolDetail(toolArgs),
              );
              this.emitRuntimeEvent<"tool_started">(sendingSession, assistantMessage, {
                type: "tool_started",
                toolCallId: toolCall.id,
                toolName,
                args: toolArgs,
                iteration,
              });
            }

            assistantMessage.content = callingDisplay;
            assistantMessage.streamingState = "in_progress";
            await this.flushAssistantMessageCheckpoint(
              sendingSession,
              assistantMessage,
              "in_progress",
            );
            await this.sessionStorage.updateSessionMeta(sendingSession);
            this.emitPlanUpdate(sendingSession);
            if (this.callbacks.isSessionActive(sendingSession)) {
              this.callbacks.onStreamingUpdate?.(callingDisplay);
            }

            const batchResults = await this.toolScheduler.executeBatch(batch);
            this.appendToolExecutionResults(sendingSession, batchResults);
            await this.sessionStorage.updateSessionMeta(sendingSession);
            this.emitPlanUpdate(sendingSession);

            for (const executionResult of batchResults) {
              const toolCall = executionResult.toolCall;
              const toolName = toolCall.function.name;
              const toolArgs = toolCall.function.arguments;
              const toolResult = executionResult.content;

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

              const toolSucceeded = executionResult.status === "completed";
              const toolDisplayStatus = toolSucceeded ? "completed" : "error";
              const planStepStatus = toPlanStepStatus(executionResult.status);

              accumulatedDisplay += this.callbacks.formatToolCallCard(
                toolName,
                toolArgs,
                toolDisplayStatus,
                toolResult,
              );
              assistantMessage.content = accumulatedDisplay;
              assistantMessage.streamingState = "in_progress";
              await this.flushAssistantMessageCheckpoint(
                sendingSession,
                assistantMessage,
                "in_progress",
              );
              this.executionPlanManager.addOrUpdateToolStep(
                sendingSession,
                currentMessages,
                toolCall.id,
                toolName,
                planStepStatus,
                truncateToolDetail(toolResult),
              );
              await this.sessionStorage.updateSessionMeta(sendingSession);
              this.emitPlanUpdate(sendingSession);
              this.emitRuntimeEvent<"tool_completed">(sendingSession, assistantMessage, {
                type: "tool_completed",
                toolCallId: toolCall.id,
                toolName,
                args: toolArgs,
                resultPreview: truncateToolDetail(toolResult),
                status: executionResult.status,
                iteration,
              });
              if (this.callbacks.isSessionActive(sendingSession)) {
                this.callbacks.onStreamingUpdate?.(accumulatedDisplay);
              }
            }

            this.appendDenialRecoveryMessage(currentMessages, batchResults);
          }

          const thinkingDisplay = accumulatedDisplay + "\n\n···";
          assistantMessage.content = thinkingDisplay;
          assistantMessage.streamingState = "in_progress";
          await this.flushAssistantMessageCheckpoint(
            sendingSession,
            assistantMessage,
            "in_progress",
          );
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
        assistantMessage.streamingState = undefined;

        this.executionPlanManager.completeRespondStep(
          sendingSession,
          currentMessages,
          truncateToolDetail(accumulatedDisplay),
        );

        await this.flushAssistantMessageCheckpoint(
          sendingSession,
          assistantMessage,
          null,
        );
        this.touchToolExecutionState(sendingSession);
        await this.sessionStorage.updateSessionMeta(sendingSession);
        this.emitPlanUpdate(sendingSession);
        this.emitRuntimeEvent<"turn_completed">(sendingSession, assistantMessage, {
          type: "turn_completed",
          content: accumulatedDisplay,
          iteration,
        });
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
      assistantMessage.streamingState = undefined;
      await this.flushAssistantMessageCheckpoint(
        sendingSession,
        assistantMessage,
        null,
      );
      this.touchToolExecutionState(sendingSession);
      await this.sessionStorage.updateSessionMeta(sendingSession);
      this.emitPlanUpdate(sendingSession);
      this.emitRuntimeEvent<"turn_failed">(sendingSession, assistantMessage, {
        type: "turn_failed",
        error: "Maximum tool-calling iterations reached.",
        iteration,
      });
      if (this.callbacks.isSessionActive(sendingSession)) {
        this.callbacks.onMessageUpdate?.(sendingSession.messages);
        this.callbacks.onMessageComplete?.();
      }
    } catch (error) {
      if (error instanceof SessionRunInvalidatedError) {
        return;
      }
      this.executionPlanManager.failPlan(
        sendingSession,
        currentMessages,
        getErrorMessage(error),
      );
      await this.flushAssistantMessageCheckpoint(
        sendingSession,
        assistantMessage,
        "in_progress",
      );
      this.touchToolExecutionState(sendingSession);
      await this.sessionStorage.updateSessionMeta(sendingSession);
      this.emitPlanUpdate(sendingSession);
      this.emitRuntimeEvent<"turn_failed">(sendingSession, assistantMessage, {
        type: "turn_failed",
        error: getErrorMessage(error),
        iteration,
      });
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
      refreshSystemPrompt,
    } = options;
    const contextManager = getContextManager();
    const maxIterations = 10;
    let iteration = 0;
    let accumulatedDisplay = "";
    const plan = this.executionPlanManager.startPlan(sendingSession, currentMessages);
    this.initializeToolExecutionState(sendingSession);
    await this.sessionStorage.updateSessionMeta(sendingSession);
    this.emitPlanUpdate(sendingSession);
    this.emitRuntimeEvent<"turn_started">(sendingSession, assistantMessage, {
      type: "turn_started",
      summary: plan.summary,
      streaming: false,
    });

    try {
      while (iteration < maxIterations) {
        iteration++;
        this.refreshSystemPrompt(currentMessages, sendingSession, refreshSystemPrompt);
        ztoolkit.log(
          `[Tool Calling] Iteration ${iteration}, messages: ${currentMessages.length}`,
        );

        const result = await provider.chatCompletionWithTools(
          currentMessages,
          tools,
        );

        this.ensureSessionTracked(sendingSession);

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

          const executionBatches = this.toolScheduler.createExecutionBatches(
            result.toolCalls.map((toolCall) => ({
              toolCall,
              sessionId: sendingSession.id,
              fallbackStructure: paperStructure || undefined,
            })),
          );

          for (const batch of executionBatches) {
            let callingDisplay = accumulatedDisplay;

            for (const request of batch) {
              const toolCall = request.toolCall;
              const toolName = toolCall.function.name;
              const toolArgs = toolCall.function.arguments;

              ztoolkit.log(`[Tool Calling] Executing tool: ${toolName}`, toolArgs);

              callingDisplay += this.callbacks.formatToolCallCard(
                toolName,
                toolArgs,
                "calling",
              );
              this.executionPlanManager.addOrUpdateToolStep(
                sendingSession,
                currentMessages,
                toolCall.id,
                toolName,
                "in_progress",
                truncateToolDetail(toolArgs),
              );
              this.emitRuntimeEvent<"tool_started">(sendingSession, assistantMessage, {
                type: "tool_started",
                toolCallId: toolCall.id,
                toolName,
                args: toolArgs,
                iteration,
              });
            }

            assistantMessage.content = callingDisplay;
            assistantMessage.streamingState = "in_progress";
            await this.flushAssistantMessageCheckpoint(
              sendingSession,
              assistantMessage,
              "in_progress",
            );
            await this.sessionStorage.updateSessionMeta(sendingSession);
            this.emitPlanUpdate(sendingSession);
            if (this.callbacks.isSessionActive(sendingSession)) {
              this.callbacks.onStreamingUpdate?.(callingDisplay);
            }

            const batchResults = await this.toolScheduler.executeBatch(batch);
            this.appendToolExecutionResults(sendingSession, batchResults);
            await this.sessionStorage.updateSessionMeta(sendingSession);
            this.emitPlanUpdate(sendingSession);

            for (const executionResult of batchResults) {
              const toolCall = executionResult.toolCall;
              const toolName = toolCall.function.name;
              const toolArgs = toolCall.function.arguments;
              const toolResult = executionResult.content;

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

              const toolSucceeded = executionResult.status === "completed";
              const toolDisplayStatus = toolSucceeded ? "completed" : "error";
              const planStepStatus = toPlanStepStatus(executionResult.status);

              accumulatedDisplay += this.callbacks.formatToolCallCard(
                toolName,
                toolArgs,
                toolDisplayStatus,
                toolResult,
              );
              assistantMessage.content = accumulatedDisplay;
              assistantMessage.streamingState = "in_progress";
              await this.flushAssistantMessageCheckpoint(
                sendingSession,
                assistantMessage,
                "in_progress",
              );
              this.executionPlanManager.addOrUpdateToolStep(
                sendingSession,
                currentMessages,
                toolCall.id,
                toolName,
                planStepStatus,
                truncateToolDetail(toolResult),
              );
              await this.sessionStorage.updateSessionMeta(sendingSession);
              this.emitPlanUpdate(sendingSession);
              this.emitRuntimeEvent<"tool_completed">(sendingSession, assistantMessage, {
                type: "tool_completed",
                toolCallId: toolCall.id,
                toolName,
                args: toolArgs,
                resultPreview: truncateToolDetail(toolResult),
                status: executionResult.status,
                iteration,
              });
              if (this.callbacks.isSessionActive(sendingSession)) {
                this.callbacks.onStreamingUpdate?.(accumulatedDisplay);
              }
            }

            this.appendDenialRecoveryMessage(currentMessages, batchResults);
          }

          const thinkingDisplay = accumulatedDisplay + "\n\n···";
          assistantMessage.content = thinkingDisplay;
          assistantMessage.streamingState = "in_progress";
          await this.flushAssistantMessageCheckpoint(
            sendingSession,
            assistantMessage,
            "in_progress",
          );
          if (this.callbacks.isSessionActive(sendingSession)) {
            this.callbacks.onStreamingUpdate?.(thinkingDisplay);
          }

          continue;
        }

        accumulatedDisplay += result.content || "";
        assistantMessage.content = accumulatedDisplay;
        assistantMessage.streamingState = undefined;
        assistantMessage.timestamp = Date.now();
        sendingSession.updatedAt = Date.now();
        this.executionPlanManager.completeRespondStep(
          sendingSession,
          currentMessages,
          truncateToolDetail(accumulatedDisplay),
        );

        await this.flushAssistantMessageCheckpoint(
          sendingSession,
          assistantMessage,
          null,
        );
        this.touchToolExecutionState(sendingSession);
        await this.sessionStorage.updateSessionMeta(sendingSession);
        this.emitPlanUpdate(sendingSession);
        this.emitRuntimeEvent<"turn_completed">(sendingSession, assistantMessage, {
          type: "turn_completed",
          content: accumulatedDisplay,
          iteration,
        });
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
      assistantMessage.streamingState = undefined;
      assistantMessage.timestamp = Date.now();
      sendingSession.updatedAt = Date.now();
      this.executionPlanManager.failPlan(
        sendingSession,
        currentMessages,
        "Maximum tool-calling iterations reached.",
      );
      await this.flushAssistantMessageCheckpoint(
        sendingSession,
        assistantMessage,
        null,
      );
      this.touchToolExecutionState(sendingSession);
      await this.sessionStorage.updateSessionMeta(sendingSession);
      this.emitPlanUpdate(sendingSession);
      this.emitRuntimeEvent<"turn_failed">(sendingSession, assistantMessage, {
        type: "turn_failed",
        error: "Maximum tool-calling iterations reached.",
        iteration,
      });
      if (this.callbacks.isSessionActive(sendingSession)) {
        this.callbacks.onMessageUpdate?.(sendingSession.messages);
        this.callbacks.onMessageComplete?.();
      }
    } catch (error) {
      if (error instanceof SessionRunInvalidatedError) {
        return;
      }
      this.executionPlanManager.failPlan(
        sendingSession,
        currentMessages,
        getErrorMessage(error),
      );
      await this.flushAssistantMessageCheckpoint(
        sendingSession,
        assistantMessage,
        "in_progress",
      );
      this.touchToolExecutionState(sendingSession);
      await this.sessionStorage.updateSessionMeta(sendingSession);
      this.emitPlanUpdate(sendingSession);
      this.emitRuntimeEvent<"turn_failed">(sendingSession, assistantMessage, {
        type: "turn_failed",
        error: getErrorMessage(error),
        iteration,
      });
      ztoolkit.log("[Tool Calling] Error:", error);
      throw error;
    }
  }

  private emitPlanUpdate(session: ChatSession): void {
    if (this.callbacks.isSessionActive(session)) {
      this.callbacks.onExecutionPlanUpdate?.(session.executionPlan);
    }
  }

  private initializeToolExecutionState(session: ChatSession): void {
    const now = Date.now();
    session.toolExecutionState = {
      planId: session.executionPlan?.id,
      turnStartedAt: now,
      updatedAt: now,
      results: [],
    };
  }

  private appendToolExecutionResults(
    session: ChatSession,
    results: ToolExecutionResult[],
  ): void {
    if (!session.toolExecutionState) {
      this.initializeToolExecutionState(session);
    }

    session.toolExecutionState!.planId = session.executionPlan?.id;
    session.toolExecutionState!.results.push(...results);
    session.toolExecutionState!.updatedAt = Date.now();
  }

  private touchToolExecutionState(session: ChatSession): void {
    if (!session.toolExecutionState) {
      this.initializeToolExecutionState(session);
    }
    session.toolExecutionState!.planId = session.executionPlan?.id;
    session.toolExecutionState!.updatedAt = Date.now();
  }

  private scheduleAssistantMessageCheckpoint(
    session: ChatSession,
    message: ChatMessage,
  ): void {
    if (!this.callbacks.isSessionTracked(session)) {
      return;
    }
    if (this.messageCheckpointTimers.has(message.id)) {
      return;
    }

    const timer = setTimeout(() => {
      this.messageCheckpointTimers.delete(message.id);
      if (!this.callbacks.isSessionTracked(session)) {
        return;
      }
      void this.enqueueAssistantMessageCheckpoint(
        session,
        message,
        "in_progress",
      );
    }, 1000);
    this.messageCheckpointTimers.set(message.id, timer);
  }

  private async flushAssistantMessageCheckpoint(
    session: ChatSession,
    message: ChatMessage,
    streamingState: ChatMessageStreamingState | null,
  ): Promise<void> {
    if (!this.callbacks.isSessionTracked(session)) {
      return;
    }
    const timer = this.messageCheckpointTimers.get(message.id);
    if (timer) {
      clearTimeout(timer);
      this.messageCheckpointTimers.delete(message.id);
    }

    await this.enqueueAssistantMessageCheckpoint(
      session,
      message,
      streamingState,
    );
  }

  private async enqueueAssistantMessageCheckpoint(
    session: ChatSession,
    message: ChatMessage,
    streamingState: ChatMessageStreamingState | null,
  ): Promise<void> {
    if (!this.callbacks.isSessionTracked(session)) {
      return;
    }
    const previous = this.messageCheckpointQueues.get(message.id) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await this.sessionStorage.updateMessageContent(
          session.id,
          message.id,
          message.content,
          message.reasoning,
          { streamingState },
        );
      });
    this.messageCheckpointQueues.set(message.id, next);

    try {
      await next;
    } finally {
      if (this.messageCheckpointQueues.get(message.id) === next) {
        this.messageCheckpointQueues.delete(message.id);
      }
    }
  }

  private appendDenialRecoveryMessage(
    currentMessages: ChatMessage[],
    results: ToolExecutionResult[],
  ): void {
    const deniedResults = results.filter((result) => result.status === "denied");
    if (deniedResults.length === 0) {
      return;
    }

    const lines = deniedResults.map((result) => {
      const descriptor = result.permissionDecision?.descriptor;
      const toolName = result.toolCall.function.name;
      const riskLevel = descriptor?.riskLevel || "unknown";
      const reason =
        result.permissionDecision?.reason ||
        result.error ||
        "No explicit denial reason was returned.";
      return `- ${toolName} (risk: ${riskLevel}): ${reason}`;
    });

    currentMessages.push({
      id: this.callbacks.generateId(),
      role: "system",
      content: [
        "Tool denial notice:",
        "The following tool calls were denied by the permission policy in this turn.",
        ...lines,
        "Do not repeat denied tool calls in this turn unless the user changes approval.",
        "Revise the plan, choose safer alternatives, or ask the user for permission if the denied action is necessary.",
      ].join("\n"),
      timestamp: Date.now(),
    });
  }

  private refreshSystemPrompt(
    currentMessages: ChatMessage[],
    session: ChatSession,
    promptBuilder?: (currentMessages: ChatMessage[], session: ChatSession) => string,
  ): void {
    if (!promptBuilder) return;

    const content = promptBuilder(currentMessages, session);
    const existing = currentMessages.find((message) => message.id === "paper-context");
    if (existing) {
      existing.content = content;
      existing.timestamp = Date.now();
      return;
    }

    currentMessages.unshift({
      id: "paper-context",
      role: "system",
      content,
      timestamp: Date.now(),
    });
  }

  private emitRuntimeEvent<T extends AgentRuntimeEventType>(
    session: ChatSession,
    assistantMessage: ChatMessage,
    event: RuntimeEventPayload<T>,
  ): void {
    const fullEvent = {
      ...event,
      sessionId: session.id,
      assistantMessageId: assistantMessage.id,
      timestamp: Date.now(),
      planId: session.executionPlan?.id,
    } as Extract<AgentRuntimeEvent, { type: T }>;

    this.callbacks.onRuntimeEvent?.(fullEvent);
  }

  private ensureSessionTracked(session: ChatSession): void {
    if (!this.callbacks.isSessionTracked(session)) {
      throw new SessionRunInvalidatedError();
    }
  }
}

function truncateToolDetail(text: string): string {
  if (text.length <= 160) {
    return text;
  }
  return text.slice(0, 157) + "...";
}

function toPlanStepStatus(
  status: ToolExecutionResult["status"],
): "completed" | "failed" | "denied" {
  switch (status) {
    case "completed":
      return "completed";
    case "denied":
      return "denied";
    default:
      return "failed";
  }
}
