import type { ChatSession } from "../../types/chat";
import {
  PAPERCHAT_TIERS,
  parseTierState,
  resolveTierModel,
  type PaperChatTier,
  type PaperChatTierPools,
} from "../providers/paperchat-tier-routing";

function createFastPathPools(
  selectedTier: PaperChatTier,
  modelId: string,
): PaperChatTierPools {
  return {
    "paperchat-lite": selectedTier === "paperchat-lite" ? [modelId] : [],
    "paperchat-standard": selectedTier === "paperchat-standard" ? [modelId] : [],
    "paperchat-pro": selectedTier === "paperchat-pro" ? [modelId] : [],
  };
}

export function resolveSessionPaperChatModel(
  session: ChatSession,
  tierStateRaw: unknown,
  availableModels: string[],
  ratios: Record<string, number>,
  pickRandom?: (candidates: string[]) => string | null | undefined,
): {
  selectedTier: PaperChatTier;
  state: ReturnType<typeof parseTierState>;
  modelId: string | null;
  pools: ReturnType<typeof resolveTierModel>["pools"];
} {
  const availableSet = new Set(availableModels);

  if (session.resolvedModelId && availableSet.has(session.resolvedModelId)) {
    const globalState = parseTierState(tierStateRaw);
    const selectedTier = session.selectedTier || globalState.selectedTier;
    const state = {
      selectedTier,
      tiers: { ...globalState.tiers },
    };

    // Keep the reported selected tier aligned with the session binding while
    // avoiding a full pool re-derivation on the common send-message path.
    if (!PAPERCHAT_TIERS.includes(state.selectedTier)) {
      state.selectedTier = globalState.selectedTier;
    }

    return {
      selectedTier,
      state,
      modelId: session.resolvedModelId,
      pools: createFastPathPools(selectedTier, session.resolvedModelId),
    };
  }

  const globalState = parseTierState(tierStateRaw);
  const selectedTier = session.selectedTier || globalState.selectedTier;
  const resolved = resolveTierModel(
    globalState,
    selectedTier,
    availableModels,
    ratios,
    pickRandom,
  );

  return {
    selectedTier,
    state: resolved.state,
    modelId: resolved.modelId,
    pools: resolved.pools,
  };
}
