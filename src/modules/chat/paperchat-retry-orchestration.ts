import type { ChatSession, ImageAttachment } from "../../types/chat";
import type { PaperChatTier } from "../providers/paperchat-tier-routing";
import type { PaperChatModelRoutingMetaMap } from "../providers/paperchat-routing-metadata";
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
  routingMeta?: PaperChatModelRoutingMetaMap;
  requiresVision?: boolean;
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
    routingMeta,
    requiresVision,
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
    routingMeta,
    { vision: requiresVision },
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
  rerollTier: (
    requiresVision: boolean,
  ) => Promise<PaperChatRerouteResult | null>;
  buildSystemNotice: (reroute: PaperChatRerouteResult) => string;
  insertSystemNotice: (
    session: ChatSession,
    content: string,
  ) => Promise<string>;
  rollbackReroute: (
    reroute: PaperChatRerouteResult,
    noticeMessageId?: string,
  ) => Promise<void>;
  resend: (payload: {
    content: string;
    images?: ImageAttachment[];
    item: TItem;
    sourceUserMessageId: string;
  }) => Promise<boolean>;
  getItem: (session: ChatSession) => TItem;
};

export async function rerollPaperChatFailureAndReplay<TItem>(
  options: RerollPaperChatFailureAndReplayOptions<TItem>,
): Promise<PaperChatRerouteResult | null> {
  const {
    session,
    rerollTier,
    buildSystemNotice,
    insertSystemNotice,
    rollbackReroute,
    resend,
    getItem,
  } = options;

  if (
    !session.lastRetryableUserMessageId ||
    !session.lastRetryableErrorMessageId
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
  const errorMessage = session.messages[errorMessageIndex];
  if (userMessage.role !== "user" || errorMessage.role !== "error") {
    return null;
  }

  const requiresVision = session.messages
    .slice(0, userMessageIndex + 1)
    .some((message) => (message.images?.length ?? 0) > 0);
  const reroute = await rerollTier(requiresVision);
  if (!reroute) {
    return null;
  }

  let noticeMessageId: string | undefined;
  try {
    noticeMessageId = await insertSystemNotice(
      session,
      buildSystemNotice(reroute),
    );
    const accepted = await resend({
      content: userMessage.content,
      images: userMessage.images,
      item: getItem(session),
      sourceUserMessageId: userMessage.id,
    });
    if (accepted) {
      return reroute;
    }
  } catch (error) {
    try {
      await rollbackReroute(reroute, noticeMessageId);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "PaperChat replay failed and its reroute could not be rolled back.",
      );
    }
    throw error;
  }

  await rollbackReroute(reroute, noticeMessageId);
  return null;
}
