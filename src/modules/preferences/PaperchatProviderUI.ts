/**
 * PaperchatProviderUI - PaperChat provider settings panel
 */

import { getPref, setPref } from "../../utils/prefs";
import { getProviderManager, BUILTIN_PROVIDERS } from "../providers";
import type { PaperChatProviderConfig } from "../../types/provider";
import { formatModelLabel, AUTO_MODEL } from "./ModelsFetcher";
import { clearElement } from "./utils";
import { isEmbeddingModel } from "../embedding/providers/PaperChatEmbedding";
import { getString } from "../../utils/locale";

/**
 * Populate PaperChat panel with settings from provider config
 */
export function populatePaperchatPanel(doc: Document): void {
  const providerManager = getProviderManager();
  const config = providerManager.getProviderConfig(
    "paperchat",
  ) as PaperChatProviderConfig;

  if (!config) return;

  // Populate model dropdown
  populatePaperchatModels(doc);

  // Populate other settings
  const maxTokensEl = doc.getElementById(
    "pref-paperchat-maxtokens",
  ) as HTMLInputElement;
  const temperatureEl = doc.getElementById(
    "pref-paperchat-temperature",
  ) as HTMLInputElement;
  const systemPromptEl = doc.getElementById(
    "pref-paperchat-systemprompt",
  ) as HTMLTextAreaElement;

  if (maxTokensEl) maxTokensEl.value = String(config.maxTokens || 4096);
  if (temperatureEl) temperatureEl.value = String(config.temperature ?? 0.7);
  if (systemPromptEl) systemPromptEl.value = config.systemPrompt || "";
}

/**
 * Populate PaperChat model dropdown from cache, defaults, or API response
 */
export function populatePaperchatModels(
  doc: Document,
  models?: string[],
  saveToCache: boolean = false,
): void {
  const providerManager = getProviderManager();
  const config = providerManager.getProviderConfig(
    "paperchat",
  ) as PaperChatProviderConfig;
  const modelSelect = doc.getElementById(
    "pref-paperchat-model",
  ) as unknown as XULMenuListElement;
  const modelPopup = doc.getElementById("pref-paperchat-model-popup");

  if (!modelSelect || !modelPopup) return;

  // Clear existing items
  clearElement(modelPopup);

  // Get models: from parameter > from provider config > from cache > from defaults
  let modelList = models;
  if (!modelList) {
    // Try from provider config
    if (config?.availableModels && config.availableModels.length > 0) {
      modelList = config.availableModels;
    }
  }
  if (!modelList) {
    // Try to load from cache
    const cachedModels = getPref("paperchatModelsCache") as string;
    if (cachedModels) {
      try {
        modelList = JSON.parse(cachedModels);
      } catch {
        // ignore parse error
      }
    }
  }
  if (!modelList || modelList.length === 0) {
    modelList = BUILTIN_PROVIDERS.paperchat.defaultModels;
  }

  // Filter out embedding models (they are used for RAG, not for chat)
  const chatModels = modelList.filter((model) => !isEmbeddingModel(model));

  // Save to cache and provider config if requested
  if (saveToCache && models) {
    // Cache ALL models (RAG reads embedding models from cache)
    setPref("paperchatModelsCache", JSON.stringify(models));
    // Only set chat models as available
    providerManager.updateProviderConfig("paperchat", {
      availableModels: chatModels,
    });
  }

  // Add "Auto (cheapest)" option at the top
  const autoItem = doc.createXULElement("menuitem");
  autoItem.setAttribute("label", getString("chat-model-auto"));
  autoItem.setAttribute("value", AUTO_MODEL);
  modelPopup.appendChild(autoItem);

  chatModels.forEach((model) => {
    const menuitem = doc.createXULElement("menuitem");
    menuitem.setAttribute("label", formatModelLabel(model, "paperchat"));
    menuitem.setAttribute("value", model);
    modelPopup.appendChild(menuitem);
  });

  // Use model pref as source of truth (consistent with chat dropdown)
  const currentModel = (getPref("model") as string) || config?.defaultModel || AUTO_MODEL;
  // Check if the current model exists in the new list
  const modelExists = currentModel === AUTO_MODEL || chatModels.includes(currentModel);
  if (modelExists) {
    modelSelect.value = currentModel;
  } else {
    // Model was removed — fall back to auto and persist the change
    modelSelect.value = AUTO_MODEL;
    setPref("model", AUTO_MODEL);
    providerManager.updateProviderConfig("paperchat", {
      defaultModel: AUTO_MODEL,
      availableModels: chatModels,
    });
  }
}

/**
 * Save PaperChat provider settings
 */
export function savePaperchatConfig(doc: Document): void {
  const providerManager = getProviderManager();

  const modelSelect = doc.getElementById(
    "pref-paperchat-model",
  ) as unknown as XULMenuListElement;
  const maxTokensEl = doc.getElementById(
    "pref-paperchat-maxtokens",
  ) as HTMLInputElement;
  const temperatureEl = doc.getElementById(
    "pref-paperchat-temperature",
  ) as HTMLInputElement;
  const systemPromptEl = doc.getElementById(
    "pref-paperchat-systemprompt",
  ) as HTMLTextAreaElement;

  const selectedModel = modelSelect?.value || "";

  // Sync model pref (source of truth for chat dropdown)
  if (selectedModel) {
    setPref("model", selectedModel);
  }

  const updates: Partial<PaperChatProviderConfig> = {
    defaultModel: selectedModel,
    maxTokens: parseInt(maxTokensEl?.value) || 4096,
    temperature: parseFloat(temperatureEl?.value) || 0.7,
    systemPrompt: systemPromptEl?.value || "",
  };

  providerManager.updateProviderConfig("paperchat", updates);
}

/**
 * Bind PaperChat panel events
 */
export function bindPaperchatEvents(
  doc: Document,
  onRefreshModels: () => Promise<void>,
): void {
  // PaperChat model selection - save to provider config
  const paperchatModelSelect = doc.getElementById(
    "pref-paperchat-model",
  ) as unknown as XULMenuListElement;
  paperchatModelSelect?.addEventListener("command", () => {
    savePaperchatConfig(doc);
  });

  // PaperChat max tokens
  const paperchatMaxTokensInput = doc.getElementById(
    "pref-paperchat-maxtokens",
  ) as HTMLInputElement;
  paperchatMaxTokensInput?.addEventListener("blur", () =>
    savePaperchatConfig(doc),
  );

  // PaperChat temperature
  const paperchatTemperatureInput = doc.getElementById(
    "pref-paperchat-temperature",
  ) as HTMLInputElement;
  paperchatTemperatureInput?.addEventListener("blur", () =>
    savePaperchatConfig(doc),
  );

  // PaperChat system prompt
  const paperchatSystemPromptInput = doc.getElementById(
    "pref-paperchat-systemprompt",
  ) as HTMLTextAreaElement;
  paperchatSystemPromptInput?.addEventListener("blur", () =>
    savePaperchatConfig(doc),
  );

  // PaperChat refresh models button
  const paperchatRefreshBtn = doc.getElementById(
    "pref-paperchat-refresh-models",
  );
  ztoolkit.log(
    "[Preferences] paperchatRefreshBtn element:",
    paperchatRefreshBtn ? "found" : "NOT FOUND",
  );
  paperchatRefreshBtn?.addEventListener("click", async () => {
    ztoolkit.log("[Preferences] Refresh models button clicked");
    await onRefreshModels();
  });
}
