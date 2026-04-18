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
import { SessionRunInvalidatedError } from "../errors";
import type { SessionStorageService } from "../SessionStorageService";
import { getToolScheduler } from "../tool-scheduler";
import { ExecutionPlanManager } from "./ExecutionPlanManager";
import {
  planToolExecutionEntries,
  type ToolExecutionBatchEntry,
} from "./ToolExecutionEntryPlanner";
import {
  awaitWhileSessionTracked,
  ensureTrackedSession,
} from "./sessionTracking";
import { createRecoveryGuidanceSystemMessage } from "../tool-recovery/ToolRecoveryPolicy";

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

interface ToolIterationParams {
  sendingSession: ChatSession;
  currentMessages: ChatMessage[];
  assistantMessage: ChatMessage;
  paperStructure?: PaperStructure | PaperStructureExtended | null;
  toolCalls: ToolCall[];
  roundContent: string;
  accumulatedDisplay: string;
  iteration: number;
  logPrefix: string;
}

const MAX_ITERATIONS = 10;
const THINKING_SUFFIX = "\n\n···";
const MAX_ITERATIONS_MESSAGE =
  "\n\nI apologize, but I was unable to complete the request within the allowed number of iterations.";
const MAX_ITERATIONS_ERROR = "Maximum tool-calling iterations reached.";

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
    const logPrefix = "Streaming Tool Calling";
    let iteration = 0;
    let accumulatedDisplay = "";
    await this.startTurn(sendingSession, assistantMessage, currentMessages, true);

    try {
      while (iteration < MAX_ITERATIONS) {
        iteration++;
        this.refreshSystemPrompt(currentMessages, sendingSession, refreshSystemPrompt);
        ztoolkit.log(
          `[${logPrefix}] Iteration ${iteration}, messages: ${currentMessages.length}`,
        );

        const displayBeforeThisRound = accumulatedDisplay;
        const result = await this.runStreamingRound(
          provider,
          currentMessages,
          tools,
          sendingSession,
          assistantMessage,
          displayBeforeThisRound,
          iteration,
        );

        this.ensureSessionTracked(sendingSession);

        ztoolkit.log(
          `[${logPrefix}] Response:`,
          result.content ? result.content.substring(0, 100) : "(no content)",
          "toolCalls:",
          result.toolCalls?.length || 0,
          "stopReason:",
          result.stopReason,
        );

        if (result.toolCalls && result.toolCalls.length > 0) {
          accumulatedDisplay = await this.runToolIteration({
            sendingSession,
            currentMessages,
            assistantMessage,
            paperStructure,
            toolCalls: result.toolCalls,
            roundContent: result.content || "",
            accumulatedDisplay,
            iteration,
            logPrefix,
          });
          continue;
        }

        await this.finalizeCompletedTurn({
          sendingSession,
          currentMessages,
          assistantMessage,
          pdfWasAttached,
          summaryTriggered,
          accumulatedDisplay: accumulatedDisplay + (result.content || ""),
          iteration,
        });
        return;
      }

      ztoolkit.log(`[${logPrefix}] Max iterations reached`);
      await this.finalizeMaxIterationsTurn(
        sendingSession,
        currentMessages,
        assistantMessage,
        accumulatedDisplay + MAX_ITERATIONS_MESSAGE,
        iteration,
      );
    } catch (error) {
      if (error instanceof SessionRunInvalidatedError) {
        return;
      }
      await this.finalizeErroredTurn(
        sendingSession,
        currentMessages,
        assistantMessage,
        error,
        iteration,
        logPrefix,
      );
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
    const logPrefix = "Tool Calling";
    let iteration = 0;
    let accumulatedDisplay = "";
    await this.startTurn(sendingSession, assistantMessage, currentMessages, false);

    try {
      while (iteration < MAX_ITERATIONS) {
        iteration++;
        this.refreshSystemPrompt(currentMessages, sendingSession, refreshSystemPrompt);
        ztoolkit.log(
          `[${logPrefix}] Iteration ${iteration}, messages: ${currentMessages.length}`,
        );

        const result = await provider.chatCompletionWithTools(
          currentMessages,
          tools,
        );

        this.ensureSessionTracked(sendingSession);

        ztoolkit.log(
          `[${logPrefix}] Response:`,
          result.content ? result.content.substring(0, 100) : "(no content)",
          "toolCalls:",
          result.toolCalls?.length || 0,
        );

        if (result.toolCalls && result.toolCalls.length > 0) {
          accumulatedDisplay = await this.runToolIteration({
            sendingSession,
            currentMessages,
            assistantMessage,
            paperStructure,
            toolCalls: result.toolCalls,
            roundContent: result.content || "",
            accumulatedDisplay,
            iteration,
            logPrefix,
          });
          continue;
        }

        await this.finalizeCompletedTurn({
          sendingSession,
          currentMessages,
          assistantMessage,
          pdfWasAttached,
          summaryTriggered,
          accumulatedDisplay: accumulatedDisplay + (result.content || ""),
          iteration,
        });
        return;
      }

      ztoolkit.log(`[${logPrefix}] Max iterations reached`);
      await this.finalizeMaxIterationsTurn(
        sendingSession,
        currentMessages,
        assistantMessage,
        accumulatedDisplay + MAX_ITERATIONS_MESSAGE,
        iteration,
      );
    } catch (error) {
      if (error instanceof SessionRunInvalidatedError) {
        return;
      }
      await this.finalizeErroredTurn(
        sendingSession,
        currentMessages,
        assistantMessage,
        error,
        iteration,
        logPrefix,
      );
      throw error;
    }
  }

  private async startTurn(
    session: ChatSession,
    assistantMessage: ChatMessage,
    currentMessages: ChatMessage[],
    streaming: boolean,
  ): Promise<void> {
    const plan = this.executionPlanManager.startPlan(session, currentMessages);
    this.initializeToolExecutionState(session);
    await this.sessionStorage.updateSessionMeta(session);
    this.emitPlanUpdate(session);
    this.emitRuntimeEvent<"turn_started">(session, assistantMessage, {
      type: "turn_started",
      summary: plan.summary,
      streaming,
    });
  }

  private async runStreamingRound(
    provider: StreamingRuntimeExecutionOptions["provider"],
    currentMessages: ChatMessage[],
    tools: ToolDefinition[],
    sendingSession: ChatSession,
    assistantMessage: ChatMessage,
    displayBeforeThisRound: string,
    iteration: number,
  ): Promise<{ content: string; toolCalls?: ToolCall[]; stopReason: string }> {
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    return new Promise((resolve, reject) => {
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
  }

  /**
   * Execute one round of tool calls: batch, dispatch, record, and emit events.
   *
   * Shared between streaming and non-streaming loops — both arrive here with
   * the same post-LLM state (assistant tool-call message pending, new tool
   * calls to run). Returns the updated accumulated display so the caller can
   * feed it into the next iteration.
   */
  private async runToolIteration(
    params: ToolIterationParams,
  ): Promise<string> {
    const {
      sendingSession,
      currentMessages,
      assistantMessage,
      paperStructure,
      toolCalls,
      roundContent,
      iteration,
      logPrefix,
    } = params;

    const assistantToolMessage: ChatMessage = {
      id: this.callbacks.generateId(),
      role: "assistant",
      content: roundContent,
      tool_calls: toolCalls,
      timestamp: Date.now(),
    };
    currentMessages.push(assistantToolMessage);

    let accumulatedDisplay = params.accumulatedDisplay;
    if (roundContent) {
      accumulatedDisplay += roundContent;
    }

    const executionEntries = this.createToolExecutionEntries(
      sendingSession,
      assistantMessage,
      toolCalls,
      paperStructure,
    );

    for (const entry of executionEntries) {
      let callingDisplay = accumulatedDisplay;

      if (entry.kind === "execute") {
        for (const request of entry.requests) {
          const toolCall = request.toolCall;
          const toolName = toolCall.function.name;
          const toolArgs = toolCall.function.arguments;
          ztoolkit.log(`[${logPrefix}] Executing: ${toolName}`, toolArgs);

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
      }

      const batchResults =
        entry.kind === "execute"
          ? await awaitWhileSessionTracked(
              sendingSession,
              this.callbacks.isSessionTracked,
              () => this.toolScheduler.executeBatch(entry.requests),
            )
          : entry.results;
      this.appendToolExecutionResults(sendingSession, batchResults);
      await this.sessionStorage.updateSessionMeta(sendingSession);
      this.emitPlanUpdate(sendingSession);

      for (const executionResult of batchResults) {
        this.ensureSessionTracked(sendingSession);
        const toolCall = executionResult.toolCall;
        const toolName = toolCall.function.name;
        const toolArgs = toolCall.function.arguments;
        const toolResult = executionResult.content;

        ztoolkit.log(
          `[${logPrefix}] Result (truncated): ${toolResult.substring(0, 200)}...`,
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
        this.ensureSessionTracked(sendingSession);
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

        // tool_started only fires for calls that were actually allowed to
        // execute. Denied calls go straight to tool_completed with
        // status="denied" so observers never see a started-but-denied pair.
        if (entry.kind === "execute" && executionResult.status !== "denied") {
          this.emitRuntimeEvent<"tool_started">(sendingSession, assistantMessage, {
            type: "tool_started",
            toolCallId: toolCall.id,
            toolName,
            args: toolArgs,
            iteration,
          });
        }
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

      const needsRecovery = batchResults.some(
        (result) => result.status === "denied" || result.status === "failed",
      );
      if (needsRecovery) {
        this.executionPlanManager.recordRecoveryStep(
          sendingSession,
          currentMessages,
          batchResults,
        );
        await this.sessionStorage.updateSessionMeta(sendingSession);
        this.emitPlanUpdate(sendingSession);
      }

      this.appendRecoveryGuidanceMessage(currentMessages, batchResults);
    }

    this.ensureSessionTracked(sendingSession);
    const thinkingDisplay = accumulatedDisplay + THINKING_SUFFIX;
    assistantMessage.content = thinkingDisplay;
    assistantMessage.streamingState = "in_progress";
    await this.flushAssistantMessageCheckpoint(
      sendingSession,
      assistantMessage,
      "in_progress",
    );
    this.ensureSessionTracked(sendingSession);
    if (this.callbacks.isSessionActive(sendingSession)) {
      this.callbacks.onStreamingUpdate?.(thinkingDisplay);
    }

    return accumulatedDisplay;
  }

  private createToolExecutionEntries(
    session: ChatSession,
    assistantMessage: ChatMessage,
    toolCalls: ToolCall[],
    paperStructure?: PaperStructure | PaperStructureExtended | null,
  ): ToolExecutionBatchEntry[] {
    return planToolExecutionEntries({
      sessionId: session.id,
      assistantMessage,
      toolCalls,
      previousResults: session.toolExecutionState?.results || [],
      paperStructure,
      createExecutionBatches: (requests) =>
        this.toolScheduler.createExecutionBatches(requests),
    });
  }

  private async finalizeCompletedTurn(params: {
    sendingSession: ChatSession;
    currentMessages: ChatMessage[];
    assistantMessage: ChatMessage;
    pdfWasAttached: boolean;
    summaryTriggered: boolean;
    accumulatedDisplay: string;
    iteration: number;
  }): Promise<void> {
    const {
      sendingSession,
      currentMessages,
      assistantMessage,
      pdfWasAttached,
      summaryTriggered,
      accumulatedDisplay,
      iteration,
    } = params;

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
    this.ensureSessionTracked(sendingSession);
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
      getContextManager()
        .generateSummaryAsync(sendingSession, async () => {
          this.ensureSessionTracked(sendingSession);
          await this.sessionStorage.updateSessionMeta(sendingSession);
        })
        .catch((err) => {
          ztoolkit.log("[AgentRuntime] Summary generation failed:", err);
        });
    }
  }

  private async finalizeMaxIterationsTurn(
    sendingSession: ChatSession,
    currentMessages: ChatMessage[],
    assistantMessage: ChatMessage,
    accumulatedDisplay: string,
    iteration: number,
  ): Promise<void> {
    assistantMessage.content = accumulatedDisplay;
    assistantMessage.timestamp = Date.now();
    sendingSession.updatedAt = Date.now();
    this.executionPlanManager.failPlan(
      sendingSession,
      currentMessages,
      MAX_ITERATIONS_ERROR,
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
    this.ensureSessionTracked(sendingSession);
    this.touchToolExecutionState(sendingSession);
    await this.sessionStorage.updateSessionMeta(sendingSession);
    this.emitPlanUpdate(sendingSession);
    this.emitRuntimeEvent<"turn_failed">(sendingSession, assistantMessage, {
      type: "turn_failed",
      error: MAX_ITERATIONS_ERROR,
      iteration,
    });
    if (this.callbacks.isSessionActive(sendingSession)) {
      this.callbacks.onMessageUpdate?.(sendingSession.messages);
      this.callbacks.onMessageComplete?.();
    }
  }

  private async finalizeErroredTurn(
    sendingSession: ChatSession,
    currentMessages: ChatMessage[],
    assistantMessage: ChatMessage,
    error: unknown,
    iteration: number,
    logPrefix: string,
  ): Promise<void> {
    this.executionPlanManager.failPlan(
      sendingSession,
      currentMessages,
      getErrorMessage(error),
    );
    // Persist as "interrupted" instead of "in_progress": the catch path means
    // this turn is done, so the on-disk snapshot should match. markInterrupted
    // on next load would fix it, but only if another session is loaded — if
    // the user re-opens this exact session we want an accurate state.
    await this.flushAssistantMessageCheckpoint(
      sendingSession,
      assistantMessage,
      "interrupted",
    );
    this.ensureSessionTracked(sendingSession);
    this.touchToolExecutionState(sendingSession);
    await this.sessionStorage.updateSessionMeta(sendingSession);
    this.emitPlanUpdate(sendingSession);
    this.emitRuntimeEvent<"turn_failed">(sendingSession, assistantMessage, {
      type: "turn_failed",
      error: getErrorMessage(error),
      iteration,
    });
    ztoolkit.log(`[${logPrefix}] Error:`, error);
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

  private appendRecoveryGuidanceMessage(
    currentMessages: ChatMessage[],
    results: ToolExecutionResult[],
  ): void {
    const systemMessage = createRecoveryGuidanceSystemMessage(
      results,
      this.callbacks.generateId,
    );
    if (!systemMessage) {
      return;
    }
    currentMessages.push(systemMessage);
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
    ensureTrackedSession(session, this.callbacks.isSessionTracked);
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
