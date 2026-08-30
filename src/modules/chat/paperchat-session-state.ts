import type { ChatSession } from "../../types/chat";
import {
  parseTierState,
  resolveTierModel,
  rerollTierModel,
  type PaperChatTierState,
} from "../providers/paperchat-tier-routing";
import type { PaperChatModelRoutingMetaMap } from "../providers/paperchat-routing-metadata";
import { getPaperChatApiCapabilities } from "../providers/paperchat-routing-metadata";
import { resolveSessionPaperChatModel } from "./paperchat-session-routing";

type ResolvePaperChatSessionBindingResult = {
  selectedTier: NonNullable<ChatSession["selectedTier"]>;
  modelId: string;
};

export type RepairPaperChatSessionBindingResult =
  ResolvePaperChatSessionBindingResult & {
    previousModelId: string | null;
    state: PaperChatTierState;
  };

export function resolvePaperChatSessionBinding(
  session: ChatSession,
  tierStateRaw: unknown,
  availableModels: string[],
  ratios: Record<string, number>,
  pickRandom?: (candidates: string[]) => string | null | undefined,
  routingMeta: PaperChatModelRoutingMetaMap = {},
): ResolvePaperChatSessionBindingResult {
  const resolution = resolveSessionPaperChatModel(
    session,
    tierStateRaw,
    availableModels,
    ratios,
    pickRandom,
    routingMeta,
  );

  if (!resolution.modelId) {
    throw new Error(
      "PaperChat tier routing could not resolve an available model",
    );
  }

  return {
    selectedTier: resolution.selectedTier,
    modelId: resolution.modelId,
  };
}

export function applyPaperChatSessionBinding(
  session: ChatSession,
  binding: ResolvePaperChatSessionBindingResult,
): boolean {
  const didChange =
    session.selectedTier !== binding.selectedTier ||
    session.resolvedModelId !== binding.modelId;

  session.selectedTier = binding.selectedTier;
  session.resolvedModelId = binding.modelId;

  return didChange;
}

export function clearPaperChatRetryableState(session: ChatSession): void {
  session.lastRetryableUserMessageId = undefined;
  session.lastRetryableErrorMessageId = undefined;
  session.lastRetryableFailedModelId = undefined;
}

export function repairPaperChatSessionBindingAfterHardFailure(
  session: ChatSession,
  tierStateRaw: unknown,
  availableModels: string[],
  ratios: Record<string, number>,
  failedModelId: string | null,
  pickRandom?: (candidates: string[]) => string | null | undefined,
  routingMeta: PaperChatModelRoutingMetaMap = {},
  requirements: { vision?: boolean } = {},
): RepairPaperChatSessionBindingResult | null {
  const globalState = parseTierState(tierStateRaw);
  const requestedTier = session.selectedTier || globalState.selectedTier;
  const resolution = resolveTierModel(
    globalState,
    requestedTier,
    availableModels,
    ratios,
    pickRandom,
    routingMeta,
  );
  const selectedTier = resolution.state.selectedTier;

  const previousModelId = failedModelId ?? session.resolvedModelId ?? null;
  const rerouteCandidates = requirements.vision
    ? resolution.pools[selectedTier].filter(
        (model) =>
          getPaperChatApiCapabilities(model, routingMeta).vision === true,
      )
    : resolution.pools[selectedTier];
  const reroutedModelId = rerollTierModel(
    rerouteCandidates,
    previousModelId,
    pickRandom ?? ((candidates) => candidates[0] ?? null),
    routingMeta,
  );
  const resolvedFallbackModelId = resolution.modelId;
  const modelId =
    reroutedModelId ||
    (resolvedFallbackModelId !== null &&
    resolvedFallbackModelId !== previousModelId &&
    (!requirements.vision ||
      rerouteCandidates.includes(resolvedFallbackModelId))
      ? resolvedFallbackModelId
      : null);

  if (!modelId) {
    return null;
  }

  return {
    selectedTier,
    modelId,
    previousModelId,
    state: resolution.state,
  };
}
