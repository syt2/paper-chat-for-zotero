import type { ChatSession } from "../../types/chat";
import {
  parseTierState,
  resolveTierModel,
  type PaperChatTier,
  type PaperChatTierPools,
} from "../providers/paperchat-tier-routing";
import type { PaperChatModelRoutingMetaMap } from "../providers/paperchat-routing-metadata";

function createFastPathPools(
  selectedTier: PaperChatTier,
  modelId: string,
): PaperChatTierPools {
  return {
    "paperchat-lite": selectedTier === "paperchat-lite" ? [modelId] : [],
    "paperchat-standard": selectedTier === "paperchat-standard" ? [modelId] : [],
    "paperchat-pro": selectedTier === "paperchat-pro" ? [modelId] : [],
    "paperchat-ultra": selectedTier === "paperchat-ultra" ? [modelId] : [],
  };
}

export function resolveSessionPaperChatModel(
  session: ChatSession,
  tierStateRaw: unknown,
  availableModels: string[],
  ratios: Record<string, number>,
  pickRandom?: (candidates: string[]) => string | null | undefined,
  routingMeta: PaperChatModelRoutingMetaMap = {},
): {
  selectedTier: PaperChatTier;
  state: ReturnType<typeof parseTierState>;
  modelId: string | null;
  pools: ReturnType<typeof resolveTierModel>["pools"];
} {
  const globalState = parseTierState(tierStateRaw);
  const selectedTier = session.selectedTier || globalState.selectedTier;
  const availableSet = new Set(availableModels);
  const configuredTierEntry = globalState.tiers[selectedTier];

  if (
    configuredTierEntry.mode === "manual" &&
    configuredTierEntry.modelId &&
    availableSet.has(configuredTierEntry.modelId)
  ) {
    const state = {
      selectedTier,
      tiers: { ...globalState.tiers },
    };

    return {
      selectedTier,
      state,
      modelId: configuredTierEntry.modelId,
      pools: createFastPathPools(selectedTier, configuredTierEntry.modelId),
    };
  }

  if (session.resolvedModelId && availableSet.has(session.resolvedModelId)) {
    const state = {
      selectedTier,
      tiers: { ...globalState.tiers },
    };

    return {
      selectedTier,
      state,
      modelId: session.resolvedModelId,
      pools: createFastPathPools(selectedTier, session.resolvedModelId),
    };
  }

  const resolved = resolveTierModel(
    globalState,
    selectedTier,
    availableModels,
    ratios,
    pickRandom,
    routingMeta,
  );

  return {
    selectedTier: resolved.state.selectedTier,
    state: resolved.state,
    modelId: resolved.modelId,
    pools: resolved.pools,
  };
}
