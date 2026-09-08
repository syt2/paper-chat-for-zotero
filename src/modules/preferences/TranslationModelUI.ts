import { getPref, setPref } from "../../utils/prefs";
import { getString } from "../../utils/locale";
import { getProviderManager } from "../providers";
import { isEmbeddingModel } from "../embedding/providers/PaperChatEmbedding";
import { clearElement } from "./utils";

function getPaperchatModels(
  fallback?: string[],
  supplied?: string[],
): string[] {
  if (supplied) return supplied;
  try {
    const cached = JSON.parse(getPref("paperchatModelsCache") || "null");
    if (Array.isArray(cached))
      return cached.filter((m): m is string => typeof m === "string");
  } catch {
    /* Use configured models when the cache is unavailable. */
  }
  return fallback || [];
}

export function populateTranslationModels(
  doc: Document,
  paperchatModels?: string[],
): void {
  const select = doc.getElementById(
    "pref-translation-model",
  ) as unknown as XULMenuListElement | null;
  const popup = doc.getElementById("pref-translation-model-popup");
  if (!select || !popup) return;
  clearElement(popup);
  const add = (value: string, label: string) => {
    const item = doc.createXULElement("menuitem");
    item.setAttribute("value", value);
    item.setAttribute("label", label);
    popup.appendChild(item);
  };
  add("auto", getString("pref-translation-auto"));
  add("", getString("pref-translation-follow-chat"));
  const saved = getPref("translationModel") || "";
  let found = !saved || saved === "auto";
  for (const provider of getProviderManager().getAllConfigs()) {
    if (!provider.enabled) continue;
    const models =
      provider.type === "paperchat"
        ? getPaperchatModels(provider.availableModels, paperchatModels)
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
  select.value = saved;
}

export function bindTranslationModelEvents(doc: Document): void {
  const translationSelect = doc.getElementById(
    "pref-translation-model",
  ) as unknown as XULMenuListElement | null;
  translationSelect?.addEventListener("command", () =>
    setPref("translationModel", translationSelect.value),
  );
  doc
    .getElementById("pref-translation-model-popup")
    ?.addEventListener("popupshowing", () => populateTranslationModels(doc));
}
