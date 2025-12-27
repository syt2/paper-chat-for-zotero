/**
 * PdfaitalkProviderUI - PDFAiTalk provider settings panel
 */

import { getPref, setPref } from "../../utils/prefs";
import { getProviderManager, BUILTIN_PROVIDERS } from "../providers";
import type { PDFAiTalkProviderConfig } from "../../types/provider";
import { getModelRatios } from "./ModelsFetcher";
import { clearElement } from "./utils";

/**
 * Populate PDFAiTalk panel with settings from provider config
 */
export function populatePdfaitalkPanel(doc: Document): void {
  const providerManager = getProviderManager();
  const config = providerManager.getProviderConfig("pdfaitalk") as PDFAiTalkProviderConfig;

  if (!config) return;

  // Populate model dropdown
  populatePdfaitalkModels(doc);

  // Populate other settings
  const maxTokensEl = doc.getElementById("pref-pdfaitalk-maxtokens") as HTMLInputElement;
  const temperatureEl = doc.getElementById("pref-pdfaitalk-temperature") as HTMLInputElement;
  const systemPromptEl = doc.getElementById("pref-pdfaitalk-systemprompt") as HTMLTextAreaElement;

  if (maxTokensEl) maxTokensEl.value = String(config.maxTokens || 4096);
  if (temperatureEl) temperatureEl.value = String(config.temperature ?? 0.7);
  if (systemPromptEl) systemPromptEl.value = config.systemPrompt || "";
}

/**
 * Populate PDFAiTalk model dropdown from cache, defaults, or API response
 */
export function populatePdfaitalkModels(doc: Document, models?: string[], saveToCache: boolean = false): void {
  const providerManager = getProviderManager();
  const config = providerManager.getProviderConfig("pdfaitalk") as PDFAiTalkProviderConfig;
  const modelSelect = doc.getElementById("pref-pdfaitalk-model") as unknown as XULMenuListElement;
  const modelPopup = doc.getElementById("pref-pdfaitalk-model-popup");

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
    const cachedModels = getPref("pdfaitalkModelsCache") as string;
    if (cachedModels) {
      try {
        modelList = JSON.parse(cachedModels);
      } catch {
        // ignore parse error
      }
    }
  }
  if (!modelList || modelList.length === 0) {
    modelList = BUILTIN_PROVIDERS.pdfaitalk.defaultModels;
  }

  // Save to cache and provider config if requested
  if (saveToCache && models) {
    setPref("pdfaitalkModelsCache", JSON.stringify(models));
    providerManager.updateProviderConfig("pdfaitalk", { availableModels: models });
  }

  const pdfaitalkModelRatios = getModelRatios();
  modelList.forEach((model) => {
    const menuitem = doc.createXULElement("menuitem");
    // Display ratio if available
    const ratio = pdfaitalkModelRatios[model];
    const label = ratio !== undefined ? `${model} (${ratio}x)` : model;
    menuitem.setAttribute("label", label);
    menuitem.setAttribute("value", model);
    modelPopup.appendChild(menuitem);
  });

  // Set current model from provider config
  const currentModel = config?.defaultModel || modelList[0];
  modelSelect.value = currentModel;
}

/**
 * Save PDFAiTalk provider settings
 */
export function savePdfaitalkConfig(doc: Document): void {
  const providerManager = getProviderManager();

  const modelSelect = doc.getElementById("pref-pdfaitalk-model") as unknown as XULMenuListElement;
  const maxTokensEl = doc.getElementById("pref-pdfaitalk-maxtokens") as HTMLInputElement;
  const temperatureEl = doc.getElementById("pref-pdfaitalk-temperature") as HTMLInputElement;
  const systemPromptEl = doc.getElementById("pref-pdfaitalk-systemprompt") as HTMLTextAreaElement;

  const updates: Partial<PDFAiTalkProviderConfig> = {
    defaultModel: modelSelect?.value || "",
    maxTokens: parseInt(maxTokensEl?.value) || 4096,
    temperature: parseFloat(temperatureEl?.value) || 0.7,
    systemPrompt: systemPromptEl?.value || "",
  };

  providerManager.updateProviderConfig("pdfaitalk", updates);
}

/**
 * Bind PDFAiTalk panel events
 */
export function bindPdfaitalkEvents(
  doc: Document,
  onRefreshModels: () => Promise<void>,
): void {
  // PDFAiTalk model selection - save to provider config
  const pdfaitalkModelSelect = doc.getElementById("pref-pdfaitalk-model") as unknown as XULMenuListElement;
  pdfaitalkModelSelect?.addEventListener("command", () => {
    savePdfaitalkConfig(doc);
  });

  // PDFAiTalk max tokens
  const pdfaitalkMaxTokensInput = doc.getElementById("pref-pdfaitalk-maxtokens") as HTMLInputElement;
  pdfaitalkMaxTokensInput?.addEventListener("blur", () => savePdfaitalkConfig(doc));

  // PDFAiTalk temperature
  const pdfaitalkTemperatureInput = doc.getElementById("pref-pdfaitalk-temperature") as HTMLInputElement;
  pdfaitalkTemperatureInput?.addEventListener("blur", () => savePdfaitalkConfig(doc));

  // PDFAiTalk system prompt
  const pdfaitalkSystemPromptInput = doc.getElementById("pref-pdfaitalk-systemprompt") as HTMLTextAreaElement;
  pdfaitalkSystemPromptInput?.addEventListener("blur", () => savePdfaitalkConfig(doc));

  // PDFAiTalk refresh models button
  const pdfaitalkRefreshBtn = doc.getElementById("pref-pdfaitalk-refresh-models");
  ztoolkit.log("[Preferences] pdfaitalkRefreshBtn element:", pdfaitalkRefreshBtn ? "found" : "NOT FOUND");
  pdfaitalkRefreshBtn?.addEventListener("click", async () => {
    ztoolkit.log("[Preferences] Refresh models button clicked");
    await onRefreshModels();
  });
}
