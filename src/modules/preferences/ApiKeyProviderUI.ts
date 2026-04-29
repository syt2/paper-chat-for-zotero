/**
 * ApiKeyProviderUI - API Key provider settings panel
 */

import { getString } from "../../utils/locale";
import { prefColors } from "../../utils/colors";
import { getProviderManager } from "../providers";
import type { ApiKeyProviderConfig } from "../../types/provider";
import { clearElement, showTestResult } from "./utils";

type ProviderMetadata = ReturnType<
  typeof getProviderManager
>["getProviderMetadata"] extends (id: string) => infer R
  ? R
  : never;

const EXTRA_REQUEST_BODY_PLACEHOLDER = '{\n  "reasoning_effort": "medium" \n}';
const MODEL_EXTRA_REQUEST_BODY_PLACEHOLDER =
  '{\n  "gpt-5": {\n    "reasoning": { "effort": "high" }\n  }\n}';

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function formatJsonObject(value: Record<string, unknown> | undefined): string {
  return value ? JSON.stringify(value, null, 2) : "";
}

function parseJsonObjectTextarea(
  value: string,
  errorMessage: string,
): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(errorMessage);
  }

  if (!isPlainJsonObject(parsed)) {
    throw new Error(errorMessage);
  }
  return parsed;
}

function parseModelExtraRequestBody(
  value: string,
): Record<string, Record<string, unknown>> | undefined {
  const parsed = parseJsonObjectTextarea(
    value,
    getString("pref-model-extra-request-body-invalid"),
  );
  if (!parsed) {
    return undefined;
  }

  for (const modelConfig of Object.values(parsed)) {
    if (!isPlainJsonObject(modelConfig)) {
      throw new Error(getString("pref-model-extra-request-body-invalid"));
    }
  }

  return parsed as Record<string, Record<string, unknown>>;
}

function clearExtraRequestBodyError(doc: Document): void {
  const testResult = doc.getElementById("pref-test-result");
  if (!testResult) {
    return;
  }
  const invalidMessages = new Set([
    getString("pref-extra-request-body-invalid"),
    getString("pref-model-extra-request-body-invalid"),
    getString("pref-invalid-json"),
  ]);
  if (invalidMessages.has(testResult.textContent || "")) {
    testResult.textContent = "";
  }
}

/**
 * Populate API key panel with provider data
 */
