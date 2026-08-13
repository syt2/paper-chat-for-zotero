/**
 * ChatManager - 聊天会话管理核心类
 *
 * 职责:
 * 1. 管理独立的聊天会话 (session 独立于 item)
 * 2. 处理消息发送和接收
 * 3. 跟踪当前活动的 item，在切换时插入 system-notice
 * 4. 动态调整工具列表和 system prompt
 */

import type {
  AgentRuntimeEvent,
  ChatMessage,
  ChatMessageStreamingState,
  ChatSession,
  ExecutionPlan,
  PresentationToolCardArtifact,
  SendMessageOptions,
  StreamCallbacks,
  SessionMeta,
} from "../../types/chat";
import type {
  ToolApprovalRequest,
  ToolApprovalResolution,
  ToolDefinition,
  ToolPermissionDecision,
  RequestUserInputResponse,
} from "../../types/tool";
import type {
  ToolCallingProvider,
  AIProvider,
  PaperChatProviderConfig,
} from "../../types/provider";
import {
  MissingActiveSessionError,
  SessionLoadError,
  SessionStorageService,
} from "./SessionStorageService";
import { PdfExtractor } from "./PdfExtractor";
import { getContextManager } from "./ContextManager";
import {
  generateAgentRuntimeContextPrompt,
  getPdfToolManager,
} from "./pdf-tools";
import {
  getToolPermissionManager,
  type ToolApprovalObserver,
} from "./tool-permissions";
import { getToolScheduler } from "./tool-scheduler";
import { getSkillRegistry, type SelectedPaperChatSkill } from "./skills";
import { getSessionArtifactStore } from "./session-artifacts";
import { getProviderManager, PaperChatProvider } from "../providers";
import type { ProviderRetryOptions } from "../providers/ProviderManager";
import { getAuthManager } from "../auth";
import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import {
  createAbortController,
  type ManagedAbortController,
} from "../../utils/abort";
import {
  getErrorMessage,
  getItemTitleSmart,
  generateTimestampId,
} from "../../utils/common";
import {
  getModelRatios,
  getModelRoutingMeta,
} from "../preferences/ModelsFetcher";
import {
  isPaperChatModelHardFailure,
  type PaperChatTier,
} from "../providers/paperchat-tier-routing";
import { isPaperChatQuotaError } from "../providers/paperchat-errors";
import {
  applyPaperChatSessionBinding,
  clearPaperChatRetryableState,
  resolvePaperChatSessionBinding,
} from "./paperchat-session-state";
import { PaperChatRetryOrchestrator } from "./PaperChatRetryOrchestrator";
import {
  PaperChatTierController,
  selectMoreSubstantialSnapshot,
  type FailedAssistantSnapshot,
  type PaperChatTierRerollResult,
} from "./PaperChatTierController";
import { ToolApprovalCoordinator } from "./ToolApprovalCoordinator";
import {
  createInterruptedAssistantContextMessage,
  stripPendingAndIncompleteToolCallContent,
} from "./interrupted-message";
import { saveDebugContextSnapshot } from "./DebugContextExporter";
import { MemoryManager } from "./memory/MemoryManager";
import { SessionTitleService } from "./SessionTitleService";
import {
  cloneHistoryThroughAssistantMessage,
  collectForkArtifactIds,
  resolveForkItemKey,
} from "./session-fork";
import {
  collectTrustedSourceTargets,
  normalizeSourceItemKeys,
  sanitizeSourceGroupTargets,
} from "./note-source-provenance";
import {
  buildNoteSummaryRuntimeInstruction,
  type NoteSummaryContext,
} from "./note-summary-destination";
import { sanitizeEvidenceReferences } from "./evidence";
import {
  applyQuotedMessagesToModelRequest,
  normalizeQuotedMessageRefs,
} from "./quoted-messages";
import {
  AgentRuntime,
  removeApiOnlyModelContextMessagesForTurn,
  retainCompletedApiOnlyModelContextMessagesForTurn,
} from "./agent-runtime/AgentRuntime";
import { normalizeAgentMaxPlanningIterations } from "./agent-runtime/IterationLimitConfig";
import {
  countHostedWebSearchResults,
  createToolBudgetState,
  getToolBudgetLimits,
} from "./tool-budget/ToolBudgetPolicy";
import { isAbortError, SessionRunInvalidatedError } from "./errors";
import { ANALYTICS_EVENTS, getAnalyticsService } from "../analytics";
import { providerSupportsToolCalling } from "../providers/provider-capabilities";
import type {
  ChatHistoryMessagePage,
  ChatHistorySearchPage,
  SearchHistoryGroupsRequest,
  SearchHistorySessionMatchesRequest,
} from "./search/SearchTypes";
import {
  createPendingSearchScopeTools,
  filterSearchToolsForScope,
  findCompletedSearchScope,
  getSearchToolPromptMode,
  type SearchScopeGateConfig,
  type SearchToolPromptMode,
  type SelectedSearchScope,
} from "./agent-runtime/SearchScopeGate";
import {
  MAX_SCOPE_ITEMS,
  resolveScopedPapers,
  type SessionScope,
} from "./session-scope";
import type { PresentationLaunchAuthorization } from "../presentation/PresentationLaunchAuthorization";
import { isIssuedPresentationLaunchAuthorization } from "../presentation/PresentationLaunchAuthorization";
// V1 migration now handled by migrateToSQLite.ts at startup

const SUPPRESS_AUTOMATIC_RETRY = "paperChatSuppressAutomaticRetry";

type RetryGuardedError = Error & {
  [SUPPRESS_AUTOMATIC_RETRY]?: boolean;
};

type InternalSendMessageOptions = SendMessageOptions & {
  item?: Zotero.Item | null;
  fromPaperChatReroll?: boolean;
  resumeFailedTurn?: boolean;
  reuseUserMessageId?: string;
  reuseAssistantMessageId?: string;
  targetSession?: ChatSession;
  requireTargetSessionActive?: boolean;
  allowedToolNames?: readonly string[];
  lockedToolItemKey?: string;
  modelRequestContent?: string;
  allowPaperChatRetry?: boolean;
  trustedSourceItemKeys?: readonly string[];
  noteSummaryContext?: NoteSummaryContext;
  requiredProviderId?: "paperchat";
  presentationAuthorization?: PresentationLaunchAuthorization;
};

function hasValidPresentationAuthorization(
  authorization: InternalSendMessageOptions["presentationAuthorization"],
  item: Zotero.Item | null | undefined,
): boolean {
  return (
    isIssuedPresentationLaunchAuthorization(authorization) &&
    !!item?.key &&
    Number.isSafeInteger(item.libraryID) &&
    authorization.source.itemKey === item.key &&
    authorization.source.libraryID === item.libraryID
  );
}

/**
 * Type guard: check if provider supports streaming tool calling
 */
function providerSupportsStreamingToolCalling(
  provider: AIProvider,
): provider is AIProvider &
  ToolCallingProvider & {
    streamChatCompletionWithTools: NonNullable<
      ToolCallingProvider["streamChatCompletionWithTools"]
    >;
  } {
  return (
    providerSupportsToolCalling(provider) &&
    "streamChatCompletionWithTools" in provider &&
    typeof provider.streamChatCompletionWithTools === "function"
  );
}

function isDeepSeekToolPromptCacheTarget(
  provider: AIProvider,
  resolvedPaperChatModelId?: string | null,
): boolean {
  const providerId = provider.config.id.toLowerCase();
  const modelId =
    providerId === "paperchat"
      ? (
          resolvedPaperChatModelId ||
          provider.config.defaultModel ||
          ""
        ).toLowerCase()
      : (provider.config.defaultModel || "").toLowerCase();
  return (
    providerId === "deepseek" ||
    (providerId === "paperchat" && modelId.includes("deepseek"))
  );
}

function buildStableToolCatalogForPromptCache(tools: ToolDefinition[]): string {
  const lines = [
    "=== STABLE TOOL CATALOG FOR PROMPT CACHE ===",
    "The structured tools field remains authoritative. This stable catalog duplicates tool schemas so providers with prefix-only prompt caches can reuse the large, unchanged tool context before dynamic conversation messages.",
  ];
  for (const tool of tools) {
    const fn = tool.function;
    lines.push(`\nTool: ${fn.name}`);
    lines.push(`Description: ${fn.description}`);
    lines.push(`Parameters: ${JSON.stringify(fn.parameters)}`);
  }
  return lines.join("\n");
}

// 使用 common.ts 中的 getItemTitleSmart 获取 item 标题

export class ChatManager {
  private sessionStorage: SessionStorageService;
  private paperChatRetry: PaperChatRetryOrchestrator;
  private pdfExtractor: PdfExtractor;
  private currentSession: ChatSession | null = null;
  private currentItemKey: string | null = null;
  private currentItemLibraryID: number | null = null;
  private initialized: boolean = false;
  private sessionNavigationQueue: Promise<void> = Promise.resolve();

  // Sessions that currently have an in-flight send/stream operation.
  // switchSession() reuses these objects instead of loading from DB,
  // so that isSessionActive() returns true and UI updates resume
  // when the user switches back to a session that is still streaming.
  private streamingSessions = new Map<string, ChatSession>();
  private sessionRunCounters = new Map<string, number>();
  private activeSessionRunIds = new Map<string, number>();
  private activeSessionAbortControllers = new Map<
    string,
    ManagedAbortController
  >();
  private paperChatRerollSessions = new Set<string>();

  private memoryManager: MemoryManager;
  private sessionTitleService: SessionTitleService;
  private agentRuntime: AgentRuntime;

  // UI回调
  private onMessageUpdate?: (messages: ChatMessage[]) => void;
  private onStreamingUpdate?: (content: string, messageId: string) => void;
  private onReasoningUpdate?: (reasoning: string, messageId: string) => void;
  private onError?: (error: Error) => void;
  private onPdfAttached?: () => void;
  private onMessageComplete?: () => void;
  private onExecutionPlanUpdate?: (plan?: ExecutionPlan) => void;
  private onSessionListUpdate?: () => void | Promise<void>;
  private onRuntimeEvent?: (event: AgentRuntimeEvent) => void;
  private approvalObserver: ToolApprovalObserver;

  constructor() {
    this.sessionStorage = new SessionStorageService();
    this.paperChatRetry = new PaperChatRetryOrchestrator({
      updateSessionMeta: (session) =>
        this.sessionStorage.updateSessionMeta(session),
      insertSystemNotice: (session, content) =>
        this.insertSystemNotice(session, content),
    });
    this.pdfExtractor = new PdfExtractor();
    this.memoryManager = new MemoryManager(this.sessionStorage);
    this.sessionTitleService = new SessionTitleService();
    this.agentRuntime = new AgentRuntime(
      this.sessionStorage,
      {
        isSessionActive: (session) => this.isSessionActive(session),
        isSessionTracked: (session, runId) =>
          this.isSessionTracked(session, runId),
        onStreamingUpdate: (content, messageId) =>
          this.onStreamingUpdate?.(content, messageId),
        onReasoningUpdate: (reasoning, messageId) =>
          this.onReasoningUpdate?.(reasoning, messageId),
        onMessageUpdate: (messages) => this.onMessageUpdate?.(messages),
        onPdfAttached: () => this.onPdfAttached?.(),
        onMessageComplete: () => this.onMessageComplete?.(),
        onExecutionPlanUpdate: (plan) => this.onExecutionPlanUpdate?.(plan),
        onRuntimeEvent: (event) => this.onRuntimeEvent?.(event),
        formatToolCallCard: (toolName, args, status, resultPreview, options) =>
          this.formatToolCallCard(
            toolName,
            args,
            status,
            resultPreview,
            options,
          ),
        generateId: () => this.generateId(),
      },
      getToolScheduler(),
    );
    this.approvalObserver = {
      onApprovalRequested: (approvalRequest) => {
        this.handleApprovalRequested(approvalRequest);
      },
      onApprovalResolved: (approvalRequest, decision) => {
        this.handleApprovalResolved(approvalRequest, decision);
      },
    };
    getToolPermissionManager().addApprovalObserver(this.approvalObserver);
  }

  /**
   * 初始化 ChatManager
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // 初始化存储服务 (migration + task recovery handled at startup in hooks.ts)
    await this.sessionStorage.init();

    // 启动时复用草稿会话；如果上次活动会话已经开始聊天，则创建新的草稿。
    try {
      const activeSession = await this.sessionStorage.getActiveSession();
      this.currentSession =
        activeSession && this.isDraftSession(activeSession)
          ? activeSession
          : await this.sessionStorage.createSession();
    } catch (error) {
      if (error instanceof MissingActiveSessionError) {
        ztoolkit.log(
          "[ChatManager] Active session is missing, creating a fresh session:",
          error.message,
        );
        await this.sessionStorage.setActiveSession(null);
        this.currentSession = await this.sessionStorage.createSession();
      } else if (error instanceof SessionLoadError) {
        ztoolkit.log(
          "[ChatManager] Active session failed to load, resetting active session:",
          error.message,
        );
        this.onError?.(
          new Error(`Failed to load the active chat session: ${error.message}`),
        );
        await this.sessionStorage.setActiveSession(null);
        this.currentSession = await this.sessionStorage.createSession();
      } else {
        throw error;
      }
    }
    await this.sessionStorage.cleanupAbandonedDraftSessions();
    this.reconcileApprovalState(this.currentSession);
    this.reconcileUserInputRequestState(this.currentSession);
    this.applySessionItemContext(this.currentSession);

    this.initialized = true;
    ztoolkit.log("[ChatManager] Initialized");

    // On startup, only re-extract if the session has grown since last extraction.
    // Skip the neverExtracted path to avoid a surprise API call on every Zotero open.
    this.memoryManager.onSessionReady(this.currentSession);
  }

  /**
   * Get the active AI provider
   */
  private getActiveProvider() {
    return getProviderManager().getActiveProvider();
  }

  private getToolDefinitionsForProvider(
    provider: AIProvider | null | undefined,
    hasCurrentItem: boolean,
    searchScope?: SelectedSearchScope,
    options: { includePresentation?: boolean } = {},
  ): ToolDefinition[] {
    const supportsHostedWebSearch =
      provider?.supportsHostedWebSearch?.() === true;
    return filterSearchToolsForScope({
      tools: getPdfToolManager().getToolDefinitions(hasCurrentItem, options),
      supportsHostedWebSearch,
      scope: searchScope,
    })
      .slice()
      .sort((left, right) =>
        left.function.name.localeCompare(right.function.name),
      );
  }

