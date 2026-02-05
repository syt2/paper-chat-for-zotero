/**
 * PaperchatProviderUI - PaperChat provider settings panel
 */

import { getPref, setPref } from "../../utils/prefs";
import { getProviderManager, BUILTIN_PROVIDERS } from "../providers";
import type { PaperChatProviderConfig } from "../../types/provider";
import { formatModelLabel } from "./ModelsFetcher";
import { clearElement } from "./utils";
import { isEmbeddingModel } from "../embedding/providers/PaperChatEmbedding";

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

  // Save to cache and provider config if requested
  if (saveToCache && models) {
    setPref("paperchatModelsCache", JSON.stringify(models));
    providerManager.updateProviderConfig("paperchat", {
      availableModels: models,
    });
  }

  // Filter out embedding models (they are used for RAG, not for chat)
  const chatModels = modelList.filter((model) => !isEmbeddingModel(model));

  chatModels.forEach((model) => {
    const menuitem = doc.createXULElement("menuitem");
    menuitem.setAttribute("label", formatModelLabel(model, "paperchat"));
    menuitem.setAttribute("value", model);
    modelPopup.appendChild(menuitem);
  });

  // Set current model from provider config (use first chat model as fallback)
  const currentModel = config?.defaultModel || chatModels[0] || modelList[0];
  modelSelect.value = currentModel;
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

  const updates: Partial<PaperChatProviderConfig> = {
    defaultModel: modelSelect?.value || "",
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
