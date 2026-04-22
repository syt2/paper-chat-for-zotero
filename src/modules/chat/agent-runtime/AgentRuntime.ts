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
  ToolPolicyTrace,
  ToolExecutionResult,
} from "../../../types/tool";
import type { ToolCallingProvider } from "../../../types/provider";
import { getErrorMessage } from "../../../utils/common";
import { getPref } from "../../../utils/prefs";
import { isAbortError, SessionRunInvalidatedError } from "../errors";
import type { SessionStorageService } from "../SessionStorageService";
import type {
  ToolSchedulerExecutionHooks,
  ToolSchedulerRequest,
} from "../tool-scheduler";
import { ExecutionPlanManager } from "./ExecutionPlanManager";
import {
  planToolExecutionEntries,
  type ToolExecutionBatchEntry,
} from "./ToolExecutionEntryPlanner";
import {
  awaitWhileSessionTracked,
  ensureTrackedSession,
} from "./sessionTracking";
import {
  DEFAULT_AGENT_MAX_PLANNING_ITERATIONS,
  normalizeAgentMaxPlanningIterations,
} from "./IterationLimitConfig";
import {
  getToolBudgetLimits,
  type ToolBudgetLimits,
} from "../tool-budget/ToolBudgetPolicy";
import { createRecoveryGuidanceSystemMessage } from "../tool-recovery/ToolRecoveryPolicy";
import { parseToolError } from "../tool-errors/ToolErrorFormatter";

interface AgentRuntimeCallbacks {
  isSessionActive: (session: ChatSession) => boolean;
  isSessionTracked: (session: ChatSession, runId?: number) => boolean;
  onRuntimeEvent?: (event: AgentRuntimeEvent) => void;
  onStreamingUpdate?: (content: string, messageId: string) => void;
  onReasoningUpdate?: (reasoning: string, messageId: string) => void;
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

interface RuntimeToolScheduler {
  createExecutionBatches(
    requests: ToolSchedulerRequest[],
  ): ToolSchedulerRequest[][];
  executeBatch(
    requests: ToolSchedulerRequest[],
    hooks?: ToolSchedulerExecutionHooks,
  ): Promise<ToolExecutionResult[]>;
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
  sessionRunId?: number;
  abortSignal?: AbortSignal;
  refreshSystemPrompt?: (
    currentMessages: ChatMessage[],
    session: ChatSession,
    runtimeState?: {
      currentIteration: number;
      remainingIterations: number;
      maxIterations: number;
      forceFinalAnswer: boolean;
    },
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
  sessionRunId?: number;
  currentMessages: ChatMessage[];
  assistantMessage: ChatMessage;
  paperStructure?: PaperStructure | PaperStructureExtended | null;
  toolCalls: ToolCall[];
  roundContent: string;
  accumulatedDisplay: string;
  iteration: number;
  logPrefix: string;
  budgetLimits: ToolBudgetLimits;
}

// Hard stop for a single assistant turn. Keeps malformed tool loops bounded
// while still allowing a few replan / retry pivots inside one response.
const THINKING_SUFFIX = "\n\n···";
const MAX_ITERATIONS_MESSAGE =
  "\n\nI apologize, but I was unable to complete the request within the allowed number of iterations.";
const MAX_ITERATIONS_ERROR = "Maximum tool-calling iterations reached.";
const AGENT_TRACE_LOG_PREF =
  "extensions.zotero.paperchat.devEnableAgentTraceLogs";

interface IterationControlState {
  currentIteration: number;
  remainingIterations: number;
  maxIterations: number;
  forceFinalAnswer: boolean;
  toolsForRound: ToolDefinition[];
}

export class AgentRuntime {
  private executionPlanManager = new ExecutionPlanManager();
  private messageCheckpointTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private messageCheckpointQueues = new Map<string, Promise<void>>();