  private buildToolCallingStableSystemPrompt(params: {
    paperStructure?: Awaited<
      ReturnType<typeof getPdfToolManager.prototype.extractAndParsePaper>
    >;
    hasCurrentItem: boolean;
    item?: Zotero.Item;
    searchToolMode?: SearchToolPromptMode;
  }): string {
    const { paperStructure, hasCurrentItem, item, searchToolMode } = params;
    const pdfToolManager = getPdfToolManager();

    return pdfToolManager.generatePaperContextPrompt(
      paperStructure || undefined,
      hasCurrentItem ? item?.key : undefined,
      hasCurrentItem && item ? getItemTitleSmart(item) : undefined,
      hasCurrentItem,
      undefined,
      undefined,
      searchToolMode,
    );
  }

  private async selectWorkflowSkills(params: {
    lastUserMessage?: ChatMessage;
    item?: Zotero.Item | null;
  }): Promise<SelectedPaperChatSkill[]> {
    const queryParts = [params.lastUserMessage?.content || ""];
    if (params.item) {
      queryParts.push(getItemTitleSmart(params.item));
    }
    return getSkillRegistry().selectSkills(queryParts.join("\n"));
  }

  private buildToolCallingRuntimeSystemPrompt(params: {
    memoryContext?: string;
    selectedSkills?: SelectedPaperChatSkill[];
    searchScope?: SelectedSearchScope;
    searchToolMode?: SearchToolPromptMode;
    sendingSession: ChatSession;
    runtimeState?: {
      currentIteration?: number;
      remainingIterations?: number;
      maxIterations: number;
      forceFinalAnswer: boolean;
    };
  }): string {
    const {
      memoryContext,
      selectedSkills,
      searchScope,
      searchToolMode,
      sendingSession,
      runtimeState,
    } = params;
    const allToolResults = sendingSession.toolExecutionState?.results || [];
    const recentToolResults = allToolResults.slice(-5);
    const hardIterationLimit =
      runtimeState?.maxIterations ??
      normalizeAgentMaxPlanningIterations(
        getPref("agentMaxPlanningIterations") as number | undefined,
      );
    const toolBudgetLimits = getToolBudgetLimits(hardIterationLimit);
    const toolBudgetState = createToolBudgetState(allToolResults);

    return generateAgentRuntimeContextPrompt(memoryContext, {
      executionPlan: sendingSession.executionPlan,
      scopedPapers: resolveScopedPapers(sendingSession.scopeItemKeys),
      scopeLabel: sendingSession.scopeLabel,
      recentToolResults,
      selectedSkills,
      searchScope,
      searchToolMode,
      runtimeLimits: {
        hardIterationLimit,
        currentIteration: runtimeState?.currentIteration,
        remainingIterations: runtimeState?.remainingIterations,
        forceFinalAnswer: runtimeState?.forceFinalAnswer,
      },
      toolBudget: {
        webSearchUsed: toolBudgetState.webSearchCalls,
        webSearchRemaining: Math.max(
          0,
          toolBudgetLimits.maxWebSearchCallsPerTurn -
            toolBudgetState.webSearchCalls,
        ),
        webSearchLimit: toolBudgetLimits.maxWebSearchCallsPerTurn,
        getFullTextUsed: toolBudgetState.getFullTextCalls,
        getFullTextRemaining: Math.max(
          0,
          toolBudgetLimits.maxFullTextCallsPerTurn -
            toolBudgetState.getFullTextCalls,
        ),
        getFullTextLimit: toolBudgetLimits.maxFullTextCallsPerTurn,
      },
    });
  }

  /**
   * 检查错误是否为认证错误 (401/403 或令牌相关错误)
   */
  private isAuthError(error: Error): boolean {
    const message = error.message || "";
    // Quota failures may also arrive as HTTP 403, so this must run before the generic 403/auth checks.
    if (isPaperChatQuotaError(error)) {
      return false;
    }
    return (
      message.includes("API Error: 401") ||
      message.includes("API Error: 403") ||
      message.includes("Unauthorized") ||
      message.includes("Invalid API key") ||
      message.includes("authentication") ||
      message.includes("invalid_api_key") ||
      message.includes("无效的令牌") ||
      message.includes("未提供令牌") ||
      message.includes("令牌状态不可用") ||
      message.includes("令牌已过期") ||
      message.includes("令牌额度不足")
    );
  }

  private createProviderRetryOptions(
    abortSignal?: AbortSignal,
  ): ProviderRetryOptions {
    let paperChatAuthReplayUsed = false;
    return {
      abortSignal,
      shouldRetry: async (error, provider) => {
        if ((error as RetryGuardedError)[SUPPRESS_AUTOMATIC_RETRY] === true) {
          return false;
        }
        if (
          provider.config.id === "paperchat" &&
          isPaperChatModelHardFailure(error)
        ) {
          // The request path already reroutes once within the same tier.
          return false;
        }
        if (provider.config.id === "paperchat" && this.isAuthError(error)) {
          if (paperChatAuthReplayUsed) {
            return false;
          }
          paperChatAuthReplayUsed = true;
          try {
            const refreshed = await getAuthManager().ensurePluginToken(true);
            if (!refreshed) {
              ztoolkit.log(
                "[API Retry] PaperChat token refresh did not produce a usable token",
              );
              return false;
            }
            ztoolkit.log(
              "[API Retry] PaperChat token refreshed; replaying the same request",
            );
            return true;
          } catch (refreshError) {
            ztoolkit.log(
              "[API Retry] Failed to refresh PaperChat token:",
              refreshError,
            );
            return false;
          }
        }
        return getProviderManager().isRetryableError(error);
      },
    };
  }

  private async ensurePaperChatModelResolved(
    session: ChatSession,
    persist: boolean = true,
  ): Promise<string> {
    const providerManager = getProviderManager();
    const paperchatProvider = providerManager.getProvider("paperchat");
    const paperchatConfig = providerManager.getProviderConfig(
      "paperchat",
    ) as PaperChatProviderConfig | null;

    if (!paperchatProvider || !paperchatConfig) {
      throw new Error("PaperChat provider is not configured");
    }

    const binding = resolvePaperChatSessionBinding(
      session,
      getPref("paperchatTierState") as string | undefined,
      paperchatConfig.availableModels || [],
      getModelRatios(),
      undefined,
      getModelRoutingMeta(),
    );

    const didChange = persist
      ? applyPaperChatSessionBinding(session, binding)
      : false;

    if (persist && didChange) {
      await this.sessionStorage.updateSessionMeta(session);
    }

    paperchatProvider.updateConfig({
      resolvedModelOverride: binding.modelId,
    });

    return binding.modelId;
  }

  private async insertSystemNotice(
    session: ChatSession,
    content: string,
    options?: { notify?: boolean },
  ): Promise<ChatMessage> {
    const notice: ChatMessage = {
      id: this.generateId(),
      role: "system",
      content,
      timestamp: Date.now(),
      isSystemNotice: true,
    };

    session.messages.push(notice);
    try {
      await this.sessionStorage.insertMessage(session.id, notice);
    } catch (error) {
      const noticeIndex = session.messages.findIndex(
        (message) => message.id === notice.id,
      );
      if (noticeIndex >= 0) {
        session.messages.splice(noticeIndex, 1);
      }
      throw error;
    }
    if (options?.notify !== false && this.isSessionActive(session)) {
      try {
        this.onMessageUpdate?.(session.messages);
      } catch (error) {
        ztoolkit.log(
          "[ChatManager] Failed to render persisted system notice:",
          getErrorMessage(error),
        );
      }
    }
    return notice;
  }

  private getSessionItem(session: ChatSession): Zotero.Item | null {
    const itemKey = session.lastActiveItemKey;
    if (!itemKey) {
      return null;
    }

    const libraryID =
      session.lastActiveItemLibraryID ?? Zotero.Libraries.userLibraryID;
    return (
      (Zotero.Items.getByLibraryAndKey(libraryID, itemKey) as
        | Zotero.Item
        | false) || null
    );
  }

  /**
   * Check if the given session is still the active/displayed session.
   * Used to guard UI callbacks so we don't update the UI for a session
   * the user has navigated away from.
   */
  private isSessionActive(session: ChatSession): boolean {
    return this.currentSession === session;
  }

  /**
   * Check whether a session object is still the authoritative in-memory
   * instance for its session id. Clearing/deleting a session replaces or
   * detaches the old object so late async callbacks can be ignored.
   */
  private isSessionTracked(session: ChatSession, runId?: number): boolean {
    const hasSessionRef =
      this.currentSession === session ||
      this.streamingSessions.get(session.id) === session;
    if (!hasSessionRef) {
      return false;
    }
    if (runId === undefined) {
      return true;
    }
    return this.activeSessionRunIds.get(session.id) === runId;
  }

  private beginSessionRun(session: ChatSession): {
    runId: number;
    abortSignal?: AbortSignal;
  } {
    const nextRunId = (this.sessionRunCounters.get(session.id) || 0) + 1;
    const abortController = createAbortController();
    this.sessionRunCounters.set(session.id, nextRunId);
    this.activeSessionRunIds.set(session.id, nextRunId);
    this.activeSessionAbortControllers.set(session.id, abortController);
    this.streamingSessions.set(session.id, session);
    return {
      runId: nextRunId,
      abortSignal: abortController.signal,
    };
  }

  private completeSessionRun(session: ChatSession, runId: number): void {
    if (this.activeSessionRunIds.get(session.id) !== runId) {
      return;
    }
    this.activeSessionRunIds.delete(session.id);
    this.activeSessionAbortControllers.delete(session.id);
    this.streamingSessions.delete(session.id);
  }

  private invalidateSessionRun(
    sessionId: string,
    options?: { abort?: boolean },
  ): void {
    const abortController = this.activeSessionAbortControllers.get(sessionId);
    this.activeSessionRunIds.delete(sessionId);
    this.activeSessionAbortControllers.delete(sessionId);
    this.streamingSessions.delete(sessionId);

    if (options?.abort) {
      abortController?.abort();
    }
  }

  private ensureTrackedRun(session: ChatSession, runId: number): void {
    if (!this.isSessionTracked(session, runId)) {
      throw new SessionRunInvalidatedError();
    }
  }

  /**
   * 设置UI回调
   */
  setCallbacks(callbacks: {
    onMessageUpdate?: (messages: ChatMessage[]) => void;
    onStreamingUpdate?: (content: string, messageId: string) => void;
    onReasoningUpdate?: (reasoning: string, messageId: string) => void;
    onError?: (error: Error) => void;
    onPdfAttached?: () => void;
    onMessageComplete?: () => void;
    onExecutionPlanUpdate?: (plan?: ExecutionPlan) => void;
    onRuntimeEvent?: (event: AgentRuntimeEvent) => void;
  }): void {
    this.onMessageUpdate = callbacks.onMessageUpdate;
    this.onStreamingUpdate = callbacks.onStreamingUpdate;
    this.onReasoningUpdate = callbacks.onReasoningUpdate;
    this.onError = callbacks.onError;
    this.onPdfAttached = callbacks.onPdfAttached;
    this.onMessageComplete = callbacks.onMessageComplete;
    this.onExecutionPlanUpdate = callbacks.onExecutionPlanUpdate;
    this.onRuntimeEvent = callbacks.onRuntimeEvent;
  }

  setSessionListUpdateCallback(callback?: () => void | Promise<void>): void {
    this.onSessionListUpdate = callback;
  }

  private notifySessionListUpdated(): void {
    if (!this.onSessionListUpdate) {
      return;
    }
    Promise.resolve(this.onSessionListUpdate()).catch((error) => {
      ztoolkit.log(
        "[ChatManager] Failed to handle session list update:",
        getErrorMessage(error),
      );
    });
  }

  private enqueueSessionNavigation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionNavigationQueue ?? Promise.resolve();
    const result = previous.then(operation, operation);
    this.sessionNavigationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * 设置当前活动的 Item Key (单文档模式，向后兼容)
   */
  setCurrentItemKey(itemKey: string | null, libraryID?: number | null): void {
    this.currentItemKey = itemKey;
    this.currentItemLibraryID =
      itemKey && Number.isSafeInteger(libraryID)
        ? libraryID!
        : itemKey
          ? (Zotero.Libraries?.userLibraryID ?? null)
          : null;
    getPdfToolManager().setCurrentItemKey(itemKey);
  }

  /**
   * 获取当前活动的 Item Key (单文档模式)
   */
  getCurrentItemKey(): string | null {
    return this.currentItemKey;
  }

  /**
   * 获取当前活动会话
   */
  getActiveSession(): ChatSession | null {
    return this.currentSession;
  }

