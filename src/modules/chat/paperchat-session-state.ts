import type { ChatSession } from "../../types/chat";
import {
  parseTierState,
  resolveTierModel,
  rerollTierModel,
  type PaperChatTierState,
} from "../providers/paperchat-tier-routing";
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
): ResolvePaperChatSessionBindingResult {
  const resolution = resolveSessionPaperChatModel(
    session,
    tierStateRaw,
    availableModels,
    ratios,
    pickRandom,
  );

  if (!resolution.modelId) {
    throw new Error("PaperChat tier routing could not resolve an available model");
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
    session.selectedTier !== binding.selectedTier
    || session.resolvedModelId !== binding.modelId;

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
): RepairPaperChatSessionBindingResult | null {
  const globalState = parseTierState(tierStateRaw);
  const selectedTier = session.selectedTier || globalState.selectedTier;
  const resolution = resolveTierModel(
    globalState,
    selectedTier,
    availableModels,
    ratios,
    pickRandom,
  );

  const previousModelId = failedModelId ?? session.resolvedModelId ?? null;
  const reroutedModelId = rerollTierModel(
    resolution.pools[selectedTier],
    previousModelId,
    pickRandom ?? ((candidates) => candidates[0] ?? null),
  );
  const modelId =
    reroutedModelId
    || (resolution.modelId !== previousModelId ? resolution.modelId : null);

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
