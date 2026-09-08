import { getPref } from "../../utils/prefs";
import { getString } from "../../utils/locale";
import { getProviderManager } from "../providers";
import { isEmbeddingModel } from "../embedding/providers/PaperChatEmbedding";

function getPaperchatModels(fallback?: string[]): string[] {
  try {
    const cached = JSON.parse(getPref("paperchatModelsCache") || "null");
    if (Array.isArray(cached))
      return cached.filter((m): m is string => typeof m === "string");
  } catch {
    /* Use configured models when the cache is unavailable. */
  }
  return fallback || [];
}

export function getTranslationModelOptions(): Array<{
  value: string;
  label: string;
}> {
  const options: Array<{ value: string; label: string }> = [];
  const add = (value: string, label: string) => options.push({ value, label });
  add("auto", getString("pref-translation-auto"));
  const saved = getPref("translationModel") || "auto";
  let found = saved === "auto";
  for (const provider of getProviderManager().getAllConfigs()) {
    if (!provider.enabled) continue;
    const models =
      provider.type === "paperchat"
        ? getPaperchatModels(provider.availableModels)
        : provider.availableModels;
    for (const model of new Set(
      [...(models || []), provider.defaultModel].filter(
        (m): m is string => !!m && !isEmbeddingModel(m),
      ),
    )) {
      const value = JSON.stringify({ providerId: provider.id, model });
      add(value, `${provider.name} · ${model}`);
      if (value === saved) found = true;
    }
  }
  if (!found) add(saved, getString("pref-translation-model-unavailable"));
  return options;
}