  async exportCurrentDebugContext(item?: Zotero.Item | null): Promise<string> {
    const session = this.currentSession;
    if (!session) {
      throw new Error("No active chat session to export.");
    }

    const provider = this.getActiveProvider();
    const supportsToolCalling = provider
      ? providerSupportsToolCalling(provider)
      : false;
    const providerConfig = provider?.config;
    const providerModel =
      providerConfig?.type === "paperchat"
        ? providerConfig.resolvedModelOverride || providerConfig.defaultModel
        : providerConfig?.defaultModel;
    const providerSystemPrompt =
      providerConfig && "systemPrompt" in providerConfig
        ? providerConfig.systemPrompt
        : undefined;

    const contextManager = getContextManager();
    const { messages: filteredMessages } =
      contextManager.filterMessages(session);
    const messagesForApi = applyQuotedMessagesToModelRequest(
      filteredMessages.filter(
        (message) =>
          !(
            message.role === "assistant" &&
            message.streamingState === "in_progress" &&
            !message.content
          ),
      ),
    );

    const withProviderSystemPrompt = (
      messages: ChatMessage[],
    ): ChatMessage[] => {
      if (!providerSystemPrompt) {
        return messages;
      }
      return [
        {
          id: "provider-system-prompt",
          role: "system",
          content: providerSystemPrompt,
          timestamp: Date.now(),
        },
        ...messages,
      ];
    };

    let messagesWithContext = withProviderSystemPrompt(messagesForApi);
    let paperContextPrompt: string | undefined;
    let runtimeContextPrompt: string | undefined;
    let toolDefinitions: ToolDefinition[] | undefined;

    if (supportsToolCalling) {
      const hasCurrentItem = !!item?.key && !!item.id;
      const pdfToolManager = getPdfToolManager();
      toolDefinitions = this.getToolDefinitionsForProvider(
        provider,
        hasCurrentItem,
      );
      const searchScopeGateEnabled =
        provider?.supportsHostedWebSearch?.() === true;
      if (searchScopeGateEnabled) {
        toolDefinitions = createPendingSearchScopeTools(toolDefinitions);
      }
      const paperStructure = hasCurrentItem
        ? await pdfToolManager.extractAndParsePaper(
            item.key,
            false,
            item.libraryID,
          )
        : undefined;
      const lastUserMessage = messagesForApi
        .filter((message) => message.role === "user")
        .at(-1);
      const memoryContext = await this.memoryManager.buildPromptContext(
        lastUserMessage?.content,
      );
      const selectedSkills = await this.selectWorkflowSkills({
        lastUserMessage,
        item: hasCurrentItem ? item : undefined,
      });

      paperContextPrompt = this.buildToolCallingStableSystemPrompt({
        paperStructure,
        hasCurrentItem,
        item: hasCurrentItem ? item : undefined,
        searchToolMode: getSearchToolPromptMode(
          toolDefinitions,
          searchScopeGateEnabled,
        ),
      });
      runtimeContextPrompt = this.buildToolCallingRuntimeSystemPrompt({
        memoryContext,
        selectedSkills,
        sendingSession: session,
        runtimeState: {
          maxIterations: normalizeAgentMaxPlanningIterations(
            getPref("agentMaxPlanningIterations") as number | undefined,
          ),
          forceFinalAnswer: false,
        },
      });

      messagesWithContext = withProviderSystemPrompt([
        {
          id: "paper-context",
          role: "system",
          content: paperContextPrompt,
          timestamp: Date.now(),
        },
        ...messagesForApi,
        {
          id: "cache-checkpoint",
          role: "system",
          content:
            "Prompt cache checkpoint. This is not user content or an instruction.",
          timestamp: Date.now(),
        },
        {
          id: "runtime-context",
          role: "system",
          content: runtimeContextPrompt,
          timestamp: Date.now(),
        },
      ]);
    }

    return saveDebugContextSnapshot({
      session,
      provider: {
        id: providerConfig?.id,
        type: providerConfig?.type,
        model: providerModel,
        supportsToolCalling,
      },
      currentItem: item,
      filteredMessages: messagesForApi,
      messagesWithContext,
      providerSystemPrompt,
      paperContextPrompt,
      runtimeContextPrompt,
      toolDefinitions,
    });
  }

  listPendingToolApprovals(sessionId?: string): ToolApprovalRequest[] {
    return getToolPermissionManager().listPendingApprovals(
      sessionId ?? this.currentSession?.id,
    );
  }

  resolveToolApprovalRequest(
    requestId: string,
    resolution: ToolApprovalResolution,
  ): ToolPermissionDecision | null {
    return getToolPermissionManager().resolveApprovalRequest(
      requestId,
      resolution,
    );
  }

  resolveUserInputRequest(
    requestId: string,
    response: RequestUserInputResponse,
  ): boolean {
    return this.agentRuntime.resolveUserInputRequest(requestId, response);
  }

  /**
   * 创建新 session
   */
  /**
   * Start a fresh conversation scoped to a set of papers (a collection or a
   * manual multi-item selection) and announce the scope in the transcript.
   */
  async startScopedSession(scope: SessionScope): Promise<ChatSession> {
    await this.init();

    const session = await this.createNewSession();
    session.scopeItemKeys = scope.itemKeys;
    session.scopeLabel = scope.label;
    await this.sessionStorage.updateSessionMeta(session);

    const papers = resolveScopedPapers(scope.itemKeys);
    const notice = getString("chat-scope-notice", {
      args: { label: scope.label, count: papers.length },
    });
    await this.insertSystemNotice(
      session,
      scope.truncated
        ? `${notice} ${getString("chat-scope-truncated", {
            args: { max: MAX_SCOPE_ITEMS },
          })}`
        : notice,
    );
    return session;
  }

  async createNewSession(): Promise<ChatSession> {
    await this.init();
    return this.enqueueSessionNavigation(() => this.createNewSessionLocked());
  }

  /**
   * Create and activate a fresh, user-visible conversation for one paper.
   * Unlike createNewSession(), this never reuses the current draft.
   */
  async createItemSession(
    itemKey: string,
    title: string,
    libraryID?: number,
  ): Promise<ChatSession> {
    await this.init();
    return this.enqueueSessionNavigation(async () => {
      const normalizedItemKey = itemKey.trim();
      const normalizedTitle = title.trim();
      if (!normalizedItemKey) {
        throw new Error("Cannot create a paper chat without an item key.");
      }
      if (!normalizedTitle) {
        throw new Error("Cannot create a paper chat without a title.");
      }

      const previousSession = this.currentSession;
      const sessionId = generateTimestampId();
      const now = Date.now();
      let session: ChatSession | null = null;

      try {
        session = await this.sessionStorage.createSession({
          sessionId,
          lastActiveItemKey: normalizedItemKey,
          lastActiveItemLibraryID: Number.isSafeInteger(libraryID)
            ? libraryID
            : undefined,
          title: normalizedTitle,
          titleSource: "user",
          titleEditedAt: now,
          activate: false,
        });
        await this.sessionStorage.setActiveSession(session.id);
      } catch (error) {
        if (session) {
          await this.sessionStorage
            .deleteSession(session.id)
            .catch(() => undefined);
        }
        throw error;
      }

      this.memoryManager.onBeforeSessionSwitch(previousSession, session.id);
      this.maybeGenerateSessionTitle(previousSession, session.id);
      this.currentSession = session;
      await this.sessionStorage.cleanupAbandonedDraftSessions();
      this.applySessionItemContext(session);
      this.reconcileApprovalState(session);
      this.reconcileUserInputRequestState(session);
      this.onMessageUpdate?.(session.messages);
      this.onExecutionPlanUpdate?.(session.executionPlan);
      this.notifySessionListUpdated();
      return session;
    });
  }

  private async createNewSessionLocked(): Promise<ChatSession> {
    const previousSession = this.currentSession;
    if (previousSession && this.isDraftSession(previousSession)) {
      await this.sessionStorage.cleanupAbandonedDraftSessions();
      return previousSession;
    }
    this.memoryManager.onBeforeSessionSwitch(previousSession, "");
    this.maybeGenerateSessionTitle(previousSession);
    this.currentSession = await this.sessionStorage.createSession();
    await this.sessionStorage.cleanupAbandonedDraftSessions();
    this.applySessionItemContext(this.currentSession);
    this.reconcileApprovalState(this.currentSession);
    this.reconcileUserInputRequestState(this.currentSession);
    return this.currentSession;
  }

  /**
   * Start a new session with the complete history through a completed AI
   * message. The source session remains untouched.
   */
  async forkCurrentSessionAtMessage(
    assistantMessageId: string,
  ): Promise<ChatSession> {
    await this.init();

    const sourceSession = this.currentSession;
    if (!sourceSession) {
      throw new Error("No active chat session to continue from.");
    }

    return this.enqueueSessionNavigation(async () => {
      const previousSession = this.currentSession;
      const forkedSessionId = generateTimestampId();
      const forkedMessages = cloneHistoryThroughAssistantMessage(
        sourceSession.messages,
        assistantMessageId,
        () => this.generateId(),
        {
          sourceSessionId: sourceSession.id,
          targetSessionId: forkedSessionId,
        },
      );
      const lastActiveItemKey = resolveForkItemKey(
        sourceSession.messages,
        assistantMessageId,
        sourceSession.lastActiveItemKey,
      );
      const forkArtifactIds = collectForkArtifactIds(forkedMessages);
      let forkedSession: ChatSession | null = null;
      try {
        await getSessionArtifactStore().copyArtifactsForFork(
          sourceSession.id,
          forkedSessionId,
          forkArtifactIds,
        );
        forkedSession = await this.sessionStorage.createSession({
          sessionId: forkedSessionId,
          messages: forkedMessages,
          lastActiveItemKey,
          lastActiveItemLibraryID: lastActiveItemKey
            ? sourceSession.lastActiveItemLibraryID
            : undefined,
          selectedTier: sourceSession.selectedTier,
          resolvedModelId: sourceSession.resolvedModelId,
          activate: false,
        });
        await this.sessionStorage.setActiveSession(forkedSession.id);
      } catch (error) {
        await Promise.allSettled([
          ...(forkedSession
            ? [this.sessionStorage.deleteSession(forkedSession.id)]
            : []),
          getSessionArtifactStore().deleteSessionArtifacts(forkedSessionId),
        ]);
        throw error;
      }

      this.memoryManager.onBeforeSessionSwitch(
        previousSession,
        forkedSession.id,
      );
      this.maybeGenerateSessionTitle(previousSession, forkedSession.id);
      this.currentSession = forkedSession;
      try {
        await this.sessionStorage.cleanupAbandonedDraftSessions();
      } catch (error) {
        ztoolkit.log(
          "[ChatManager] Failed to clean abandoned drafts after forking:",
          getErrorMessage(error),
        );
      }
      this.applySessionItemContext(forkedSession);
      this.reconcileApprovalState(forkedSession);
      this.reconcileUserInputRequestState(forkedSession);
      this.notifySessionListUpdated();

      return forkedSession;
    });
  }

  /**
   * 切换到指定 session
   */
  async switchSession(sessionId: string): Promise<ChatSession | null> {
    await this.init();
    return this.enqueueSessionNavigation(() =>
      this.switchSessionLocked(sessionId),
    );
  }

  private async switchSessionLocked(
    sessionId: string,
  ): Promise<ChatSession | null> {
    const previousSession = this.currentSession;
    // Trigger memory extraction for the session we're leaving
    this.memoryManager.onBeforeSessionSwitch(previousSession, sessionId);
    this.maybeGenerateSessionTitle(previousSession, sessionId);

    try {
      // If the target session is currently streaming, reuse its in-memory
      // object so that isSessionActive(sendingSession) returns true and
      // live streaming updates resume on the UI.
      const session =
        this.streamingSessions.get(sessionId) ??
        (await this.sessionStorage.loadSession(sessionId));

      if (session) {
        this.currentSession = session;
        await this.sessionStorage.setActiveSession(sessionId);
        this.applySessionItemContext(session);
        this.reconcileApprovalState(session);
        this.reconcileUserInputRequestState(session);
      }
      return session;
    } catch (error) {
      if (error instanceof SessionLoadError) {
        ztoolkit.log("[ChatManager] switchSession failed:", error.message);
        this.onError?.(error);
        return null;
      }
      throw error;
    }
  }

  /**
   * 删除 session
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.init();
    return this.enqueueSessionNavigation(() =>
      this.deleteSessionLocked(sessionId),
    );
  }

  private async deleteSessionLocked(sessionId: string): Promise<void> {
    const deletingCurrentSession = this.currentSession?.id === sessionId;

    // Durable delete first. If the storage delete throws, pending approvals
    // and session policies remain intact so the user can retry or recover —
    // denying them before the delete would leave approvals killed while the
    // session still exists on disk.
    await this.sessionStorage.deleteSession(sessionId);

    getToolPermissionManager().denyPendingApprovals({
      sessionId,
      reason:
        "Pending tool approvals were denied because the session was deleted.",
    });
    this.agentRuntime.cancelPendingUserInputRequests(sessionId);
    getToolPermissionManager().clearSessionPolicies(sessionId);
    getSessionArtifactStore()
      .deleteSessionArtifacts(sessionId)
      .catch((error) => {
        ztoolkit.log(
          "[ChatManager] Failed to delete session artifacts:",
          getErrorMessage(error),
        );
      });

    this.invalidateSessionRun(sessionId, { abort: true });
    if (deletingCurrentSession) {
      this.currentSession = null;
    }

    // 清理 ContextManager 中的相关状态
    getContextManager().onSessionDeleted(sessionId);

    // 如果删除的是当前 session，切换到最近的或创建新的
    if (deletingCurrentSession) {
      try {
        this.currentSession =
          await this.sessionStorage.getOrCreateActiveSession();
      } catch (error) {
        if (error instanceof MissingActiveSessionError) {
          ztoolkit.log(
            "[ChatManager] Replacement active session is missing after delete, creating a fresh session:",
            error.message,
          );
          await this.sessionStorage.setActiveSession(null);
          this.currentSession = await this.sessionStorage.createSession();
        } else if (error instanceof SessionLoadError) {
          ztoolkit.log(
            "[ChatManager] Replacement active session failed to load after delete, creating a fresh session:",
            error.message,
          );
          this.onError?.(
            new Error(
              `Failed to load the replacement chat session: ${error.message}`,
            ),
          );
          await this.sessionStorage.setActiveSession(null);
          this.currentSession = await this.sessionStorage.createSession();
        } else {
          throw error;
        }
      }
      this.reconcileApprovalState(this.currentSession);
      this.reconcileUserInputRequestState(this.currentSession);
    }

    this.applySessionItemContext(this.currentSession);
  }

  /**
   * 获取所有 session 列表
   */
  async getAllSessions(): Promise<SessionMeta[]> {
    await this.init();
    return this.sessionStorage.listSessions();
  }

  startSearchHistoryBackfill(): void {
    this.sessionStorage.startSearchBackfill();
  }

  async stopSearchHistoryBackfill(): Promise<void> {
    await this.sessionStorage.stopSearchBackfill();
  }

  async searchHistoryGroups(
    input: SearchHistoryGroupsRequest,
  ): Promise<ChatHistorySearchPage> {
    await this.init();
    return this.sessionStorage.searchHistoryGroups(input);
  }

  async searchHistorySessionMatches(
    input: SearchHistorySessionMatchesRequest,
  ): Promise<ChatHistoryMessagePage> {
    await this.init();
    return this.sessionStorage.searchHistorySessionMatches(input);
  }

