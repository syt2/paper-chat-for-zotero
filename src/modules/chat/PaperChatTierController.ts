/**
 * PaperChatTierController - PaperChat tier selection, reroll, and failed-turn
 * retry state.
 *
 * Owns the user-facing tier operations (reroll the resolved model within a
 * tier, switch tiers, clear/retry the last retryable failure, reroll+retry in
 * one step) and the failure-state helpers shared with ChatManager's send
 * loop (snapshotting a failed assistant message, persisting the interrupted
 * remnant, recording retryable-failure metadata).
 *
 * The host (ChatManager) supplies session context, storage, notice insertion,
 * and resend. Reroll bookkeeping (`paperChatRerollSessions`) stays on the
 * host so its white-box tests keep their seams; the controller reaches it
 * through begin/end/isRerollInProgress.
 */

import type { ChatMessage, ChatSession } from "../../types/chat";
import { getErrorMessage } from "../../utils/common";
import { getProviderManager } from "../providers";
import {
  rerollTierModel,
  deriveTierPools,
  type PaperChatTier,
} from "../providers/paperchat-tier-routing";
import { isPaperChatQuotaError } from "../providers/paperchat-errors";
import {
  getModelRatios,
  getModelRoutingMeta,
} from "../preferences/ModelsFetcher";
import { clearPaperChatRetryableState } from "./paperchat-session-state";
import { rerollPaperChatFailureAndReplay } from "./paperchat-retry-orchestration";
import {
  getPaperChatChatModels,
  pickRandomCandidate,
} from "./PaperChatRetryOrchestrator";
import { stripPendingAndIncompleteToolCallContent } from "./interrupted-message";
import { retainCompletedApiOnlyModelContextMessagesForTurn } from "./agent-runtime/AgentRuntime";
import { ANALYTICS_EVENTS, getAnalyticsService } from "../analytics";
import type { SessionStorageService } from "./SessionStorageService";

export type FailedAssistantSnapshot = Pick<
  ChatMessage,
  | "content"
  | "reasoning"
  | "evidence"
  | "sourceItemKeys"
  | "presentationArtifacts"
>;

export function selectMoreSubstantialSnapshot(
  current: FailedAssistantSnapshot | null,
  previous: FailedAssistantSnapshot | null,
): FailedAssistantSnapshot | null {
  if (!current) return previous;
  if (!previous) return current;
  const preferred =
    current.content.length >= previous.content.length ? current : previous;
  const artifacts = mergePresentationArtifacts(
    previous.presentationArtifacts,
    current.presentationArtifacts,
  );
  return {
    ...preferred,
    presentationArtifacts: artifacts.length ? artifacts : undefined,
  };
}

function mergePresentationArtifacts(
  previous: ChatMessage["presentationArtifacts"],
  current: ChatMessage["presentationArtifacts"],
): NonNullable<ChatMessage["presentationArtifacts"]> {
  const merged = new Map<
    string,
    NonNullable<ChatMessage["presentationArtifacts"]>[number]
  >();
  for (const artifact of [...(previous || []), ...(current || [])]) {
    const key = artifact.localId || artifact.toolCallId;
    const existing = merged.get(key);
    merged.set(
      key,
      existing
        ? {
            ...existing,
            ...artifact,
            path: artifact.path || existing.path,
            previewPaths: artifact.previewPaths || existing.previewPaths,
            attachmentItemID:
              artifact.attachmentItemID || existing.attachmentItemID,
          }
        : artifact,
    );
  }
  return [...merged.values()];
}

export interface PaperChatTierRerollResult {
  previousModel: string;
  nextModel: string;
  tier: PaperChatTier;
}

/** Options the controller passes back into the host's sendMessage. */
export interface PaperChatResendOptions {
  item?: Zotero.Item | null;
  images?: ChatMessage["images"];
  fromPaperChatReroll: boolean;
  resumeFailedTurn: boolean;
  reuseUserMessageId: string;
  targetSession: ChatSession;
  requireTargetSessionActive: boolean;
}

