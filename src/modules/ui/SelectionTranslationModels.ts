import { getSelectablePaperchatModels } from "../preferences/ModelsFetcher";
import { getPref } from "../../utils/prefs";
import { getString } from "../../utils/locale";
import { getProviderManager } from "../providers";
import { isEmbeddingModel } from "../embedding/providers/PaperChatEmbedding";

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
        ? getSelectablePaperchatModels()
        : provider.availableModels;
    for (const model of new Set(
      [
        ...(models || []),
        ...(provider.type === "paperchat" ? [] : [provider.defaultModel]),
      ].filter((m): m is string => !!m && !isEmbeddingModel(m)),
    )) {
      const value = JSON.stringify({ providerId: provider.id, model });
      add(value, `${provider.name} · ${model}`);
      if (value === saved) found = true;
    }
  }
  if (!found) {
    let savedProviderId: unknown;
    try {
      savedProviderId = JSON.parse(saved).providerId;
    } catch {
      /* Legacy selection. */
    }
    if (savedProviderId !== "paperchat")
      add(saved, getString("pref-translation-model-unavailable"));
  }
  return options;
}