  async updateSessionTitle(
    sessionId: string,
    title: string | null,
    source: "generated" | "user" = "user",
  ): Promise<void> {
    await this.init();
    const normalizedTitle = title?.trim() || null;
    await this.sessionStorage.updateSessionTitle(
      sessionId,
      normalizedTitle,
      source,
    );

    const session = this.getTrackedSessionById(sessionId);
    if (session) {
      session.title = normalizedTitle || undefined;
      session.titleSource =
        normalizedTitle || source === "user" ? source : undefined;
      const now = Date.now();
      session.titleGeneratedAt =
        normalizedTitle && source === "generated" ? now : undefined;
      session.titleEditedAt = source === "user" ? now : undefined;
    }
  }

  private maybeGenerateSessionTitle(
    session: ChatSession | null,
    nextSessionId?: string,
  ): void {
    if (!session || session.id === nextSessionId) {
      return;
    }
    if (!this.sessionTitleService.isEligible(session)) {
      return;
    }

    void this.sessionTitleService
      .generateTitle(session)
      .then(async (title) => {
        if (!title) {
          return;
        }
        const latestSession =
          this.getTrackedSessionById(session.id) ??
          (await this.sessionStorage.loadSession(session.id));
        if (!latestSession || latestSession.titleSource === "user") {
          return;
        }
        if (latestSession.title?.trim()) {
          return;
        }
        await this.updateSessionTitle(session.id, title, "generated");
        this.notifySessionListUpdated();
      })
      .catch((error) => {
        ztoolkit.log(
          "[ChatManager] Failed to persist generated session title:",
          getErrorMessage(error),
        );
      });
  }

  /**
   * 显示错误消息到聊天界面
   */
  async showErrorMessage(content: string): Promise<void> {
    if (!this.currentSession) {
      await this.init();
    }

    const errorMessage: ChatMessage = {
      id: this.generateId(),
      role: "error",
      content,
      timestamp: Date.now(),
    };
    this.currentSession!.messages.push(errorMessage);
    await this.sessionStorage.insertMessage(
      this.currentSession!.id,
      errorMessage,
    );
    this.onMessageUpdate?.(this.currentSession!.messages);
  }

  private paperChatTierController?: PaperChatTierController;

  /**
   * Lazily built so white-box tests that create managers via
   * Object.create(ChatManager.prototype) get a working controller: the
   * getter lives on the prototype and the host arrows read the manager's
   * fields at call time.
   */
  private get paperChatTier(): PaperChatTierController {
    if (!this.paperChatTierController) {
      this.paperChatTierController = new PaperChatTierController({
        init: () => this.init(),
        getCurrentSession: () => this.currentSession,
        getSessionStorage: () => this.sessionStorage,
        isSessionRunActive: (sessionId) =>
          this.activeSessionRunIds.has(sessionId),
        isRerollInProgress: (sessionId) =>
          this.paperChatRerollSessions.has(sessionId),
        beginReroll: (sessionId) => {
          this.paperChatRerollSessions.add(sessionId);
        },
        endReroll: (sessionId) => {
          this.paperChatRerollSessions.delete(sessionId);
        },
        rerollTier: () => this.rerollCurrentPaperChatTier(),
        buildReroutedNotice: (tier, previousModel, nextModel) =>
          this.paperChatRetry.buildReroutedNotice(
            tier,
            previousModel,
            nextModel,
          ),
        insertSystemNotice: (session, content) =>
          this.insertSystemNotice(session, content),
        sendMessage: (content, options) => this.sendMessage(content, options),
        getSessionItem: (session) => this.getSessionItem(session),
        notifyMessagesUpdated: (messages) => {
          this.onMessageUpdate?.(messages);
        },
      });
    }
    return this.paperChatTierController;
  }

  async rerollCurrentPaperChatTier(): Promise<PaperChatTierRerollResult | null> {
    return this.paperChatTier.rerollCurrentPaperChatTier();
  }

  async switchCurrentSessionPaperChatTier(
    tier: PaperChatTier,
    modelOverride?: string | null,
  ): Promise<void> {
    return this.paperChatTier.switchCurrentSessionPaperChatTier(
      tier,
      modelOverride,
    );
  }

  async clearCurrentSessionPaperChatRetryableState(): Promise<void> {
    return this.paperChatTier.clearCurrentSessionPaperChatRetryableState();
  }

  async retryCurrentPaperChatFailure(): Promise<boolean> {
    return this.paperChatTier.retryCurrentPaperChatFailure();
  }

  async retryFailedTurn(
    sessionId: string,
    errorMessageId: string,
  ): Promise<boolean> {
    await this.init();
    const session = this.currentSession;
    if (session?.id !== sessionId || this.activeSessionRunIds.has(sessionId)) {
      return false;
    }

    const errorIndex = session.messages.findIndex(
      (message) => message.id === errorMessageId && message.role === "error",
    );
    if (errorIndex < 0) return false;

    let userMessage: ChatMessage | undefined;
    let assistantMessage: ChatMessage | undefined;
    for (let index = errorIndex - 1; index >= 0; index--) {
      const message = session.messages[index];
      if (
        !assistantMessage &&
        message.role === "assistant" &&
        message.streamingState === "interrupted"
      ) {
        assistantMessage = message;
      }
      if (message.role === "user") {
        userMessage = message;
        break;
      }
    }
    if (!userMessage) return false;

    const accepted = await this.sendMessage(userMessage.content, {
      item: this.getSessionItem(session),
      images: userMessage.images,
      resumeFailedTurn: true,
      reuseUserMessageId: userMessage.id,
      reuseAssistantMessageId: assistantMessage?.id,
      targetSession: session,
      requireTargetSessionActive: true,
    });
    if (!accepted) return false;

    const errorMessage = session.messages.find(
      (message) => message.id === errorMessageId && message.role === "error",
    );
    if (errorMessage) {
      await this.sessionStorage.deleteMessage(session.id, errorMessage.id);
      session.messages.splice(session.messages.indexOf(errorMessage), 1);
      if (this.isSessionActive(session)) {
        this.onMessageUpdate?.(session.messages);
      }
    }
    return true;
  }

  async rerollCurrentPaperChatFailureAndRetry(): Promise<PaperChatTierRerollResult | null> {
    return this.paperChatTier.rerollCurrentPaperChatFailureAndRetry();
  }

  async applyPaperChatFailureState(
    session: ChatSession,
    userMessageId: string,
    errorMessage: ChatMessage,
    error: unknown,
    failedProviderId: string,
    failedModelId: string | null,
    allowRetry: boolean = true,
  ): Promise<void> {
    return this.paperChatTier.applyPaperChatFailureState(
      session,
      userMessageId,
      errorMessage,
      error,
      failedProviderId,
      failedModelId,
      allowRetry,
    );
  }

  private createFailedAssistantSnapshot(
    assistantMessage: ChatMessage,
  ): FailedAssistantSnapshot | null {
    return this.paperChatTier.createFailedAssistantSnapshot(assistantMessage);
  }

  private resetAssistantForRetry(assistantMessage: ChatMessage): void {
    this.paperChatTier.resetAssistantForRetry(assistantMessage);
  }

  private async finalizeFailedAssistantMessage(
    session: ChatSession,
    assistantMessage: ChatMessage,
    fallbackSnapshot: FailedAssistantSnapshot | null,
  ): Promise<boolean> {
    return this.paperChatTier.finalizeFailedAssistantMessage(
      session,
      assistantMessage,
      fallbackSnapshot,
    );
  }

  private async applyFailureStateSafely(
    session: ChatSession,
    userMessageId: string,
    errorMessage: ChatMessage,
    error: unknown,
    failedProviderId: string,
    failedModelId: string | null,
    allowRetry: boolean = true,
  ): Promise<void> {
    return this.paperChatTier.applyFailureStateSafely(
      session,
      userMessageId,
      errorMessage,
      error,
      failedProviderId,
      failedModelId,
      allowRetry,
    );
  }

  /**
   * 插入 item 切换的 system-notice 消息
   */
  private async insertItemSwitchNotice(
    newItemKey: string,
    newItemTitle: string,
    newItemLibraryID: number | undefined,
    session?: ChatSession,
  ): Promise<void> {
    const target = session ?? this.currentSession;
    if (!target) return;

    const notice: ChatMessage = {
      id: this.generateId(),
      role: "system",
      content: `--- Switched to paper: "${newItemTitle}" ---`,
      timestamp: Date.now(),
      isSystemNotice: true,
    };

    target.messages.push(notice);
    await this.sessionStorage.insertMessage(target.id, notice);
    target.lastActiveItemKey = newItemKey;
    target.lastActiveItemLibraryID = Number.isSafeInteger(newItemLibraryID)
      ? newItemLibraryID
      : undefined;
  }

