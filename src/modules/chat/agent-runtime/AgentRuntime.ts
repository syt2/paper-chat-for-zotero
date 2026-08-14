import type {
  AgentRuntimeEvent,
  AgentRuntimeEventType,
  ChatMessage,
  ChatSession,
  ExecutionPlan,
  HostedWebSearchCall,
  PresentationToolCardArtifact,
  StreamToolCallingCallbacks,
} from "../../../types/chat";
import type {
  PaperStructure,
  PaperStructureExtended,
  RequestUserInputResponse,
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
import type { ToolSchedulerExecutionContext } from "../tool-scheduler/ToolScheduler";
import type { PresentationLaunchAuthorization } from "../../presentation/PresentationLaunchAuthorization";
import { ExecutionPlanManager } from "./ExecutionPlanManager";
import {
  createReusedCompletedToolResult,
  findCompletedToolResultMatch,
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
  createToolBudgetState,
  getToolBudgetLimits,
  HOSTED_WEB_SEARCH_RESULT_ID_PREFIX,
  type ToolBudgetLimits,
} from "../tool-budget/ToolBudgetPolicy";
import { getToolRuntimeMetadata } from "../tool-scheduler/ToolMetadataRegistry";
import { createRecoveryGuidanceSystemMessage } from "../tool-recovery/ToolRecoveryPolicy";
import {
  formatToolError,
  parseToolError,
} from "../tool-errors/ToolErrorFormatter";
import {
  createBlockedRetryResult,
  findBlockedRetryMatch,
  fingerprintToolCall,
  MAX_PRESENTATION_ATTEMPTS_PER_TURN,
} from "../tool-retry/ToolRetryPolicy";
import {
  UserInputRequestCoordinator,
  type RuntimeEventPayload,
} from "./UserInputRequestCoordinator";
import { AssistantMessageCheckpointer } from "./AssistantMessageCheckpointer";
import {
  collectTrustedSourceTargets,
  normalizeSourceItemKeys,
  sanitizeSourceGroupTargets,
} from "../note-source-provenance";
import {
  buildNoteSummaryDestinationRequestArgs,
  rewriteCreateNoteTarget,
  type NoteSummaryContext,
} from "../note-summary-destination";
import {
  appendEvidenceCitationCatalog,
  collectToolEvidenceRecords,
  sanitizeEvidenceReferences,
} from "../evidence";
import { getMaxIterationsMessage } from "./messages";
import {
  SEARCH_SCOPE_TOOL_NAME,
  advanceSearchScopeAfterResults,
  createUnavailableSearchToolResult,
  executeSearchScopeSelection,
  findCompletedSearchScope,
  hasScholarlyThenWebSearchScope,
  isSearchScopeControlledToolName,
  type SearchScopeGateConfig,
  type SelectedSearchScope,
} from "./SearchScopeGate";
import {
  parsePresentationVisualReviewResponse,
  type PresentationVisualReviewer,
} from "../../presentation/PresentationVisualReview";
import {
  buildPresentationPlannerSystemPrompt,
  buildPresentationPlannerUserPrompt,
  parsePresentationPlannerResponse,
  type PresentationPlanner,
} from "../../presentation/PresentationPlanner";
import { normalizePresentationToolCall } from "../../presentation/PresentationToolCallPolicy";
import { PresentationCardProgressTracker } from "../../presentation/PresentationCardProgress";
import type {
  PresentationCardProgress,
  PresentationProgressUpdate,
} from "../../presentation/contracts";

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
    options?: {
      expandStateId?: string;
      resultPreviewMaxLength?: number;
      showResultWhileCalling?: boolean;
      presentationArtifact?: PresentationToolCardArtifact;
      presentationProgress?: PresentationCardProgress;
    },
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

interface HostedWebSearchDisplayState {
  index: number;
  status: "searching" | "completed" | "error";
  actionType?: string;
  queries?: string[];
  sources?: Array<{ title?: string; url: string }>;
}

type ProviderRequestExecutor = <T>(
  operation: () => Promise<T>,
  onProviderRerouted?: () => void,
) => Promise<T>;

interface RuntimeExecutionOptions {
  provider: ToolCallingProvider;
  currentMessages: ChatMessage[];
  assistantMessage: ChatMessage;
  pdfWasAttached: boolean;
  summaryTriggered: boolean;
  tools: ToolDefinition[];
  paperStructure?: PaperStructure | PaperStructureExtended | null;
  sendingSession: ChatSession;
  currentItemKey?: string | null;
  currentItemLibraryID?: number;
  sessionRunId?: number;
  abortSignal?: AbortSignal;
  executeProviderRequest?: ProviderRequestExecutor;
  preserveToolExecutionState?: boolean;
  lockedToolItemKey?: string;
  noteSummaryContext?: NoteSummaryContext;
  searchScopeGate?: SearchScopeGateConfig;
  refreshSystemPrompt?: (
    currentMessages: ChatMessage[],
    session: ChatSession,
    runtimeState?: {
      currentIteration: number;
      remainingIterations: number;
      maxIterations: number;
      forceFinalAnswer: boolean;
    },
  ) => string | null;
  presentationAuthorization?: PresentationLaunchAuthorization;
}

interface StreamingRuntimeExecutionOptions extends RuntimeExecutionOptions {
  provider: ToolCallingProvider & {
    streamChatCompletionWithTools: NonNullable<
      ToolCallingProvider["streamChatCompletionWithTools"]
    >;
  };
}

interface ToolIterationParams {
  sendingSession: ChatSession;
  sessionRunId?: number;
  currentMessages: ChatMessage[];
  assistantMessage: ChatMessage;
  provider: ToolCallingProvider;
  paperStructure?: PaperStructure | PaperStructureExtended | null;
  toolCalls: ToolCall[];
  roundContent: string;
  roundReasoning?: string;
  accumulatedDisplay: string;
  iteration: number;
  logPrefix: string;
  budgetLimits: ToolBudgetLimits;
  reuseCompletedResults: boolean;
  currentItemKey?: string | null;
  lockedToolItemKey?: string;
  currentItemLibraryID?: number;
  allowedToolNames: Set<string>;
  selectedSearchScope?: SelectedSearchScope;
  noteSummaryContext?: NoteSummaryContext;
  abortSignal?: AbortSignal;
  executeProviderRequest: ProviderRequestExecutor;
  presentationAuthorization?: PresentationLaunchAuthorization;
}

function rewriteToolCallItemKey(
  toolCall: ToolCall,
  lockedItemKey?: string,
): ToolCall {
  if (!lockedItemKey) {
    return toolCall;
  }
  try {
    const parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
    if (
      typeof parsedArgs !== "object" ||
      parsedArgs === null ||
      Array.isArray(parsedArgs)
    ) {
      return toolCall;
    }
    return {
      ...toolCall,
      function: {
        ...toolCall.function,
        arguments: JSON.stringify({
          ...parsedArgs,
          itemKey: lockedItemKey,
        }),
      },
    };
  } catch {
    return toolCall;
  }
}

// Hard stop for a single assistant turn. Keeps malformed tool loops bounded
// while still allowing a few replan / retry pivots inside one response.
const MAX_ITERATIONS_ERROR = "Maximum tool-calling iterations reached.";
const MAX_PRESENTATION_RECOVERY_EXTENSIONS = 2;
const MAX_PRESENTATION_RECOVERY_NUDGES = 2;
const AGENT_TRACE_LOG_PREF =
  "extensions.zotero.paperchat.devEnableAgentTraceLogs";

class PresentationProtocolError extends Error {
  constructor(
    message: string,
    readonly previousDraft?: unknown,
  ) {
    super(message);
    this.name = "PresentationProtocolError";
  }
}

type RuntimeToolIterationEntry =
  | ToolExecutionBatchEntry
  | {
      kind: "user_input";
      toolCall: ToolCall;
    }
  | {
      kind: "search_scope";
      toolCall: ToolCall;
    };

function createUnavailableToolResult(toolCall: ToolCall): ToolExecutionResult {
  return {
    toolCall,
    status: "denied",
    policyTrace: [
      {
        stage: "planner",
        policy: "permission_decision",
        outcome: "blocked",
        summary:
          "Blocked a tool that was not available in the current model round.",
      },
    ],
    content: formatToolError({
      summary: `Tool ${toolCall.function.name} is not available in the current model round.`,
      category: "permission_denied",
      retryable: true,
      cause:
        "The model requested a tool that was not included in the current request.",
      suggestedFix:
        "Continue using only the tools exposed in this model round.",
    }),
  };
}

interface IterationControlState {
  currentIteration: number;
  remainingIterations: number;
  maxIterations: number;
  forceFinalAnswer: boolean;
  toolsForRound: ToolDefinition[];
  toolChoice: "auto" | "none";
}

export class AgentRuntime {
  private executionPlanManager = new ExecutionPlanManager();
  private messageCheckpointer = new AssistantMessageCheckpointer({
    isSessionTracked: (session, sessionRunId) =>
      this.callbacks.isSessionTracked(session, sessionRunId),
    persistCheckpoint: async (session, message, streamingState) => {
      const groundedDisplay = this.sanitizeGroundedDisplay(
        session,
        message.content,
      );
      const mergedSourceItemKeys = this.mergeAssistantSourceItemKeys(
        message,
        groundedDisplay.sourceItemKeys,
      );
      const sourceItemKeys = mergedSourceItemKeys || [];
      message.sourceItemKeys = mergedSourceItemKeys;
      await this.sessionStorage.updateMessageContent(
        session.id,
        message.id,
        groundedDisplay.content,
        message.reasoning,
        {
          streamingState,
          evidence: groundedDisplay.evidence || [],
          sourceItemKeys,
          presentationArtifacts: message.presentationArtifacts || [],
        },
      );
    },
  });
  private pendingMutatingToolEntries = new Map<string, Set<Promise<void>>>();
  private userInput = new UserInputRequestCoordinator({
    persistUserInputRequestState: (session) =>
      this.sessionStorage.updateSessionUserInputRequestState(session),
    notifySessionUpdated: (session) => {
      if (this.callbacks.isSessionActive(session)) {
        this.callbacks.onExecutionPlanUpdate?.(session.executionPlan);
        this.callbacks.onMessageUpdate?.(session.messages);
      }
    },
    ensureSessionTracked: (session, sessionRunId) =>
      this.ensureSessionTracked(session, sessionRunId),
    emitRuntimeEvent: <T extends AgentRuntimeEventType>(
      session: ChatSession,
      sessionRunId: number | undefined,
      assistantMessage: ChatMessage,
      event: RuntimeEventPayload<T>,
    ) => this.emitRuntimeEvent(session, sessionRunId, assistantMessage, event),
    addUserInputPlanStep: (session, currentMessages, toolCallId, description) =>
      this.executionPlanManager.addOrUpdateToolStep(
        session,
        currentMessages,
        toolCallId,
        "request_user_input",
        "in_progress",
        description,
      ),
  });

  constructor(
    private sessionStorage: SessionStorageService,
    private callbacks: AgentRuntimeCallbacks,
    private toolScheduler: RuntimeToolScheduler,
  ) {}

  resolveUserInputRequest(
    requestId: string,
    response: RequestUserInputResponse,
  ): boolean {
    return this.userInput.resolveUserInputRequest(requestId, response);
  }

  cancelPendingUserInputRequests(sessionId: string): number {
    return this.userInput.cancelPendingUserInputRequests(sessionId);
  }

  async waitForPendingMutatingToolExecutions(sessionId: string): Promise<void> {
    const pending = this.pendingMutatingToolEntries.get(sessionId);
    if (!pending?.size) {
      return;
    }
    await Promise.all([...pending]);
  }

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
      currentItemKey,
      currentItemLibraryID,
      sessionRunId,
      abortSignal,
      executeProviderRequest = (operation) => operation(),
      preserveToolExecutionState = false,
      lockedToolItemKey,
      noteSummaryContext,
      searchScopeGate,
      refreshSystemPrompt,
      presentationAuthorization,
    } = options;
    const logPrefix = "Streaming Tool Calling";
    const configuredMaxIterations = this.getMaxIterations();
    let maxIterations = configuredMaxIterations;
    let presentationRecoveryExtensions = 0;
    let presentationRecoveryNudges = 0;
    let pendingRetryablePresentationFailure = false;
    let presentationFailureAttempts = 0;
    let budgetLimits = getToolBudgetLimits(configuredMaxIterations);
    let iteration = 0;
    let accumulatedDisplay = assistantMessage.content;
    await this.startTurn(
      sendingSession,
      sessionRunId,
      assistantMessage,
      currentMessages,
      true,
      preserveToolExecutionState,
    );
    presentationFailureAttempts = countRetryablePresentationFailures(
      sendingSession.toolExecutionState?.results || [],
    );
    let selectedSearchScope = searchScopeGate
      ? findCompletedSearchScope(
          sendingSession.toolExecutionState?.results || [],
        )
      : undefined;
    if (
      searchScopeGate &&
      hasScholarlyThenWebSearchScope(
        sendingSession.toolExecutionState?.results || [],
      )
    ) {
      maxIterations = Math.max(maxIterations, 6);
      budgetLimits = getToolBudgetLimits(maxIterations);
    }
    if (selectedSearchScope) {
      searchScopeGate?.onScopeSelected(selectedSearchScope);
    }

    try {
      while (iteration < maxIterations) {
        iteration++;
        const iterationControl = this.createIterationControl(
          iteration,
          tools,
          maxIterations,
          sendingSession,
          budgetLimits,
          provider.supportsHostedWebSearch?.() === true,
        );
        this.refreshSystemPrompt(
          currentMessages,
          sendingSession,
          refreshSystemPrompt,
          iterationControl,
        );
        this.prepareMessagesForModel(currentMessages, provider);
        ztoolkit.log(
          `[${logPrefix}] Iteration ${iteration}, messages: ${currentMessages.length}`,
        );
        if (iterationControl.forceFinalAnswer) {
          ztoolkit.log(
            `[${logPrefix}] Final synthesis iteration ${iteration}/${maxIterations}; tools disabled for this round`,
          );
        }

        const displayBeforeThisRound = accumulatedDisplay;
        const refreshRoundToolsAfterProviderChange = () =>
          this.refreshIterationToolsForProvider(
            iterationControl,
            iteration,
            tools,
            maxIterations,
            sendingSession,
            budgetLimits,
            provider.supportsHostedWebSearch?.() === true,
          );
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
          iterationControl.toolChoice,
          executeProviderRequest,
          refreshRoundToolsAfterProviderChange,
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

        this.upsertHostedWebSearchResults(
          sendingSession,
          result.hostedWebSearches || [],
        );
        const hostedWebSearchDisplay = this.formatHostedWebSearchDisplay(
          result.hostedWebSearches || [],
        );

        if (
          !iterationControl.forceFinalAnswer &&
          result.toolCalls &&
          result.toolCalls.length > 0
        ) {
          const toolIteration = await this.runToolIteration({
            sendingSession,
            sessionRunId,
            currentMessages,
            assistantMessage,
            provider,
            paperStructure,
            toolCalls: result.toolCalls,
            roundContent: result.content || "",
            roundReasoning: result.reasoning,
            accumulatedDisplay: accumulatedDisplay + hostedWebSearchDisplay,
            iteration,
            logPrefix,
            budgetLimits,
            reuseCompletedResults: preserveToolExecutionState,
            currentItemKey,
            lockedToolItemKey,
            currentItemLibraryID,
            allowedToolNames: new Set(
              iterationControl.toolsForRound.map((tool) => tool.function.name),
            ),
            selectedSearchScope,
            noteSummaryContext,
            abortSignal,
            executeProviderRequest,
            presentationAuthorization,
          });
          accumulatedDisplay = toolIteration.accumulatedDisplay;
          presentationFailureAttempts +=
            toolIteration.retryablePresentationFailures;
          const presentationRetryBudgetRemaining =
            presentationFailureAttempts < MAX_PRESENTATION_ATTEMPTS_PER_TURN;
          if (toolIteration.completedPresentationCalls > 0) {
            pendingRetryablePresentationFailure = false;
          } else if (toolIteration.retryablePresentationFailures > 0) {
            pendingRetryablePresentationFailure =
              presentationRetryBudgetRemaining;
          }
          if (
            toolIteration.retryablePresentationFailures > 0 &&
            !presentationRetryBudgetRemaining
          ) {
            currentMessages.push(
              createPresentationAttemptsExhaustedSystemMessage(
                this.callbacks.generateId(),
              ),
            );
            maxIterations = iteration + 1;
            budgetLimits = getToolBudgetLimits(maxIterations);
          } else if (
            toolIteration.retryablePresentationFailures > 0 &&
            presentationRecoveryExtensions <
              MAX_PRESENTATION_RECOVERY_EXTENSIONS &&
            maxIterations < iteration + 2
          ) {
            maxIterations = iteration + 2;
            presentationRecoveryExtensions += 1;
            budgetLimits = getToolBudgetLimits(maxIterations);
          }
          if (
            toolIteration.selectedSearchScope &&
            toolIteration.selectedSearchScope !== selectedSearchScope
          ) {
            const nextSearchScope = toolIteration.selectedSearchScope;
            if (!selectedSearchScope) {
              maxIterations += 1;
            }
            if (nextSearchScope === "scholarly_then_web") {
              maxIterations = Math.max(maxIterations, iteration + 3, 6);
              budgetLimits = getToolBudgetLimits(maxIterations);
            } else if (selectedSearchScope === "scholarly_then_web") {
              maxIterations = Math.max(maxIterations, iteration + 2, 6);
              budgetLimits = getToolBudgetLimits(maxIterations);
            }
            selectedSearchScope = nextSearchScope;
            searchScopeGate?.onScopeSelected(selectedSearchScope);
          }
          continue;
        }

        if (
          !iterationControl.forceFinalAnswer &&
          pendingRetryablePresentationFailure &&
          presentationRecoveryNudges < MAX_PRESENTATION_RECOVERY_NUDGES
        ) {
          currentMessages.push(
            createPresentationRetryRequiredSystemMessage(
              this.callbacks.generateId(),
            ),
          );
          presentationRecoveryNudges += 1;
          maxIterations = Math.max(maxIterations, iteration + 2);
          budgetLimits = getToolBudgetLimits(maxIterations);
          ztoolkit.log(
            `[${logPrefix}] Ignoring a terminal response after a retryable presentation failure; keeping presentation available for recovery`,
          );
          continue;
        }

        if (
          iterationControl.forceFinalAnswer &&
          (result.suppressedToolCall ||
            !!result.toolCalls?.length ||
            !(result.content || "").trim())
        ) {
          ztoolkit.log(
            `[${logPrefix}] Final synthesis round did not produce a terminal answer; falling back to max-iterations message`,
          );
          await this.finalizeMaxIterationsTurn(
            sendingSession,
            sessionRunId,
            currentMessages,
            assistantMessage,
            accumulatedDisplay +
              (result.content || "") +
              getMaxIterationsMessage(),
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
          accumulatedDisplay:
            accumulatedDisplay +
            hostedWebSearchDisplay +
            (result.content || ""),
          iteration,
        });
        return;
      }

      ztoolkit.log(
        `[${logPrefix}] Max iterations reached without a terminal response`,
      );
      await this.finalizeMaxIterationsTurn(
        sendingSession,
        sessionRunId,
        currentMessages,
        assistantMessage,
        accumulatedDisplay + getMaxIterationsMessage(),
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
      currentItemKey,
      currentItemLibraryID,
      sessionRunId,
      abortSignal,
      executeProviderRequest = (operation) => operation(),
      preserveToolExecutionState = false,
      lockedToolItemKey,
      noteSummaryContext,
      searchScopeGate,
      refreshSystemPrompt,
      presentationAuthorization,
    } = options;
    const logPrefix = "Tool Calling";
    const configuredMaxIterations = this.getMaxIterations();
    let maxIterations = configuredMaxIterations;
    let presentationRecoveryExtensions = 0;
    let presentationRecoveryNudges = 0;
    let pendingRetryablePresentationFailure = false;
    let presentationFailureAttempts = 0;
    let budgetLimits = getToolBudgetLimits(configuredMaxIterations);
    let iteration = 0;
    let accumulatedDisplay = assistantMessage.content;
    await this.startTurn(
      sendingSession,
      sessionRunId,
      assistantMessage,
      currentMessages,
      false,
      preserveToolExecutionState,
    );
    presentationFailureAttempts = countRetryablePresentationFailures(
      sendingSession.toolExecutionState?.results || [],
    );
    let selectedSearchScope = searchScopeGate
      ? findCompletedSearchScope(
          sendingSession.toolExecutionState?.results || [],
        )
      : undefined;
    if (
      searchScopeGate &&
      hasScholarlyThenWebSearchScope(
        sendingSession.toolExecutionState?.results || [],
      )
    ) {
      maxIterations = Math.max(maxIterations, 6);
      budgetLimits = getToolBudgetLimits(maxIterations);
    }
    if (selectedSearchScope) {
      searchScopeGate?.onScopeSelected(selectedSearchScope);
    }

    try {
      while (iteration < maxIterations) {
        iteration++;
        const iterationControl = this.createIterationControl(
          iteration,
          tools,
          maxIterations,
          sendingSession,
          budgetLimits,
          provider.supportsHostedWebSearch?.() === true,
        );
        this.refreshSystemPrompt(
          currentMessages,
          sendingSession,
          refreshSystemPrompt,
          iterationControl,
        );
        this.prepareMessagesForModel(currentMessages, provider);
        ztoolkit.log(
          `[${logPrefix}] Iteration ${iteration}, messages: ${currentMessages.length}`,
        );
        if (iterationControl.forceFinalAnswer) {
          ztoolkit.log(
            `[${logPrefix}] Final synthesis iteration ${iteration}/${maxIterations}; tools disabled for this round`,
          );
        }

        const result = await executeProviderRequest(
          () =>
            provider.chatCompletionWithTools(
              currentMessages,
              iterationControl.toolsForRound,
              abortSignal,
              {
                toolChoice: iterationControl.toolChoice,
              },
            ),
          () =>
            this.refreshIterationToolsForProvider(
              iterationControl,
              iteration,
              tools,
              maxIterations,
              sendingSession,
              budgetLimits,
              provider.supportsHostedWebSearch?.() === true,
            ),
        );

        this.ensureSessionTracked(sendingSession, sessionRunId);

        ztoolkit.log(
          `[${logPrefix}] Response:`,
          result.content ? result.content.substring(0, 100) : "(no content)",
          "toolCalls:",
          result.toolCalls?.length || 0,
        );

        this.upsertHostedWebSearchResults(
          sendingSession,
          result.hostedWebSearches || [],
        );
        const hostedWebSearchDisplay = this.formatHostedWebSearchDisplay(
          result.hostedWebSearches || [],
        );

        if (
          !iterationControl.forceFinalAnswer &&
          result.toolCalls &&
          result.toolCalls.length > 0
        ) {
          const toolIteration = await this.runToolIteration({
            sendingSession,
            sessionRunId,
            currentMessages,
            assistantMessage,
            provider,
            paperStructure,
            toolCalls: result.toolCalls,
            roundContent: result.content || "",
            roundReasoning: result.reasoning,
            accumulatedDisplay: accumulatedDisplay + hostedWebSearchDisplay,
            iteration,
            logPrefix,
            budgetLimits,
            reuseCompletedResults: preserveToolExecutionState,
            currentItemKey,
            lockedToolItemKey,
            currentItemLibraryID,
            allowedToolNames: new Set(
              iterationControl.toolsForRound.map((tool) => tool.function.name),
            ),
            selectedSearchScope,
            noteSummaryContext,
            abortSignal,
            executeProviderRequest,
            presentationAuthorization,
          });
          accumulatedDisplay = toolIteration.accumulatedDisplay;
          presentationFailureAttempts +=
            toolIteration.retryablePresentationFailures;
          const presentationRetryBudgetRemaining =
            presentationFailureAttempts < MAX_PRESENTATION_ATTEMPTS_PER_TURN;
          if (toolIteration.completedPresentationCalls > 0) {
            pendingRetryablePresentationFailure = false;
          } else if (toolIteration.retryablePresentationFailures > 0) {
            pendingRetryablePresentationFailure =
              presentationRetryBudgetRemaining;
          }
          if (
            toolIteration.retryablePresentationFailures > 0 &&
            !presentationRetryBudgetRemaining
          ) {
            currentMessages.push(
              createPresentationAttemptsExhaustedSystemMessage(
                this.callbacks.generateId(),
              ),
            );
            maxIterations = iteration + 1;
            budgetLimits = getToolBudgetLimits(maxIterations);
          } else if (
            toolIteration.retryablePresentationFailures > 0 &&
            presentationRecoveryExtensions <
              MAX_PRESENTATION_RECOVERY_EXTENSIONS &&
            maxIterations < iteration + 2
          ) {
            maxIterations = iteration + 2;
            presentationRecoveryExtensions += 1;
            budgetLimits = getToolBudgetLimits(maxIterations);
          }
          if (
            toolIteration.selectedSearchScope &&
            toolIteration.selectedSearchScope !== selectedSearchScope
          ) {
            const nextSearchScope = toolIteration.selectedSearchScope;
            if (!selectedSearchScope) {
              maxIterations += 1;
            }
            if (nextSearchScope === "scholarly_then_web") {
              maxIterations = Math.max(maxIterations, iteration + 3, 6);
              budgetLimits = getToolBudgetLimits(maxIterations);
            } else if (selectedSearchScope === "scholarly_then_web") {
              maxIterations = Math.max(maxIterations, iteration + 2, 6);
              budgetLimits = getToolBudgetLimits(maxIterations);
            }
            selectedSearchScope = nextSearchScope;
            searchScopeGate?.onScopeSelected(selectedSearchScope);
          }
          continue;
        }

        if (
          !iterationControl.forceFinalAnswer &&
          pendingRetryablePresentationFailure &&
          presentationRecoveryNudges < MAX_PRESENTATION_RECOVERY_NUDGES
        ) {
          currentMessages.push(
            createPresentationRetryRequiredSystemMessage(
              this.callbacks.generateId(),
            ),
          );
          presentationRecoveryNudges += 1;
          maxIterations = Math.max(maxIterations, iteration + 2);
          budgetLimits = getToolBudgetLimits(maxIterations);
          ztoolkit.log(
            `[${logPrefix}] Ignoring a terminal response after a retryable presentation failure; keeping presentation available for recovery`,
          );
          continue;
        }

        if (
          iterationControl.forceFinalAnswer &&
          (result.suppressedToolCall ||
            !!result.toolCalls?.length ||
            !(result.content || "").trim())
        ) {
          ztoolkit.log(
            `[${logPrefix}] Final synthesis round did not produce a terminal answer; falling back to max-iterations message`,
          );
          await this.finalizeMaxIterationsTurn(
            sendingSession,
            sessionRunId,
            currentMessages,
            assistantMessage,
            accumulatedDisplay +
              (result.content || "") +
              getMaxIterationsMessage(),
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
          accumulatedDisplay:
            accumulatedDisplay +
            hostedWebSearchDisplay +
            (result.content || ""),
          iteration,
        });
        return;
      }

      ztoolkit.log(
        `[${logPrefix}] Max iterations reached without a terminal response`,
      );
      await this.finalizeMaxIterationsTurn(
        sendingSession,
        sessionRunId,
        currentMessages,
        assistantMessage,
        accumulatedDisplay + getMaxIterationsMessage(),
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
    preserveToolExecutionState: boolean,
  ): Promise<void> {
    const plan = this.executionPlanManager.startPlan(session, currentMessages);
    if (preserveToolExecutionState && session.toolExecutionState) {
      session.toolExecutionState.planId = plan.id;
      session.toolExecutionState.updatedAt = Date.now();
    } else {
      this.initializeToolExecutionState(session);
    }
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
    toolChoice: "auto" | "none",
    executeProviderRequest: ProviderRequestExecutor,
    onProviderRerouted: () => void,
  ): Promise<{
    content: string;
    reasoning?: string;
    toolCalls?: ToolCall[];
    hostedWebSearches?: HostedWebSearchCall[];
    suppressedToolCall?: boolean;
    stopReason: string;
  }> {
    const reasoningBeforeRound = assistantMessage.reasoning || "";
    const failedAttemptState: {
      best?: { content: string; reasoning: string };
    } = {};

    const runAttempt = () =>
      new Promise<{
        content: string;
        reasoning?: string;
        toolCalls?: ToolCall[];
        hostedWebSearches?: HostedWebSearchCall[];
        suppressedToolCall?: boolean;
        stopReason: string;
      }>((resolve, reject) => {
        const pendingToolCalls = new Map<
          number,
          { id: string; name: string; arguments: string }
        >();
        const hostedWebSearches = new Map<
          string,
          HostedWebSearchDisplayState
        >();
        let roundContent = "";
        let roundReasoning = "";
        let stopReason = "end_turn";

        assistantMessage.content = displayBeforeThisRound;
        assistantMessage.reasoning = reasoningBeforeRound || undefined;

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

        const buildHostedWebSearchDisplay = (): string =>
          this.formatHostedWebSearchDisplay(
            [...hostedWebSearches.entries()].map(([id, search]) => ({
              id,
              ...search,
            })),
          );

        const getPersistedStreamingContent = (): string =>
          displayBeforeThisRound + roundContent;

        const getUiStreamingContent = (): string =>
          displayBeforeThisRound +
          buildHostedWebSearchDisplay() +
          roundContent +
          buildDraftToolCallDisplay();

        const updateAssistantStreamingContent = (): string | undefined => {
          if (!this.callbacks.isSessionTracked(sendingSession, sessionRunId)) {
            return undefined;
          }
          const uiContent = getUiStreamingContent();
          assistantMessage.content = getPersistedStreamingContent();
          assistantMessage.streamingState = "in_progress";
          this.messageCheckpointer.schedule(
            sendingSession,
            sessionRunId,
            assistantMessage,
          );
          if (this.callbacks.isSessionActive(sendingSession)) {
            this.callbacks.onStreamingUpdate?.(uiContent, assistantMessage.id);
          }
          return uiContent;
        };

        const rejectAttempt = (error: Error) => {
          if (!this.callbacks.isSessionTracked(sendingSession, sessionRunId)) {
            reject(error);
            return;
          }
          for (const [id, search] of hostedWebSearches) {
            hostedWebSearches.set(id, { ...search, status: "error" });
          }
          this.upsertHostedWebSearchResults(
            sendingSession,
            [...hostedWebSearches.entries()].map(([id, search]) => ({
              id,
              ...search,
            })),
          );
          const failedAttempt = {
            content: buildHostedWebSearchDisplay() + roundContent,
            reasoning: roundReasoning,
          };
          if (
            !failedAttemptState.best ||
            failedAttempt.content.length >
              failedAttemptState.best.content.length ||
            (failedAttempt.content.length ===
              failedAttemptState.best.content.length &&
              failedAttempt.reasoning.length >
                failedAttemptState.best.reasoning.length)
          ) {
            failedAttemptState.best = failedAttempt;
          }
          reject(error);
        };

        const callbacks: StreamToolCallingCallbacks = {
          onTextDelta: (text) => {
            if (
              !this.callbacks.isSessionTracked(sendingSession, sessionRunId)
            ) {
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
            if (
              !this.callbacks.isSessionTracked(sendingSession, sessionRunId)
            ) {
              return;
            }
            roundReasoning += text;
            const fullReasoning = reasoningBeforeRound + roundReasoning;
            assistantMessage.reasoning = fullReasoning;
            assistantMessage.streamingState = "in_progress";
            this.messageCheckpointer.schedule(
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
                reasoning: fullReasoning,
                iteration,
              },
            );
            if (this.callbacks.isSessionActive(sendingSession)) {
              this.callbacks.onReasoningUpdate?.(
                fullReasoning,
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
          onHostedWebSearchStatus: ({
            index,
            id,
            status,
            actionType,
            queries,
            sources,
          }) => {
            const current = hostedWebSearches.get(id);
            hostedWebSearches.set(id, {
              index,
              status:
                current?.status === "error" || status === "error"
                  ? "error"
                  : current?.status === "completed"
                    ? "completed"
                    : status,
              actionType: actionType || current?.actionType,
              queries: queries?.length ? queries : current?.queries,
              sources: sources?.length ? sources : current?.sources,
            });
            updateAssistantStreamingContent();
          },
          onComplete: (result) => {
            stopReason = result.stopReason;
            for (const search of result.hostedWebSearches || []) {
              const current = hostedWebSearches.get(search.id);
              hostedWebSearches.set(search.id, {
                index: search.index,
                status:
                  current?.status === "error" || search.status === "error"
                    ? "error"
                    : current?.status === "completed" ||
                        search.status === "completed"
                      ? "completed"
                      : "searching",
                actionType: search.actionType || current?.actionType,
                queries: search.queries?.length
                  ? search.queries
                  : current?.queries,
                sources: search.sources?.length
                  ? search.sources
                  : current?.sources,
              });
            }
            const streamedToolCalls: ToolCall[] = [];
            for (const [, tc] of pendingToolCalls) {
              streamedToolCalls.push({
                id: tc.id,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: tc.arguments,
                },
              });
            }
            const toolCalls =
              result.toolCalls && result.toolCalls.length > 0
                ? result.toolCalls
                : streamedToolCalls;
            resolve({
              content: result.content,
              reasoning: result.reasoning || roundReasoning || undefined,
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              hostedWebSearches:
                hostedWebSearches.size > 0
                  ? [...hostedWebSearches.entries()].map(([id, search]) => ({
                      id,
                      ...search,
                    }))
                  : undefined,
              suppressedToolCall: result.suppressedToolCall,
              stopReason,
            });
          },
          onError: rejectAttempt,
        };

        provider
          .streamChatCompletionWithTools(
            currentMessages,
            tools,
            callbacks,
            abortSignal,
            { toolChoice },
          )
          .catch((error: unknown) =>
            rejectAttempt(
              error instanceof Error ? error : new Error(String(error)),
            ),
          );
      });

    try {
      return await executeProviderRequest(runAttempt, onProviderRerouted);
    } catch (error) {
      const bestFailedAttempt = failedAttemptState.best;
      if (
        bestFailedAttempt &&
        this.callbacks.isSessionTracked(sendingSession, sessionRunId)
      ) {
        assistantMessage.content =
          displayBeforeThisRound + bestFailedAttempt.content;
        assistantMessage.reasoning =
          reasoningBeforeRound + bestFailedAttempt.reasoning || undefined;
      }
      throw error;
    }
  }

  /**
   * Execute one round of tool calls: batch, dispatch, record, and emit events.
   *
   * Shared between streaming and non-streaming loops — both arrive here with
   * the same post-LLM state (assistant tool-call message pending, new tool
   * calls to run). Returns the updated accumulated display so the caller can
   * feed it into the next iteration.
   */
  private async runToolIteration(params: ToolIterationParams): Promise<{
    accumulatedDisplay: string;
    selectedSearchScope?: SelectedSearchScope;
    retryablePresentationFailures: number;
    completedPresentationCalls: number;
  }> {
    const {
      sendingSession,
      sessionRunId,
      currentMessages,
      assistantMessage,
      provider,
      paperStructure,
      toolCalls,
      roundContent,
      roundReasoning,
      iteration,
      logPrefix,
      budgetLimits,
      reuseCompletedResults,
      currentItemKey,
      lockedToolItemKey,
      currentItemLibraryID,
      allowedToolNames,
      selectedSearchScope,
      noteSummaryContext,
      abortSignal,
      executeProviderRequest,
      presentationAuthorization,
    } = params;
    const contextStrategy = getToolContextStrategy(provider);

    const latestUserRequest = [...currentMessages]
      .reverse()
      .find((message) => message.role === "user" && !message.apiOnly)?.content;
    const previousToolResults =
      sendingSession.toolExecutionState?.results || [];
    const normalizedToolCalls = toolCalls.map((toolCall) =>
      normalizePresentationToolCall(
        toolCall,
        latestUserRequest || "",
        previousToolResults,
      ),
    );
    const presentationLocalIds = createPresentationLocalIds(
      normalizedToolCalls,
      iteration,
    );
    const createPresentationProgress =
      (presentationCall: ToolCall, localId: string) =>
      async (
        update: PresentationProgressUpdate,
        cardProgress: PresentationCardProgress,
      ): Promise<void> => {
        if (!this.callbacks.isSessionTracked(sendingSession, sessionRunId)) {
          return;
        }
        this.executionPlanManager.addOrUpdateToolStep(
          sendingSession,
          currentMessages,
          localId,
          presentationCall.function.name,
          "in_progress",
          truncateToolDetail(update.message),
        );
        this.emitPlanUpdate(sendingSession, sessionRunId);
        this.emitRuntimeEvent<"tool_progress">(
          sendingSession,
          sessionRunId,
          assistantMessage,
          {
            type: "tool_progress",
            toolCallId: presentationCall.id,
            toolName: presentationCall.function.name,
            phase: update.phase,
            message: update.message,
            current: update.current,
            total: update.total,
            pptxPath: update.pptxPath,
            previewPaths: update.previewPaths,
            isDraft: update.isDraft,
            localId,
            stage: cardProgress.stage,
            startedAt: cardProgress.startedAt,
            updatedAt: cardProgress.updatedAt,
            iteration,
          },
        );
      };
    const executionContext: ToolSchedulerExecutionContext | undefined =
      currentItemKey ||
      normalizedToolCalls.some(
        (toolCall) => toolCall.function.name === "presentation",
      )
        ? {
            paperSource: {
              itemKey: currentItemKey || undefined,
              libraryID: currentItemLibraryID,
            },
            ...(presentationAuthorization ? { presentationAuthorization } : {}),
            ...(normalizedToolCalls.some(
              (toolCall) => toolCall.function.name === "presentation",
            )
              ? {
                  presentationPlanner: this.createPresentationPlanner(
                    provider,
                    executeProviderRequest,
                    abortSignal,
                  ),
                  presentationVisualReviewer:
                    this.createPresentationVisualReviewer(
                      provider,
                      executeProviderRequest,
                      abortSignal,
                    ),
                }
              : {}),
          }
        : undefined;

    const invalidSummaryCreateNoteCallIds = new Set<string>();
    const protectedToolCalls = normalizedToolCalls.map((toolCall) => {
      toolCall = rewriteToolCallItemKey(toolCall, lockedToolItemKey);
      if (!noteSummaryContext) {
        return toolCall;
      }
      if (toolCall.function.name === "request_user_input") {
        return {
          ...toolCall,
          function: {
            ...toolCall.function,
            arguments: JSON.stringify(
              buildNoteSummaryDestinationRequestArgs(noteSummaryContext),
            ),
          },
        };
      }
      if (
        toolCall.function.name === "create_note" &&
        noteSummaryContext.destination.status === "resolved"
      ) {
        const rewritten = rewriteCreateNoteTarget(
          toolCall,
          noteSummaryContext.destination.itemKey,
        );
        if (!rewritten) {
          invalidSummaryCreateNoteCallIds.add(toolCall.id);
          return toolCall;
        }
        return rewritten;
      }
      return toolCall;
    });

    const assistantToolMessage: ChatMessage = {
      id: this.callbacks.generateId(),
      role: "assistant",
      content: roundContent,
      reasoning: roundReasoning,
      tool_calls: protectedToolCalls,
      timestamp: Date.now(),
    };
    currentMessages.push(assistantToolMessage);

    const executionEntries = this.createRuntimeToolIterationEntries(
      sendingSession,
      assistantMessage,
      protectedToolCalls,
      budgetLimits,
      paperStructure,
      reuseCompletedResults,
      currentItemKey,
      allowedToolNames,
      noteSummaryContext,
      invalidSummaryCreateNoteCallIds,
      executionContext,
    );

    // Reused exchanges already live in the previous turn's retained apiOnly
    // transcript. Re-recording them under the new assistant id would duplicate
    // the same tool results in every later request.
    const reusedToolCallIds = new Set(
      executionEntries.flatMap((entry) =>
        entry.kind === "reused"
          ? entry.results.map((result) => result.toolCall.id)
          : [],
      ),
    );
    const unavailableToolCallIds = new Set(
      protectedToolCalls
        .filter((toolCall) => !allowedToolNames.has(toolCall.function.name))
        .map((toolCall) => toolCall.id),
    );
    if (contextStrategy.persistApiOnlyTranscript) {
      const persistedToolCalls = protectedToolCalls.filter(
        (toolCall) =>
          !reusedToolCallIds.has(toolCall.id) &&
          !unavailableToolCallIds.has(toolCall.id),
      );
      if (persistedToolCalls.length > 0) {
        insertApiOnlyModelContextMessage(sendingSession, assistantMessage, {
          ...assistantToolMessage,
          tool_calls: persistedToolCalls,
          id: buildApiOnlyModelContextMessageId(
            assistantMessage.id,
            this.callbacks.generateId(),
          ),
          apiOnly: true,
        });
      }
    }

    let accumulatedDisplay = params.accumulatedDisplay;
    let resolvedSearchScope = selectedSearchScope;
    let retryablePresentationFailures = 0;
    let completedPresentationCalls = 0;
    if (roundContent) {
      accumulatedDisplay += roundContent;
    }

    let activeCallingDisplay = "";
    let activePendingDisplayToolCalls = new Map<string, ToolCall>();
    let activeProgressByToolCall = new Map<
      string,
      PresentationCardProgressTracker
    >();
    const formatCallingToolCards = (calls: ToolCall[]): string =>
      calls
        .map((toolCall) => {
          const localId = presentationLocalIds.get(toolCall);
          const progress = localId
            ? activeProgressByToolCall.get(localId)?.progress
            : undefined;
          return this.callbacks.formatToolCallCard(
            toolCall.function.name,
            toolCall.function.arguments,
            "calling",
            progress?.message,
            localId
              ? {
                  expandStateId: localId,
                  showResultWhileCalling: Boolean(progress?.message),
                  resultPreviewMaxLength: 320,
                  presentationArtifact: findPresentationArtifact(localId),
                  presentationProgress: progress,
                }
              : undefined,
          );
        })
        .join("");
    const upsertPresentationArtifact = (
      artifact: PresentationToolCardArtifact,
    ): void => {
      const artifacts = assistantMessage.presentationArtifacts || [];
      const index = artifacts.findIndex(
        (candidate) =>
          (artifact.localId && candidate.localId === artifact.localId) ||
          (!artifact.localId &&
            !candidate.localId &&
            candidate.toolCallId === artifact.toolCallId),
      );
      if (index >= 0) {
        const previous = artifacts[index];
        artifacts[index] = {
          ...previous,
          ...artifact,
          path: artifact.path || previous.path,
          previewPaths: artifact.previewPaths || previous.previewPaths,
          attachmentItemID:
            artifact.attachmentItemID || previous.attachmentItemID,
        };
      } else {
        artifacts.push(artifact);
      }
      assistantMessage.presentationArtifacts = artifacts;
    };
    const findPresentationArtifact = (
      localId: string,
    ): PresentationToolCardArtifact | undefined =>
      assistantMessage.presentationArtifacts?.find(
        (artifact) => artifact.localId === localId,
      );
    const renderCallingProgress = async (
      toolCall: ToolCall,
      update: PresentationProgressUpdate,
    ): Promise<void> => {
      if (
        toolCall.function.name !== "presentation" ||
        !activePendingDisplayToolCalls.has(
          presentationLocalIds.get(toolCall) || toolCall.id,
        ) ||
        !this.callbacks.isSessionTracked(sendingSession, sessionRunId)
      ) {
        return;
      }
      const localId = presentationLocalIds.get(toolCall) || toolCall.id;
      const tracker =
        activeProgressByToolCall.get(localId) ||
        new PresentationCardProgressTracker();
      activeProgressByToolCall.set(localId, tracker);
      const nextProgress = tracker.update(update);
      await createPresentationProgress(toolCall, localId)(update, nextProgress);
      if (update.pptxPath || update.previewPaths?.length) {
        upsertPresentationArtifact({
          toolCallId: toolCall.id,
          localId,
          path: update.pptxPath,
          previewPaths: update.previewPaths,
          isDraft: update.isDraft,
        });
      }
      const progressCards = formatCallingToolCards([
        ...activePendingDisplayToolCalls.values(),
      ]);
      const display = activeCallingDisplay + progressCards;
      assistantMessage.content = display;
      assistantMessage.streamingState = "in_progress";
      if (update.pptxPath || update.previewPaths?.length) {
        // A presentation milestone points at a real file that already exists.
        // Persist it before returning to the renderer so a Zotero crash cannot
        // leave the PPTX on disk without its chat entry/open action.
        await this.messageCheckpointer.flush(
          sendingSession,
          sessionRunId,
          assistantMessage,
          "in_progress",
        );
      }
      if (this.callbacks.isSessionActive(sendingSession)) {
        this.callbacks.onStreamingUpdate?.(display, assistantMessage.id);
      }
    };

    for (const entry of executionEntries) {
      let callingDisplay = accumulatedDisplay;
      const pendingDisplayToolCalls = new Map<string, ToolCall>();

      if (entry.kind === "execute" || entry.kind === "search_scope") {
        const calls =
          entry.kind === "execute"
            ? entry.requests.map((request) => request.toolCall)
            : [entry.toolCall];
        for (const toolCall of calls) {
          const toolName = toolCall.function.name;
          const toolArgs = toolCall.function.arguments;
          ztoolkit.log(`[${logPrefix}] Executing: ${toolName}`, toolArgs);

          const localId = presentationLocalIds.get(toolCall) || toolCall.id;
          pendingDisplayToolCalls.set(localId, toolCall);
          this.executionPlanManager.addOrUpdateToolStep(
            sendingSession,
            currentMessages,
            localId,
            toolName,
            "in_progress",
            truncateToolDetail(toolArgs),
          );
        }
        activeCallingDisplay = accumulatedDisplay;
        activePendingDisplayToolCalls = pendingDisplayToolCalls;
        activeProgressByToolCall = new Map();
        if (entry.kind === "execute") {
          for (const request of entry.requests) {
            if (request.toolCall.function.name !== "presentation") continue;
            const localId =
              presentationLocalIds.get(request.toolCall) || request.toolCall.id;
            activeProgressByToolCall.set(
              localId,
              new PresentationCardProgressTracker(),
            );
            request.executionContext = {
              ...request.executionContext,
              presentationProgress: (update) =>
                renderCallingProgress(request.toolCall, update),
            };
          }
        }
        callingDisplay += formatCallingToolCards([
          ...pendingDisplayToolCalls.values(),
        ]);

        assistantMessage.content = callingDisplay;
        assistantMessage.streamingState = "in_progress";
        await this.messageCheckpointer.flush(
          sendingSession,
          sessionRunId,
          assistantMessage,
          "in_progress",
        );
        this.ensureSessionTracked(sendingSession, sessionRunId);
        await this.sessionStorage.updateSessionMeta(sendingSession);
        this.emitPlanUpdate(sendingSession, sessionRunId);
        if (this.callbacks.isSessionActive(sendingSession)) {
          this.callbacks.onStreamingUpdate?.(
            callingDisplay,
            assistantMessage.id,
          );
        }
      }

      if (entry.kind === "user_input") {
        assistantMessage.content = accumulatedDisplay;
        assistantMessage.streamingState = "in_progress";
        await this.messageCheckpointer.flush(
          sendingSession,
          sessionRunId,
          assistantMessage,
          "in_progress",
        );
        this.ensureSessionTracked(sendingSession, sessionRunId);
        await this.sessionStorage.updateSessionMeta(sendingSession);
        this.emitPlanUpdate(sendingSession, sessionRunId);
        if (this.callbacks.isSessionActive(sendingSession)) {
          this.callbacks.onStreamingUpdate?.(
            accumulatedDisplay,
            assistantMessage.id,
          );
        }
      }

      const releaseMutatingToolEntry =
        entry.kind === "execute"
          ? this.beginMutatingToolEntry(sendingSession.id, entry.requests)
          : null;
      try {
        this.ensureSessionTracked(sendingSession, sessionRunId);

        const batchResults =
          entry.kind === "execute"
            ? await this.executeBatchWithRuntimeEvents(
                sendingSession,
                sessionRunId,
                assistantMessage,
                entry.requests,
                iteration,
              )
            : entry.kind === "user_input"
              ? [
                  await this.userInput.executeUserInputRequest(
                    sendingSession,
                    sessionRunId,
                    currentMessages,
                    assistantMessage,
                    entry.toolCall,
                    iteration,
                    noteSummaryContext,
                  ),
                ]
              : entry.kind === "search_scope"
                ? (() => {
                    const selection = executeSearchScopeSelection(
                      entry.toolCall,
                      resolvedSearchScope,
                    );
                    if (selection.selectedScope) {
                      resolvedSearchScope = selection.selectedScope;
                    }
                    return [selection.result];
                  })()
                : entry.results;
        if (
          noteSummaryContext &&
          batchResults.some(
            (result) =>
              result.toolCall.function.name === "create_note" &&
              result.status === "completed",
          )
        ) {
          noteSummaryContext.noteCreated = true;
        }
        resolvedSearchScope = advanceSearchScopeAfterResults(
          resolvedSearchScope,
          batchResults,
        );
        if (entry.kind !== "reused") {
          this.appendToolExecutionResults(sendingSession, batchResults);
          await this.sessionStorage.updateSessionMeta(sendingSession);
          this.emitPlanUpdate(sendingSession, sessionRunId);
        }

        for (const executionResult of batchResults) {
          this.ensureSessionTracked(sendingSession, sessionRunId);
          const toolCall = executionResult.toolCall;
          const toolName = toolCall.function.name;
          const toolArgs = toolCall.function.arguments;
          const toolResult = executionResult.content;

          ztoolkit.log(
            `[${logPrefix}] Result (truncated): ${toolResult.substring(0, 200)}...`,
          );

          const shouldCompactModelToolResult =
            contextStrategy.compactToolResultOnCreate &&
            !executionResult.artifact &&
            toolName !== "read_artifact";
          const modelToolResult = shouldCompactModelToolResult
            ? compactToolResultContent(
                toolResult,
                contextStrategy.compactionPolicy,
              )
            : toolResult;
          const toolResultMessage: ChatMessage = {
            id: this.callbacks.generateId(),
            role: "tool",
            content: appendEvidenceCitationCatalog(
              modelToolResult,
              executionResult.evidence,
            ),
            tool_call_id: toolCall.id,
            timestamp: Date.now(),
          };
          currentMessages.push(toolResultMessage);
          if (
            contextStrategy.persistApiOnlyTranscript &&
            entry.kind !== "reused" &&
            !unavailableToolCallIds.has(toolCall.id)
          ) {
            insertApiOnlyModelContextMessage(sendingSession, assistantMessage, {
              ...toolResultMessage,
              id: buildApiOnlyModelContextMessageId(
                assistantMessage.id,
                this.callbacks.generateId(),
              ),
              apiOnly: true,
            });
          }

          if (entry.kind === "reused") {
            continue;
          }

          const toolSucceeded = executionResult.status === "completed";
          const toolDisplayStatus = toolSucceeded ? "completed" : "error";
          const planStepStatus = toPlanStepStatus(executionResult.status);
          const primaryPolicyTrace = getPrimaryPolicyTrace(executionResult);
          const parsedToolError =
            executionResult.status === "completed"
              ? null
              : parseToolError(executionResult.content);

          const presentationLocalId =
            toolName === "presentation"
              ? presentationLocalIds.get(toolCall) || toolCall.id
              : undefined;
          const presentationArtifact =
            toolName === "presentation"
              ? parsePresentationToolCardArtifact(
                  toolResult,
                  toolCall.id,
                  presentationLocalId || toolCall.id,
                )
              : undefined;
          if (presentationArtifact) {
            upsertPresentationArtifact(presentationArtifact);
          }
          const presentationProgress = presentationLocalId
            ? (
                activeProgressByToolCall.get(presentationLocalId) ||
                new PresentationCardProgressTracker()
              ).finish(toolSucceeded)
            : undefined;

          accumulatedDisplay += this.callbacks.formatToolCallCard(
            toolName,
            toolArgs,
            toolDisplayStatus,
            toolResult,
            toolName === "presentation"
              ? {
                  expandStateId: presentationLocalId,
                  presentationArtifact:
                    findPresentationArtifact(presentationLocalId || "") ||
                    presentationArtifact,
                  presentationProgress,
                  resultPreviewMaxLength: 600,
                }
              : undefined,
          );
          pendingDisplayToolCalls.delete(
            presentationLocalIds.get(toolCall) || toolCall.id,
          );
          activePendingDisplayToolCalls = pendingDisplayToolCalls;
          const displayWithPendingTools =
            accumulatedDisplay +
            formatCallingToolCards([...pendingDisplayToolCalls.values()]);
          assistantMessage.content = displayWithPendingTools;
          assistantMessage.streamingState = "in_progress";
          await this.messageCheckpointer.flush(
            sendingSession,
            sessionRunId,
            assistantMessage,
            "in_progress",
          );
          this.ensureSessionTracked(sendingSession, sessionRunId);
          this.executionPlanManager.addOrUpdateToolStep(
            sendingSession,
            currentMessages,
            presentationLocalIds.get(toolCall) || toolCall.id,
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
              displayWithPendingTools,
              assistantMessage.id,
            );
          }
        }

        const needsRecovery = batchResults.some(
          (result) =>
            (result.status === "denied" || result.status === "failed") &&
            !isDuplicatePresentationAttemptBlock(result),
        );
        if (needsRecovery) {
          this.executionPlanManager.recordRecoveryStep(
            sendingSession,
            currentMessages,
            batchResults.filter(
              (result) => !isDuplicatePresentationAttemptBlock(result),
            ),
          );
          await this.sessionStorage.updateSessionMeta(sendingSession);
          this.emitPlanUpdate(sendingSession, sessionRunId);
        }

        retryablePresentationFailures += batchResults.filter(
          isRetryablePresentationFailure,
        ).length;
        completedPresentationCalls += batchResults.filter(
          (result) =>
            result.toolCall.function.name === "presentation" &&
            result.status === "completed",
        ).length;

        this.appendRecoveryGuidanceMessage(currentMessages, batchResults);
      } finally {
        activePendingDisplayToolCalls = new Map();
        releaseMutatingToolEntry?.();
      }
    }

    this.ensureSessionTracked(sendingSession, sessionRunId);
    const groundedDisplay = this.sanitizeGroundedDisplay(
      sendingSession,
      accumulatedDisplay,
    );

    assistantMessage.content = groundedDisplay.content;
    assistantMessage.evidence = groundedDisplay.evidence;
    assistantMessage.streamingState = "in_progress";
    await this.messageCheckpointer.flush(
      sendingSession,
      sessionRunId,
      assistantMessage,
      "in_progress",
    );
    this.ensureSessionTracked(sendingSession, sessionRunId);
    if (this.callbacks.isSessionActive(sendingSession)) {
      this.callbacks.onStreamingUpdate?.(
        groundedDisplay.content,
        assistantMessage.id,
      );
    }

    return {
      accumulatedDisplay,
      selectedSearchScope: resolvedSearchScope,
      retryablePresentationFailures,
      completedPresentationCalls,
    };
  }

  private createToolExecutionEntries(
    session: ChatSession,
    assistantMessage: ChatMessage,
    toolCalls: ToolCall[],
    budgetLimits: ToolBudgetLimits,
    paperStructure?: PaperStructure | PaperStructureExtended | null,
    reuseCompletedResults: boolean = false,
    currentItemKey?: string | null,
    executionContext?: ToolSchedulerExecutionContext,
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
      reuseCompletedResults,
      currentItemKey,
      executionContext,
    });
  }

  private createRuntimeToolIterationEntries(
    session: ChatSession,
    assistantMessage: ChatMessage,
    toolCalls: ToolCall[],
    budgetLimits: ToolBudgetLimits,
    paperStructure?: PaperStructure | PaperStructureExtended | null,
    reuseCompletedResults: boolean = false,
    currentItemKey?: string | null,
    allowedToolNames?: Set<string>,
    noteSummaryContext?: NoteSummaryContext,
    invalidSummaryCreateNoteCallIds: ReadonlySet<string> = new Set(),
    executionContext?: ToolSchedulerExecutionContext,
  ): RuntimeToolIterationEntry[] {
    const entries: RuntimeToolIterationEntry[] = [];
    let runnableSegment: ToolCall[] = [];
    let noteCreationReserved = noteSummaryContext?.noteCreated === true;
    let presentationAttemptReserved = false;
    const seenUserInputFingerprints = new Set<string>();

    const flushRunnableSegment = () => {
      if (runnableSegment.length === 0) {
        return;
      }
      entries.push(
        ...this.createToolExecutionEntries(
          session,
          assistantMessage,
          runnableSegment,
          budgetLimits,
          paperStructure,
          reuseCompletedResults,
          noteSummaryContext?.destination.status === "resolved"
            ? noteSummaryContext.destination.itemKey
            : currentItemKey,
          executionContext,
        ),
      );
      runnableSegment = [];
    };

    for (const toolCall of toolCalls) {
      if (allowedToolNames && !allowedToolNames.has(toolCall.function.name)) {
        flushRunnableSegment();
        entries.push({
          kind: "synthetic",
          results: [
            isSearchScopeControlledToolName(toolCall.function.name)
              ? createUnavailableSearchToolResult(toolCall)
              : createUnavailableToolResult(toolCall),
          ],
        });
        continue;
      }
      if (
        isSearchScopeControlledToolName(toolCall.function.name) &&
        !allowedToolNames?.has(toolCall.function.name)
      ) {
        flushRunnableSegment();
        entries.push({
          kind: "synthetic",
          results: [createUnavailableSearchToolResult(toolCall)],
        });
        continue;
      }
      if (toolCall.function.name === SEARCH_SCOPE_TOOL_NAME) {
        flushRunnableSegment();
        entries.push({ kind: "search_scope", toolCall });
        continue;
      }
      if (toolCall.function.name === "presentation") {
        if (presentationAttemptReserved) {
          flushRunnableSegment();
          entries.push({
            kind: "synthetic",
            results: [createDuplicatePresentationAttemptResult(toolCall)],
          });
          continue;
        }
        presentationAttemptReserved = true;
      }
      if (toolCall.function.name === "request_user_input") {
        flushRunnableSegment();
        if (
          noteSummaryContext &&
          noteSummaryContext.destination.status !== "pending"
        ) {
          entries.push({
            kind: "synthetic",
            results: [
              {
                toolCall,
                status: "completed",
                content:
                  noteSummaryContext.destination.status === "cancelled"
                    ? "The user cancelled note destination selection. Do not create a note."
                    : "The note destination is already selected. Continue without asking again.",
              },
            ],
          });
          continue;
        }
        const completedResult = reuseCompletedResults
          ? findCompletedToolResultMatch(
              toolCall,
              session.toolExecutionState?.results || [],
            )
          : null;
        if (completedResult) {
          entries.push({
            kind: "reused",
            results: [
              createReusedCompletedToolResult(toolCall, completedResult),
            ],
          });
          continue;
        }
        const fingerprint = fingerprintToolCall(toolCall);
        if (seenUserInputFingerprints.has(fingerprint)) {
          entries.push({
            kind: "synthetic",
            results: [
              createDuplicateUserInputRequestResult(toolCall, fingerprint),
            ],
          });
          continue;
        }
        seenUserInputFingerprints.add(fingerprint);
        const blockedRetry = findBlockedRetryMatch(
          toolCall,
          session.toolExecutionState?.results || [],
        );
        if (blockedRetry) {
          entries.push({
            kind: "synthetic",
            results: [
              createBlockedRetryResult(toolCall, blockedRetry.previousResult),
            ],
          });
          continue;
        }
        entries.push({
          kind: "user_input",
          toolCall,
        });
        continue;
      }
      if (
        toolCall.function.name === "create_note" &&
        noteSummaryContext &&
        noteSummaryContext.destination.status !== "resolved"
      ) {
        flushRunnableSegment();
        const cancelled = noteSummaryContext.destination.status === "cancelled";
        entries.push({
          kind: "synthetic",
          results: [
            {
              toolCall,
              status: "denied",
              policyTrace: [
                {
                  stage: "planner",
                  policy: "permission_decision",
                  outcome: "blocked",
                  summary: cancelled
                    ? "Blocked note creation because the user cancelled destination selection."
                    : "Blocked note creation until the user selects a destination.",
                },
              ],
              content: formatToolError({
                summary: cancelled
                  ? "Note creation was cancelled by the user."
                  : "Choose a note destination before creating the note.",
                category: "missing_context",
                retryable: !cancelled,
                cause: cancelled
                  ? "The user cancelled the destination request."
                  : "No application-validated destination has been selected.",
                suggestedFix: cancelled
                  ? "End this note-summary action without creating a note."
                  : "Call request_user_input by itself, wait for the response, then call create_note in the next model turn.",
              }),
            },
          ],
        });
        continue;
      }
      if (
        toolCall.function.name === "create_note" &&
        invalidSummaryCreateNoteCallIds.has(toolCall.id)
      ) {
        flushRunnableSegment();
        entries.push({
          kind: "synthetic",
          results: [
            {
              toolCall,
              status: "denied",
              policyTrace: [
                {
                  stage: "planner",
                  policy: "argument_parse",
                  outcome: "blocked",
                  summary:
                    "Blocked note creation because its arguments were not a JSON object.",
                },
              ],
              content: formatToolError({
                summary: "Invalid arguments for create_note.",
                category: "invalid_arguments",
                retryable: true,
                cause: "Arguments must be a valid JSON object.",
                suggestedFix:
                  "Retry create_note with a valid JSON object containing note content.",
              }),
            },
          ],
        });
        continue;
      }
      if (
        toolCall.function.name === "create_note" &&
        noteSummaryContext &&
        noteCreationReserved
      ) {
        flushRunnableSegment();
        entries.push({
          kind: "synthetic",
          results: [
            {
              toolCall,
              status: "denied",
              policyTrace: [
                {
                  stage: "planner",
                  policy: "permission_decision",
                  outcome: "blocked",
                  summary:
                    "Blocked duplicate note creation in the same summary action.",
                },
              ],
              content: formatToolError({
                summary:
                  "The summary note has already been created or scheduled.",
                category: "permission_denied",
                retryable: false,
                cause:
                  "A note summary action may create at most one Zotero note.",
                suggestedFix:
                  "Continue with a brief completion message without calling create_note again.",
              }),
            },
          ],
        });
        continue;
      }
      if (toolCall.function.name === "create_note" && noteSummaryContext) {
        noteCreationReserved = true;
      }
      runnableSegment.push(toolCall);
    }

    flushRunnableSegment();
    return entries;
  }

  private createPresentationVisualReviewer(
    provider: ToolCallingProvider,
    executeProviderRequest: ProviderRequestExecutor,
    abortSignal?: AbortSignal,
  ): PresentationVisualReviewer {
    return async (request) => {
      const images = request.previewSlides.map((dataUrl, index) => {
        const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/s);
        if (!match) {
          throw new Error(
            `Presentation preview slide ${index + 1} is not a base64 image.`,
          );
        }
        return {
          type: "base64" as const,
          mimeType: match[1],
          data: match[2],
          name: `presentation-slide-${index + 1}.png`,
        };
      });
      const finalStage = request.stage === "final";
      const runReview = async (repair?: PresentationProtocolError) => {
        const messages: ChatMessage[] = [
          {
            id: this.callbacks.generateId(),
            role: "system",
            content: [
              "You are the visual quality gate for PaperChat academic presentations.",
              "Inspect every supplied slide image at full size and judge the deck as a premium public research presentation, not as a merely valid file.",
              "Reject large-text statement pages, tiny evidence thumbnails, dashboard or card-grid styling, weak hierarchy, awkward wrapping, crowded process nodes, sparse unused canvas, illegible captions, and repeated silhouettes.",
              "Compare the whole deck as a sequence. Reject any repeated paper image across the cover and content slides or across two content slides unless the outline proves they are explicit non-overlapping subfigure crops. Reject a deck that changes its model-authored audience-facing language between slides. The outline includes the required deck locale. Original-language paper titles, acronyms, equations, and quoted Figure/Table captions are source evidence and must not be treated as language mixing.",
              "Treat the bibliographic year in the outline as authoritative Zotero metadata. Do not replace it with or reject it in favor of a preprint, conference, competition, dataset, or experiment year mentioned in the paper unless the rendered slide contradicts the outline itself.",
              "The default teal-green-academic-defense reference standard is a precise white scholarly system rather than a poster or dashboard: the cover needs a measured title hierarchy and a substantial paper-derived hero; the research-gap slide needs a real comparison matrix or aligned evidence rows; the method slide needs one readable editable pipeline with a dominant architecture figure; evidence slides need figures, charts, or tables large enough to present from a distance; and the conclusion needs three findings, at least two open questions or limitations, and a visible next step. Apply the cinematic full-bleed standard only when the outline explicitly says dark-editorial.",
              "Apply measurable composition checks. Content-slide claim titles should normally read at roughly 24-30 pt. A primary figure, chart, table, matrix, or pipeline should own roughly 55-70% of the usable canvas through an asymmetric split or a full-width evidence stage. Reject any planned region that is mostly empty, any small table stranded in one corner, and any gallery whose two images are visibly the same paper crop.",
              "Prefer evidence-first academic composition: white or near-white staging, black or deep-blue typography, restrained teal or cyan accents, thin precise rules, direct data labels, one real paper figure or editable data object owning each canvas, quiet footers, and deliberate variation in page rhythm. Reject dark poster styling when the outline specifies the academic design system, and reject a deck that merely recolors one repeated layout.",
              "Never change scientific numbers, chart data, source figures, page references, or claims. You may shorten audience-facing text, switch to a compatible existing layout, enlarge existing evidence, reorder existing figures, or drop redundant narrative modules.",
              "Review the cover as carefully as the content slides. An unstructured title page, a tiny ultra-wide architecture diagram, weak image staging, or a method figure reused as the cover hero is not presentation-ready. A designed white academic cover is valid when its title hierarchy and evidence image are substantial. If its hierarchy or image composition is weak, use deckPatch instead of passing it.",
              "Audit source-figure completeness, not only figure size. Reject any architecture diagram, plot, table, or qualitative panel whose boxes, arrows, axes, labels, panels, or plotted content are visibly cut at an image boundary. An architecture figure must retain both its input side and final classifier/output stages; a crop that ends mid-box or mid-arrow is a release-blocking defect even when the remaining portion is large and readable.",
              "Use verdicts to guide internal development and repair, not to decide whether a production PPTX may be written. pass means the deck is genuinely presentation-ready and may still include minor optional polish in the summary. revise means one bounded draft repair can resolve a visible problem. reject means a material defect still harms readability, evidence scale, hierarchy, consistency, or audience trust. In production every visual-review verdict is advisory and the best successfully rendered deck is still exported; only deterministic schema, renderer, PPTX integrity, or filesystem failures may prevent writing. Never revise or reject only for subjective preference or micro-polish.",
              "Classify every non-pass verdict with failureClass. Use editorial for evidence-module count, visual density, image count, cover styling, composition variety, hierarchy, empty canvas, or other presentation-quality judgment. Use render_safety only to prioritize repair of catastrophic source cropping, severe text clipping or overflow that makes content unreadable, or another defect that makes the deck unsafe to present. Even render_safety is a production repair signal rather than a visual-model veto. Never label a merely sparse or less-polished slide as render_safety.",
              "Audit editable charts against the chart structure included in the outline, not by counting visible bars alone. In a grouped bar chart, one category label correctly names a cluster containing one bar per legend series; do not demand a separate category label for every bar. Reject only when the outline itself shows missing or mismatched labels/values, or the rendered legend and category labels are actually unreadable.",
              finalStage
                ? "This is the final internal review. Return only pass or reject: pass when all slides are genuinely presentation-ready, reject when a material defect remains. Every production rejection is reported as an advisory warning and must not imply that no PPTX was written; the visual reviewer does not own the export gate. Never return revise at the final gate."
                : "This is the draft gate. If the deck is close but needs one repair pass, return concise slide patches. Reject it if the fixed layout system cannot make it presentation-ready.",
              `Return JSON only with: verdict (pass, revise, or reject), summary, failureClass (editorial or render_safety for every non-pass verdict), optional deckPatch, and optional patches. deckPatch may contain coverLayout (single-hero or editorial-collage), coverTitleScale (compact, standard, or large), swapCoverFigureOrder, or dropCoverEvidenceLine. Each slide patch uses exported slideNumber 2-${Math.max(2, request.previewSlides.length)} and may contain layout, title, subtitle, eyebrow, keyMessage, bullets, figureEmphasis (standard or dominant), swapFigureOrder, or dropFields. Allowed dropFields: subtitle, keyMessage, bullets, groups, metrics, callouts, figure, figures, chart, table, equation, matrix, timeline, process, comparison.`,
              repair
                ? "The previous reviewer response violated the JSON protocol. Correct that protocol error now; do not change the supplied slide evidence and do not call tools."
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
            timestamp: Date.now(),
          },
          {
            id: this.callbacks.generateId(),
            role: "user",
            content: [
              `Review stage: ${request.stage}`,
              `Deck outline:\n${request.outline}`,
              repair ? `Protocol issue: ${repair.message}` : "",
              repair?.previousDraft === undefined
                ? ""
                : `Previous invalid response:\n${JSON.stringify(repair.previousDraft)}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
            images,
            timestamp: Date.now(),
          },
        ];
        const result = await executeProviderRequest(() =>
          provider.chatCompletionWithTools(messages, undefined, abortSignal, {
            toolChoice: "none",
            stateless: true,
          }),
        );
        if (result.suppressedToolCall || result.toolCalls?.length) {
          throw new PresentationProtocolError(
            "Presentation visual reviewer returned a tool call instead of JSON.",
            {
              suppressedToolCall: result.suppressedToolCall,
              toolCalls: result.toolCalls,
              content: result.content,
            },
          );
        }
        try {
          return parsePresentationVisualReviewResponse(result.content || "");
        } catch (error) {
          throw new PresentationProtocolError(
            getErrorMessage(error),
            result.content || "",
          );
        }
      };
      try {
        return await runReview();
      } catch (error) {
        if (!(error instanceof PresentationProtocolError)) throw error;
        return runReview(error);
      }
    };
  }

  private createPresentationPlanner(
    provider: ToolCallingProvider,
    executeProviderRequest: ProviderRequestExecutor,
    abortSignal?: AbortSignal,
  ): PresentationPlanner {
    return async (request) => {
      const runPlanner = async (
        planningRequest: Parameters<PresentationPlanner>[0],
      ) => {
        const messages: ChatMessage[] = [
          {
            id: this.callbacks.generateId(),
            role: "system",
            content: buildPresentationPlannerSystemPrompt(
              planningRequest.intent.slideCount,
            ),
            timestamp: Date.now(),
          },
          {
            id: this.callbacks.generateId(),
            role: "user",
            content: buildPresentationPlannerUserPrompt(planningRequest),
            timestamp: Date.now(),
          },
        ];
        const result = await executeProviderRequest(() =>
          provider.chatCompletionWithTools(messages, undefined, abortSignal, {
            toolChoice: "none",
            stateless: true,
          }),
        );
        if (result.suppressedToolCall || result.toolCalls?.length) {
          throw new PresentationProtocolError(
            "Presentation planner returned a tool call instead of JSON.",
            {
              suppressedToolCall: result.suppressedToolCall,
              toolCalls: result.toolCalls,
              content: result.content,
            },
          );
        }
        try {
          return parsePresentationPlannerResponse(result.content || "");
        } catch (error) {
          throw new PresentationProtocolError(
            getErrorMessage(error),
            result.content || "",
          );
        }
      };
      try {
        return await runPlanner(request);
      } catch (error) {
        if (!(error instanceof PresentationProtocolError) || request.repair) {
          throw error;
        }
        return runPlanner({
          ...request,
          repair: {
            issues: [error.message],
            previousDraft: error.previousDraft,
          },
        });
      }
    };
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

  private beginMutatingToolEntry(
    sessionId: string,
    requests: ToolSchedulerRequest[],
  ): (() => void) | null {
    const mutatesState = requests.some(
      (request) =>
        getToolRuntimeMetadata(request.toolCall.function.name)?.mutatesState ===
        true,
    );
    if (!mutatesState) {
      return null;
    }

    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const sessionEntries =
      this.pendingMutatingToolEntries.get(sessionId) ||
      new Set<Promise<void>>();
    sessionEntries.add(pending);
    this.pendingMutatingToolEntries.set(sessionId, sessionEntries);

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      sessionEntries.delete(pending);
      if (sessionEntries.size === 0) {
        this.pendingMutatingToolEntries.delete(sessionId);
      }
      resolve();
    };
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

    const groundedDisplay = this.sanitizeGroundedDisplay(
      sendingSession,
      accumulatedDisplay,
    );
    const sanitizedDisplay = groundedDisplay.content;

    assistantMessage.content = sanitizedDisplay;
    assistantMessage.evidence = groundedDisplay.evidence;
    assistantMessage.sourceItemKeys = this.mergeAssistantSourceItemKeys(
      assistantMessage,
      groundedDisplay.sourceItemKeys,
    );
    assistantMessage.timestamp = Date.now();
    sendingSession.updatedAt = Date.now();

    if (!assistantMessage.reasoning) {
      delete assistantMessage.reasoning;
    }
    assistantMessage.streamingState = undefined;

    this.executionPlanManager.completeRespondStep(
      sendingSession,
      currentMessages,
      truncateToolDetail(sanitizedDisplay),
    );

    await this.messageCheckpointer.flush(
      sendingSession,
      sessionRunId,
      assistantMessage,
      null,
    );
    this.ensureSessionTracked(sendingSession, sessionRunId);
    this.touchToolExecutionState(sendingSession);
    if (hasApiOnlyModelContextMessages(sendingSession)) {
      await this.sessionStorage.saveSession(sendingSession);
    } else {
      await this.sessionStorage.updateSessionMeta(sendingSession);
    }
    this.emitPlanUpdate(sendingSession, sessionRunId);
    this.emitRuntimeEvent<"turn_completed">(
      sendingSession,
      sessionRunId,
      assistantMessage,
      {
        type: "turn_completed",
        content: sanitizedDisplay,
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
    const groundedDisplay = this.sanitizeGroundedDisplay(
      sendingSession,
      accumulatedDisplay,
    );
    assistantMessage.content = groundedDisplay.content;
    assistantMessage.evidence = groundedDisplay.evidence;
    assistantMessage.sourceItemKeys = this.mergeAssistantSourceItemKeys(
      assistantMessage,
      groundedDisplay.sourceItemKeys,
    );
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
    const toolContextChanged =
      retainCompletedApiOnlyModelContextMessagesForTurn(
        sendingSession,
        assistantMessage.id,
      );
    await this.messageCheckpointer.flush(
      sendingSession,
      sessionRunId,
      assistantMessage,
      null,
    );
    this.ensureSessionTracked(sendingSession, sessionRunId);
    this.touchToolExecutionState(sendingSession);
    if (toolContextChanged) {
      await this.sessionStorage.saveSession(sendingSession);
    } else {
      await this.sessionStorage.updateSessionMeta(sendingSession);
    }
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
    retainCompletedApiOnlyModelContextMessagesForTurn(
      sendingSession,
      assistantMessage.id,
    );
    const groundedDisplay = this.sanitizeGroundedDisplay(
      sendingSession,
      assistantMessage.content,
    );
    assistantMessage.content = groundedDisplay.content;
    assistantMessage.evidence = groundedDisplay.evidence;
    assistantMessage.sourceItemKeys = this.mergeAssistantSourceItemKeys(
      assistantMessage,
      groundedDisplay.sourceItemKeys,
    );
    await this.messageCheckpointer.flush(
      sendingSession,
      sessionRunId,
      assistantMessage,
      "interrupted",
    );
    this.ensureSessionTracked(sendingSession, sessionRunId);
    this.touchToolExecutionState(sendingSession);
    // Do not save the hidden transcript here. ChatManager may replay the same
    // provider/model, and owns the final persistence once retries are exhausted.
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

  private sanitizeGroundedDisplay(
    session: ChatSession,
    content: string,
  ): {
    content: string;
    evidence: ChatMessage["evidence"];
    sourceItemKeys: ChatMessage["sourceItemKeys"];
  } {
    const results = session.toolExecutionState?.results || [];
    const trustedTargets = collectTrustedSourceTargets(results);
    const sourceSanitized = sanitizeSourceGroupTargets(content, trustedTargets);
    const evidenceSanitized = sanitizeEvidenceReferences(
      sourceSanitized,
      collectToolEvidenceRecords(results),
    );
    const referencedEvidence =
      evidenceSanitized.referencedRecords.length > 0
        ? evidenceSanitized.referencedRecords
        : undefined;
    const sourceItemKeys = normalizeSourceItemKeys([
      ...trustedTargets.itemKeys,
      ...(referencedEvidence || []).map((record) => record.itemKey),
    ]);
    return {
      content: evidenceSanitized.content,
      evidence: referencedEvidence,
      sourceItemKeys: sourceItemKeys.length > 0 ? sourceItemKeys : undefined,
    };
  }

  private mergeAssistantSourceItemKeys(
    message: ChatMessage,
    collected: ChatMessage["sourceItemKeys"],
  ): ChatMessage["sourceItemKeys"] {
    const keys = normalizeSourceItemKeys([
      ...(message.sourceItemKeys || []),
      ...(collected || []),
    ]);
    return keys.length > 0 ? keys : undefined;
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

  private formatHostedWebSearchDisplay(
    searches: HostedWebSearchCall[],
  ): string {
    return [...searches]
      .sort((left, right) => left.index - right.index)
      .map((search) => {
        const details: string[] = [];
        if (search.queries?.length) {
          details.push(`query: ${search.queries.join(" | ")}`);
        }
        if (search.actionType) {
          details.push(`action: ${search.actionType}`);
        }
        if (search.sources?.length) {
          details.push("sources:");
          for (const source of search.sources) {
            details.push(
              `- ${source.title ? `${source.title} — ` : ""}${source.url}`,
            );
          }
        }
        return this.callbacks.formatToolCallCard(
          "web_search",
          "",
          search.status === "completed"
            ? "completed"
            : search.status === "error"
              ? "error"
              : "calling",
          details.join("\n") || undefined,
          {
            expandStateId: `${HOSTED_WEB_SEARCH_RESULT_ID_PREFIX}${search.id}`,
            resultPreviewMaxLength: 1000,
            showResultWhileCalling: true,
          },
        );
      })
      .join("");
  }

  private upsertHostedWebSearchResults(
    session: ChatSession,
    searches: HostedWebSearchCall[],
  ): void {
    if (searches.length === 0) {
      return;
    }
    if (!session.toolExecutionState) {
      this.initializeToolExecutionState(session);
    }
    const sessionResults = session.toolExecutionState!.results;
    for (const search of searches) {
      const toolCallId = `${HOSTED_WEB_SEARCH_RESULT_ID_PREFIX}${search.id}`;
      const query = (search.queries || []).join(" | ");
      const sourceUrls = [
        ...new Set((search.sources || []).map((source) => source.url)),
      ];
      const contentLines = [
        "Web source URLs:",
        ...sourceUrls.map((url) => `- ${JSON.stringify(url)}`),
        "End web source URLs",
        "",
        search.status === "error"
          ? "Hosted web search failed."
          : "Hosted web search completed.",
      ];
      const toolCall: ToolCall = {
        id: toolCallId,
        type: "function",
        function: {
          name: "web_search",
          arguments: JSON.stringify(query ? { query } : {}),
        },
      };
      const nextResult: ToolExecutionResult = {
        toolCall,
        args: query ? { query } : undefined,
        metadata: getToolRuntimeMetadata("web_search") || undefined,
        references: sourceUrls.map((url) => ({ type: "web", url })),
        status: search.status === "error" ? "failed" : "completed",
        content:
          search.status === "error"
            ? formatToolError({
                summary: "Hosted web search failed.",
                category: "execution_failed",
                retryable: true,
                cause: "The model provider reported a hosted web-search error.",
                suggestedFix:
                  "Use already gathered evidence or try a materially narrower query if another search is still justified.",
                saferAlternative:
                  "Use Zotero library evidence or local scholarly search when the request is academic.",
              })
            : contentLines.join("\n"),
        error:
          search.status === "error"
            ? "The model provider reported a hosted web-search error."
            : undefined,
      };
      const existingIndex = sessionResults.findIndex(
        (result) => result.toolCall.id === toolCallId,
      );
      if (existingIndex >= 0) {
        sessionResults[existingIndex] = nextResult;
      } else {
        sessionResults.push(nextResult);
      }
    }
    session.toolExecutionState!.planId = session.executionPlan?.id;
    session.toolExecutionState!.updatedAt = Date.now();
  }

  private touchToolExecutionState(session: ChatSession): void {
    if (!session.toolExecutionState) {
      this.initializeToolExecutionState(session);
    }
    session.toolExecutionState!.planId = session.executionPlan?.id;
    session.toolExecutionState!.updatedAt = Date.now();
  }

  private appendRecoveryGuidanceMessage(
    currentMessages: ChatMessage[],
    results: ToolExecutionResult[],
  ): void {
    const actionableResults = results.filter(
      (result) => !isDuplicatePresentationAttemptBlock(result),
    );
    const completedPresentationMessage =
      createPresentationExportCompletedSystemMessage(
        this.callbacks.generateId(),
        actionableResults,
      );
    if (completedPresentationMessage) {
      currentMessages.push(completedPresentationMessage);
    }
    const systemMessage = createRecoveryGuidanceSystemMessage(
      actionableResults,
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
    session: ChatSession,
    budgetLimits: ToolBudgetLimits,
    supportsHostedWebSearch: boolean,
  ): IterationControlState {
    const remainingIterations = maxIterations - iteration + 1;
    const forceFinalAnswer = remainingIterations === 1;
    const searchBudget = createToolBudgetState(
      session.toolExecutionState?.results || [],
    );
    const remainingSearchCalls = Math.max(
      0,
      budgetLimits.maxWebSearchCallsPerTurn - searchBudget.webSearchCalls,
    );
    const toolsForRound =
      remainingSearchCalls === 0
        ? tools.filter((tool) => {
            if (tool.function.name === "search_scholarly_sources") {
              return false;
            }
            return !(
              tool.function.name === "web_search" && !supportsHostedWebSearch
            );
          })
        : tools;
    return {
      currentIteration: iteration,
      remainingIterations,
      maxIterations,
      forceFinalAnswer,
      toolsForRound: forceFinalAnswer ? [] : toolsForRound,
      toolChoice: forceFinalAnswer ? "none" : "auto",
    };
  }

  private refreshIterationToolsForProvider(
    iterationControl: IterationControlState,
    iteration: number,
    tools: ToolDefinition[],
    maxIterations: number,
    session: ChatSession,
    budgetLimits: ToolBudgetLimits,
    supportsHostedWebSearch: boolean,
  ): void {
    const refreshed = this.createIterationControl(
      iteration,
      tools,
      maxIterations,
      session,
      budgetLimits,
      supportsHostedWebSearch,
    );
    iterationControl.toolsForRound.splice(
      0,
      iterationControl.toolsForRound.length,
      ...refreshed.toolsForRound,
    );
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
    ) => string | null,
    runtimeState?: {
      currentIteration: number;
      remainingIterations: number;
      maxIterations: number;
      forceFinalAnswer: boolean;
    },
  ): void {
    if (!promptBuilder) return;

    const content = promptBuilder(currentMessages, session, runtimeState);
    if (content === null) {
      for (let index = currentMessages.length - 1; index >= 0; index--) {
        if (
          currentMessages[index].id === "cache-checkpoint" ||
          currentMessages[index].id === "runtime-context"
        ) {
          currentMessages.splice(index, 1);
        }
      }
      return;
    }
    const currentCheckpointIndex = currentMessages.findIndex(
      (message) => message.id === "cache-checkpoint",
    );
    const currentRuntimeIndex = currentMessages.findIndex(
      (message) => message.id === "runtime-context",
    );
    if (
      currentCheckpointIndex >= 0 &&
      currentRuntimeIndex === currentCheckpointIndex + 1 &&
      currentRuntimeIndex === currentMessages.length - 1
    ) {
      currentMessages[currentRuntimeIndex].content = content;
      currentMessages[currentRuntimeIndex].timestamp = Date.now();
      return;
    }

    for (const message of currentMessages) {
      if (message.id === "cache-checkpoint") {
        message.id = "cache-checkpoint-history";
      } else if (message.id === "runtime-context") {
        message.id = "runtime-context-history";
      }
    }

    currentMessages.push({
      id: "cache-checkpoint",
      role: "system",
      content:
        "Prompt cache checkpoint. This is not user content or an instruction.",
      timestamp: Date.now(),
    });
    currentMessages.push({
      id: "runtime-context",
      role: "system",
      content,
      timestamp: Date.now(),
    });
  }

  private prepareMessagesForModel(
    currentMessages: ChatMessage[],
    provider: ToolCallingProvider,
  ): void {
    const strategy = getToolContextStrategy(provider);
    compactOlderToolResultMessages(currentMessages, strategy.compactionPolicy);
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

function createDuplicateUserInputRequestResult(
  toolCall: ToolCall,
  fingerprint: string,
): ToolExecutionResult {
  const cause =
    "This exact request_user_input call was already emitted in the same model response.";
  return {
    toolCall,
    args: undefined,
    policyTrace: [
      {
        stage: "planner",
        policy: "retry_block",
        outcome: "blocked",
        summary:
          "Blocked duplicate request_user_input call in the same model response.",
        detail: cause,
        data: {
          fingerprint,
        },
      },
    ],
    status: "failed",
    content: formatToolError({
      summary: "Duplicate user input request blocked.",
      category: "invalid_arguments",
      retryable: false,
      cause,
      suggestedFix:
        "Wait for the existing user input answer or ask a materially different question.",
      saferAlternative:
        "Continue from the first user-input result once it is available.",
    }),
    error: cause,
  };
}

function createDuplicatePresentationAttemptResult(
  toolCall: ToolCall,
): ToolExecutionResult {
  const cause =
    "The same model response requested more than one full presentation generation attempt.";
  return {
    toolCall,
    args: undefined,
    policyTrace: [
      {
        stage: "planner",
        policy: "presentation_response_limit",
        outcome: "blocked",
        summary:
          "Blocked an additional presentation call in the same model response.",
        detail: cause,
      },
    ],
    status: "denied",
    content: formatToolError({
      summary: "Additional presentation generation was blocked.",
      category: "permission_denied",
      retryable: false,
      cause,
      suggestedFix:
        "Use the result of the first presentation call. Only a retryable failure may be retried in a later model response.",
    }),
    error: cause,
  };
}

function isDuplicatePresentationAttemptBlock(
  result: ToolExecutionResult,
): boolean {
  return (
    result.policyTrace?.some(
      (trace) => trace.policy === "presentation_response_limit",
    ) === true
  );
}

function createPresentationRetryRequiredSystemMessage(id: string): ChatMessage {
  return {
    id,
    role: "system",
    content: [
      "The previous presentation call failed before writing a PPTX and is retryable.",
      "Do not end the turn with an apology or claim that the tool cannot be called again.",
      "Call presentation again now with exactly the same arguments as the first attempt. Do not add or change language, instructions, title, fileName, or designSystem; PaperChat will start a fresh isolated planning, rendering, verification, and export attempt.",
    ].join(" "),
    timestamp: Date.now(),
  };
}

function createPresentationAttemptsExhaustedSystemMessage(
  id: string,
): ChatMessage {
  return {
    id,
    role: "system",
    content: [
      `The bounded presentation budget of ${MAX_PRESENTATION_ATTEMPTS_PER_TURN} full attempts is exhausted for this turn.`,
      "Do not call presentation or any other tool again in this turn.",
      "Give a concise final response stating that no PPTX was written and summarize the latest presentation failure.",
      "Do not describe this as an unchanged-call restriction or claim that the tool is generally unavailable.",
    ].join(" "),
    timestamp: Date.now(),
  };
}

function createPresentationExportCompletedSystemMessage(
  id: string,
  results: ToolExecutionResult[],
): ChatMessage | undefined {
  const completed = [...results]
    .reverse()
    .find(
      (result) =>
        result.toolCall.function.name === "presentation" &&
        result.status === "completed",
    );
  if (!completed) return undefined;

  let payload:
    | {
        status?: unknown;
        path?: unknown;
        fileName?: unknown;
        slideCount?: unknown;
      }
    | undefined;
  try {
    const parsed = JSON.parse(completed.content);
    if (parsed && typeof parsed === "object") {
      payload = parsed;
    }
  } catch {
    return undefined;
  }
  if (
    (payload?.status !== "completed" &&
      payload?.status !== "completed_with_warnings") ||
    typeof payload.path !== "string"
  ) {
    return undefined;
  }

  return {
    id,
    role: "system",
    content: [
      "The presentation tool successfully wrote a PPTX file.",
      `Status: ${payload.status}.`,
      `Path: ${payload.path}.`,
      typeof payload.fileName === "string"
        ? `File name: ${payload.fileName}.`
        : "",
      typeof payload.slideCount === "number"
        ? `Slide count: ${payload.slideCount}.`
        : "",
      "Your final answer must state that the PPTX was exported successfully and name the file or path.",
      "Never claim that no file was written, that a quality gate blocked export, or that another presentation attempt is required. Treat completed_with_warnings as a successful export with advisory warnings.",
    ]
      .filter(Boolean)
      .join(" "),
    timestamp: Date.now(),
  };
}

function isRetryablePresentationFailure(result: ToolExecutionResult): boolean {
  if (
    result.toolCall.function.name !== "presentation" ||
    result.status !== "failed"
  ) {
    return false;
  }
  return parseToolError(result.content)?.retryable === true;
}

function countRetryablePresentationFailures(
  results: ToolExecutionResult[],
): number {
  return results.filter(isRetryablePresentationFailure).length;
}

function truncateToolDetail(text: string): string {
  if (text.length <= 160) {
    return text;
  }
  return text.slice(0, 157) + "...";
}

function parsePresentationToolCardArtifact(
  content: string,
  toolCallId: string,
  localId: string,
): PresentationToolCardArtifact | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const value = parsed as Record<string, unknown>;
  const path = typeof value.path === "string" ? value.path : undefined;
  const previewPaths = Array.isArray(value.previewPaths)
    ? value.previewPaths.filter(
        (candidate): candidate is string => typeof candidate === "string",
      )
    : undefined;
  const attachmentItemID = Number.isSafeInteger(value.attachmentItemID)
    ? (value.attachmentItemID as number)
    : undefined;
  if (!path && !previewPaths?.length) return undefined;
  return {
    toolCallId,
    localId,
    path,
    previewPaths,
    attachmentItemID,
    isDraft: false,
  };
}

function createPresentationLocalIds(
  toolCalls: readonly ToolCall[],
  iteration: number,
): Map<ToolCall, string> {
  const occurrences = new Map<string, number>();
  const localIds = new Map<ToolCall, string>();
  for (const toolCall of toolCalls) {
    if (toolCall.function.name !== "presentation") continue;
    const occurrence = (occurrences.get(toolCall.id) || 0) + 1;
    occurrences.set(toolCall.id, occurrence);
    localIds.set(
      toolCall,
      `${toolCall.id}:presentation:${iteration}:${occurrence}`,
    );
  }
  return localIds;
}

const TOOL_RESULT_COMPACTED_PREFIX =
  "[Tool result compacted to preserve prompt cache and context budget]";
const TOOL_RESULT_FULL_KEEP_COUNT = 6;
const TOOL_RESULT_COMPACT_CHAR_LIMIT = 10000;
const TOOL_RESULT_SUMMARY_CHAR_LIMIT = 700;

interface ToolResultCompactionPolicy {
  keepFullCount: number;
  compactCharLimit: number;
  summaryCharLimit: number;
  stripAssistantToolCards: boolean;
}

interface ToolContextStrategy {
  compactionPolicy: ToolResultCompactionPolicy;
  persistApiOnlyTranscript: boolean;
  compactToolResultOnCreate: boolean;
}

const DEFAULT_TOOL_RESULT_COMPACTION_POLICY: ToolResultCompactionPolicy = {
  keepFullCount: TOOL_RESULT_FULL_KEEP_COUNT,
  compactCharLimit: TOOL_RESULT_COMPACT_CHAR_LIMIT,
  summaryCharLimit: TOOL_RESULT_SUMMARY_CHAR_LIMIT,
  stripAssistantToolCards: true,
};

const DEEPSEEK_TOOL_RESULT_COMPACTION_POLICY: ToolResultCompactionPolicy = {
  keepFullCount: 0,
  compactCharLimit: 0,
  summaryCharLimit: 700,
  stripAssistantToolCards: true,
};

const DEFAULT_TOOL_CONTEXT_STRATEGY: ToolContextStrategy = {
  compactionPolicy: DEFAULT_TOOL_RESULT_COMPACTION_POLICY,
  persistApiOnlyTranscript: true,
  compactToolResultOnCreate: false,
};

// GPT/OpenAI-style models can keep the model transcript closer to the raw
// tool exchange without needing DeepSeek's aggressive cache-stability path.
const OPENAI_TOOL_CONTEXT_STRATEGY: ToolContextStrategy = {
  compactionPolicy: DEFAULT_TOOL_RESULT_COMPACTION_POLICY,
  persistApiOnlyTranscript: true,
  compactToolResultOnCreate: false,
};

const DEEPSEEK_TOOL_CONTEXT_STRATEGY: ToolContextStrategy = {
  compactionPolicy: DEEPSEEK_TOOL_RESULT_COMPACTION_POLICY,
  persistApiOnlyTranscript: true,
  compactToolResultOnCreate: true,
};

function getToolContextStrategy(
  provider: ToolCallingProvider,
): ToolContextStrategy {
  const providerId = provider.config.id.toLowerCase();
  const resolvedPaperChatModel = (
    "resolvedModelOverride" in provider.config
      ? provider.config.resolvedModelOverride
      : undefined
  ) as string | undefined;
  const modelId =
    providerId === "paperchat"
      ? (
          resolvedPaperChatModel ||
          provider.config.defaultModel ||
          ""
        ).toLowerCase()
      : (provider.config.defaultModel || "").toLowerCase();
  if (
    providerId === "deepseek" ||
    (providerId === "paperchat" && modelId.includes("deepseek"))
  ) {
    return DEEPSEEK_TOOL_CONTEXT_STRATEGY;
  }
  if (
    provider.config.type === "openai" ||
    providerId === "openai" ||
    isOpenAIStyleModelId(modelId)
  ) {
    return OPENAI_TOOL_CONTEXT_STRATEGY;
  }
  return DEFAULT_TOOL_CONTEXT_STRATEGY;
}

function isOpenAIStyleModelId(modelId: string): boolean {
  return (
    modelId.includes("gpt") ||
    modelId.includes("openai") ||
    /^o\d/.test(modelId)
  );
}

function insertApiOnlyModelContextMessage(
  session: ChatSession,
  assistantMessage: ChatMessage,
  message: ChatMessage,
): void {
  const insertIndex = session.messages.findIndex(
    (candidate) => candidate.id === assistantMessage.id,
  );
  if (insertIndex >= 0) {
    session.messages.splice(insertIndex, 0, message);
    return;
  }
  session.messages.push(message);
}

function buildApiOnlyModelContextMessageId(
  assistantMessageId: string,
  messageId: string,
): string {
  return `${assistantMessageId}-api-context-${messageId}`;
}

export function removeApiOnlyModelContextMessagesForTurn(
  session: ChatSession,
  assistantMessageId: string,
): void {
  const prefix = `${assistantMessageId}-api-context-`;
  session.messages = session.messages.filter(
    (message) => !(message.apiOnly && message.id.startsWith(prefix)),
  );
}

/**
 * Keep only provider-valid completed tool exchanges for an interrupted turn.
 * UI tool cards remain on the visible assistant message; this hidden transcript
 * is the trusted model-facing representation of completed tool results.
 */
export function retainCompletedApiOnlyModelContextMessagesForTurn(
  session: ChatSession,
  assistantMessageId: string,
): boolean {
  const prefix = `${assistantMessageId}-api-context-`;
  const turnMessages = session.messages.filter(
    (message) => message.apiOnly && message.id.startsWith(prefix),
  );
  if (turnMessages.length === 0) {
    return false;
  }

  const retained: ChatMessage[] = [];
  for (let index = 0; index < turnMessages.length; ) {
    const assistant = turnMessages[index];
    if (assistant.role !== "assistant" || !assistant.tool_calls?.length) {
      index += 1;
      continue;
    }

    let nextIndex = index + 1;
    const toolResults = new Map<string, ChatMessage[]>();
    while (
      nextIndex < turnMessages.length &&
      turnMessages[nextIndex].role === "tool"
    ) {
      const toolResult = turnMessages[nextIndex];
      if (toolResult.tool_call_id) {
        const matchingResults = toolResults.get(toolResult.tool_call_id) || [];
        matchingResults.push(toolResult);
        toolResults.set(toolResult.tool_call_id, matchingResults);
      }
      nextIndex += 1;
    }

    const consumedResultCount = new Map<string, number>();
    const completedToolCalls = assistant.tool_calls.filter((toolCall) => {
      const id = toolCall.id;
      if (!id) return false;
      const resultIndex = consumedResultCount.get(id) || 0;
      const completed = resultIndex < (toolResults.get(id)?.length || 0);
      if (completed) consumedResultCount.set(id, resultIndex + 1);
      return completed;
    });
    if (completedToolCalls.length > 0) {
      retained.push({ ...assistant, tool_calls: completedToolCalls });
      const retainedResultCount = new Map<string, number>();
      for (const toolCall of completedToolCalls) {
        const resultIndex = retainedResultCount.get(toolCall.id) || 0;
        retained.push(toolResults.get(toolCall.id)![resultIndex]);
        retainedResultCount.set(toolCall.id, resultIndex + 1);
      }
    }
    index = nextIndex;
  }

  let inserted = false;
  const nextMessages: ChatMessage[] = [];
  for (const message of session.messages) {
    if (message.apiOnly && message.id.startsWith(prefix)) {
      if (!inserted) {
        nextMessages.push(...retained);
        inserted = true;
      }
      continue;
    }
    nextMessages.push(message);
  }
  session.messages = nextMessages;
  return true;
}

function hasApiOnlyModelContextMessages(session: ChatSession): boolean {
  return session.messages.some((message) => message.apiOnly);
}

function compactOlderToolResultMessages(
  messages: ChatMessage[],
  policy: ToolResultCompactionPolicy,
): void {
  if (policy.stripAssistantToolCards) {
    stripAssistantToolCallCards(messages);
  }

  const toolMessageIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "tool")
    .map(({ index }) => index);
  const keepFull = new Set(
    policy.keepFullCount > 0
      ? toolMessageIndexes.slice(-policy.keepFullCount)
      : [],
  );

  for (const index of toolMessageIndexes) {
    if (keepFull.has(index)) {
      continue;
    }
    const message = messages[index];
    if (message.content.startsWith(TOOL_RESULT_COMPACTED_PREFIX)) {
      continue;
    }
    if (message.content.length <= policy.compactCharLimit) {
      continue;
    }
    message.content = compactToolResultContent(message.content, policy);
  }
}

function stripAssistantToolCallCards(messages: ChatMessage[]): void {
  for (const message of messages) {
    if (
      message.role !== "assistant" ||
      message.tool_calls ||
      !message.content.includes("<tool-call")
    ) {
      continue;
    }
    const stripped = message.content
      .replace(/\n?<tool-call\b[^>]*>[\s\S]*?<\/tool-call>\n?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    message.content =
      stripped || "[Tool call details omitted from model context.]";
  }
}

function buildCompactedToolResultContent(
  content: string,
  summaryCharLimit: number,
): string {
  const compacted = content
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, summaryCharLimit);
  return [
    TOOL_RESULT_COMPACTED_PREFIX,
    `Original characters: ${content.length}`,
    `Preview: ${compacted}${content.length > summaryCharLimit ? "..." : ""}`,
  ].join("\n");
}

function compactToolResultContent(
  content: string,
  policy: ToolResultCompactionPolicy,
): string {
  if (
    content.startsWith(TOOL_RESULT_COMPACTED_PREFIX) ||
    content.length <= policy.compactCharLimit
  ) {
    return content;
  }
  return buildCompactedToolResultContent(content, policy.summaryCharLimit);
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
    case "tool_progress":
      return {
        type: event.type,
        sessionId: event.sessionId,
        planId: event.planId,
        assistantMessageId: event.assistantMessageId,
        iteration: event.iteration,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        phase: event.phase,
        message: event.message,
        current: event.current,
        total: event.total,
        hasPptx: Boolean(event.pptxPath),
        previewCount: event.previewPaths?.length || 0,
        isDraft: event.isDraft,
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
    case "user_input_requested":
      return {
        type: event.type,
        sessionId: event.sessionId,
        planId: event.planId,
        assistantMessageId: event.assistantMessageId,
        requestId: event.requestId,
        toolCallId: event.toolCallId,
        questionCount: event.questionCount,
        autoResolutionMs: event.autoResolutionMs,
        pendingCount: event.pendingCount,
      };
    case "user_input_resolved":
      return {
        type: event.type,
        sessionId: event.sessionId,
        planId: event.planId,
        assistantMessageId: event.assistantMessageId,
        requestId: event.requestId,
        toolCallId: event.toolCallId,
        status: event.status,
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
