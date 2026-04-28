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
  SendMessageOptions,
  ToolApprovalState,
  StreamCallbacks,
  SessionMeta,
} from "../../types/chat";
import type {
  ToolApprovalRequest,
  ToolApprovalResolution,
  ToolDefinition,
  ToolPermissionDecision,
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
import { getPdfToolManager } from "./pdf-tools";
import {
  getToolPermissionManager,
  type ToolApprovalObserver,
} from "./tool-permissions";
import { getToolScheduler } from "./tool-scheduler";
import { getProviderManager } from "../providers";
import { getAuthManager } from "../auth";
import { getString } from "../../utils/locale";
import { getPref, setPref } from "../../utils/prefs";
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
import { isEmbeddingModel } from "../embedding/providers/PaperChatEmbedding";
import {
  rerollTierModel,
  deriveTierPools,
  isPaperChatModelHardFailure,
  type PaperChatTier,
} from "../providers/paperchat-tier-routing";
import { isPaperChatQuotaError } from "../providers/paperchat-errors";
import {
  applyPaperChatSessionBinding,
  clearPaperChatRetryableState,
  repairPaperChatSessionBindingAfterHardFailure,
  resolvePaperChatSessionBinding,
} from "./paperchat-session-state";
import {
  repairPaperChatSessionAfterHardFailureWithRollback,
  rerollPaperChatFailureAndReplay,
} from "./paperchat-retry-orchestration";
import { MemoryManager } from "./memory/MemoryManager";
import { AgentRuntime } from "./agent-runtime/AgentRuntime";
import { normalizeAgentMaxPlanningIterations } from "./agent-runtime/IterationLimitConfig";
import {
  createToolBudgetState,
  getToolBudgetLimits,
} from "./tool-budget/ToolBudgetPolicy";
import { isAbortError, SessionRunInvalidatedError } from "./errors";
import { ANALYTICS_EVENTS, getAnalyticsService } from "../analytics";
// V1 migration now handled by migrateToSQLite.ts at startup

/**
 * Type guard: check if provider supports tool calling
 * Works with any AIProvider (for fallback compatibility)
 */
function providerSupportsToolCalling(
  provider: AIProvider,
): provider is AIProvider & ToolCallingProvider {
  return (
    "chatCompletionWithTools" in provider &&
    typeof (provider as ToolCallingProvider).chatCompletionWithTools ===
      "function"
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

function pickRandomCandidate(
  candidates: string[],
  weights: Record<string, number> = {},
): string | null {
  if (candidates.length === 0) {
    return null;
  }

  let totalWeight = 0;
  for (const candidate of candidates) {
    const weight = weights[candidate] ?? 1;
    if (Number.isFinite(weight) && weight > 0) {
      totalWeight += weight;
    }
  }

  if (totalWeight <= 0) {
    const index = Math.floor(Math.random() * candidates.length);
    return candidates[index] ?? null;
  }

  let cursor = Math.random() * totalWeight;
  for (const candidate of candidates) {
    const weight = weights[candidate] ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      continue;
    }
    cursor -= weight;
    if (cursor < 0) {
      return candidate;
    }
  }

  return candidates[candidates.length - 1] ?? null;
}

function getPaperChatChatModels(): string[] {
  const providerConfig = getProviderManager().getProviderConfig(
    "paperchat",
  ) as PaperChatProviderConfig | null;
  const configuredModels = providerConfig?.availableModels;
  if (Array.isArray(configuredModels) && configuredModels.length > 0) {
    return configuredModels.filter((model) => !isEmbeddingModel(model));
  }

  return [];
}

// 使用 common.ts 中的 getItemTitleSmart 获取 item 标题

export class ChatManager {
  private sessionStorage: SessionStorageService;
  private pdfExtractor: PdfExtractor;
  private currentSession: ChatSession | null = null;
  private currentItemKey: string | null = null;
  private initialized: boolean = false;

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

  private memoryManager: MemoryManager;
  private agentRuntime: AgentRuntime;

  // UI回调
  private onMessageUpdate?: (messages: ChatMessage[]) => void;
  private onStreamingUpdate?: (content: string, messageId: string) => void;
  private onReasoningUpdate?: (reasoning: string, messageId: string) => void;
  private onError?: (error: Error) => void;
  private onPdfAttached?: () => void;
  private onMessageComplete?: () => void;
  private onExecutionPlanUpdate?: (plan?: ExecutionPlan) => void;
  private onRuntimeEvent?: (event: AgentRuntimeEvent) => void;
  private onFallbackNotice?: (fromProvider: string, toProvider: string) => void; // 降级通知回调
  private approvalObserver: ToolApprovalObserver;

  constructor() {
    this.sessionStorage = new SessionStorageService();
    this.pdfExtractor = new PdfExtractor();
    this.memoryManager = new MemoryManager(this.sessionStorage);
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
        formatToolCallCard: (toolName, args, status, resultPreview) =>
          this.formatToolCallCard(toolName, args, status, resultPreview),
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

    // 加载活动 session
    try {
      this.currentSession =
        await this.sessionStorage.getOrCreateActiveSession();
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
    this.reconcileApprovalState(this.currentSession);
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

  private buildToolCallingSystemPrompt(params: {
    currentMessages: ChatMessage[];
    paperStructure?: Awaited<
      ReturnType<typeof getPdfToolManager.prototype.extractAndParsePaper>
    >;
    hasCurrentItem: boolean;
    item?: Zotero.Item;
    memoryContext?: string;
    sendingSession: ChatSession;
    runtimeState?: {
      currentIteration?: number;
      remainingIterations?: number;
      maxIterations: number;
      forceFinalAnswer: boolean;
    };
  }): string {
    const {
      currentMessages,
      paperStructure,
      hasCurrentItem,
      item,
      memoryContext,
      sendingSession,
      runtimeState,
    } = params;
    const pdfToolManager = getPdfToolManager();
    const allToolResults = sendingSession.toolExecutionState?.results || [];
    const recentToolResults = allToolResults.slice(-5);
    const hardIterationLimit =
      runtimeState?.maxIterations ??
      normalizeAgentMaxPlanningIterations(
        getPref("agentMaxPlanningIterations") as number | undefined,
      );
    const toolBudgetLimits = getToolBudgetLimits(hardIterationLimit);
    const toolBudgetState = createToolBudgetState(allToolResults);

    return pdfToolManager.generatePaperContextPrompt(
      paperStructure || undefined,
      hasCurrentItem ? item?.key : undefined,
      hasCurrentItem && item ? getItemTitleSmart(item) : undefined,
      hasCurrentItem,
      memoryContext,
      {
        executionPlan: sendingSession.executionPlan,
        recentToolResults,
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
      },
    );
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

  /**
   * 检查当前 provider 是否为 PaperChat (支持 token 刷新)
   */
  private isPaperChatProvider(): boolean {
    const provider = this.getActiveProvider();
    return provider?.getName() === "PaperChat";
  }

  private syncSessionItemState(session: ChatSession | null): void {
    this.applySessionItemContext(session);
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

  private buildPaperChatReroutedNotice(
    tier: PaperChatTier,
    previousModel: string,
    nextModel: string,
  ): string {
    const tierLabel =
      tier === "paperchat-lite"
        ? getString("chat-tier-lite")
        : tier === "paperchat-ultra"
          ? getString("chat-tier-ultra")
          : tier === "paperchat-pro"
            ? getString("chat-tier-pro")
            : getString("chat-tier-standard");

    return getString("chat-model-rerouted", {
      args: {
        tier: tierLabel,
        old: previousModel,
        new: nextModel,
      },
    });
  }

  private trackPaperChatModelRerouted(
    tier: PaperChatTier,
    previousModel: string,
    nextModel: string,
    reason: "streaming" | "tool_calling" | "failure_repair",
  ): void {
    getAnalyticsService().track(ANALYTICS_EVENTS.paperChatModelRerouted, {
      tier,
      previous_model: previousModel,
      next_model: nextModel,
      reason,
    });
  }

  private async repairPaperChatSessionAfterHardFailure(
    session: ChatSession,
    failedModelId: string | null,
    persist: boolean = true,
  ): Promise<{
    previousModel: string;
    nextModel: string;
    tier: PaperChatTier;
  } | null> {
    const previousTierStateRaw =
      (getPref("paperchatTierState") as string | undefined) || "";
    const updateProviderOverride = (modelId: string | undefined) => {
      getProviderManager().getProvider("paperchat")?.updateConfig({
        resolvedModelOverride: modelId,
      });
    };

    if (!persist) {
      const repair = repairPaperChatSessionBindingAfterHardFailure(
        session,
        previousTierStateRaw,
        getPaperChatChatModels(),
        getModelRatios(),
        failedModelId,
        pickRandomCandidate,
        getModelRoutingMeta(),
      );

      if (!repair || !repair.previousModelId) {
        return null;
      }

      setPref("paperchatTierState", JSON.stringify(repair.state));
      applyPaperChatSessionBinding(session, repair);
      updateProviderOverride(repair.modelId);

      return {
        previousModel: repair.previousModelId,
        nextModel: repair.modelId,
        tier: repair.selectedTier,
      };
    }

    const reroute = await repairPaperChatSessionAfterHardFailureWithRollback({
      session,
      failedModelId,
      previousTierStateRaw,
      availableModels: getPaperChatChatModels(),
      ratios: getModelRatios(),
      routingMeta: getModelRoutingMeta(),
      persistSessionMeta: (updatedSession) =>
        this.sessionStorage.updateSessionMeta(updatedSession),
      setTierStateRaw: (raw) => {
        setPref("paperchatTierState", raw);
      },
      updateProviderOverride,
      pickRandom: pickRandomCandidate,
    });

    if (!reroute) {
      return null;
    }

    return reroute;
  }

  private async insertSystemNotice(
    session: ChatSession,
    content: string,
  ): Promise<void> {
    const notice: ChatMessage = {
      id: this.generateId(),
      role: "system",
      content,
      timestamp: Date.now(),
      isSystemNotice: true,
    };

    session.messages.push(notice);
    await this.sessionStorage.insertMessage(session.id, notice);
    if (this.isSessionActive(session)) {
      this.onMessageUpdate?.(session.messages);
    }
  }

  private getSessionItem(session: ChatSession): Zotero.Item | null {
    const itemKey = session.lastActiveItemKey;
    if (!itemKey) {
      return null;
    }

    const libraryID = Zotero.Libraries.userLibraryID;
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
    onFallbackNotice?: (fromProvider: string, toProvider: string) => void;
  }): void {
    this.onMessageUpdate = callbacks.onMessageUpdate;
    this.onStreamingUpdate = callbacks.onStreamingUpdate;
    this.onReasoningUpdate = callbacks.onReasoningUpdate;
    this.onError = callbacks.onError;
    this.onPdfAttached = callbacks.onPdfAttached;
    this.onMessageComplete = callbacks.onMessageComplete;
    this.onExecutionPlanUpdate = callbacks.onExecutionPlanUpdate;
    this.onRuntimeEvent = callbacks.onRuntimeEvent;
    this.onFallbackNotice = callbacks.onFallbackNotice;

    // 设置 ProviderManager 的降级回调
    const providerManager = getProviderManager();
    providerManager.setOnFallback((from, to, error) => {
      ztoolkit.log(
        `[ChatManager] Provider fallback: ${from} -> ${to}, error: ${error.message}`,
      );
      // 通知 UI 层（如果需要额外处理）
      this.onFallbackNotice?.(from, to);
    });
  }

  /**
   * 设置当前活动的 Item Key (单文档模式，向后兼容)
   */
  setCurrentItemKey(itemKey: string | null): void {
    this.currentItemKey = itemKey;
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

  /**
   * 创建新 session
   */
  async createNewSession(): Promise<ChatSession> {
    await this.init();
    this.currentSession = await this.sessionStorage.createSession();
    this.applySessionItemContext(this.currentSession);
    this.reconcileApprovalState(this.currentSession);
    return this.currentSession;
  }

  /**
   * 切换到指定 session
   */
  async switchSession(sessionId: string): Promise<ChatSession | null> {
    await this.init();

    // Trigger memory extraction for the session we're leaving
    this.memoryManager.onBeforeSessionSwitch(this.currentSession, sessionId);

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
    getToolPermissionManager().clearSessionPolicies(sessionId);

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

  async rerollCurrentPaperChatTier(): Promise<{
    previousModel: string;
    nextModel: string;
    tier: PaperChatTier;
  } | null> {
    await this.init();

    const session = this.currentSession;
    if (!session || !session.selectedTier || !session.resolvedModelId) {
      return null;
    }

    const providerManager = getProviderManager();
    const provider = this.getActiveProvider();
    if (!provider || providerManager.getActiveProviderId() !== "paperchat") {
      return null;
    }

    const availableModels = getPaperChatChatModels();
    const routingMeta = getModelRoutingMeta();
    const pools = deriveTierPools(availableModels, getModelRatios(), routingMeta);
    const nextModel = rerollTierModel(
      pools[session.selectedTier],
      session.resolvedModelId,
      pickRandomCandidate,
      routingMeta,
    );

    if (!nextModel) {
      return null;
    }

    const previousModel = session.resolvedModelId;
    const previousRetryableState = {
      lastRetryableUserMessageId: session.lastRetryableUserMessageId,
      lastRetryableErrorMessageId: session.lastRetryableErrorMessageId,
      lastRetryableFailedModelId: session.lastRetryableFailedModelId,
    };
    const previousUpdatedAt = session.updatedAt;

    session.resolvedModelId = nextModel;
    clearPaperChatRetryableState(session);

    try {
      await this.sessionStorage.updateSessionMeta(session);
    } catch (error) {
      session.resolvedModelId = previousModel;
      session.lastRetryableUserMessageId =
        previousRetryableState.lastRetryableUserMessageId;
      session.lastRetryableErrorMessageId =
        previousRetryableState.lastRetryableErrorMessageId;
      session.lastRetryableFailedModelId =
        previousRetryableState.lastRetryableFailedModelId;
      session.updatedAt = previousUpdatedAt;
      throw error;
    }

    const paperchatProvider = providerManager.getProvider("paperchat");
    paperchatProvider?.updateConfig({
      resolvedModelOverride: nextModel,
    });

    return {
      previousModel,
      nextModel,
      tier: session.selectedTier,
    };
  }

  async switchCurrentSessionPaperChatTier(
    tier: PaperChatTier,
    modelOverride?: string | null,
  ): Promise<void> {
    await this.init();

    const session = this.currentSession;
    if (!session) {
      return;
    }

    const nextResolvedModelId =
      modelOverride === undefined ? undefined : modelOverride || undefined;
    if (modelOverride === undefined && session.selectedTier === tier) {
      return;
    }
    if (
      modelOverride !== undefined &&
      session.selectedTier === tier &&
      session.resolvedModelId === nextResolvedModelId
    ) {
      return;
    }

    const previousSessionState = {
      selectedTier: session.selectedTier,
      resolvedModelId: session.resolvedModelId,
      lastRetryableUserMessageId: session.lastRetryableUserMessageId,
      lastRetryableErrorMessageId: session.lastRetryableErrorMessageId,
      lastRetryableFailedModelId: session.lastRetryableFailedModelId,
      updatedAt: session.updatedAt,
    };

    session.selectedTier = tier;
    session.resolvedModelId = nextResolvedModelId;
    clearPaperChatRetryableState(session);

    try {
      await this.sessionStorage.updateSessionMeta(session);
    } catch (error) {
      session.selectedTier = previousSessionState.selectedTier;
      session.resolvedModelId = previousSessionState.resolvedModelId;
      session.lastRetryableUserMessageId =
        previousSessionState.lastRetryableUserMessageId;
      session.lastRetryableErrorMessageId =
        previousSessionState.lastRetryableErrorMessageId;
      session.lastRetryableFailedModelId =
        previousSessionState.lastRetryableFailedModelId;
      session.updatedAt = previousSessionState.updatedAt;
      throw error;
    }

    const providerManager = getProviderManager();
    const paperchatProvider = providerManager.getProvider("paperchat");
    paperchatProvider?.updateConfig({
      resolvedModelOverride: nextResolvedModelId,
    });
  }

  async clearCurrentSessionPaperChatRetryableState(): Promise<void> {
    await this.init();

    const session = this.currentSession;
    if (!session) {
      return;
    }

    const hadRetryableState =
      !!session.lastRetryableUserMessageId ||
      !!session.lastRetryableErrorMessageId ||
      !!session.lastRetryableFailedModelId;

    if (!hadRetryableState) {
      return;
    }

    const previousState = {
      lastRetryableUserMessageId: session.lastRetryableUserMessageId,
      lastRetryableErrorMessageId: session.lastRetryableErrorMessageId,
      lastRetryableFailedModelId: session.lastRetryableFailedModelId,
      updatedAt: session.updatedAt,
    };

    clearPaperChatRetryableState(session);

    try {
      await this.sessionStorage.updateSessionMeta(session);
    } catch (error) {
      session.lastRetryableUserMessageId =
        previousState.lastRetryableUserMessageId;
      session.lastRetryableErrorMessageId =
        previousState.lastRetryableErrorMessageId;
      session.lastRetryableFailedModelId =
        previousState.lastRetryableFailedModelId;
      session.updatedAt = previousState.updatedAt;
      throw error;
    }
  }

  async rerollCurrentPaperChatFailureAndRetry(): Promise<{
    previousModel: string;
    nextModel: string;
    tier: PaperChatTier;
  } | null> {
    await this.init();

    const session = this.currentSession;
    if (!session) {
      return null;
    }

    return rerollPaperChatFailureAndReplay<Zotero.Item | null>({
      session,
      rerollTier: () => this.rerollCurrentPaperChatTier(),
      deleteMessage: (sessionId, messageId) =>
        this.sessionStorage.deleteMessage(sessionId, messageId),
      buildSystemNotice: (reroute) =>
        this.buildPaperChatReroutedNotice(
          reroute.tier,
          reroute.previousModel,
          reroute.nextModel,
        ),
      insertSystemNotice: (targetSession, content) =>
        this.insertSystemNotice(targetSession, content),
      resend: async ({ content, images, item }) => {
        await this.sendMessage(content, {
          item,
          images,
        });
      },
      getItem: (targetSession) => this.getSessionItem(targetSession),
    });
  }

  async insertCurrentSessionSystemNotice(content: string): Promise<void> {
    await this.init();

    if (!this.currentSession) {
      return;
    }

    await this.insertSystemNotice(this.currentSession, content);
  }

  private async applyPaperChatFailureState(
    session: ChatSession,
    userMessageId: string,
    errorMessage: ChatMessage,
    error: unknown,
    failedProviderId: string,
    failedModelId: string | null,
  ): Promise<void> {
    const isPaperChatFailure = failedProviderId === "paperchat";
    const isHardFailure =
      isPaperChatFailure &&
      error instanceof Error &&
      isPaperChatModelHardFailure(error);

    if (isHardFailure) {
      try {
        const reroute = await this.repairPaperChatSessionAfterHardFailure(
          session,
          failedModelId,
          false,
        );
        if (reroute) {
          this.trackPaperChatModelRerouted(
            reroute.tier,
            reroute.previousModel,
            reroute.nextModel,
            "failure_repair",
          );
        }
      } catch (repairError) {
        ztoolkit.log(
          "[ChatManager] Failed to repair PaperChat tier state after hard failure:",
          getErrorMessage(repairError),
        );
      }
    }

    if (isPaperChatFailure && isPaperChatQuotaError(error)) {
      getAnalyticsService().track(ANALYTICS_EVENTS.paperChatQuotaError, {
        provider: failedProviderId,
      });
    }

    const isRetryablePaperChatFailure =
      isPaperChatFailure && !isPaperChatQuotaError(error);

    session.lastRetryableUserMessageId = isRetryablePaperChatFailure
      ? userMessageId
      : undefined;
    session.lastRetryableErrorMessageId = isRetryablePaperChatFailure
      ? errorMessage.id
      : undefined;
    session.lastRetryableFailedModelId = isRetryablePaperChatFailure
      ? (failedModelId ?? undefined)
      : undefined;
  }

  /**
   * 插入降级通知消息到聊天界面
   */
  private async insertFallbackNotice(
    session: ChatSession,
    fromProvider: string,
    toProvider: string,
  ): Promise<void> {
    const notice: ChatMessage = {
      id: this.generateId(),
      role: "system",
      content: `⚠️ ${fromProvider} unavailable, switching to ${toProvider}...`,
      timestamp: Date.now(),
      isSystemNotice: true,
    };

    session.messages.push(notice);
    await this.sessionStorage.insertMessage(session.id, notice);
    if (this.isSessionActive(session)) {
      this.onMessageUpdate?.(session.messages);
    }
  }

  /**
   * 插入 item 切换的 system-notice 消息
   */
  private async insertItemSwitchNotice(
    newItemKey: string,
    newItemTitle: string,
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
  }

  /**
   * 发送消息
   * @param content 消息内容
   * @param options 选项
   */
  async sendMessage(
    content: string,
    options: SendMessageOptions & { item?: Zotero.Item | null } = {},
  ): Promise<boolean> {
    await this.init();

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
    const sendingSession = this.currentSession;
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
      // 检查是否需要插入 item 切换通知
      if (itemKey !== sendingSession.lastActiveItemKey) {
        if (hasCurrentItem) {
          // 切换到新 item
          await this.insertItemSwitchNotice(
            itemKey!,
            itemTitle!,
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
        }
        // 更新当前 itemKey
        this.currentItemKey = itemKey;
        getPdfToolManager().setCurrentItemKey(itemKey);
      }

      // 获取活动的 AI 提供商
      const providerManager = getProviderManager();
      const provider = this.getActiveProvider();
      chatProviderId = providerManager.getActiveProviderId();
      ztoolkit.log(
        "[ChatManager] provider:",
        provider?.getName(),
        "isReady:",
        provider?.isReady(),
      );

      if (providerManager.getActiveProviderId() === "paperchat") {
        await this.ensurePaperChatModelResolved(sendingSession);
      }

      if (!provider || !provider.isReady()) {
        ztoolkit.log("[ChatManager] Provider not ready, showing error in chat");
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

      if (useToolCalling) {
        // 如果有当前 item，尝试提取 PDF（用于 PDF 相关工具）
        if (hasCurrentItem && item) {
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
      const userMessage: ChatMessage = {
        id: this.generateId(),
        role: "user",
        content: finalContent,
        images: options.images,
        files: options.files,
        timestamp: Date.now(),
        pdfContext: pdfWasAttached,
        selectedText: options.selectedText,
      };

      sendingSession.messages.push(userMessage);
      await this.sessionStorage.insertMessage(sendingSession.id, userMessage);
      sendingSession.updatedAt = Date.now();
      if (this.isSessionActive(sendingSession)) {
        this.onMessageUpdate?.(sendingSession.messages);
      }

      // 创建 AI 消息占位
      const assistantMessage: ChatMessage = {
        id: this.generateId(),
        role: "assistant",
        content: "",
        streamingState: "in_progress",
        timestamp: Date.now(),
      };

      sendingSession.messages.push(assistantMessage);
      await this.sessionStorage.insertMessage(
        sendingSession.id,
        assistantMessage,
      );
      sendingSession.executionPlan = undefined;
      sendingSession.toolExecutionState = undefined;
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

      // 获取上下文管理器并过滤消息
      const contextManager = getContextManager();
      const { messages: filteredMessages, summaryTriggered } =
        contextManager.filterMessages(sendingSession);

      // 从过滤后的消息中排除最后一条 (assistant 占位)
      const messagesForApi = filteredMessages.filter(
        (m: ChatMessage) => m.id !== assistantMessage.id,
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
          abortSignal,
        );
        if (toolCallingResult !== null) {
          trackChatCompleted(toolCallingResult);
        }
        return true;
      }

      let failedProviderId = provider.config.id;
      let failedProvider: AIProvider = provider;
      let failedPaperChatModelId: string | null = null;
      let fallbackFromProviderName: string | null = null;
      let fallbackToProviderName: string | null = null;

      const handleFallbackNotice = async () => {
        if (!fallbackFromProviderName || !fallbackToProviderName) {
          return;
        }
        ensureSendingSessionTracked();
        try {
          await this.insertFallbackNotice(
            sendingSession,
            fallbackFromProviderName,
            fallbackToProviderName,
          );
        } catch (noticeError) {
          ztoolkit.log(
            "[ChatManager] Failed to persist fallback notice:",
            noticeError,
          );
          this.onError?.(
            new Error(
              `Switched from ${fallbackFromProviderName} to ${fallbackToProviderName}, but failed to show the fallback notice: ${getErrorMessage(noticeError)}`,
            ),
          );
        } finally {
          fallbackFromProviderName = null;
          fallbackToProviderName = null;
        }
      };

      // 传统模式：流式调用（带自动降级）
      try {
        await providerManager.executeWithFallback(async (currentProvider) => {
          chatProviderId = currentProvider.config.id;
          if (currentProvider.config.id !== failedProviderId) {
            fallbackFromProviderName = failedProvider.getName();
            fallbackToProviderName = currentProvider.getName();
          }
          failedProviderId = currentProvider.config.id;
          failedProvider = currentProvider;
          await handleFallbackNotice();

          if (currentProvider.config.id === "paperchat") {
            failedPaperChatModelId = await this.ensurePaperChatModelResolved(
              sendingSession,
              false,
            );
          } else {
            failedPaperChatModelId = null;
          }

          ensureSendingSessionTracked();

          // 重置 assistant 消息内容（降级时需要清空之前的部分内容）
          assistantMessage.content = "";
          assistantMessage.reasoning = "";
          assistantMessage.streamingState = "in_progress";

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
                await this.sessionStorage.updateMessageContent(
                  sendingSession.id,
                  assistantMessage.id,
                  assistantMessage.content,
                  assistantMessage.reasoning,
                  { streamingState },
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
                  assistantMessage.content = fullContent;
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

                  // 对于 PaperChat 的认证错误，尝试刷新 token
                  if (
                    this.isAuthError(error) &&
                    currentProvider.getName() === "PaperChat"
                  ) {
                    try {
                      const authManager = getAuthManager();
                      await authManager.ensurePluginToken(true);
                      ztoolkit.log(
                        "[API Retry] Token refreshed, but will use fallback mechanism",
                      );
                    } catch (refreshError) {
                      ztoolkit.log(
                        "[API Retry] Failed to refresh token:",
                        refreshError,
                      );
                    }
                  }

                  // 拒绝 Promise，让 executeWithFallback 处理降级
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
            if (
              currentProvider.config.id !== "paperchat" ||
              !(error instanceof Error) ||
              !isPaperChatModelHardFailure(error)
            ) {
              throw error;
            }

            const reroute = await this.repairPaperChatSessionAfterHardFailure(
              sendingSession,
              failedPaperChatModelId,
            );
            ensureSendingSessionTracked();
            if (!reroute) {
              throw error;
            }

            failedPaperChatModelId = reroute.nextModel;
            assistantMessage.content = "";
            assistantMessage.reasoning = "";
            await this.insertSystemNotice(
              sendingSession,
              this.buildPaperChatReroutedNotice(
                reroute.tier,
                reroute.previousModel,
                reroute.nextModel,
              ),
            );
            this.trackPaperChatModelRerouted(
              reroute.tier,
              reroute.previousModel,
              reroute.nextModel,
              "streaming",
            );

            return await streamCurrentProvider();
          }
        });

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
        // 所有 provider 都失败了
        ztoolkit.log("[ChatManager] All providers failed:", error);

        // 移除 assistant 占位消息（使用 id 精确定位，避免误删 fallback notice）
        const assistantIndex = sendingSession.messages.findIndex(
          (m) => m.id === assistantMessage.id,
        );
        if (assistantIndex !== -1) {
          sendingSession.messages.splice(assistantIndex, 1);
          await this.sessionStorage.deleteMessage(
            sendingSession.id,
            assistantMessage.id,
          );
        }

        const errorMessage: ChatMessage = {
          id: this.generateId(),
          role: "error",
          content: getErrorMessage(error),
          timestamp: Date.now(),
        };

        await this.applyPaperChatFailureState(
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
   * 优先使用流式模式，fallback 到非流式
   * 支持 provider 降级：在第一次调用时选择可用的 provider
   */
  private async sendMessageWithToolCalling(
    _provider: ToolCallingProvider, // 原始 provider，可能被降级替换
    messagesForApi: ChatMessage[],
    assistantMessage: ChatMessage,
    pdfWasAttached: boolean,
    summaryTriggered: boolean,
    hasCurrentItem: boolean,
    item: Zotero.Item,
    sendingSession: ChatSession,
    sessionRunId: number,
    onProviderUsed: (providerId: string) => void,
    abortSignal?: AbortSignal,
  ): Promise<boolean | null> {
    const pdfToolManager = getPdfToolManager();
    const providerManager = getProviderManager();
    const ensureSendingSessionTracked = () => {
      this.ensureTrackedRun(sendingSession, sessionRunId);
    };

    // 获取动态工具列表
    const tools = pdfToolManager.getToolDefinitions(hasCurrentItem);

    // 实时提取论文结构
    const paperStructure = hasCurrentItem
      ? await pdfToolManager.extractAndParsePaper(item.key)
      : undefined;
    ensureSendingSessionTracked();

    // Search for relevant memories using the last user message as query
    const lastUserMessage = messagesForApi
      .filter((m) => m.role === "user")
      .at(-1);
    const memoryContext = await this.memoryManager.buildPromptContext(
      lastUserMessage?.content,
    );
    ensureSendingSessionTracked();

    // 添加论文上下文系统提示
    const buildSystemPrompt = (
      currentMessages: ChatMessage[],
      _session?: ChatSession,
      runtimeState?: {
        currentIteration?: number;
        remainingIterations?: number;
        maxIterations: number;
        forceFinalAnswer: boolean;
      },
    ) =>
      this.buildToolCallingSystemPrompt({
        currentMessages,
        paperStructure,
        hasCurrentItem,
        item: hasCurrentItem ? item : undefined,
        memoryContext,
        sendingSession,
        runtimeState,
      });

    const paperContextPrompt = buildSystemPrompt(messagesForApi, sendingSession, {
      maxIterations: normalizeAgentMaxPlanningIterations(
        getPref("agentMaxPlanningIterations") as number | undefined,
      ),
      forceFinalAnswer: false,
    });

    const messagesWithContext: ChatMessage[] = [
      {
        id: "paper-context",
        role: "system",
        content: paperContextPrompt,
        timestamp: Date.now(),
      },
      ...messagesForApi,
    ];

    // 使用 executeWithFallback 找到第一个可用的支持 tool calling 的 provider
    // 注意：一旦开始 tool calling 循环，就不再降级（状态难以恢复）
    let failedProviderId = _provider.config.id;
    let failedProvider: AIProvider = _provider;
    let failedPaperChatModelId: string | null = null;

    let fallbackFromProviderName: string | null = null;
    let fallbackToProviderName: string | null = null;

    const handleFallbackNotice = async () => {
      if (!fallbackFromProviderName || !fallbackToProviderName) {
        return;
      }
      ensureSendingSessionTracked();
      try {
        await this.insertFallbackNotice(
          sendingSession,
          fallbackFromProviderName,
          fallbackToProviderName,
        );
      } catch (noticeError) {
        ztoolkit.log(
          "[ChatManager] Failed to persist fallback notice:",
          noticeError,
        );
        this.onError?.(
          new Error(
            `Switched from ${fallbackFromProviderName} to ${fallbackToProviderName}, but failed to show the fallback notice: ${getErrorMessage(noticeError)}`,
          ),
        );
      } finally {
        fallbackFromProviderName = null;
        fallbackToProviderName = null;
      }
    };

    try {
      await providerManager.executeWithFallback(async (currentProvider) => {
        onProviderUsed(currentProvider.config.id);
        if (currentProvider.config.id !== failedProviderId) {
          fallbackFromProviderName = failedProvider.getName();
          fallbackToProviderName = currentProvider.getName();
        }
        failedProviderId = currentProvider.config.id;
        failedProvider = currentProvider;
        await handleFallbackNotice();

        if (currentProvider.config.id === "paperchat") {
          failedPaperChatModelId = await this.ensurePaperChatModelResolved(
            sendingSession,
            false,
          );
        } else {
          failedPaperChatModelId = null;
        }
        ensureSendingSessionTracked();

        // 检查 provider 是否支持 tool calling
        if (!providerSupportsToolCalling(currentProvider)) {
          throw new Error(
            `Provider ${currentProvider.getName()} does not support tool calling`,
          );
        }

        const toolProvider = currentProvider as AIProvider &
          ToolCallingProvider;

        // 重置 assistant 消息内容（降级时需要清空之前的部分内容）
        assistantMessage.content = "";
        assistantMessage.reasoning = "";

        const executeToolCallingAttempt = async () => {
          if (providerSupportsStreamingToolCalling(currentProvider)) {
            ztoolkit.log(
              `[Tool Calling] Using streaming mode with ${currentProvider.getName()}`,
            );
            await this.sendMessageWithStreamingToolCalling(
              currentProvider as AIProvider &
                ToolCallingProvider & {
                  streamChatCompletionWithTools: NonNullable<
                    ToolCallingProvider["streamChatCompletionWithTools"]
                  >;
                },
              messagesWithContext,
              assistantMessage,
              pdfWasAttached,
              summaryTriggered,
              tools,
              paperStructure,
              sendingSession,
              sessionRunId,
              buildSystemPrompt,
              abortSignal,
            );
            return;
          }

          ztoolkit.log(
            `[Tool Calling] Using non-streaming mode with ${currentProvider.getName()}`,
          );
          await this.sendMessageWithNonStreamingToolCalling(
            toolProvider,
            messagesWithContext,
            assistantMessage,
            pdfWasAttached,
            summaryTriggered,
            tools,
            paperStructure,
            sendingSession,
            sessionRunId,
            buildSystemPrompt,
            abortSignal,
          );
        };

        try {
          await executeToolCallingAttempt();
        } catch (error) {
          if (
            currentProvider.config.id !== "paperchat" ||
            !(error instanceof Error) ||
            !isPaperChatModelHardFailure(error)
          ) {
            throw error;
          }

          const reroute = await this.repairPaperChatSessionAfterHardFailure(
            sendingSession,
            failedPaperChatModelId,
          );
          ensureSendingSessionTracked();
          if (!reroute) {
            throw error;
          }

          failedPaperChatModelId = reroute.nextModel;
          assistantMessage.content = "";
          assistantMessage.reasoning = "";
          await this.insertSystemNotice(
            sendingSession,
            this.buildPaperChatReroutedNotice(
              reroute.tier,
              reroute.previousModel,
              reroute.nextModel,
            ),
          );
          this.trackPaperChatModelRerouted(
            reroute.tier,
            reroute.previousModel,
            reroute.nextModel,
            "tool_calling",
          );

          await executeToolCallingAttempt();
        }
      });

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
      // 所有 provider 都失败了
      ztoolkit.log("[Tool Calling] All providers failed:", error);

      // 移除 assistant 占位消息（使用 id 精确定位，避免误删 fallback notice）
      const assistantIndex = sendingSession.messages.findIndex(
        (m) => m.id === assistantMessage.id,
      );
      if (assistantIndex !== -1) {
        sendingSession.messages.splice(assistantIndex, 1);
        await this.sessionStorage.deleteMessage(
          sendingSession.id,
          assistantMessage.id,
        );
      }

      const errorMessage: ChatMessage = {
        id: this.generateId(),
        role: "error",
        content: getErrorMessage(error),
        timestamp: Date.now(),
      };
      await this.applyPaperChatFailureState(
        sendingSession,
        messagesForApi.filter((m) => m.role === "user").at(-1)?.id || "",
        errorMessage,
        error,
        failedProviderId,
        failedProviderId === "paperchat"
          ? failedPaperChatModelId || sendingSession.resolvedModelId || null
          : null,
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
    const escapedResult = resultPreview
      ? this.escapeXml(
          resultPreview.length > 100
            ? resultPreview.substring(0, 97) + "..."
            : resultPreview,
        )
      : "";

    // 使用特殊标记格式，便于 MessageRenderer 识别和渲染
    let card = `\n<tool-call status="${status}">\n`;
    card += `<tool-name>${statusIcon} ${escapedToolName}</tool-name>\n`;
    if (escapedArgs) {
      card += `<tool-args>${escapedArgs}</tool-args>\n`;
    }
    card += `<tool-status>${statusText}</tool-status>\n`;
    if (escapedResult && status !== "calling") {
      card += `<tool-result>${escapedResult}</tool-result>\n`;
    }
    card += `</tool-call>\n`;

    return card;
  }

  private stripPendingToolCallCards(content: string): string {
    return content
      .replace(
        /\n?<tool-call status="calling">[\s\S]*?<\/tool-call>\n?/g,
        "\n",
      )
      .replace(/\n{3,}/g, "\n\n")
      .trim();
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
    sendingSession: ChatSession,
    sessionRunId: number,
    buildSystemPrompt: (
      currentMessages: ChatMessage[],
      session: ChatSession,
      runtimeState?: {
        currentIteration?: number;
        remainingIterations?: number;
        maxIterations: number;
        forceFinalAnswer: boolean;
      },
    ) => string,
    abortSignal?: AbortSignal,
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
      sessionRunId,
      abortSignal,
      refreshSystemPrompt: buildSystemPrompt,
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
    sendingSession: ChatSession,
    sessionRunId: number,
    buildSystemPrompt: (
      currentMessages: ChatMessage[],
      session: ChatSession,
      runtimeState?: {
        currentIteration?: number;
        remainingIterations?: number;
        maxIterations: number;
        forceFinalAnswer: boolean;
      },
    ) => string,
    abortSignal?: AbortSignal,
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
      sessionRunId,
      abortSignal,
      refreshSystemPrompt: buildSystemPrompt,
    });
    clearPaperChatRetryableState(sendingSession);
    await this.sessionStorage.updateSessionMeta(sendingSession);
  }

  async cancelCurrentTurn(): Promise<boolean> {
    await this.init();

    const session = this.currentSession;
    if (!session) {
      return false;
    }

    const hasActiveRun = this.activeSessionRunIds.has(session.id);
    const pendingApprovalCount =
      session.toolApprovalState?.pendingRequests.length || 0;
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
      pendingApprovalCount === 0
    ) {
      return false;
    }

    this.invalidateSessionRun(session.id, { abort: true });

    if (pendingApprovalCount > 0) {
      getToolPermissionManager().denyPendingApprovals({
        sessionId: session.id,
        reason:
          "Pending tool approvals were denied because the user cancelled the current turn.",
      });
    }

    const now = Date.now();
    for (const message of interruptedMessages) {
      const cleanedContent = this.stripPendingToolCallCards(message.content);
      if (cleanedContent) {
        message.content = cleanedContent;
      } else {
        message.content = getString("chat-turn-cancelled");
      }
      message.streamingState = "interrupted";
      message.timestamp = now;
      await this.sessionStorage.updateMessageContent(
        session.id,
        message.id,
        message.content,
        message.reasoning,
        { streamingState: "interrupted" },
      );
    }

    session.executionPlan = undefined;
    session.toolExecutionState = undefined;
    session.toolApprovalState = undefined;
    session.updatedAt = now;
    await this.sessionStorage.updateSessionMeta(session);

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
    if (!this.currentSession) return;

    const clearedSession = this.createClearedSession(this.currentSession);
    getToolPermissionManager().denyPendingApprovals({
      sessionId: clearedSession.id,
      reason:
        "Pending tool approvals were denied because the session was cleared.",
    });
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

  private handleApprovalRequested(approvalRequest: ToolApprovalRequest): void {
    const session = this.getTrackedSessionById(
      approvalRequest.request.sessionId,
    );
    if (!session) {
      return;
    }

    const pendingRequests = [
      ...(session.toolApprovalState?.pendingRequests || []).filter(
        (entry) => entry.id !== approvalRequest.id,
      ),
      approvalRequest,
    ].sort((a, b) => a.createdAt - b.createdAt);

    session.toolApprovalState = {
      pendingRequests,
      updatedAt: Date.now(),
    };
    this.persistApprovalState(session);
    this.notifyApprovalStateChanged(session);
    this.emitApprovalRuntimeEvent(
      session,
      {
        type: "approval_requested",
        requestId: approvalRequest.id,
        toolCallId: approvalRequest.request.toolCall.id,
        toolName: approvalRequest.toolName,
        riskLevel: approvalRequest.descriptor.riskLevel,
        pendingCount: pendingRequests.length,
      },
      approvalRequest.assistantMessageId,
    );
  }

  private handleApprovalResolved(
    approvalRequest: ToolApprovalRequest,
    decision: ToolPermissionDecision,
  ): void {
    const session = this.getTrackedSessionById(
      approvalRequest.request.sessionId,
    );
    if (!session) {
      return;
    }

    const pendingRequests = (
      session.toolApprovalState?.pendingRequests || []
    ).filter((entry) => entry.id !== approvalRequest.id);

    session.toolApprovalState =
      pendingRequests.length > 0
        ? {
            pendingRequests,
            updatedAt: Date.now(),
          }
        : undefined;

    this.persistApprovalState(session);
    this.notifyApprovalStateChanged(session);
    this.emitApprovalRuntimeEvent(
      session,
      {
        type: "approval_resolved",
        requestId: approvalRequest.id,
        toolCallId: approvalRequest.request.toolCall.id,
        toolName: approvalRequest.toolName,
        verdict: decision.verdict,
        scope: decision.scope,
        pendingCount: pendingRequests.length,
      },
      approvalRequest.assistantMessageId,
    );
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
      messages: [],
      contextSummary: undefined,
      contextState: undefined,
      executionPlan: undefined,
      toolExecutionState: undefined,
      toolApprovalState: undefined,
      memoryExtractedAt: undefined,
      memoryExtractedMsgCount: undefined,
      selectedTier: session.selectedTier,
      resolvedModelId: session.resolvedModelId,
      lastRetryableUserMessageId: undefined,
      lastRetryableErrorMessageId: undefined,
      lastRetryableFailedModelId: undefined,
    };
  }

  private applySessionItemContext(session: ChatSession | null): void {
    this.currentItemKey = session?.lastActiveItemKey ?? null;
    getPdfToolManager().setCurrentItemKey(this.currentItemKey);
  }

  private reconcileApprovalState(session: ChatSession | null): void {
    if (!session) {
      return;
    }

    const pendingRequests = getToolPermissionManager().listPendingApprovals(
      session.id,
    );
    const normalizedState: ToolApprovalState | undefined =
      pendingRequests.length > 0
        ? {
            pendingRequests,
            updatedAt: Date.now(),
          }
        : undefined;

    const currentIds = (session.toolApprovalState?.pendingRequests || [])
      .map((entry) => entry.id)
      .sort();
    const normalizedIds = pendingRequests.map((entry) => entry.id).sort();
    const isSameState =
      currentIds.length === normalizedIds.length &&
      currentIds.every((id, index) => id === normalizedIds[index]);

    if (isSameState && !!session.toolApprovalState === !!normalizedState) {
      return;
    }

    session.toolApprovalState = normalizedState;
    this.persistApprovalState(session);
  }

  private persistApprovalState(session: ChatSession): void {
    this.sessionStorage.updateSessionApprovalState(session).catch((error) => {
      ztoolkit.log(
        "[ChatManager] Failed to persist tool approval state:",
        error,
      );
    });
  }

  private notifyApprovalStateChanged(session: ChatSession): void {
    if (this.isSessionActive(session)) {
      this.onExecutionPlanUpdate?.(session.executionPlan);
    }
  }

  private emitApprovalRuntimeEvent(
    session: ChatSession,
    payload:
      | Omit<
          Extract<AgentRuntimeEvent, { type: "approval_requested" }>,
          "sessionId" | "assistantMessageId" | "timestamp" | "planId"
        >
      | Omit<
          Extract<AgentRuntimeEvent, { type: "approval_resolved" }>,
          "sessionId" | "assistantMessageId" | "timestamp" | "planId"
        >,
    assistantMessageId?: string,
  ): void {
    const resolvedAssistantMessageId =
      assistantMessageId ||
      [...session.messages].reverse().find((m) => m.role === "assistant")?.id ||
      payload.toolCallId;

    this.onRuntimeEvent?.({
      ...payload,
      sessionId: session.id,
      assistantMessageId: resolvedAssistantMessageId,
      timestamp: Date.now(),
      planId: session.executionPlan?.id,
    } as AgentRuntimeEvent);
  }

  /**
   * 销毁
   */
  async destroy(): Promise<void> {
    await this.memoryManager.flushOnDestroy(this.currentSession);
    if (this.currentSession) {
      await this.sessionStorage.updateSessionMeta(this.currentSession);
    }
    getToolPermissionManager().removeApprovalObserver(this.approvalObserver);
    this.currentSession = null;
    this.currentItemKey = null;
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