  /**
   * 发送消息
   * @param content 消息内容
   * @param options 选项
   */
  async sendMessage(
    content: string,
    options: InternalSendMessageOptions = {},
  ): Promise<boolean> {
    await this.init();

    const requiredProviderManager = options.requiredProviderId
      ? getProviderManager()
      : null;
    const requiredProvider = options.requiredProviderId
      ? requiredProviderManager?.getProvider(options.requiredProviderId)
      : null;

    if (
      options.requiredProviderId &&
      (requiredProviderManager?.getActiveProviderId() !==
        options.requiredProviderId ||
        requiredProvider?.config.id !== options.requiredProviderId ||
        !requiredProvider.isReady())
    ) {
      return false;
    }

    if (
      options.presentationAuthorization &&
      (!hasValidPresentationAuthorization(
        options.presentationAuthorization,
        options.item,
      ) ||
        options.requiredProviderId !== "paperchat" ||
        !options.allowedToolNames ||
        options.allowedToolNames.length !== 1 ||
        options.allowedToolNames[0] !== "presentation")
    ) {
      return false;
    }

    const item = options.item;
    const hasCurrentItem = item !== null && item !== undefined && item.id !== 0;
    const itemKey = hasCurrentItem ? item!.key : null;
    const itemTitle = hasCurrentItem ? getItemTitleSmart(item!) : null;

    ztoolkit.log(
      "[ChatManager] sendMessage called, hasCurrentItem:",
      hasCurrentItem,
      "itemKey:",
      itemKey,
    );

    // 确保有 session
    if (!this.currentSession) {
      try {
        this.currentSession =
          await this.sessionStorage.getOrCreateActiveSession();
      } catch (error) {
        if (error instanceof MissingActiveSessionError) {
          ztoolkit.log(
            "[ChatManager] Active session is missing during send, creating a fresh session:",
            error.message,
          );
          await this.sessionStorage.setActiveSession(null);
          this.currentSession = await this.sessionStorage.createSession();
        } else if (error instanceof SessionLoadError) {
          ztoolkit.log(
            "[ChatManager] Active session failed to load during send, creating a fresh session:",
            error.message,
          );
          this.onError?.(
            new Error(
              `Failed to load the active chat session: ${error.message}`,
            ),
          );
          await this.sessionStorage.setActiveSession(null);
          this.currentSession = await this.sessionStorage.createSession();
        } else {
          throw error;
        }
      }
    }

    // Capture a stable reference to the session we're sending in.
    // This ensures DB writes and in-memory mutations target the correct
    // session even if the user switches sessions mid-stream.
    if (
      options.requireTargetSessionActive &&
      this.currentSession !== options.targetSession
    ) {
      return false;
    }
    const sendingSession = options.targetSession || this.currentSession;
    if (
      this.activeSessionRunIds.has(sendingSession.id) ||
      ((this.paperChatRerollSessions?.has(sendingSession.id) ?? false) &&
        !options.fromPaperChatReroll)
    ) {
      this.onError?.(new Error(getString("chat-turn-in-progress")));
      return false;
    }
    if (sendingSession.userInputRequestState?.pendingRequests.length) {
      this.onError?.(
        new Error("Please answer the pending PaperChat question first."),
      );
      return false;
    }
    const reusedUserMessage = options.reuseUserMessageId
      ? sendingSession.messages.find(
          (message) =>
            message.id === options.reuseUserMessageId &&
            message.role === "user",
        )
      : undefined;
    if (options.reuseUserMessageId && !reusedUserMessage) {
      return false;
    }
    const reusedAssistantMessage = options.reuseAssistantMessageId
      ? sendingSession.messages.find(
          (message) =>
            message.id === options.reuseAssistantMessageId &&
            message.role === "assistant" &&
            message.streamingState === "interrupted",
        )
      : undefined;
    if (options.reuseAssistantMessageId && !reusedAssistantMessage) {
      return false;
    }
    const reusedAssistantContext = reusedAssistantMessage
      ? createInterruptedAssistantContextMessage(reusedAssistantMessage)
      : null;
    const initialAssistantContent = reusedAssistantMessage?.content || "";
    const initialAssistantReasoning = reusedAssistantMessage?.reasoning;
    const { runId: sessionRunId, abortSignal } =
      this.beginSessionRun(sendingSession);
    const ensureSendingSessionTracked = () => {
      this.ensureTrackedRun(sendingSession, sessionRunId);
    };
    const chatStartedAt = Date.now();
    let chatProviderId = getProviderManager().getActiveProviderId();
    let chatCompletedTracked = false;
    const trackChatCompleted = (success: boolean) => {
      if (chatCompletedTracked) {
        return;
      }
      chatCompletedTracked = true;
      getAnalyticsService().track(ANALYTICS_EVENTS.chatCompleted, {
        provider: chatProviderId,
        success,
        duration_ms: Math.max(0, Date.now() - chatStartedAt),
      });
    };

    getAnalyticsService().track(ANALYTICS_EVENTS.chatSent, {
      provider: getProviderManager().getActiveProviderId(),
      has_item: hasCurrentItem,
      attach_pdf: !!options.attachPdf,
      image_count: options.images?.length || 0,
      file_count: options.files?.length || 0,
      has_selected_text: !!options.selectedText,
    });

    try {
      const itemLibraryID = hasCurrentItem
        ? Number.isSafeInteger(item!.libraryID)
          ? item!.libraryID
          : Zotero.Libraries.userLibraryID
        : null;
      const sessionItemLibraryID = sendingSession.lastActiveItemKey
        ? (sendingSession.lastActiveItemLibraryID ??
          Zotero.Libraries.userLibraryID)
        : null;
      const itemContextChanged =
        itemKey !== sendingSession.lastActiveItemKey ||
        (itemKey !== null && itemLibraryID !== sessionItemLibraryID);

      // 检查是否需要插入 item 切换通知。Zotero item key 只在单个
      // library 内唯一，因此同 key 跨个人库/群组库也必须视为切换。
      if (itemContextChanged) {
        if (hasCurrentItem) {
          // 切换到新 item
          await this.insertItemSwitchNotice(
            itemKey!,
            itemTitle!,
            itemLibraryID ?? undefined,
            sendingSession,
          );
        } else if (sendingSession.lastActiveItemKey !== null) {
          // 从有 item 切换到无 item
          const notice: ChatMessage = {
            id: this.generateId(),
            role: "system",
            content: `--- No paper selected ---`,
            timestamp: Date.now(),
            isSystemNotice: true,
          };
          sendingSession.messages.push(notice);
          await this.sessionStorage.insertMessage(sendingSession.id, notice);
          sendingSession.lastActiveItemKey = null;
          sendingSession.lastActiveItemLibraryID = undefined;
        }
      }

      // The reader can move independently from the chat session. Bind every
      // send to its explicit item so retrying an older failed turn cannot run
      // tools against the newly opened paper.
      this.currentItemKey = itemKey;
      this.currentItemLibraryID = itemLibraryID;
      getPdfToolManager().setCurrentItemKey(itemKey);

      // 获取活动的 AI 提供商
      const providerManager = getProviderManager();
      if (
        options.requiredProviderId &&
        providerManager.getActiveProviderId() !== options.requiredProviderId
      ) {
        trackChatCompleted(false);
        return false;
      }
      let provider = requiredProvider || this.getActiveProvider();
      chatProviderId = providerManager.getActiveProviderId();
      if (
        options.requiredProviderId &&
        (provider !== requiredProvider ||
          provider?.config.id !== options.requiredProviderId)
      ) {
        trackChatCompleted(false);
        return false;
      }
      ztoolkit.log(
        "[ChatManager] provider:",
        provider?.getName(),
        "isReady:",
        provider?.isReady(),
      );

      if (
        providerManager.getActiveProviderId() === "paperchat" &&
        provider?.config.type === "paperchat"
      ) {
        const resolvedModelId =
          await this.ensurePaperChatModelResolved(sendingSession);
        provider = new PaperChatProvider({
          ...provider.config,
          resolvedModelOverride: resolvedModelId,
          requestSessionId: sendingSession.id,
        });
      }

      if (!provider || !provider.isReady()) {
        ztoolkit.log("[ChatManager] Provider not ready, showing error in chat");
        if (options.fromPaperChatReroll) {
          trackChatCompleted(false);
          return false;
        }
        const errorMessage: ChatMessage = {
          id: this.generateId(),
          role: "assistant",
          content: getString(
            "chat-error-no-provider" as Parameters<typeof getString>[0],
          ),
          timestamp: Date.now(),
        };
        sendingSession.messages.push(errorMessage);
        await this.sessionStorage.insertMessage(
          sendingSession.id,
          errorMessage,
        );
        if (this.isSessionActive(sendingSession)) {
          this.onMessageUpdate?.(sendingSession.messages);
        }
        trackChatCompleted(false);
        return false;
      }

      // 构建最终消息内容
      let finalContent = content;

      // 处理选中文本
      if (options.selectedText) {
        const prefix = hasCurrentItem
          ? "[Selected text from PDF]"
          : "[Selected text]";
        finalContent = `${prefix}:\n"${options.selectedText}"\n\n[Question]:\n${content}`;
      }

      // PDF 附件相关
      let pdfAttachment:
        | { data: string; mimeType: string; name: string }
        | undefined;
      let pdfWasAttached = false;

      ztoolkit.log(
        "[Tool Calling] provider type:",
        provider?.constructor?.name,
      );
      ztoolkit.log(
        "[Tool Calling] providerSupportsToolCalling:",
        providerSupportsToolCalling(provider),
      );

      // 如果 provider 支持 tool calling，启用 tool calling 模式
      // 即使没有 PDF，也可以使用 library 工具（搜索、笔记等）
      const useToolCalling = providerSupportsToolCalling(provider);
      if (options.allowedToolNames?.length && !useToolCalling) {
        throw new Error(getString("chat-note-summary-tools-unavailable"));
      }

      if (useToolCalling) {
        // 如果有当前 item，尝试提取 PDF（用于 PDF 相关工具）
        if (hasCurrentItem && item && !options.noteSummaryContext) {
          const hasPdf = await this.pdfExtractor.hasPdfAttachment(item);
          ztoolkit.log("[PDF Auto-detect] Item has PDF:", hasPdf);

          if (hasPdf) {
            const pdfText = await this.pdfExtractor.extractPdfText(item);
            if (pdfText) {
              pdfWasAttached = true;
              ztoolkit.log("[PDF Auto-detect] PDF extracted for tool calling");
            } else {
              ztoolkit.log("[PDF Auto-detect] PDF text extraction failed");
              // 尝试原始 PDF 上传
              if (
                provider.supportsPdfUpload() &&
                getPref("uploadRawPdfOnFailure")
              ) {
                const pdfBase64 = await this.pdfExtractor.getPdfBase64(item);
                if (pdfBase64) {
                  pdfAttachment = pdfBase64;
                  pdfWasAttached = true;
                  ztoolkit.log(
                    "[PDF Auto-detect] Using raw PDF upload as fallback",
                  );
                }
              }
            }
          }
        }
      } else if (hasCurrentItem && item) {
        // Provider 不支持 tool calling，使用传统模式
        const hasPdf = await this.pdfExtractor.hasPdfAttachment(item);
        if (hasPdf) {
          const pdfText = await this.pdfExtractor.extractPdfText(item);
          if (pdfText) {
            pdfWasAttached = true;
            finalContent = `[PDF Content]:\n${pdfText.substring(0, 50000)}\n\n[Question]:\n${content}`;
            ztoolkit.log("[PDF Legacy] Embedded PDF content in message");
          }
        }
      }

      // 处理文件附件
      if (options.files && options.files.length > 0) {
        ztoolkit.log(
          "[File Attach] Processing",
          options.files.length,
          "file(s)",
        );
        const filesContent = options.files
          .map((f) => `[File: ${f.name}]\n${f.content}`)
          .join("\n\n");
        finalContent = `${filesContent}\n\n[Question]:\n${content}`;
      }

      // 创建用户消息
      const wasDraftSession = !reusedUserMessage
        ? this.isDraftSession(sendingSession)
        : false;
      const quotedMessages = normalizeQuotedMessageRefs(options.quotedMessages);
      const userMessage: ChatMessage = reusedUserMessage || {
        id: this.generateId(),
        role: "user",
        content: finalContent,
        images: options.images,
        files: options.files,
        quotedMessages: quotedMessages.length > 0 ? quotedMessages : undefined,
        timestamp: Date.now(),
        pdfContext: pdfWasAttached,
        selectedText: options.selectedText,
      };

      if (!reusedUserMessage) {
        sendingSession.messages.push(userMessage);
        await this.sessionStorage.insertMessage(sendingSession.id, userMessage);
      }
      clearPaperChatRetryableState(sendingSession);
      const reusedUserIndex = reusedUserMessage
        ? sendingSession.messages.findIndex(
            (message) => message.id === reusedUserMessage.id,
          )
        : -1;
      const requestContextSession =
        reusedUserMessage && !options.resumeFailedTurn
          ? {
              ...sendingSession,
              messages: sendingSession.messages.slice(0, reusedUserIndex + 1),
              contextState: sendingSession.contextState
                ? { ...sendingSession.contextState }
                : undefined,
            }
          : sendingSession;
      // Reply-summary actions send the selected reply as an isolated, ephemeral
      // user payload. The visible summary command remains in chat history, but
      // the original conversation is not duplicated in the model request.
      const apiRequestContextSession =
        options.modelRequestContent === undefined
          ? requestContextSession
          : {
              ...requestContextSession,
              messages: [
                {
                  ...userMessage,
                  content: options.modelRequestContent,
                },
              ],
              contextSummary: undefined,
              contextState: undefined,
            };
      sendingSession.updatedAt = Date.now();
      if (wasDraftSession) {
        this.notifySessionListUpdated();
      }
      if (this.isSessionActive(sendingSession)) {
        this.onMessageUpdate?.(sendingSession.messages);
      }

      const preRequestLoadingMessage: ChatMessage = {
        id: this.generateId(),
        role: "assistant",
        content: "",
        streamingState: "in_progress",
        timestamp: Date.now(),
      };
      sendingSession.messages.push(preRequestLoadingMessage);
      if (this.isSessionActive(sendingSession)) {
        this.onMessageUpdate?.(sendingSession.messages);
      }

      const contextManager = getContextManager();
      let contextCompacted = false;
      try {
        contextCompacted = await contextManager.compactBeforeSendIfNeeded(
          apiRequestContextSession,
          async () => {
            if (options.modelRequestContent !== undefined) {
              return;
            }
            if (requestContextSession !== sendingSession) {
              sendingSession.contextSummary =
                requestContextSession.contextSummary;
              sendingSession.contextState = requestContextSession.contextState;
            }
            await this.sessionStorage.updateSessionMeta(sendingSession);
          },
        );
      } finally {
        const loadingIndex = sendingSession.messages.findIndex(
          (message) => message.id === preRequestLoadingMessage.id,
        );
        if (loadingIndex >= 0) {
          sendingSession.messages.splice(loadingIndex, 1);
        }
      }
      if (contextCompacted) {
        await this.insertSystemNotice(
          sendingSession,
          "上下文已自动压缩，较早的聊天内容已合并为摘要。",
          { notify: false },
        );
      }

      // 创建 AI 消息占位
      const assistantMessage: ChatMessage = reusedAssistantMessage || {
        id: this.generateId(),
        role: "assistant",
        content: "",
        streamingState: "in_progress",
        timestamp: Date.now(),
        sourceItemKeys: (() => {
          const keys = normalizeSourceItemKeys(
            options.trustedSourceItemKeys === undefined
              ? itemKey && (useToolCalling || pdfWasAttached)
                ? [itemKey]
                : []
              : options.trustedSourceItemKeys,
          );
          return keys.length > 0 ? keys : undefined;
        })(),
      };

      if (reusedAssistantMessage) {
        assistantMessage.streamingState = "in_progress";
        assistantMessage.timestamp = Date.now();
        this.resetAssistantForRetry(assistantMessage);
        assistantMessage.content = initialAssistantContent;
        assistantMessage.reasoning = initialAssistantReasoning;
        await this.sessionStorage.updateMessageContent(
          sendingSession.id,
          assistantMessage.id,
          assistantMessage.content,
          assistantMessage.reasoning,
          {
            streamingState: "in_progress",
            presentationArtifacts: [],
          },
        );
      } else {
        sendingSession.messages.push(assistantMessage);
        await this.sessionStorage.insertMessage(
          sendingSession.id,
          assistantMessage,
        );
      }
      sendingSession.executionPlan = undefined;
      if (!options.resumeFailedTurn) {
        sendingSession.toolExecutionState = undefined;
      }
      sendingSession.toolApprovalState = undefined;
      await this.sessionStorage.updateSessionMeta(sendingSession);
      if (this.isSessionActive(sendingSession)) {
        this.onExecutionPlanUpdate?.(sendingSession.executionPlan);
      }
      if (this.isSessionActive(sendingSession)) {
        this.onMessageUpdate?.(sendingSession.messages);
      }
      if (!this.isSessionTracked(sendingSession, sessionRunId)) {
        return true;
      }

      const { messages: filteredMessages, summaryTriggered } =
        contextManager.filterMessages(apiRequestContextSession);

      // 从过滤后的消息中排除最后一条 (assistant 占位)
      const messagesWithoutPlaceholder = filteredMessages.filter(
        (message: ChatMessage) => message.id !== assistantMessage.id,
      );
      if (reusedAssistantContext) {
        messagesWithoutPlaceholder.push(reusedAssistantContext);
      }
      const messagesForApi = applyQuotedMessagesToModelRequest(
        messagesWithoutPlaceholder,
      );

      ztoolkit.log(
        "[API Request] Original message count:",
        sendingSession.messages.length,
      );
      ztoolkit.log(
        "[API Request] Filtered message count:",
        messagesForApi.length,
      );
      ztoolkit.log("[API Request] Use tool calling:", useToolCalling);

      // 如果启用 tool calling
      if (useToolCalling && providerSupportsToolCalling(provider)) {
        ztoolkit.log("[Tool Calling] Using tool calling mode");
        const toolCallingResult = await this.sendMessageWithToolCalling(
          provider,
          messagesForApi,
          assistantMessage,
          pdfWasAttached,
          summaryTriggered,
          hasCurrentItem,
          item!,
          sendingSession,
          sessionRunId,
          (providerId) => {
            chatProviderId = providerId;
          },
          options.resumeFailedTurn === true,
          abortSignal,
          options.allowedToolNames,
          options.allowPaperChatRetry !== false,
          options.noteSummaryContext,
          options.lockedToolItemKey,
          options.presentationAuthorization,
        );
        if (toolCallingResult !== null) {
          trackChatCompleted(toolCallingResult);
        }
        return true;
      }

      let failedProviderId = provider.config.id;
      let failedPaperChatModelId: string | null =
        provider.config.type === "paperchat"
          ? provider.config.resolvedModelOverride ||
            sendingSession.resolvedModelId ||
            null
          : null;
      let paperChatHardRerouteUsed = false;
      let latestFailedAssistantSnapshot: FailedAssistantSnapshot | null = null;

      const captureFailedAssistantSnapshot = () => {
        latestFailedAssistantSnapshot = selectMoreSubstantialSnapshot(
          this.createFailedAssistantSnapshot(assistantMessage),
          latestFailedAssistantSnapshot,
        );
      };
      const resetAssistantForAttempt = () => {
        this.resetAssistantForRetry(assistantMessage);
        if (reusedAssistantMessage) {
          assistantMessage.content = initialAssistantContent;
          assistantMessage.reasoning = initialAssistantReasoning;
        }
      };

      // 传统模式：流式调用（可恢复错误使用同一 Provider/模型重试）
      try {
        await providerManager.executeWithRetry(
          provider,
          async () => {
            const currentProvider = provider;
            chatProviderId = currentProvider.config.id;
            failedProviderId = currentProvider.config.id;

            ensureSendingSessionTracked();

            // 重试时清空当前显示，但保留最后一份非空输出供终态失败恢复。
            captureFailedAssistantSnapshot();
            resetAssistantForAttempt();

            let checkpointTimer: ReturnType<typeof setTimeout> | null = null;
            let checkpointQueue: Promise<void> = Promise.resolve();

            const enqueueCheckpoint = (
              streamingState: ChatMessageStreamingState | null,
            ): Promise<void> => {
              if (!this.isSessionTracked(sendingSession, sessionRunId)) {
                return checkpointQueue;
              }
              checkpointQueue = checkpointQueue
                .catch(() => undefined)
                .then(async () => {
                  if (!this.isSessionTracked(sendingSession, sessionRunId)) {
                    return;
                  }
                  const sanitizedCheckpoint = sanitizeEvidenceReferences(
                    assistantMessage.content,
                    [],
                  );
                  await this.sessionStorage.updateMessageContent(
                    sendingSession.id,
                    assistantMessage.id,
                    sanitizedCheckpoint.content,
                    assistantMessage.reasoning,
                    {
                      streamingState,
                      evidence: [],
                      sourceItemKeys: assistantMessage.sourceItemKeys || [],
                    },
                  );
                });
              return checkpointQueue;
            };

            const scheduleCheckpoint = (): void => {
              if (!this.isSessionTracked(sendingSession, sessionRunId)) {
                return;
              }
              if (checkpointTimer) {
                return;
              }
              checkpointTimer = setTimeout(() => {
                checkpointTimer = null;
                if (!this.isSessionTracked(sendingSession, sessionRunId)) {
                  return;
                }
                void enqueueCheckpoint("in_progress");
              }, 1000);
            };

            const flushCheckpoint = async (
              streamingState: ChatMessageStreamingState | null,
            ): Promise<void> => {
              if (checkpointTimer) {
                clearTimeout(checkpointTimer);
                checkpointTimer = null;
              }
              if (!this.isSessionTracked(sendingSession, sessionRunId)) {
                return;
              }
              await enqueueCheckpoint(streamingState);
            };

            const streamCurrentProvider = () =>
              new Promise<void>((resolve, reject) => {
                const callbacks: StreamCallbacks = {
                  onChunk: (chunk: string) => {
                    if (!this.isSessionTracked(sendingSession, sessionRunId)) {
                      return;
                    }
                    assistantMessage.content += chunk;
                    scheduleCheckpoint();
                    if (this.isSessionActive(sendingSession)) {
                      this.onStreamingUpdate?.(
                        assistantMessage.content,
                        assistantMessage.id,
                      );
                    }
                  },
                  onReasoningChunk: (chunk: string) => {
                    if (!this.isSessionTracked(sendingSession, sessionRunId)) {
                      return;
                    }
                    assistantMessage.reasoning =
                      (assistantMessage.reasoning || "") + chunk;
                    scheduleCheckpoint();
                    if (this.isSessionActive(sendingSession)) {
                      this.onReasoningUpdate?.(
                        assistantMessage.reasoning,
                        assistantMessage.id,
                      );
                    }
                  },
                  onComplete: async (fullContent: string) => {
                    if (!this.isSessionTracked(sendingSession, sessionRunId)) {
                      if (checkpointTimer) {
                        clearTimeout(checkpointTimer);
                        checkpointTimer = null;
                      }
                      resolve();
                      return;
                    }
                    assistantMessage.content = sanitizeEvidenceReferences(
                      sanitizeSourceGroupTargets(
                        initialAssistantContent + fullContent,
                        collectTrustedSourceTargets([]),
                      ),
                      [],
                    ).content;
                    assistantMessage.evidence = undefined;
                    assistantMessage.streamingState = undefined;
                    assistantMessage.timestamp = Date.now();
                    sendingSession.updatedAt = Date.now();
                    clearPaperChatRetryableState(sendingSession);

                    // Clean up empty reasoning
                    if (!assistantMessage.reasoning) {
                      delete assistantMessage.reasoning;
                    }

                    await flushCheckpoint(null);
                    await this.sessionStorage.updateSessionMeta(sendingSession);
                    if (this.isSessionActive(sendingSession)) {
                      this.onMessageUpdate?.(sendingSession.messages);

                      if (pdfWasAttached) {
                        this.onPdfAttached?.();
                      }
                      this.onMessageComplete?.();
                    }

                    // 异步触发摘要生成（不阻塞主流程）
                    if (summaryTriggered) {
                      contextManager
                        .generateSummaryAsync(sendingSession, async () => {
                          ensureSendingSessionTracked();
                          await this.sessionStorage.updateSessionMeta(
                            sendingSession,
                          );
                        })
                        .catch((err: unknown) => {
                          ztoolkit.log(
                            "[ChatManager] Summary generation failed:",
                            err,
                          );
                        });
                    }

                    resolve();
                  },
                  onError: async (error: Error) => {
                    ztoolkit.log("[API Error]", error.message);
                    if (checkpointTimer) {
                      clearTimeout(checkpointTimer);
                      checkpointTimer = null;
                    }
                    if (!this.isSessionTracked(sendingSession, sessionRunId)) {
                      resolve();
                      return;
                    }

                    // Reject so the same-provider retry policy can decide whether to replay.
                    reject(error);
                  },
                };

                currentProvider.streamChatCompletion(
                  messagesForApi,
                  callbacks,
                  pdfAttachment,
                  abortSignal,
                );
              });

            try {
              return await streamCurrentProvider();
            } catch (error) {
              await checkpointQueue.catch(() => undefined);
              captureFailedAssistantSnapshot();
              const reroute =
                await this.paperChatRetry.reroutePaperChatSessionForHardFailure(
                  {
                    session: sendingSession,
                    provider: currentProvider,
                    error,
                    failedModelId: failedPaperChatModelId,
                    alreadyRerouted: paperChatHardRerouteUsed,
                    reason: "streaming",
                    ensureSessionTracked: ensureSendingSessionTracked,
                  },
                );
              if (!reroute) {
                throw error;
              }

              paperChatHardRerouteUsed = true;
              failedPaperChatModelId = reroute.nextModel;
              resetAssistantForAttempt();
              try {
                return await streamCurrentProvider();
              } catch (reroutedError) {
                await checkpointQueue.catch(() => undefined);
                captureFailedAssistantSnapshot();
                throw reroutedError;
              }
            }
          },
          this.createProviderRetryOptions(abortSignal),
        );

        trackChatCompleted(true);
        return true;
      } catch (error) {
        if (error instanceof SessionRunInvalidatedError) {
          return true;
        }
        if (
          isAbortError(error) &&
          !this.isSessionTracked(sendingSession, sessionRunId)
        ) {
          return true;
        }
        ztoolkit.log(
          "[ChatManager] Provider request failed after retries:",
          error,
        );

        await this.finalizeFailedAssistantMessage(
          sendingSession,
          assistantMessage,
          latestFailedAssistantSnapshot,
        );

        const errorMessage: ChatMessage = {
          id: this.generateId(),
          role: "error",
          content: getErrorMessage(error),
          timestamp: Date.now(),
        };

        await this.applyFailureStateSafely(
          sendingSession,
          userMessage.id,
          errorMessage,
          error,
          failedProviderId,
          failedProviderId === "paperchat"
            ? failedPaperChatModelId || sendingSession.resolvedModelId || null
            : null,
        );

        sendingSession.messages.push(errorMessage);
        await this.sessionStorage.insertMessage(
          sendingSession.id,
          errorMessage,
        );
        await this.sessionStorage.updateSessionMeta(sendingSession);

        if (this.isSessionActive(sendingSession)) {
          this.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
          this.onMessageUpdate?.(sendingSession.messages);
        }

        // The user message has already been persisted into the session.
        // Return success here so the UI clears the input instead of restoring
        // a draft that now duplicates the visible chat history.
        trackChatCompleted(false);
        return true;
      }
    } catch (error) {
      trackChatCompleted(false);
      throw error;
    } finally {
      this.completeSessionRun(sendingSession, sessionRunId);
    }
  }

