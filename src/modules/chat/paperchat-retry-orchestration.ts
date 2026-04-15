import type { ChatSession, ImageAttachment } from "../../types/chat";
import type { PaperChatTier } from "../providers/paperchat-tier-routing";
import {
  applyPaperChatSessionBinding,
  repairPaperChatSessionBindingAfterHardFailure,
} from "./paperchat-session-state";

export type PaperChatRerouteResult = {
  previousModel: string;
  nextModel: string;
  tier: PaperChatTier;
};

type RepairPaperChatSessionAfterHardFailureOptions = {
  session: ChatSession;
  failedModelId: string | null;
  previousTierStateRaw: string;
  availableModels: string[];
  ratios: Record<string, number>;
  persistSessionMeta: (session: ChatSession) => Promise<void>;
  setTierStateRaw: (raw: string) => void;
  updateProviderOverride: (modelId: string | undefined) => void;
  pickRandom?: (candidates: string[]) => string | null | undefined;
};

export async function repairPaperChatSessionAfterHardFailureWithRollback(
  options: RepairPaperChatSessionAfterHardFailureOptions,
): Promise<PaperChatRerouteResult | null> {
  const {
    session,
    failedModelId,
    previousTierStateRaw,
    availableModels,
    ratios,
    persistSessionMeta,
    setTierStateRaw,
    updateProviderOverride,
    pickRandom,
  } = options;
  const previousSessionState = {
    selectedTier: session.selectedTier,
    resolvedModelId: session.resolvedModelId,
    updatedAt: session.updatedAt,
  };
  const repair = repairPaperChatSessionBindingAfterHardFailure(
    session,
    previousTierStateRaw,
    availableModels,
    ratios,
    failedModelId,
    pickRandom,
  );

  if (!repair || !repair.previousModelId) {
    return null;
  }

  setTierStateRaw(JSON.stringify(repair.state));
  applyPaperChatSessionBinding(session, repair);

  try {
    await persistSessionMeta(session);
  } catch (error) {
    setTierStateRaw(previousTierStateRaw);
    session.selectedTier = previousSessionState.selectedTier;
    session.resolvedModelId = previousSessionState.resolvedModelId;
    session.updatedAt = previousSessionState.updatedAt;
    updateProviderOverride(previousSessionState.resolvedModelId);
    throw error;
  }

  updateProviderOverride(repair.modelId);

  return {
    previousModel: repair.previousModelId,
    nextModel: repair.modelId,
    tier: repair.selectedTier,
  };
}

type RerollPaperChatFailureAndReplayOptions<TItem> = {
  session: ChatSession;
  rerollTier: () => Promise<PaperChatRerouteResult | null>;
  deleteMessage: (sessionId: string, messageId: string) => Promise<void>;
  buildSystemNotice: (reroute: PaperChatRerouteResult) => string;
  insertSystemNotice: (session: ChatSession, content: string) => Promise<void>;
  resend: (payload: {
    content: string;
    images?: ImageAttachment[];
    item: TItem;
  }) => Promise<void>;
  getItem: (session: ChatSession) => TItem;
};

export async function rerollPaperChatFailureAndReplay<TItem>(
  options: RerollPaperChatFailureAndReplayOptions<TItem>,
): Promise<PaperChatRerouteResult | null> {
  const {
    session,
    rerollTier,
    deleteMessage,
    buildSystemNotice,
    insertSystemNotice,
    resend,
    getItem,
  } = options;

  if (
    !session.lastRetryableUserMessageId
    || !session.lastRetryableErrorMessageId
  ) {
    return null;
  }

  const userMessageIndex = session.messages.findIndex(
    (message) => message.id === session.lastRetryableUserMessageId,
  );
  const errorMessageIndex = session.messages.findIndex(
    (message) => message.id === session.lastRetryableErrorMessageId,
  );
  if (userMessageIndex === -1 || errorMessageIndex === -1) {
    return null;
  }

  const userMessage = session.messages[userMessageIndex];
  if (userMessage.role !== "user") {
    return null;
  }

  const reroute = await rerollTier();
  if (!reroute) {
    return null;
  }

  const removalOrder = [userMessageIndex, errorMessageIndex].sort((a, b) => b - a);
  for (const index of removalOrder) {
    const [removed] = session.messages.splice(index, 1);
    if (removed) {
      await deleteMessage(session.id, removed.id);
    }
  }

  await insertSystemNotice(session, buildSystemNotice(reroute));
  await resend({
    content: userMessage.content,
    images: userMessage.images,
    item: getItem(session),
  });

  return reroute;
}