  constructor(
    private sessionStorage: SessionStorageService,
    private callbacks: AgentRuntimeCallbacks,
    private toolScheduler: RuntimeToolScheduler,
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
      sessionRunId,
      abortSignal,
      refreshSystemPrompt,
    } = options;
    const logPrefix = "Streaming Tool Calling";
    const maxIterations = this.getMaxIterations();
    const budgetLimits = getToolBudgetLimits(maxIterations);
    let iteration = 0;
    let accumulatedDisplay = "";
    await this.startTurn(
      sendingSession,
      sessionRunId,
      assistantMessage,
      currentMessages,
      true,
    );

    try {
      while (iteration < maxIterations) {
        iteration++;
        const iterationControl = this.createIterationControl(
          iteration,
          tools,
          maxIterations,
        );
        this.refreshSystemPrompt(
          currentMessages,
          sendingSession,
          refreshSystemPrompt,
          iterationControl,
        );
        ztoolkit.log(
          `[${logPrefix}] Iteration ${iteration}, messages: ${currentMessages.length}`,
        );
        if (iterationControl.forceFinalAnswer) {
          ztoolkit.log(
            `[${logPrefix}] Final synthesis iteration ${iteration}/${maxIterations}; tools disabled for this round`,
          );
        }

        const displayBeforeThisRound = accumulatedDisplay;
        const result = await this.runStreamingRound(
          provider,
          currentMessages,
          iterationControl.toolsForRound,
          sendingSession,
          sessionRunId,
          abortSignal,
          assistantMessage,
          displayBeforeThisRound,
          iteration,
        );

        this.ensureSessionTracked(sendingSession, sessionRunId);

        ztoolkit.log(
          `[${logPrefix}] Response:`,
          result.content ? result.content.substring(0, 100) : "(no content)",
          "toolCalls:",
          result.toolCalls?.length || 0,
          "stopReason:",
          result.stopReason,
        );

        if (
          !iterationControl.forceFinalAnswer &&
          result.toolCalls &&
          result.toolCalls.length > 0
        ) {
          accumulatedDisplay = await this.runToolIteration({
            sendingSession,
            sessionRunId,
            currentMessages,
            assistantMessage,
            paperStructure,
            toolCalls: result.toolCalls,
            roundContent: result.content || "",
            accumulatedDisplay,
            iteration,
            logPrefix,
            budgetLimits,
          });
          continue;
        }

        if (
          iterationControl.forceFinalAnswer &&
          !(result.content || "").trim()
        ) {
          ztoolkit.log(
            `[${logPrefix}] Final synthesis round returned no text; falling back to max-iterations message`,
          );
          await this.finalizeMaxIterationsTurn(
            sendingSession,
            sessionRunId,
            currentMessages,
            assistantMessage,
            accumulatedDisplay + MAX_ITERATIONS_MESSAGE,
            iteration,
          );
          return;
        }

        await this.finalizeCompletedTurn({
          sendingSession,
          sessionRunId,
          currentMessages,
          assistantMessage,
          pdfWasAttached,
          summaryTriggered,
          accumulatedDisplay: accumulatedDisplay + (result.content || ""),
          iteration,
        });
        return;
      }

      ztoolkit.log(`[${logPrefix}] Max iterations reached without a terminal response`);
      await this.finalizeMaxIterationsTurn(
        sendingSession,
        sessionRunId,
        currentMessages,
        assistantMessage,
        accumulatedDisplay + MAX_ITERATIONS_MESSAGE,
        iteration,
      );
    } catch (error) {
      if (
        error instanceof SessionRunInvalidatedError ||
        (isAbortError(error) &&
          !this.callbacks.isSessionTracked(sendingSession, sessionRunId))
      ) {
        return;
      }
      await this.finalizeErroredTurn(
        sendingSession,
        sessionRunId,
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
      sessionRunId,
      abortSignal,
      refreshSystemPrompt,
    } = options;
    const logPrefix = "Tool Calling";
    const maxIterations = this.getMaxIterations();
    const budgetLimits = getToolBudgetLimits(maxIterations);
    let iteration = 0;
    let accumulatedDisplay = "";
    await this.startTurn(
      sendingSession,
      sessionRunId,
      assistantMessage,
      currentMessages,
      false,
    );

    try {
      while (iteration < maxIterations) {
        iteration++;
        const iterationControl = this.createIterationControl(
          iteration,
          tools,
          maxIterations,
        );
        this.refreshSystemPrompt(
          currentMessages,
          sendingSession,
          refreshSystemPrompt,
          iterationControl,
        );
        ztoolkit.log(
          `[${logPrefix}] Iteration ${iteration}, messages: ${currentMessages.length}`,
        );
        if (iterationControl.forceFinalAnswer) {
          ztoolkit.log(
            `[${logPrefix}] Final synthesis iteration ${iteration}/${maxIterations}; tools disabled for this round`,
          );
        }

        const result = await provider.chatCompletionWithTools(
          currentMessages,
          iterationControl.toolsForRound,
          abortSignal,
        );

        this.ensureSessionTracked(sendingSession, sessionRunId);

        ztoolkit.log(
          `[${logPrefix}] Response:`,
          result.content ? result.content.substring(0, 100) : "(no content)",
          "toolCalls:",
          result.toolCalls?.length || 0,
        );

        if (
          !iterationControl.forceFinalAnswer &&
          result.toolCalls &&
          result.toolCalls.length > 0
        ) {
          accumulatedDisplay = await this.runToolIteration({
            sendingSession,
            sessionRunId,
            currentMessages,
            assistantMessage,
            paperStructure,
            toolCalls: result.toolCalls,
            roundContent: result.content || "",
            accumulatedDisplay,
            iteration,
            logPrefix,
            budgetLimits,
          });
          continue;
        }

        if (
          iterationControl.forceFinalAnswer &&
          !(result.content || "").trim()
        ) {
          ztoolkit.log(
            `[${logPrefix}] Final synthesis round returned no text; falling back to max-iterations message`,
          );
          await this.finalizeMaxIterationsTurn(
            sendingSession,
            sessionRunId,
            currentMessages,
            assistantMessage,
            accumulatedDisplay + MAX_ITERATIONS_MESSAGE,
            iteration,
          );
          return;
        }

        await this.finalizeCompletedTurn({
          sendingSession,
          sessionRunId,
          currentMessages,
          assistantMessage,
          pdfWasAttached,
          summaryTriggered,
          accumulatedDisplay: accumulatedDisplay + (result.content || ""),
          iteration,
        });
        return;
      }

      ztoolkit.log(`[${logPrefix}] Max iterations reached without a terminal response`);
      await this.finalizeMaxIterationsTurn(
        sendingSession,
        sessionRunId,
        currentMessages,
        assistantMessage,
        accumulatedDisplay + MAX_ITERATIONS_MESSAGE,
        iteration,
      );
    } catch (error) {
      if (
        error instanceof SessionRunInvalidatedError ||
        (isAbortError(error) &&
          !this.callbacks.isSessionTracked(sendingSession, sessionRunId))
      ) {
        return;
      }
      await this.finalizeErroredTurn(
        sendingSession,
        sessionRunId,
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
    sessionRunId: number | undefined,
    assistantMessage: ChatMessage,
    currentMessages: ChatMessage[],
    streaming: boolean,
  ): Promise<void> {
    const plan = this.executionPlanManager.startPlan(session, currentMessages);
    this.initializeToolExecutionState(session);
    await this.sessionStorage.updateSessionMeta(session);
    this.emitPlanUpdate(session, sessionRunId);
    this.emitRuntimeEvent<"turn_started">(
      session,
      sessionRunId,
      assistantMessage,
      {
        type: "turn_started",
        summary: plan.summary,
        streaming,
      },
    );
  }

  private async runStreamingRound(
    provider: StreamingRuntimeExecutionOptions["provider"],
    currentMessages: ChatMessage[],
    tools: ToolDefinition[],
    sendingSession: ChatSession,
    sessionRunId: number | undefined,
    abortSignal: AbortSignal | undefined,
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

      const buildDraftToolCallDisplay = (): string => {
        const ordered = [...pendingToolCalls.entries()].sort(
          ([leftIndex], [rightIndex]) => leftIndex - rightIndex,
        );
        return ordered
          .map(([, toolCall]) =>
            this.callbacks.formatToolCallCard(
              toolCall.name,
              toolCall.arguments,
              "calling",
            ),
          )
          .join("");
      };

      const getPersistedStreamingContent = (): string =>
        displayBeforeThisRound + roundContent;

      const getUiStreamingContent = (): string =>
        getPersistedStreamingContent() + buildDraftToolCallDisplay();

      const updateAssistantStreamingContent = (): string | undefined => {
        if (!this.callbacks.isSessionTracked(sendingSession, sessionRunId)) {
          return undefined;
        }
        const uiContent = getUiStreamingContent();
        assistantMessage.content = getPersistedStreamingContent();
        assistantMessage.streamingState = "in_progress";
        this.scheduleAssistantMessageCheckpoint(
          sendingSession,
          sessionRunId,
          assistantMessage,
        );
        if (this.callbacks.isSessionActive(sendingSession)) {
          this.callbacks.onStreamingUpdate?.(uiContent, assistantMessage.id);
        }
        return uiContent;
      };

      const callbacks: StreamToolCallingCallbacks = {
        onTextDelta: (text) => {
          if (!this.callbacks.isSessionTracked(sendingSession, sessionRunId)) {
            return;
          }
          roundContent += text;
          const uiContent = updateAssistantStreamingContent();
          this.emitRuntimeEvent<"text_delta">(
            sendingSession,
            sessionRunId,
            assistantMessage,
            {
              type: "text_delta",
              delta: text,
              content: uiContent || assistantMessage.content,
              iteration,
            },
          );
        },
        onReasoningDelta: (text) => {
          if (!this.callbacks.isSessionTracked(sendingSession, sessionRunId)) {
            return;
          }
          assistantMessage.reasoning =
            (assistantMessage.reasoning || "") + text;
          assistantMessage.streamingState = "in_progress";
          this.scheduleAssistantMessageCheckpoint(
            sendingSession,
            sessionRunId,
            assistantMessage,
          );
          this.emitRuntimeEvent<"reasoning_delta">(
            sendingSession,
            sessionRunId,
            assistantMessage,
            {
              type: "reasoning_delta",
              delta: text,
              reasoning: assistantMessage.reasoning,
              iteration,
            },
          );
          if (this.callbacks.isSessionActive(sendingSession)) {
            this.callbacks.onReasoningUpdate?.(
              assistantMessage.reasoning,
              assistantMessage.id,
            );
          }
        },
        onToolCallStart: ({ index, id, name }) => {
          pendingToolCalls.set(index, { id, name, arguments: "" });
          ztoolkit.log(
            `[Streaming Tool Calling] Tool call started: ${name} (${id})`,
          );
          updateAssistantStreamingContent();
        },
        onToolCallDelta: (index, argumentsDelta) => {
          const tc = pendingToolCalls.get(index);
          if (tc) {
            tc.arguments += argumentsDelta;
            updateAssistantStreamingContent();
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
        .streamChatCompletionWithTools(
          currentMessages,
          tools,
          callbacks,
          abortSignal,
        )
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
  private async runToolIteration(params: ToolIterationParams): Promise<string> {
    const {
      sendingSession,
      sessionRunId,
      currentMessages,
      assistantMessage,
      paperStructure,
      toolCalls,
      roundContent,
      iteration,
      logPrefix,
      budgetLimits,
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
      budgetLimits,
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
          sessionRunId,
          assistantMessage,
          "in_progress",
        );
        await this.sessionStorage.updateSessionMeta(sendingSession);
        this.emitPlanUpdate(sendingSession, sessionRunId);
        if (this.callbacks.isSessionActive(sendingSession)) {
          this.callbacks.onStreamingUpdate?.(
            callingDisplay,
            assistantMessage.id,
          );
        }
      }

      const batchResults =
        entry.kind === "execute"
          ? await this.executeBatchWithRuntimeEvents(
              sendingSession,
              sessionRunId,
              assistantMessage,
              entry.requests,
              iteration,
            )
          : entry.results;
      this.appendToolExecutionResults(sendingSession, batchResults);
      await this.sessionStorage.updateSessionMeta(sendingSession);
      this.emitPlanUpdate(sendingSession, sessionRunId);

      for (const executionResult of batchResults) {
        this.ensureSessionTracked(sendingSession, sessionRunId);
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
        const primaryPolicyTrace = getPrimaryPolicyTrace(executionResult);
        const parsedToolError =
          executionResult.status === "completed"
            ? null
            : parseToolError(executionResult.content);

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
          sessionRunId,
          assistantMessage,
          "in_progress",
        );
        this.ensureSessionTracked(sendingSession, sessionRunId);
        this.executionPlanManager.addOrUpdateToolStep(
          sendingSession,
          currentMessages,
          toolCall.id,
          toolName,
          planStepStatus,
          truncateToolDetail(toolResult),
        );
        await this.sessionStorage.updateSessionMeta(sendingSession);
        this.emitPlanUpdate(sendingSession, sessionRunId);

        this.emitRuntimeEvent<"tool_completed">(
          sendingSession,
          sessionRunId,
          assistantMessage,
          {
            type: "tool_completed",
            toolCallId: toolCall.id,
            toolName,
            args: toolArgs,
            resultPreview: truncateToolDetail(toolResult),
            status: executionResult.status,
            origin: primaryPolicyTrace?.stage || "executor",
            policyName: primaryPolicyTrace?.policy,
            policyOutcome: primaryPolicyTrace?.outcome,
            policySummary: primaryPolicyTrace?.summary,
            policyTrace: executionResult.policyTrace,
            errorCategory:
              executionResult.status === "completed"
                ? undefined
                : parsedToolError?.category || "unspecified",
            iteration,
          },
        );
        if (this.callbacks.isSessionActive(sendingSession)) {
          this.callbacks.onStreamingUpdate?.(
            accumulatedDisplay,
            assistantMessage.id,
          );
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
        this.emitPlanUpdate(sendingSession, sessionRunId);
      }

      this.appendRecoveryGuidanceMessage(currentMessages, batchResults);
    }

    this.ensureSessionTracked(sendingSession, sessionRunId);
    const thinkingDisplay = accumulatedDisplay + THINKING_SUFFIX;
    assistantMessage.content = thinkingDisplay;
    assistantMessage.streamingState = "in_progress";
    await this.flushAssistantMessageCheckpoint(
      sendingSession,
      sessionRunId,
      assistantMessage,
      "in_progress",
    );
    this.ensureSessionTracked(sendingSession, sessionRunId);
    if (this.callbacks.isSessionActive(sendingSession)) {
      this.callbacks.onStreamingUpdate?.(
        thinkingDisplay,
        assistantMessage.id,
      );
    }

    return accumulatedDisplay;
  }

  private createToolExecutionEntries(
    session: ChatSession,
    assistantMessage: ChatMessage,
    toolCalls: ToolCall[],
    budgetLimits: ToolBudgetLimits,
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
      budgetLimits,
    });
  }

  private async executeBatchWithRuntimeEvents(
    session: ChatSession,
    sessionRunId: number | undefined,
    assistantMessage: ChatMessage,
    requests: ToolSchedulerRequest[],
    iteration: number,
  ): Promise<ToolExecutionResult[]> {
    const startedRequests: ToolSchedulerRequest[] = [];

    try {
      return await awaitWhileSessionTracked(
        session,
        this.callbacks.isSessionTracked,
        sessionRunId,
        () =>
          this.toolScheduler.executeBatch(requests, {
            onExecutionReady: (request) => {
              this.ensureSessionTracked(session, sessionRunId);
              startedRequests.push(request);
              this.emitRuntimeEvent<"tool_started">(
                session,
                sessionRunId,
                assistantMessage,
                {
                  type: "tool_started",
                  toolCallId: request.toolCall.id,
                  toolName: request.toolCall.function.name,
                  args: request.toolCall.function.arguments,
                  iteration,
                },
              );
            },
          }),
      );
    } catch (error) {
      if (error instanceof SessionRunInvalidatedError) {
        this.emitInterruptedToolCompletions(
          session,
          sessionRunId,
          assistantMessage,
          startedRequests,
          iteration,
        );
      }
      throw error;
    }
  }

  private emitInterruptedToolCompletions(
    session: ChatSession,
    sessionRunId: number | undefined,
    assistantMessage: ChatMessage,
    requests: ToolSchedulerRequest[],
    iteration: number,
  ): void {
    const emittedToolCallIds = new Set<string>();
    for (const request of requests) {
      const toolCall = request.toolCall;
      if (emittedToolCallIds.has(toolCall.id)) {
        continue;
      }
      emittedToolCallIds.add(toolCall.id);
      this.emitRuntimeEvent<"tool_completed">(
        session,
        sessionRunId,
        assistantMessage,
        {
          type: "tool_completed",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          args: toolCall.function.arguments,
          resultPreview:
            "Tool execution interrupted because the session is no longer active.",
          status: "failed",
          origin: "executor",
          errorCategory: "unavailable",
          iteration,
        },
        { allowWhenInvalidated: true },
      );
    }
  }

  private async finalizeCompletedTurn(params: {
    sendingSession: ChatSession;
    sessionRunId?: number;
    currentMessages: ChatMessage[];
    assistantMessage: ChatMessage;
    pdfWasAttached: boolean;
    summaryTriggered: boolean;
    accumulatedDisplay: string;
    iteration: number;
  }): Promise<void> {
    const {
      sendingSession,
      sessionRunId,
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
      sessionRunId,
      assistantMessage,
      null,
    );
    this.ensureSessionTracked(sendingSession, sessionRunId);
    this.touchToolExecutionState(sendingSession);
    await this.sessionStorage.updateSessionMeta(sendingSession);
    this.emitPlanUpdate(sendingSession, sessionRunId);
    this.emitRuntimeEvent<"turn_completed">(
      sendingSession,
      sessionRunId,
      assistantMessage,
      {
        type: "turn_completed",
        content: accumulatedDisplay,
        iteration,
      },
    );
    if (this.callbacks.isSessionActive(sendingSession)) {
      this.callbacks.onMessageUpdate?.(sendingSession.messages);

      if (pdfWasAttached) {
        this.callbacks.onPdfAttached?.();
      }
      this.callbacks.onMessageComplete?.();
    }

    if (summaryTriggered) {
      void import("../ContextManager")
        .then(({ getContextManager }) =>
          getContextManager().generateSummaryAsync(sendingSession, async () => {
            this.ensureSessionTracked(sendingSession, sessionRunId);
            await this.sessionStorage.updateSessionMeta(sendingSession);
          }),
        )
        .catch((err) => {
          ztoolkit.log("[AgentRuntime] Summary generation failed:", err);
        });
    }
  }

  private async finalizeMaxIterationsTurn(
    sendingSession: ChatSession,
    sessionRunId: number | undefined,
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
      sessionRunId,
      assistantMessage,
      null,
    );
    this.ensureSessionTracked(sendingSession, sessionRunId);
    this.touchToolExecutionState(sendingSession);
    await this.sessionStorage.updateSessionMeta(sendingSession);
    this.emitPlanUpdate(sendingSession, sessionRunId);
    this.emitRuntimeEvent<"turn_failed">(
      sendingSession,
      sessionRunId,
      assistantMessage,
      {
        type: "turn_failed",
        error: MAX_ITERATIONS_ERROR,
        iteration,
      },
    );
    if (this.callbacks.isSessionActive(sendingSession)) {
      this.callbacks.onMessageUpdate?.(sendingSession.messages);
      this.callbacks.onMessageComplete?.();
    }
  }

  private async finalizeErroredTurn(
    sendingSession: ChatSession,
    sessionRunId: number | undefined,
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
      sessionRunId,
      assistantMessage,
      "interrupted",
    );
    this.ensureSessionTracked(sendingSession, sessionRunId);
    this.touchToolExecutionState(sendingSession);
    await this.sessionStorage.updateSessionMeta(sendingSession);
    this.emitPlanUpdate(sendingSession, sessionRunId);
    this.emitRuntimeEvent<"turn_failed">(
      sendingSession,
      sessionRunId,
      assistantMessage,
      {
        type: "turn_failed",
        error: getErrorMessage(error),
        iteration,
      },
    );
    ztoolkit.log(`[${logPrefix}] Error:`, error);
  }