  /**
   * 使用 Tool Calling 发送消息
   * 优先使用 provider 支持的流式模式，否则使用非流式模式。
   * 每次模型请求独立重试，已完成的工具结果保留在当前上下文中。
   */
  private async sendMessageWithToolCalling(
    _provider: ToolCallingProvider,
    messagesForApi: ChatMessage[],
    assistantMessage: ChatMessage,
    pdfWasAttached: boolean,
    summaryTriggered: boolean,
    hasCurrentItem: boolean,
    item: Zotero.Item,
    sendingSession: ChatSession,
    sessionRunId: number,
    onProviderUsed: (providerId: string) => void,
    preserveToolExecutionState: boolean,
    abortSignal?: AbortSignal,
    allowedToolNames?: readonly string[],
    allowPaperChatRetry: boolean = true,
    noteSummaryContext?: NoteSummaryContext,
    lockedToolItemKey?: string,
    presentationAuthorization?: PresentationLaunchAuthorization,
  ): Promise<boolean | null> {
    const pdfToolManager = getPdfToolManager();
    const providerManager = getProviderManager();
    const ensureSendingSessionTracked = () => {
      this.ensureTrackedRun(sendingSession, sessionRunId);
    };

    let searchScopeGateEnabled = false;
    let selectedSearchScope = preserveToolExecutionState
      ? findCompletedSearchScope(
          sendingSession.toolExecutionState?.results || [],
        )
      : undefined;
    const allowedToolNameSet = allowedToolNames
      ? new Set(allowedToolNames)
      : null;
    const buildToolsForCurrentSearchScope = (
      provider: AIProvider | null | undefined,
    ): ToolDefinition[] => {
      // An explicit allowlist is an exact request boundary. Do not inject the
      // search-scope gate or any other tool that the caller did not authorize.
      searchScopeGateEnabled =
        allowedToolNameSet === null &&
        provider?.supportsHostedWebSearch?.() === true;
      const scopedTools = this.getToolDefinitionsForProvider(
        provider,
        hasCurrentItem,
        selectedSearchScope,
        { includePresentation: !!presentationAuthorization },
      );
      const allowedTools = allowedToolNameSet
        ? scopedTools.filter((tool) =>
            allowedToolNameSet.has(tool.function.name),
          )
        : scopedTools;
      return searchScopeGateEnabled && !selectedSearchScope
        ? createPendingSearchScopeTools(allowedTools)
        : allowedTools;
    };
    const tools = buildToolsForCurrentSearchScope(_provider);
    const getStableSearchToolMode = (): SearchToolPromptMode =>
      searchScopeGateEnabled ? "gated" : getSearchToolPromptMode(tools);
    const includeFullChatContext = !noteSummaryContext;
    const hasPromptPaperContext = hasCurrentItem && includeFullChatContext;

    // 实时提取论文结构
    const paperStructure = hasPromptPaperContext
      ? await pdfToolManager.extractAndParsePaper(
          item.key,
          false,
          item.libraryID,
        )
      : undefined;
    ensureSendingSessionTracked();

    // Search for relevant memories using the last user message as query
    const lastUserMessage = messagesForApi
      .filter((m) => m.role === "user")
      .at(-1);
    const memoryContext = includeFullChatContext
      ? await this.memoryManager.buildPromptContext(lastUserMessage?.content)
      : "";
    const selectedSkills = includeFullChatContext
      ? await this.selectWorkflowSkills({
          lastUserMessage,
          item: hasCurrentItem ? item : undefined,
        })
      : [];
    ensureSendingSessionTracked();

    // Keep the large stable paper/tool instructions at the start of the request,
    // and keep changing runtime state at the end so prompt-cache prefixes survive.
    const buildRuntimeSystemPrompt = (
      _currentMessages: ChatMessage[],
      _session?: ChatSession,
      runtimeState?: {
        currentIteration?: number;
        remainingIterations?: number;
        maxIterations: number;
        forceFinalAnswer: boolean;
      },
    ) => {
      const prompt = this.buildToolCallingRuntimeSystemPrompt({
        memoryContext,
        selectedSkills,
        searchScope: selectedSearchScope,
        searchToolMode: getSearchToolPromptMode(
          tools,
          searchScopeGateEnabled && !selectedSearchScope,
        ),
        sendingSession,
        runtimeState,
      });
      return noteSummaryContext
        ? `${prompt}\n\n${buildNoteSummaryRuntimeInstruction(noteSummaryContext)}`
        : prompt;
    };

    let paperContextPrompt = this.buildToolCallingStableSystemPrompt({
      paperStructure,
      hasCurrentItem: hasPromptPaperContext,
      item: hasPromptPaperContext ? item : undefined,
      searchToolMode: getStableSearchToolMode(),
    });
    const runtimeContextPrompt = buildRuntimeSystemPrompt(
      messagesForApi,
      sendingSession,
      {
        maxIterations: normalizeAgentMaxPlanningIterations(
          getPref("agentMaxPlanningIterations") as number | undefined,
        ),
        forceFinalAnswer: false,
      },
    );

    const messagesWithContext: ChatMessage[] = [
      {
        id: "paper-context",
        role: "system",
        content: paperContextPrompt,
        timestamp: Date.now(),
      },
      ...messagesForApi,
      {
        id: "cache-checkpoint",
        role: "system",
        content:
          "Prompt cache checkpoint. This is not user content or an instruction.",
        timestamp: Date.now(),
      },
      {
        id: "runtime-context",
        role: "system",
        content: runtimeContextPrompt,
        timestamp: Date.now(),
      },
    ];

    // Tool calling retries each failed model request in place so completed tool
    // results remain in currentMessages and are never executed a second time.
    const currentProvider = _provider as AIProvider & ToolCallingProvider;
    const failedProviderId = currentProvider.config.id;
    let failedPaperChatModelId: string | null =
      currentProvider.config.type === "paperchat"
        ? currentProvider.config.resolvedModelOverride ||
          sendingSession.resolvedModelId ||
          null
        : null;
    let paperChatHardRerouteUsed = false;

    try {
      onProviderUsed(currentProvider.config.id);
      if (
        currentProvider.config.id === "paperchat" &&
        !failedPaperChatModelId
      ) {
        failedPaperChatModelId = await this.ensurePaperChatModelResolved(
          sendingSession,
          false,
        );
        currentProvider.updateConfig({
          resolvedModelOverride: failedPaperChatModelId,
        });
      }
      ensureSendingSessionTracked();

      if (!preserveToolExecutionState) {
        removeApiOnlyModelContextMessagesForTurn(
          sendingSession,
          assistantMessage.id,
        );
      }
      const attemptMessagesWithContext = messagesWithContext.map((message) => ({
        ...message,
      }));
      // Tracks the runtime state of the most recent prompt build so a
      // mid-iteration reroute resync does not drop iteration/final-answer info.
      let latestRuntimeState:
        | {
            currentIteration?: number;
            remainingIterations?: number;
            maxIterations: number;
            forceFinalAnswer: boolean;
          }
        | undefined = {
        maxIterations: normalizeAgentMaxPlanningIterations(
          getPref("agentMaxPlanningIterations") as number | undefined,
        ),
        forceFinalAnswer: false,
      };
      const refreshSearchToolsForCurrentModel = (
        refreshStablePrompt: boolean = true,
      ) => {
        const nextTools = buildToolsForCurrentSearchScope(currentProvider);
        tools.splice(0, tools.length, ...nextTools);
        if (refreshStablePrompt) {
          paperContextPrompt = this.buildToolCallingStableSystemPrompt({
            paperStructure,
            hasCurrentItem: hasPromptPaperContext,
            item: hasPromptPaperContext ? item : undefined,
            searchToolMode: getStableSearchToolMode(),
          });
        }
      };
      const syncModelSpecificRequestContext = () => {
        const isDeepSeek = isDeepSeekToolPromptCacheTarget(
          currentProvider,
          failedPaperChatModelId || sendingSession.resolvedModelId,
        );
        const useStableDeepSeekCatalog = isDeepSeek && !searchScopeGateEnabled;
        const paperContextMessage = attemptMessagesWithContext.find(
          (message) => message.id === "paper-context",
        );
        if (paperContextMessage) {
          paperContextMessage.content = useStableDeepSeekCatalog
            ? `${paperContextPrompt}\n\n${buildStableToolCatalogForPromptCache(tools)}`
            : paperContextPrompt;
        }
        for (
          let index = attemptMessagesWithContext.length - 1;
          index >= 0;
          index--
        ) {
          if (
            attemptMessagesWithContext[index].id === "cache-checkpoint" ||
            attemptMessagesWithContext[index].id === "runtime-context"
          ) {
            attemptMessagesWithContext.splice(index, 1);
          }
        }
        if (!useStableDeepSeekCatalog) {
          attemptMessagesWithContext.push(
            {
              id: "cache-checkpoint",
              role: "system",
              content:
                "Prompt cache checkpoint. This is not user content or an instruction.",
              timestamp: Date.now(),
            },
            {
              id: "runtime-context",
              role: "system",
              content: buildRuntimeSystemPrompt(
                attemptMessagesWithContext,
                sendingSession,
                latestRuntimeState,
              ),
              timestamp: Date.now(),
            },
          );
        } else if (noteSummaryContext) {
          // DeepSeek keeps the large tool catalog in the stable prefix, but a
          // note-summary action still needs its changing destination and
          // noteCreated state on every model round.
          attemptMessagesWithContext.push(
            {
              id: "cache-checkpoint",
              role: "system",
              content:
                "Prompt cache checkpoint. This is not user content or an instruction.",
              timestamp: Date.now(),
            },
            {
              id: "runtime-context",
              role: "system",
              content: buildRuntimeSystemPrompt(
                attemptMessagesWithContext,
                sendingSession,
                latestRuntimeState,
              ),
              timestamp: Date.now(),
            },
          );
        }
      };
      syncModelSpecificRequestContext();
      const searchScopeGate: SearchScopeGateConfig = {
        onScopeSelected: (scope) => {
          selectedSearchScope = scope;
          refreshSearchToolsForCurrentModel();
          syncModelSpecificRequestContext();
        },
      };
      const runtimePromptBuilder = (
        currentMessages: ChatMessage[],
        session: ChatSession,
        runtimeState?: {
          currentIteration?: number;
          remainingIterations?: number;
          maxIterations: number;
          forceFinalAnswer: boolean;
        },
      ) => {
        latestRuntimeState = runtimeState ?? latestRuntimeState;
        return isDeepSeekToolPromptCacheTarget(
          currentProvider,
          failedPaperChatModelId || sendingSession.resolvedModelId,
        ) &&
          !searchScopeGateEnabled &&
          !noteSummaryContext
          ? null
          : buildRuntimeSystemPrompt(currentMessages, session, runtimeState);
      };

      const executeProviderRequest = async <T>(
        operation: () => Promise<T>,
        onProviderRerouted?: () => void,
      ): Promise<T> => {
        const runOperationWithHostedSearchGuard = async (): Promise<T> => {
          ensureSendingSessionTracked();
          const hostedSearchesBeforeAttempt = countHostedWebSearchResults(
            sendingSession.toolExecutionState?.results || [],
          );
          try {
            return await operation();
          } catch (error) {
            const hostedSearchesAfterAttempt = countHostedWebSearchResults(
              sendingSession.toolExecutionState?.results || [],
            );
            if (hostedSearchesAfterAttempt > hostedSearchesBeforeAttempt) {
              const guardedError = (
                error instanceof Error ? error : new Error(String(error))
              ) as RetryGuardedError;
              guardedError[SUPPRESS_AUTOMATIC_RETRY] = true;
              throw guardedError;
            }
            throw error;
          }
        };

        return providerManager.executeWithRetry(
          currentProvider,
          async () => {
            try {
              return await runOperationWithHostedSearchGuard();
            } catch (error) {
              if (
                error instanceof Error &&
                (error as RetryGuardedError)[SUPPRESS_AUTOMATIC_RETRY] === true
              ) {
                throw error;
              }
              const reroute =
                await this.paperChatRetry.reroutePaperChatSessionForHardFailure(
                  {
                    session: sendingSession,
                    provider: currentProvider,
                    error,
                    failedModelId: failedPaperChatModelId,
                    alreadyRerouted: paperChatHardRerouteUsed,
                    reason: "tool_calling",
                    ensureSessionTracked: ensureSendingSessionTracked,
                  },
                );
              if (!reroute) {
                throw error;
              }

              paperChatHardRerouteUsed = true;
              failedPaperChatModelId = reroute.nextModel;
              refreshSearchToolsForCurrentModel();
              syncModelSpecificRequestContext();
              onProviderRerouted?.();
              return runOperationWithHostedSearchGuard();
            }
          },
          this.createProviderRetryOptions(abortSignal),
        );
      };

      if (providerSupportsStreamingToolCalling(currentProvider)) {
        ztoolkit.log(
          `[Tool Calling] Using streaming mode with ${currentProvider.getName()}`,
        );
        await this.sendMessageWithStreamingToolCalling(
          currentProvider,
          attemptMessagesWithContext,
          assistantMessage,
          pdfWasAttached,
          summaryTriggered,
          tools,
          paperStructure,
          item?.libraryID ?? this.currentItemLibraryID ?? undefined,
          sendingSession,
          sessionRunId,
          runtimePromptBuilder,
          executeProviderRequest,
          preserveToolExecutionState,
          lockedToolItemKey,
          noteSummaryContext,
          searchScopeGate,
          abortSignal,
          presentationAuthorization,
        );
      } else {
        ztoolkit.log(
          `[Tool Calling] Using non-streaming mode with ${currentProvider.getName()}`,
        );
        await this.sendMessageWithNonStreamingToolCalling(
          currentProvider,
          attemptMessagesWithContext,
          assistantMessage,
          pdfWasAttached,
          summaryTriggered,
          tools,
          paperStructure,
          item?.libraryID ?? this.currentItemLibraryID ?? undefined,
          sendingSession,
          sessionRunId,
          runtimePromptBuilder,
          executeProviderRequest,
          preserveToolExecutionState,
          lockedToolItemKey,
          noteSummaryContext,
          searchScopeGate,
          abortSignal,
          presentationAuthorization,
        );
      }

      return true;
    } catch (error) {
      if (error instanceof SessionRunInvalidatedError) {
        return null;
      }
      if (
        isAbortError(error) &&
        !this.isSessionTracked(sendingSession, sessionRunId)
      ) {
        return null;
      }
      ztoolkit.log("[Tool Calling] Model request failed after retries:", error);

      await this.finalizeFailedAssistantMessage(
        sendingSession,
        assistantMessage,
        null,
      );

      const errorMessage: ChatMessage = {
        id: this.generateId(),
        role: "error",
        content: getErrorMessage(error),
        timestamp: Date.now(),
      };
      await this.applyFailureStateSafely(
        sendingSession,
        messagesForApi.filter((m) => m.role === "user").at(-1)?.id || "",
        errorMessage,
        error,
        failedProviderId,
        failedProviderId === "paperchat"
          ? failedPaperChatModelId || sendingSession.resolvedModelId || null
          : null,
        allowPaperChatRetry,
      );
      sendingSession.messages.push(errorMessage);
      await this.sessionStorage.insertMessage(sendingSession.id, errorMessage);
      await this.sessionStorage.updateSessionMeta(sendingSession);

      if (this.isSessionActive(sendingSession)) {
        this.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
        this.onMessageUpdate?.(sendingSession.messages);
      }

      // The user message has already been persisted into the session.
      // Keep tool-calling failure semantics aligned with the non-tool path so
      // the UI does not treat this as an unaccepted draft.
      return false;
    }
  }