export function populateApiKeyPanel(
  doc: Document,
  config: ApiKeyProviderConfig,
  metadata: ProviderMetadata,
): void {
  const titleEl = doc.getElementById("pref-provider-title");
  const descEl = doc.getElementById("pref-provider-description");
  const apikeyEl = doc.getElementById(
    "pref-provider-apikey",
  ) as HTMLInputElement;
  const baseurlEl = doc.getElementById(
    "pref-provider-baseurl",
  ) as HTMLInputElement;
  const modelSelect = doc.getElementById(
    "pref-provider-model",
  ) as unknown as XULMenuListElement;
  const maxTokensEl = doc.getElementById(
    "pref-provider-maxtokens",
  ) as HTMLInputElement;
  const temperatureEl = doc.getElementById(
    "pref-provider-temperature",
  ) as HTMLInputElement;
  const systemPromptEl = doc.getElementById(
    "pref-provider-systemprompt",
  ) as HTMLTextAreaElement;
  const extraRequestBodyEl = doc.getElementById(
    "pref-provider-extra-request-body",
  ) as HTMLTextAreaElement;
  const modelExtraRequestBodyEl = doc.getElementById(
    "pref-provider-model-extra-request-body",
  ) as HTMLTextAreaElement;
  const deleteBtn = doc.getElementById("pref-delete-provider");

  if (titleEl) titleEl.textContent = config.name;
  if (descEl) descEl.textContent = metadata?.description || "";
  if (apikeyEl) apikeyEl.value = config.apiKey || "";
  if (baseurlEl)
    baseurlEl.value = config.baseUrl || metadata?.defaultBaseUrl || "";
  if (maxTokensEl) maxTokensEl.value = String(config.maxTokens || 8192);
  if (temperatureEl) temperatureEl.value = String(config.temperature ?? 0.7);
  if (systemPromptEl) systemPromptEl.value = config.systemPrompt || "";
  if (extraRequestBodyEl) {
    extraRequestBodyEl.placeholder = EXTRA_REQUEST_BODY_PLACEHOLDER;
    extraRequestBodyEl.value = formatJsonObject(config.extraRequestBody);
  }
  if (modelExtraRequestBodyEl) {
    modelExtraRequestBodyEl.placeholder = MODEL_EXTRA_REQUEST_BODY_PLACEHOLDER;
    modelExtraRequestBodyEl.value = formatJsonObject(
      config.modelExtraRequestBody,
    );
  }

  // Populate model dropdown
  const modelPopup = doc.getElementById("pref-provider-model-popup");
  if (modelPopup && modelSelect) {
    // Clear existing items
    clearElement(modelPopup);

    // Add available models
    const models = config.availableModels || metadata?.defaultModels || [];
    models.forEach((model) => {
      const menuitem = doc.createXULElement("menuitem");
      menuitem.setAttribute("label", model);
      menuitem.setAttribute("value", model);
      modelPopup.appendChild(menuitem);
    });

    modelSelect.value = config.defaultModel || models[0] || "";
  }

  // Show delete button only for custom providers
  if (deleteBtn) {
    if (!config.isBuiltin) {
      deleteBtn.removeAttribute("hidden");
    } else {
      deleteBtn.setAttribute("hidden", "true");
    }
  }

  // Reset test result
  const testResult = doc.getElementById("pref-test-result");
  if (testResult) testResult.textContent = "";

  // Populate model list
  populateModelList(doc, config);
}

/**
 * Populate model list with delete buttons for custom models
 */