  private emitPlanUpdate(session: ChatSession, sessionRunId?: number): void {
    if (
      this.callbacks.isSessionActive(session) &&
      this.callbacks.isSessionTracked(session, sessionRunId)
    ) {
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
    sessionRunId: number | undefined,
    message: ChatMessage,
  ): void {
    if (!this.callbacks.isSessionTracked(session, sessionRunId)) {
      return;
    }
    if (this.messageCheckpointTimers.has(message.id)) {
      return;
    }

    const timer = setTimeout(() => {
      this.messageCheckpointTimers.delete(message.id);
      if (!this.callbacks.isSessionTracked(session, sessionRunId)) {
        return;
      }
      void this.enqueueAssistantMessageCheckpoint(
        session,
        sessionRunId,
        message,
        "in_progress",
      );
    }, 1000);
    this.messageCheckpointTimers.set(message.id, timer);
  }

  private async flushAssistantMessageCheckpoint(
    session: ChatSession,
    sessionRunId: number | undefined,
    message: ChatMessage,
    streamingState: ChatMessageStreamingState | null,
  ): Promise<void> {
    if (!this.callbacks.isSessionTracked(session, sessionRunId)) {
      return;
    }
    const timer = this.messageCheckpointTimers.get(message.id);
    if (timer) {
      clearTimeout(timer);
      this.messageCheckpointTimers.delete(message.id);
    }

    await this.enqueueAssistantMessageCheckpoint(
      session,
      sessionRunId,
      message,
      streamingState,
    );
  }

  private async enqueueAssistantMessageCheckpoint(
    session: ChatSession,
    sessionRunId: number | undefined,
    message: ChatMessage,
    streamingState: ChatMessageStreamingState | null,
  ): Promise<void> {
    if (!this.callbacks.isSessionTracked(session, sessionRunId)) {
      return;
    }
    const previous =
      this.messageCheckpointQueues.get(message.id) || Promise.resolve();
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

  private createIterationControl(
    iteration: number,
    tools: ToolDefinition[],
    maxIterations: number,
  ): IterationControlState {
    const remainingIterations = maxIterations - iteration + 1;
    const forceFinalAnswer = remainingIterations === 1;
    return {
      currentIteration: iteration,
      remainingIterations,
      maxIterations,
      forceFinalAnswer,
      toolsForRound: forceFinalAnswer ? [] : tools,
    };
  }

  private getMaxIterations(): number {
    try {
      const raw = getPref("agentMaxPlanningIterations") as number | undefined;
      return normalizeAgentMaxPlanningIterations(raw);
    } catch {
      return DEFAULT_AGENT_MAX_PLANNING_ITERATIONS;
    }
  }

  private refreshSystemPrompt(
    currentMessages: ChatMessage[],
    session: ChatSession,
    promptBuilder?: (
      currentMessages: ChatMessage[],
      session: ChatSession,
      runtimeState?: {
        currentIteration: number;
        remainingIterations: number;
        maxIterations: number;
        forceFinalAnswer: boolean;
      },
    ) => string,
    runtimeState?: {
      currentIteration: number;
      remainingIterations: number;
      maxIterations: number;
      forceFinalAnswer: boolean;
    },
  ): void {
    if (!promptBuilder) return;

    const content = promptBuilder(currentMessages, session, runtimeState);
    const existing = currentMessages.find(
      (message) => message.id === "paper-context",
    );
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
    sessionRunId: number | undefined,
    assistantMessage: ChatMessage,
    event: RuntimeEventPayload<T>,
    options?: { allowWhenInvalidated?: boolean },
  ): void {
    if (
      !options?.allowWhenInvalidated &&
      !this.callbacks.isSessionTracked(session, sessionRunId)
    ) {
      return;
    }
    const fullEvent = {
      ...event,
      sessionId: session.id,
      assistantMessageId: assistantMessage.id,
      timestamp: Date.now(),
      planId: session.executionPlan?.id,
    } as Extract<AgentRuntimeEvent, { type: T }>;

    this.logRuntimeEvent(fullEvent);
    this.callbacks.onRuntimeEvent?.(fullEvent);
  }

  private logRuntimeEvent(event: AgentRuntimeEvent): void {
    if (!this.shouldLogRuntimeEvents()) {
      return;
    }

    ztoolkit.log(
      "[AgentRuntime][trace]",
      JSON.stringify(summarizeRuntimeEventForLog(event)),
    );
  }

  private shouldLogRuntimeEvents(): boolean {
    try {
      return Zotero.Prefs.get(AGENT_TRACE_LOG_PREF, true) === true;
    } catch {
      return false;
    }
  }

  private ensureSessionTracked(
    session: ChatSession,
    sessionRunId?: number,
  ): void {
    ensureTrackedSession(
      session,
      this.callbacks.isSessionTracked,
      sessionRunId,
    );
  }
}

function truncateToolDetail(text: string): string {
  if (text.length <= 160) {
    return text;
  }
  return text.slice(0, 157) + "...";
}

function getPrimaryPolicyTrace(
  result: ToolExecutionResult,
): ToolPolicyTrace | undefined {
  return result.policyTrace?.[0];
}

function summarizeRuntimeEventForLog(
  event: AgentRuntimeEvent,
): Record<string, unknown> {
  switch (event.type) {
    case "tool_started":
      return {
        type: event.type,
        sessionId: event.sessionId,
        planId: event.planId,
        assistantMessageId: event.assistantMessageId,
        iteration: event.iteration,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      };
    case "tool_completed":
      return {
        type: event.type,
        sessionId: event.sessionId,
        planId: event.planId,
        assistantMessageId: event.assistantMessageId,
        iteration: event.iteration,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: event.status,
        origin: event.origin,
        policyName: event.policyName,
        policyOutcome: event.policyOutcome,
        policySummary: event.policySummary,
        errorCategory: event.errorCategory,
        resultPreview: event.resultPreview,
      };
    case "approval_requested":
      return {
        type: event.type,
        sessionId: event.sessionId,
        planId: event.planId,
        assistantMessageId: event.assistantMessageId,
        requestId: event.requestId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        riskLevel: event.riskLevel,
        pendingCount: event.pendingCount,
      };
    case "approval_resolved":
      return {
        type: event.type,
        sessionId: event.sessionId,
        planId: event.planId,
        assistantMessageId: event.assistantMessageId,
        requestId: event.requestId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        verdict: event.verdict,
        scope: event.scope,
        pendingCount: event.pendingCount,
      };
    case "turn_started":
      return {
        type: event.type,
        sessionId: event.sessionId,
        planId: event.planId,
        assistantMessageId: event.assistantMessageId,
        streaming: event.streaming,
        summary: event.summary,
      };
    case "turn_completed":
      return {
        type: event.type,
        sessionId: event.sessionId,
        planId: event.planId,
        assistantMessageId: event.assistantMessageId,
        iteration: event.iteration,
        contentPreview: truncateToolDetail(event.content),
      };
    case "turn_failed":
      return {
        type: event.type,
        sessionId: event.sessionId,
        planId: event.planId,
        assistantMessageId: event.assistantMessageId,
        iteration: event.iteration,
        error: event.error,
      };
    case "text_delta":
      return {
        type: event.type,
        sessionId: event.sessionId,
        planId: event.planId,
        assistantMessageId: event.assistantMessageId,
        deltaPreview: truncateToolDetail(event.delta),
        contentLength: event.content.length,
      };
    case "reasoning_delta":
      return {
        type: event.type,
        sessionId: event.sessionId,
        planId: event.planId,
        assistantMessageId: event.assistantMessageId,
        deltaPreview: truncateToolDetail(event.delta),
        reasoningLength: event.reasoning.length,
      };
  }

  const exhaustiveEvent: never = event;
  return exhaustiveEvent;
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