  /**
   * 转义 XML 特殊字符，防止 XSS/XML 注入
   */
  private escapeXml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  /**
   * 格式化工具调用卡片（用于 UI 显示）
   */
  private formatToolCallCard(
    toolName: string,
    args: string,
    status: "calling" | "completed" | "error",
    resultPreview?: string,
    options?: {
      expandStateId?: string;
      resultPreviewMaxLength?: number;
      showResultWhileCalling?: boolean;
      presentationArtifact?: PresentationToolCardArtifact;
    },
  ): string {
    const statusIcon =
      status === "calling" ? "⏳" : status === "completed" ? "✓" : "✗";
    const statusText =
      status === "calling"
        ? getString("tool-status-calling")
        : status === "completed"
          ? getString("tool-status-done")
          : getString("tool-status-error");

    // 解析参数用于显示
    let argsDisplay = "";
    try {
      const parsed = JSON.parse(args);
      argsDisplay = Object.entries(parsed)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ");
      if (argsDisplay.length > 60) {
        argsDisplay = argsDisplay.substring(0, 57) + "...";
      }
    } catch {
      argsDisplay = args.length > 60 ? args.substring(0, 57) + "..." : args;
    }

    // 转义所有用户输入，防止 XSS/XML 注入
    const escapedToolName = this.escapeXml(toolName);
    const escapedArgs = this.escapeXml(argsDisplay);
    const escapedExpandStateId = options?.expandStateId
      ? this.escapeXml(options.expandStateId)
      : "";
    const resultPreviewMaxLength = options?.resultPreviewMaxLength ?? 100;
    const escapedResult = resultPreview
      ? this.escapeXml(
          resultPreview.length > resultPreviewMaxLength
            ? resultPreview.substring(0, resultPreviewMaxLength - 3) + "..."
            : resultPreview,
        )
      : "";
    const artifact = options?.presentationArtifact;
    const escapedArtifactPath = artifact?.path
      ? this.escapeXml(artifact.path)
      : "";
    const escapedPreviewPaths = (artifact?.previewPaths || [])
      .filter(
        (path): path is string => typeof path === "string" && path.length > 0,
      )
      .slice(0, 6)
      .map((path) => this.escapeXml(path));
    const escapedAttachmentItemID = Number.isSafeInteger(
      artifact?.attachmentItemID,
    )
      ? String(artifact?.attachmentItemID)
      : "";
    const escapedArtifactToolCallId = artifact?.toolCallId
      ? this.escapeXml(artifact.toolCallId)
      : "";

    // 使用特殊标记格式，便于 MessageRenderer 识别和渲染
    let card = `\n<tool-call status="${status}"${
      escapedExpandStateId ? ` expand-key="${escapedExpandStateId}"` : ""
    }>\n`;
    card += `<tool-name>${statusIcon} ${escapedToolName}</tool-name>\n`;
    if (escapedArgs) {
      card += `<tool-args>${escapedArgs}</tool-args>\n`;
    }
    card += `<tool-status>${statusText}</tool-status>\n`;
    if (
      escapedResult &&
      (status !== "calling" || options?.showResultWhileCalling)
    ) {
      card += `<tool-result>${escapedResult}</tool-result>\n`;
    }
    if (
      escapedArtifactToolCallId &&
      (escapedArtifactPath || escapedPreviewPaths.length > 0)
    ) {
      card += `<presentation-artifact${` tool-call-id="${escapedArtifactToolCallId}"`}${
        escapedArtifactPath ? ` path="${escapedArtifactPath}"` : ""
      }${
        escapedAttachmentItemID
          ? ` attachment-item-id="${escapedAttachmentItemID}"`
          : ""
      } draft="${artifact?.isDraft ? "true" : "false"}">\n`;
      for (const previewPath of escapedPreviewPaths) {
        card += `<presentation-preview path="${previewPath}"/>\n`;
      }
      card += `</presentation-artifact>\n`;
    }
    card += `</tool-call>\n`;

    return card;
  }

  private stripPendingToolCallCards(content: string): string {
    return stripPendingAndIncompleteToolCallContent(content);
  }

  private hasPendingToolCallCards(content: string): boolean {
    return /<tool-call status="calling">[\s\S]*?<\/tool-call>/.test(content);
  }