export function populateModelList(
  doc: Document,
  config: ApiKeyProviderConfig,
): void {
  const providerManager = getProviderManager();
  const listContainer = doc.getElementById("pref-model-list");
  if (!listContainer) return;

  // Clear existing items
  clearElement(listContainer);

  const models = config.availableModels || [];
  models.forEach((modelId) => {
    const isCustom = providerManager.isCustomModel(config.id, modelId);
    const modelInfo = providerManager.getModelInfo(config.id, modelId);

    const item = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    item.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 8px;
      border-bottom: 1px solid var(--color-border, #eee);
    `;

    // Model info container
    const infoContainer = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    infoContainer.style.cssText =
      "display: flex; flex-direction: column; flex: 1;";

    // Model ID with custom badge
    const nameRow = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    nameRow.style.cssText = "display: flex; align-items: center; gap: 6px;";

    const nameSpan = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "span",
    ) as HTMLSpanElement;
    nameSpan.textContent = modelId;
    nameSpan.style.cssText = "font-size: 12px;";
    nameRow.appendChild(nameSpan);

    if (isCustom) {
      const badge = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "span",
      ) as HTMLSpanElement;
      badge.textContent = getString("pref-model-custom" as any);
      badge.style.cssText = `font-size: 10px; padding: 1px 4px; background: ${prefColors.customBadgeBg}; color: ${prefColors.customBadgeText}; border-radius: 3px;`;
      nameRow.appendChild(badge);
    }

    infoContainer.appendChild(nameRow);

    // Model metadata (if available)
    if (modelInfo?.contextWindow || modelInfo?.capabilities?.length) {
      const metaSpan = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "span",
      ) as HTMLSpanElement;
      const metaParts: string[] = [];
      if (modelInfo.contextWindow) {
        metaParts.push(`${Math.round(modelInfo.contextWindow / 1000)}K ctx`);
      }
      if (modelInfo.capabilities?.length) {
        metaParts.push(modelInfo.capabilities.join(", "));
      }
      metaSpan.textContent = metaParts.join(" | ");
      metaSpan.style.cssText = "font-size: 10px; color: #888;";
      infoContainer.appendChild(metaSpan);
    }

    item.appendChild(infoContainer);

    // Delete button for custom models
    if (isCustom) {
      const deleteBtn = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "button",
      ) as HTMLButtonElement;
      deleteBtn.textContent = "×";
      deleteBtn.style.cssText = `
        border: none;
        background: none;
        color: #c00;
        cursor: pointer;
        font-size: 16px;
        padding: 0 4px;
        line-height: 1;
      `;
      deleteBtn.addEventListener("click", () => {
        if (providerManager.removeCustomModel(config.id, modelId)) {
          const updatedConfig = providerManager.getProviderConfig(
            config.id,
          ) as ApiKeyProviderConfig;
          if (updatedConfig) {
            const metadata = providerManager.getProviderMetadata(config.id);
            populateApiKeyPanel(doc, updatedConfig, metadata);
          }
        }
      });
      item.appendChild(deleteBtn);
    }

    listContainer.appendChild(item);
  });

  // Show empty state if no models
  if (models.length === 0) {
    const emptyItem = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    emptyItem.textContent = "—";
    emptyItem.style.cssText =
      "padding: 8px; text-align: center; color: #888; font-size: 12px;";
    listContainer.appendChild(emptyItem);
  }
}

/**
 * Save current API key provider config
 */
export function saveCurrentProviderConfig(
  doc: Document,
  currentProviderId: string,
): void {
  if (currentProviderId === "paperchat") return;

  const providerManager = getProviderManager();

  const apikeyEl = doc.getElementById(
    "pref-provider-apikey",
  ) as HTMLInputElement;
  const baseurlEl = doc.getElementById(
    "pref-provider-baseurl",
  ) as HTMLInputElement;
  const modelSelect = doc.getElementById(
    "pref-provider-model",
  ) as unknown as XULMenuListElement;
  const maxTokensEl = doc.getElementById(
    "pref-provider-maxtokens",
  ) as HTMLInputElement;
  const temperatureEl = doc.getElementById(
    "pref-provider-temperature",
  ) as HTMLInputElement;
  const systemPromptEl = doc.getElementById(
    "pref-provider-systemprompt",
  ) as HTMLTextAreaElement;
  const extraRequestBodyEl = doc.getElementById(
    "pref-provider-extra-request-body",
  ) as HTMLTextAreaElement;
  const modelExtraRequestBodyEl = doc.getElementById(
    "pref-provider-model-extra-request-body",
  ) as HTMLTextAreaElement;

  const apiKey = apikeyEl?.value || "";
  const wasEnabled = (
    providerManager.getProviderConfig(currentProviderId) as ApiKeyProviderConfig
  )?.enabled;
  const isNowEnabled = !!apiKey.trim();

  let extraRequestBody: Record<string, unknown> | undefined;
  let modelExtraRequestBody:
    | Record<string, Record<string, unknown>>
    | undefined;
  try {
    extraRequestBody = parseJsonObjectTextarea(
      extraRequestBodyEl?.value || "",
      getString("pref-extra-request-body-invalid"),
    );
    modelExtraRequestBody = parseModelExtraRequestBody(
      modelExtraRequestBodyEl?.value || "",
    );
  } catch (error) {
    showTestResult(
      doc,
      error instanceof Error ? error.message : getString("pref-invalid-json"),
      true,
    );
    return;
  }

  const updates: Partial<ApiKeyProviderConfig> = {
    enabled: isNowEnabled, // Auto-enable when API key is filled
    apiKey,
    baseUrl: baseurlEl?.value || "",
    defaultModel: modelSelect?.value || "",
    maxTokens: parseInt(maxTokensEl?.value) || 8192,
    temperature: parseFloat(temperatureEl?.value) || 0.7,
    systemPrompt: systemPromptEl?.value || "",
    extraRequestBody,
    modelExtraRequestBody,
  };

  providerManager.updateProviderConfig(currentProviderId, updates);
  clearExtraRequestBodyError(doc);

  return wasEnabled !== isNowEnabled ? undefined : undefined; // Type placeholder, actual logic in caller
}

/**
 * Auto-fetch models from provider API after API key is entered
 */
export async function autoFetchModels(
  doc: Document,
  currentProviderId: string,
): Promise<void> {
  const providerManager = getProviderManager();
  const provider = providerManager.getProvider(currentProviderId);
  if (!provider) return;

  try {
    showTestResult(doc, getString("pref-fetching-models"), false);
    const models = await provider.getAvailableModels();
    const config = providerManager.getProviderConfig(
      currentProviderId,
    ) as ApiKeyProviderConfig;
    if (config && models.length > 0) {
      providerManager.updateProviderConfig(currentProviderId, {
        availableModels: models,
      });
      // Refresh panel
      const metadata = providerManager.getProviderMetadata(currentProviderId);
      populateApiKeyPanel(
        doc,
        { ...config, availableModels: models },
        metadata,
      );
      showTestResult(
        doc,
        getString("pref-models-loaded", { args: { count: models.length } }),
        false,
      );
    } else {
      showTestResult(doc, "", false);
    }
  } catch {
    showTestResult(doc, getString("pref-fetch-models-failed"), true);
  }
}

/**
 * Bind API key panel events
 */
export function bindApiKeyEvents(
  doc: Document,
  getCurrentProviderId: () => string,
  onProviderListRefresh: () => void,
  onActiveProviderRefresh: () => void,
  onProviderAdded?: (providerId: string) => void,
  onProviderRemoved?: () => void,
): void {
  const providerManager = getProviderManager();

  // API Key input (save on blur and auto-fetch models)
  const apikeyInput = doc.getElementById(
    "pref-provider-apikey",
  ) as HTMLInputElement;
  apikeyInput?.addEventListener("blur", async () => {
    const currentProviderId = getCurrentProviderId();
    const wasEnabled = (
      providerManager.getProviderConfig(
        currentProviderId,
      ) as ApiKeyProviderConfig
    )?.enabled;
    saveCurrentProviderConfig(doc, currentProviderId);
    const isNowEnabled = (
      providerManager.getProviderConfig(
        currentProviderId,
      ) as ApiKeyProviderConfig
    )?.enabled;

    // Refresh provider list to update green dot status
    onProviderListRefresh();

    // Refresh active provider dropdown if enabled status changed
    if (wasEnabled !== isNowEnabled) {
      onActiveProviderRefresh();
    }

    // Auto-fetch models when API key is entered
    if (apikeyInput.value.trim()) {
      await autoFetchModels(doc, currentProviderId);
    }
  });

  // Toggle API key visibility
  const toggleKeyBtn = doc.getElementById("pref-toggle-apikey");
  toggleKeyBtn?.addEventListener("click", () => {
    if (apikeyInput.type === "password") {
      apikeyInput.type = "text";
      toggleKeyBtn.setAttribute("label", getString("pref-hide-key"));
    } else {
      apikeyInput.type = "password";
      toggleKeyBtn.setAttribute("label", getString("pref-show-key"));
    }
  });

  // Base URL input
  const baseurlInput = doc.getElementById(
    "pref-provider-baseurl",
  ) as HTMLInputElement;
  baseurlInput?.addEventListener("blur", () =>
    saveCurrentProviderConfig(doc, getCurrentProviderId()),
  );

  // Model selection
  const modelSelect = doc.getElementById(
    "pref-provider-model",
  ) as unknown as XULMenuListElement;
  modelSelect?.addEventListener("command", () =>
    saveCurrentProviderConfig(doc, getCurrentProviderId()),
  );

  // Max tokens
  const maxTokensInput = doc.getElementById(
    "pref-provider-maxtokens",
  ) as HTMLInputElement;
  maxTokensInput?.addEventListener("blur", () =>
    saveCurrentProviderConfig(doc, getCurrentProviderId()),
  );

  // Temperature
  const temperatureInput = doc.getElementById(
    "pref-provider-temperature",
  ) as HTMLInputElement;
  temperatureInput?.addEventListener("blur", () =>
    saveCurrentProviderConfig(doc, getCurrentProviderId()),
  );

  // System prompt
  const systemPromptInput = doc.getElementById(
    "pref-provider-systemprompt",
  ) as HTMLTextAreaElement;
  systemPromptInput?.addEventListener("blur", () =>
    saveCurrentProviderConfig(doc, getCurrentProviderId()),
  );

  const extraRequestBodyInput = doc.getElementById(
    "pref-provider-extra-request-body",
  ) as HTMLTextAreaElement;
  extraRequestBodyInput?.addEventListener("blur", () =>
    saveCurrentProviderConfig(doc, getCurrentProviderId()),
  );

  const modelExtraRequestBodyInput = doc.getElementById(
    "pref-provider-model-extra-request-body",
  ) as HTMLTextAreaElement;
  modelExtraRequestBodyInput?.addEventListener("blur", () =>
    saveCurrentProviderConfig(doc, getCurrentProviderId()),
  );

  // Refresh models button
  const refreshModelsBtn = doc.getElementById("pref-refresh-models");
  refreshModelsBtn?.addEventListener("click", () =>
    autoFetchModels(doc, getCurrentProviderId()),
  );

  // Test connection button
  const testConnectionBtn = doc.getElementById("pref-test-connection");
  testConnectionBtn?.addEventListener("click", async () => {
    const currentProviderId = getCurrentProviderId();
    const provider = providerManager.getProvider(currentProviderId);
    if (!provider) {
      showTestResult(doc, getString("pref-provider-not-ready"), true);
      return;
    }

    showTestResult(doc, getString("pref-testing"), false);
    try {
      const success = await provider.testConnection();
      if (success) {
        showTestResult(doc, getString("pref-test-success"), false);
      } else {
        showTestResult(doc, getString("pref-test-failed"), true);
      }
    } catch (e) {
      showTestResult(doc, getString("pref-test-failed"), true);
    }
  });

  // Delete custom provider button
  const deleteProviderBtn = doc.getElementById("pref-delete-provider");
  deleteProviderBtn?.addEventListener("click", () => {
    const currentProviderId = getCurrentProviderId();
    if (providerManager.removeCustomProvider(currentProviderId)) {
      onProviderListRefresh();
      onActiveProviderRefresh();
      onProviderRemoved?.();
    }
  });

  // Add custom provider button
  const addProviderBtn = doc.getElementById("pref-add-provider-btn");
  addProviderBtn?.addEventListener("click", () => {
    const name = addon.data.prefs?.window?.prompt(
      getString("pref-enter-provider-name"),
    );
    if (name && name.trim()) {
      const newId = providerManager.addCustomProvider(name.trim());
      onProviderListRefresh();
      onActiveProviderRefresh();
      onProviderAdded?.(newId);
    }
  });

  // Add custom model button
  const addModelBtn = doc.getElementById("pref-add-model-btn");
  addModelBtn?.addEventListener("click", () => {
    const currentProviderId = getCurrentProviderId();
    if (currentProviderId === "paperchat") return;

    const modelId = addon.data.prefs?.window?.prompt(
      getString("pref-enter-model-id"),
    );
    if (modelId && modelId.trim()) {
      const success = providerManager.addCustomModel(
        currentProviderId,
        modelId.trim(),
      );
      if (success) {
        const config = providerManager.getProviderConfig(
          currentProviderId,
        ) as ApiKeyProviderConfig;
        if (config) {
          const metadata =
            providerManager.getProviderMetadata(currentProviderId);
          populateApiKeyPanel(doc, config, metadata);
        }
      } else {
        showTestResult(doc, getString("pref-model-exists" as any), true);
      }
    }
  });
}
