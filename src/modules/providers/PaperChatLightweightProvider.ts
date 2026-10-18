import type { AIProvider, PaperChatProviderConfig } from "../../types/provider";
import { getProviderManager } from "./ProviderManager";
import { PaperChatProvider } from "./PaperChatProvider";
import { deriveTierPools } from "./paperchat-tier-routing";
import {
  getModelRatios,
  getModelRoutingMeta,
  getSelectablePaperchatModels,
} from "../preferences/ModelsFetcher";

export interface PaperChatLightweightProviderOptions {
  maxTokens: number;
  temperature: number;
  systemPrompt?: string;
  modelId?: string;
}

export function createPaperChatLightweightProvider(
  options: PaperChatLightweightProviderOptions,
): AIProvider | null {
  const providerManager = getProviderManager();
  const config = providerManager.getProviderConfig("paperchat");
  if (!config || config.type !== "paperchat") {
    return null;
  }

  const availableModels = getSelectablePaperchatModels();
  const ratios = getModelRatios();
  const pools = deriveTierPools(availableModels, ratios, getModelRoutingMeta());
  const modelId =
    (options.modelId && availableModels.includes(options.modelId)
      ? options.modelId
      : undefined) ||
    pickLowestRatioModel(pools["paperchat-lite"], ratios) ||
    pickLowestRatioModel(availableModels, ratios);
  if (!modelId) {
    return null;
  }

  const lightweightConfig: PaperChatProviderConfig = {
    ...config,
    resolvedModelOverride: modelId,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    systemPrompt: options.systemPrompt || "",
  };
  return new PaperChatProvider(lightweightConfig);
}

function pickLowestRatioModel(
  models: string[],
  ratios: Record<string, number>,
): string | undefined {
  return [...models].sort((a, b) => {
    const ratioA = ratios[a] ?? Number.POSITIVE_INFINITY;
    const ratioB = ratios[b] ?? Number.POSITIVE_INFINITY;
    if (ratioA !== ratioB) {
      return ratioA - ratioB;
    }
    return a.localeCompare(b);
  })[0];
}