/** ChatManager services the controller borrows. */
export interface PaperChatTierHost {
  init(): Promise<void>;
  getCurrentSession(): ChatSession | null;
  getSessionStorage(): SessionStorageService;
  isSessionRunActive(sessionId: string): boolean;
  isRerollInProgress(sessionId: string): boolean;
  beginReroll(sessionId: string): void;
  endReroll(sessionId: string): void;
  /**
   * Routes through ChatManager's public rerollCurrentPaperChatTier so
   * instance-level test stubs keep intercepting the reroll+retry flow.
   */
  rerollTier(): Promise<PaperChatTierRerollResult | null>;
  buildReroutedNotice(
    tier: PaperChatTier,
    previousModel: string,
    nextModel: string,
  ): string;
  insertSystemNotice(
    session: ChatSession,
    content: string,
  ): Promise<ChatMessage>;
  sendMessage(
    content: string,
    options: PaperChatResendOptions,
  ): Promise<boolean>;
  getSessionItem(session: ChatSession): Zotero.Item | null;
  notifyMessagesUpdated(messages: ChatMessage[]): void;
}

export class PaperChatTierController {
  constructor(private readonly host: PaperChatTierHost) {}

  async rerollCurrentPaperChatTier(): Promise<PaperChatTierRerollResult | null> {
    await this.host.init();

    const session = this.host.getCurrentSession();
    if (!session || !session.selectedTier || !session.resolvedModelId) {
      return null;
    }

    const providerManager = getProviderManager();
    const provider = providerManager.getActiveProvider();
    if (!provider || providerManager.getActiveProviderId() !== "paperchat") {
      return null;
    }

    const availableModels = getPaperChatChatModels();
    const routingMeta = getModelRoutingMeta();
    const pools = deriveTierPools(
      availableModels,
      getModelRatios(),
      routingMeta,
    );
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
      await this.host.getSessionStorage().updateSessionMeta(session);
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
    await this.host.init();

    const session = this.host.getCurrentSession();
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
      await this.host.getSessionStorage().updateSessionMeta(session);
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
    await this.host.init();

    const session = this.host.getCurrentSession();
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
      await this.host.getSessionStorage().updateSessionMeta(session);
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

  async retryCurrentPaperChatFailure(): Promise<boolean> {
    await this.host.init();

    const session = this.host.getCurrentSession();
    if (
      !session ||
      getProviderManager().getActiveProviderId() !== "paperchat" ||
      this.host.isSessionRunActive(session.id) ||
      this.host.isRerollInProgress(session.id) ||
      !session.lastRetryableUserMessageId ||
      !session.lastRetryableErrorMessageId
    ) {
      return false;
    }

    const userMessage = session.messages.find(
      (message) =>
        message.id === session.lastRetryableUserMessageId &&
        message.role === "user",
    );
    const errorMessage = session.messages.find(
      (message) =>
        message.id === session.lastRetryableErrorMessageId &&
        message.role === "error",
    );
    if (!userMessage || !errorMessage) {
      return false;
    }

    this.host.beginReroll(session.id);
    try {
      return await this.host.sendMessage(userMessage.content, {
        item: this.host.getSessionItem(session),
        images: userMessage.images,
        fromPaperChatReroll: true,
        resumeFailedTurn: true,
        reuseUserMessageId: userMessage.id,
        targetSession: session,
        requireTargetSessionActive: true,
      });
    } finally {
      this.host.endReroll(session.id);
    }
  }

  async rerollCurrentPaperChatFailureAndRetry(): Promise<PaperChatTierRerollResult | null> {
    await this.host.init();

    const session = this.host.getCurrentSession();
    if (
      !session ||
      this.host.isSessionRunActive(session.id) ||
      this.host.isRerollInProgress(session.id)
    ) {
      return null;
    }

    this.host.beginReroll(session.id);
    const previousState = {
      resolvedModelId: session.resolvedModelId,
      lastRetryableUserMessageId: session.lastRetryableUserMessageId,
      lastRetryableErrorMessageId: session.lastRetryableErrorMessageId,
      lastRetryableFailedModelId: session.lastRetryableFailedModelId,
      updatedAt: session.updatedAt,
    };
    try {
      return await rerollPaperChatFailureAndReplay<Zotero.Item | null>({
        session,
        rerollTier: () => this.host.rerollTier(),
        buildSystemNotice: (reroute) =>
          this.host.buildReroutedNotice(
            reroute.tier,
            reroute.previousModel,
            reroute.nextModel,
          ),
        insertSystemNotice: async (targetSession, content) =>
          (await this.host.insertSystemNotice(targetSession, content)).id,
        rollbackReroute: async (_reroute, noticeMessageId) => {
          const restoreState = (targetSession: ChatSession) => {
            targetSession.resolvedModelId = previousState.resolvedModelId;
            targetSession.lastRetryableUserMessageId =
              previousState.lastRetryableUserMessageId;
            targetSession.lastRetryableErrorMessageId =
              previousState.lastRetryableErrorMessageId;
            targetSession.lastRetryableFailedModelId =
              previousState.lastRetryableFailedModelId;
            targetSession.updatedAt = previousState.updatedAt;
          };
          restoreState(session);
          const currentSession = this.host.getCurrentSession();
          if (currentSession?.id === session.id && currentSession !== session) {
            restoreState(currentSession);
          }

          if (noticeMessageId) {
            const noticeIndex = session.messages.findIndex(
              (message) => message.id === noticeMessageId,
            );
            if (noticeIndex >= 0) {
              session.messages.splice(noticeIndex, 1);
            }
          }

          getProviderManager()
            .getProvider("paperchat")
            ?.updateConfig({
              resolvedModelOverride:
                this.host.getCurrentSession()?.resolvedModelId ||
                previousState.resolvedModelId,
            });
          const notifySession = this.host.getCurrentSession();
          if (notifySession?.id === session.id) {
            this.host.notifyMessagesUpdated(notifySession.messages);
          }
          let rollbackError: unknown = null;
          try {
            await this.host.getSessionStorage().updateSessionMeta(session);
          } catch (error) {
            rollbackError = error;
          }
          if (noticeMessageId) {
            try {
              await this.host
                .getSessionStorage()
                .deleteMessage(session.id, noticeMessageId);
            } catch (error) {
              rollbackError ||= error;
            }
          }
          if (rollbackError) {
            throw rollbackError;
          }
        },
        resend: ({ content, images, item, sourceUserMessageId }) =>
          this.host.sendMessage(content, {
            item,
            images,
            fromPaperChatReroll: true,
            resumeFailedTurn: true,
            reuseUserMessageId: sourceUserMessageId,
            targetSession: session,
            requireTargetSessionActive: true,
          }),
        getItem: (targetSession) => this.host.getSessionItem(targetSession),
      });
    } finally {
      this.host.endReroll(session.id);
    }
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
    const isPaperChatFailure = failedProviderId === "paperchat";

    if (isPaperChatFailure && isPaperChatQuotaError(error)) {
      getAnalyticsService().track(ANALYTICS_EVENTS.paperChatQuotaError, {
        provider: failedProviderId,
      });
    }

    const isRetryablePaperChatFailure =
      allowRetry && isPaperChatFailure && !isPaperChatQuotaError(error);

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

  clearFailedTurnRuntimeState(session: ChatSession): void {
    session.executionPlan = undefined;
    if (!session.toolExecutionState?.results.length) {
      session.toolExecutionState = undefined;
    }
    session.toolApprovalState = undefined;
  }

  createFailedAssistantSnapshot(
    assistantMessage: ChatMessage,
  ): FailedAssistantSnapshot | null {
    const content = stripPendingAndIncompleteToolCallContent(
      assistantMessage.content,
    );
    const reasoning = assistantMessage.reasoning?.trim() || undefined;
    const evidence = assistantMessage.evidence?.length
      ? assistantMessage.evidence
      : undefined;
    const sourceItemKeys = assistantMessage.sourceItemKeys?.length
      ? assistantMessage.sourceItemKeys
      : undefined;
    const presentationArtifacts = assistantMessage.presentationArtifacts?.length
      ? assistantMessage.presentationArtifacts
      : undefined;
    return content || reasoning || evidence || presentationArtifacts
      ? {
          content,
          reasoning,
          evidence,
          sourceItemKeys,
          presentationArtifacts,
        }
      : null;
  }

  resetAssistantForRetry(assistantMessage: ChatMessage): void {
    assistantMessage.content = "";
    delete assistantMessage.reasoning;
    delete assistantMessage.evidence;
    delete assistantMessage.tool_calls;
    // A reused interrupted message represents a new attempt. Keep any previous
    // PPTX in the captured failure snapshot, but do not show it as output from
    // the retry before the new attempt emits its own artifact checkpoint.
    delete assistantMessage.presentationArtifacts;
    assistantMessage.streamingState = "in_progress";
  }

  async finalizeFailedAssistantMessage(
    session: ChatSession,
    assistantMessage: ChatMessage,
    fallbackSnapshot: FailedAssistantSnapshot | null,
  ): Promise<boolean> {
    const toolContextChanged =
      retainCompletedApiOnlyModelContextMessagesForTurn(
        session,
        assistantMessage.id,
      );
    this.clearFailedTurnRuntimeState(session);

    const snapshot = selectMoreSubstantialSnapshot(
      this.createFailedAssistantSnapshot(assistantMessage),
      fallbackSnapshot,
    );
    if (!snapshot) {
      const assistantIndex = session.messages.findIndex(
        (message) => message.id === assistantMessage.id,
      );
      if (assistantIndex >= 0) {
        session.messages.splice(assistantIndex, 1);
        await this.host
          .getSessionStorage()
          .deleteMessage(session.id, assistantMessage.id);
      }
      if (toolContextChanged) {
        await this.host.getSessionStorage().saveSession(session);
      }
      return false;
    }

    assistantMessage.content = snapshot.content;
    assistantMessage.reasoning = snapshot.reasoning;
    assistantMessage.evidence = snapshot.evidence;
    assistantMessage.sourceItemKeys = snapshot.sourceItemKeys;
    assistantMessage.presentationArtifacts = snapshot.presentationArtifacts;
    assistantMessage.streamingState = "interrupted";
    assistantMessage.timestamp = Date.now();
    delete assistantMessage.tool_calls;
    await this.host
      .getSessionStorage()
      .updateMessageContent(
        session.id,
        assistantMessage.id,
        snapshot.content,
        snapshot.reasoning,
        {
          streamingState: "interrupted",
          evidence: snapshot.evidence || [],
          sourceItemKeys: snapshot.sourceItemKeys || [],
          presentationArtifacts: snapshot.presentationArtifacts || [],
        },
      );
    if (toolContextChanged) {
      await this.host.getSessionStorage().saveSession(session);
    }
    return true;
  }

  async applyFailureStateSafely(
    session: ChatSession,
    userMessageId: string,
    errorMessage: ChatMessage,
    error: unknown,
    failedProviderId: string,
    failedModelId: string | null,
    allowRetry: boolean = true,
  ): Promise<void> {
    try {
      await this.applyPaperChatFailureState(
        session,
        userMessageId,
        errorMessage,
        error,
        failedProviderId,
        failedModelId,
        allowRetry,
      );
    } catch (stateError) {
      ztoolkit.log(
        "[PaperChatTierController] Failed to apply provider failure state:",
        getErrorMessage(stateError),
      );
    }
  }
}