  /**
   * 流式 Tool Calling - 边输出边调用工具
   * 实现类似 Claude Code 的效果：实时显示文本和工具调用状态
   */
  private async sendMessageWithStreamingToolCalling(
    provider: ToolCallingProvider & {
      streamChatCompletionWithTools: NonNullable<
        ToolCallingProvider["streamChatCompletionWithTools"]
      >;
    },
    currentMessages: ChatMessage[],
    assistantMessage: ChatMessage,
    pdfWasAttached: boolean,
    summaryTriggered: boolean,
    tools: ToolDefinition[],
    paperStructure: Awaited<
      ReturnType<typeof getPdfToolManager.prototype.extractAndParsePaper>
    >,
    currentItemLibraryID: number | undefined,
    sendingSession: ChatSession,
    sessionRunId: number,
    buildSystemPrompt:
      | ((
          currentMessages: ChatMessage[],
          session: ChatSession,
          runtimeState?: {
            currentIteration?: number;
            remainingIterations?: number;
            maxIterations: number;
            forceFinalAnswer: boolean;
          },
        ) => string | null)
      | undefined,
    executeProviderRequest: <T>(
      operation: () => Promise<T>,
      onProviderRerouted?: () => void,
    ) => Promise<T>,
    preserveToolExecutionState: boolean,
    lockedToolItemKey?: string,
    noteSummaryContext?: NoteSummaryContext,
    searchScopeGate?: SearchScopeGateConfig,
    abortSignal?: AbortSignal,
    presentationAuthorization?: PresentationLaunchAuthorization,
  ): Promise<void> {
    await this.agentRuntime.executeStreamingToolLoop({
      provider,
      currentMessages,
      assistantMessage,
      pdfWasAttached,
      summaryTriggered,
      tools,
      paperStructure,
      sendingSession,
      currentItemKey: sendingSession.lastActiveItemKey,
      currentItemLibraryID,
      sessionRunId,
      abortSignal,
      executeProviderRequest,
      preserveToolExecutionState,
      lockedToolItemKey,
      noteSummaryContext,
      searchScopeGate,
      refreshSystemPrompt: buildSystemPrompt,
      presentationAuthorization,
    });
    clearPaperChatRetryableState(sendingSession);
    await this.sessionStorage.updateSessionMeta(sendingSession);
  }

  /**
   * 非流式 Tool Calling - 等待完整响应后再继续
   * 使用与流式相同的累积显示逻辑
   */
  private async sendMessageWithNonStreamingToolCalling(
    provider: ToolCallingProvider,
    currentMessages: ChatMessage[],
    assistantMessage: ChatMessage,
    pdfWasAttached: boolean,
    summaryTriggered: boolean,
    tools: ToolDefinition[],
    paperStructure: Awaited<
      ReturnType<typeof getPdfToolManager.prototype.extractAndParsePaper>
    >,
    currentItemLibraryID: number | undefined,
    sendingSession: ChatSession,
    sessionRunId: number,
    buildSystemPrompt:
      | ((
          currentMessages: ChatMessage[],
          session: ChatSession,
          runtimeState?: {
            currentIteration?: number;
            remainingIterations?: number;
            maxIterations: number;
            forceFinalAnswer: boolean;
          },
        ) => string | null)
      | undefined,
    executeProviderRequest: <T>(
      operation: () => Promise<T>,
      onProviderRerouted?: () => void,
    ) => Promise<T>,
    preserveToolExecutionState: boolean,
    lockedToolItemKey?: string,
    noteSummaryContext?: NoteSummaryContext,
    searchScopeGate?: SearchScopeGateConfig,
    abortSignal?: AbortSignal,
    presentationAuthorization?: PresentationLaunchAuthorization,
  ): Promise<void> {
    await this.agentRuntime.executeNonStreamingToolLoop({
      provider,
      currentMessages,
      assistantMessage,
      pdfWasAttached,
      summaryTriggered,
      tools,
      paperStructure,
      sendingSession,
      currentItemKey: sendingSession.lastActiveItemKey,
      currentItemLibraryID,
      sessionRunId,
      abortSignal,
      executeProviderRequest,
      preserveToolExecutionState,
      lockedToolItemKey,
      noteSummaryContext,
      searchScopeGate,
      refreshSystemPrompt: buildSystemPrompt,
      presentationAuthorization,
    });
    clearPaperChatRetryableState(sendingSession);
    await this.sessionStorage.updateSessionMeta(sendingSession);
  }

  async cancelCurrentTurn(): Promise<boolean> {
    await this.init();

    const sessionId = this.currentSession?.id;
    if (!sessionId) {
      return false;
    }

    return this.cancelTrackedSessionTurn(sessionId);
  }

  async cancelSessionTurn(sessionId: string): Promise<boolean> {
    await this.init();

    return this.cancelTrackedSessionTurn(sessionId);
  }

  private async cancelTrackedSessionTurn(sessionId: string): Promise<boolean> {
    const session = this.getTrackedSessionById(sessionId);
    if (!session) return false;

    const activeRunId = this.activeSessionRunIds.get(session.id);
    const hasActiveRun = activeRunId !== undefined;
    const pendingApprovalCount =
      session.toolApprovalState?.pendingRequests.length || 0;
    const pendingUserInputCount =
      session.userInputRequestState?.pendingRequests.length || 0;
    const interruptedMessages = session.messages.filter(
      (message) =>
        message.role === "assistant" &&
        (message.streamingState === "in_progress" ||
          this.hasPendingToolCallCards(message.content)),
    );

    if (
      !hasActiveRun &&
      interruptedMessages.length === 0 &&
      !session.executionPlan &&
      pendingApprovalCount === 0 &&
      pendingUserInputCount === 0
    ) {
      return false;
    }

    // Stop any next provider request immediately. If a write-class tool is
    // already running, keep the run tracked just long enough to persist its
    // result before invalidating and cleaning the interrupted turn.
    this.activeSessionAbortControllers.get(session.id)?.abort();

    if (pendingApprovalCount > 0) {
      getToolPermissionManager().denyPendingApprovals({
        sessionId: session.id,
        reason:
          "Pending tool approvals were denied because the user cancelled the current turn.",
      });
    }
    if (pendingUserInputCount > 0) {
      this.agentRuntime.cancelPendingUserInputRequests(session.id);
    }
    if (hasActiveRun) {
      await this.agentRuntime.waitForPendingMutatingToolExecutions(session.id);
    }
    const currentRunId = this.activeSessionRunIds.get(session.id);
    if (
      activeRunId !== undefined &&
      currentRunId !== undefined &&
      currentRunId !== activeRunId
    ) {
      return true;
    }
    if (activeRunId === undefined || currentRunId === activeRunId) {
      this.invalidateSessionRun(session.id);
    }

    const now = Date.now();
    let toolContextChanged = false;
    const completedToolItemKeys = [
      ...collectTrustedSourceTargets(session.toolExecutionState?.results || [])
        .itemKeys,
    ];
    for (const message of interruptedMessages) {
      toolContextChanged =
        retainCompletedApiOnlyModelContextMessagesForTurn(
          session,
          message.id,
        ) || toolContextChanged;
      const cleanedContent = this.stripPendingToolCallCards(message.content);
      const sanitizedEvidence = sanitizeEvidenceReferences(
        cleanedContent,
        message.evidence || [],
      );
      const hasPresentationArtifacts = Boolean(
        message.presentationArtifacts?.length,
      );
      if (
        !sanitizedEvidence.content &&
        !message.reasoning?.trim() &&
        !hasPresentationArtifacts
      ) {
        // Mirror finalizeFailedAssistantMessage: drop an empty interrupted
        // placeholder instead of persisting UI text that would later be
        // projected into model context as fabricated assistant output.
        const messageIndex = session.messages.findIndex(
          (entry) => entry.id === message.id,
        );
        if (messageIndex >= 0) {
          session.messages.splice(messageIndex, 1);
        }
        await this.sessionStorage.deleteMessage(session.id, message.id);
        continue;
      }
      message.content = sanitizedEvidence.content;
      message.evidence = sanitizedEvidence.referencedRecords.length
        ? sanitizedEvidence.referencedRecords
        : undefined;
      const sourceItemKeys = normalizeSourceItemKeys([
        ...(message.sourceItemKeys || []),
        ...completedToolItemKeys,
      ]);
      message.sourceItemKeys = sourceItemKeys.length
        ? sourceItemKeys
        : undefined;
      message.streamingState = "interrupted";
      message.timestamp = now;
      await this.sessionStorage.updateMessageContent(
        session.id,
        message.id,
        message.content,
        message.reasoning,
        {
          streamingState: "interrupted",
          evidence: message.evidence || [],
          sourceItemKeys,
          presentationArtifacts: message.presentationArtifacts || [],
        },
      );
    }

    session.executionPlan = undefined;
    if (!session.toolExecutionState?.results.length) {
      session.toolExecutionState = undefined;
    }
    session.toolApprovalState = undefined;
    session.userInputRequestState = undefined;
    session.updatedAt = now;
    if (toolContextChanged) {
      await this.sessionStorage.saveSession(session);
    } else {
      await this.sessionStorage.updateSessionMeta(session);
    }

    if (this.isSessionActive(session)) {
      this.onExecutionPlanUpdate?.(session.executionPlan);
      this.onMessageUpdate?.(session.messages);
    }

    return true;
  }

  /**
   * 清空当前会话
   */
  async clearCurrentSession(): Promise<void> {
    return this.enqueueSessionNavigation(() =>
      this.clearCurrentSessionLocked(),
    );
  }

  private async clearCurrentSessionLocked(): Promise<void> {
    if (!this.currentSession) return;

    const clearedSession = this.createClearedSession(this.currentSession);
    getToolPermissionManager().denyPendingApprovals({
      sessionId: clearedSession.id,
      reason:
        "Pending tool approvals were denied because the session was cleared.",
    });
    this.agentRuntime.cancelPendingUserInputRequests(clearedSession.id);
    this.invalidateSessionRun(clearedSession.id, { abort: true });
    this.currentSession = clearedSession;
    this.applySessionItemContext(clearedSession);

    await this.sessionStorage.deleteAllMessages(clearedSession.id);
    await this.sessionStorage.updateSessionMeta(clearedSession);
    this.onExecutionPlanUpdate?.(clearedSession.executionPlan);
    this.onMessageUpdate?.(clearedSession.messages);

    ztoolkit.log("Current session cleared");
  }

  /**
   * 检查是否有PDF附件
   */
  async hasPdfAttachment(item: Zotero.Item): Promise<boolean> {
    return this.pdfExtractor.hasPdfAttachment(item);
  }

  /**
   * 获取选中的PDF文本
   */
  getSelectedText(): string | null {
    return this.pdfExtractor.getSelectedTextFromReader();
  }

  /**
   * 获取PDF提取器
   */
  getPdfExtractor(): PdfExtractor {
    return this.pdfExtractor;
  }

  /**
   * 生成唯一ID
   */
  private generateId(): string {
    return generateTimestampId();
  }

  private toolApprovalCoordinator?: ToolApprovalCoordinator;

  /** Lazy for the same Object.create-based white-box tests as paperChatTier. */
  private get approvals(): ToolApprovalCoordinator {
    if (!this.toolApprovalCoordinator) {
      this.toolApprovalCoordinator = new ToolApprovalCoordinator({
        getTrackedSessionById: (sessionId) =>
          this.getTrackedSessionById(sessionId),
        getSessionStorage: () => this.sessionStorage,
        isSessionActive: (session) => this.isSessionActive(session),
        isSessionRunActive: (sessionId) =>
          this.activeSessionRunIds.has(sessionId),
        notifyExecutionPlanUpdate: (session) => {
          this.onExecutionPlanUpdate?.(session.executionPlan);
        },
        emitRuntimeEvent: (event) => {
          this.onRuntimeEvent?.(event);
        },
      });
    }
    return this.toolApprovalCoordinator;
  }

  private handleApprovalRequested(approvalRequest: ToolApprovalRequest): void {
    this.approvals.handleApprovalRequested(approvalRequest);
  }

  private handleApprovalResolved(
    approvalRequest: ToolApprovalRequest,
    decision: ToolPermissionDecision,
  ): void {
    this.approvals.handleApprovalResolved(approvalRequest, decision);
  }

  private getTrackedSessionById(sessionId?: string): ChatSession | null {
    if (!sessionId) {
      return null;
    }
    const streamingSession = this.streamingSessions.get(sessionId);
    if (streamingSession) {
      return streamingSession;
    }
    if (this.currentSession?.id === sessionId) {
      return this.currentSession;
    }
    return null;
  }

  private createClearedSession(session: ChatSession): ChatSession {
    const now = Date.now();
    return {
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: now,
      lastActiveItemKey: null,
      lastActiveItemLibraryID: undefined,
      messages: [],
      contextSummary: undefined,
      contextState: undefined,
      executionPlan: undefined,
      toolExecutionState: undefined,
      toolApprovalState: undefined,
      userInputRequestState: undefined,
      memoryExtractedAt: undefined,
      memoryExtractedMsgCount: undefined,
      selectedTier: session.selectedTier,
      resolvedModelId: session.resolvedModelId,
      lastRetryableUserMessageId: undefined,
      lastRetryableErrorMessageId: undefined,
      lastRetryableFailedModelId: undefined,
    };
  }

  private isDraftSession(session: ChatSession): boolean {
    return !session.messages.some(
      (message) => message.role === "user" && !message.apiOnly,
    );
  }

  private applySessionItemContext(session: ChatSession | null): void {
    this.currentItemKey = session?.lastActiveItemKey ?? null;
    this.currentItemLibraryID = this.currentItemKey
      ? (session?.lastActiveItemLibraryID ?? Zotero.Libraries.userLibraryID)
      : null;
    getPdfToolManager().setCurrentItemKey(this.currentItemKey);
  }

  private reconcileApprovalState(session: ChatSession | null): void {
    this.approvals.reconcileApprovalState(session);
  }

  private reconcileUserInputRequestState(session: ChatSession | null): void {
    this.approvals.reconcileUserInputRequestState(session);
  }

  /**
   * 销毁
   */
  async destroy(): Promise<void> {
    await this.stopSearchHistoryBackfill();
    await this.memoryManager.flushOnDestroy(this.currentSession);
    if (this.currentSession) {
      await this.sessionStorage.updateSessionMeta(this.currentSession);
    }
    getToolPermissionManager().removeApprovalObserver(this.approvalObserver);
    this.currentSession = null;
    this.currentItemKey = null;
    this.currentItemLibraryID = null;
    for (const abortController of this.activeSessionAbortControllers.values()) {
      abortController.abort();
    }
    this.sessionRunCounters.clear();
    this.activeSessionRunIds.clear();
    this.activeSessionAbortControllers.clear();
    this.streamingSessions.clear();
    getPdfToolManager().setCurrentItemKey(null);
    this.memoryManager.clear();
    this.initialized = false;
  }
}
