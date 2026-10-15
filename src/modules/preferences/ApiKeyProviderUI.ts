/**
 * ApiKeyProviderUI - API Key provider settings panel
 */

import { getString } from "../../utils/locale";
import { prefColors } from "../../utils/colors";
import { getProviderManager } from "../providers";
import type { ApiKeyProviderConfig } from "../../types/provider";
import { getErrorMessage } from "../../utils/common";
import { clearElement, showTestResult } from "./utils";
import {
  shouldAutoFetchModels,
  type ModelFetchAttempt,
  type ModelFetchStatus,
  type ModelFetchTrigger,
} from "./model-fetch-policy";

type ProviderMetadata = ReturnType<
  typeof getProviderManager
>["getProviderMetadata"] extends (id: string) => infer R
  ? R
  : never;

const EXTRA_REQUEST_BODY_PLACEHOLDER =
  '{\n  "thinking": { "type": "disabled" }\n}';
const MODEL_EXTRA_REQUEST_BODY_PLACEHOLDER =
  '{\n  "deepseek-v4-flash": {\n    "thinking": { "type": "enabled" },\n    "reasoning_effort": "max"\n  }\n}';

/** How long to wait for a pasted key to settle in the field before fetching. */
const PASTE_FETCH_DELAY_MS = 300;

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * Credentials a model list belongs to. Auto-fetch compares this string so a
 * paste, a blur and a panel open for the same key collapse into one request,
 * while any edit to the key or Base URL earns a fresh one.
 */
function getModelFetchCredentials(config: ApiKeyProviderConfig): string {
  return `${(config.apiKey || "").trim()}\n${(config.baseUrl || "").trim()}`;
}

/** True while the API key panel renders the given provider. */
function isPanelShowingProvider(doc: Document, providerId: string): boolean {
  const panel = doc.getElementById("pref-panel-apikey");
  return panel?.getAttribute("data-provider-id") === providerId;
}

/**
 * Last automatic attempt per provider. Kept for the whole session, not per
 * window, so reopening the settings does not re-fetch credentials whose result
 * is already known.
 */
const modelFetchAttempts = new Map<string, ModelFetchAttempt>();

interface ModelFetchRequest {
  /** Credentials the request was queued for. */
  credentials: string;
  /** True when the user asked explicitly (Refresh button). */
  manual: boolean;
}

/** Newest queued request per provider; a later trigger replaces an earlier one. */
const pendingModelFetches = new Map<string, ModelFetchRequest>();

/** Tail of the serialized fetch chain per provider, keeping one request in flight. */
const modelFetchChains = new Map<string, Promise<void>>();

/**
 * Show a model fetch is running and keep the Refresh button from stacking
 * requests on top of each other.
 */
function setModelFetchBusy(
  doc: Document,
  providerId: string,
  busy: boolean,
): void {
  if (!isPanelShowingProvider(doc, providerId)) return;

  const refreshBtn = doc.getElementById("pref-refresh-models");
  if (refreshBtn) {
    if (busy) {
      refreshBtn.setAttribute("disabled", "true");
    } else {
      refreshBtn.removeAttribute("disabled");
    }
  }
  if (busy) {
    showTestResult(doc, getString("pref-fetching-models"), false);
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
  // Record which provider this panel shows: an asynchronous model fetch only
  // renders its result when the panel still belongs to the provider it asked
  // about.
  doc
    .getElementById("pref-panel-apikey")
    ?.setAttribute("data-provider-id", config.id);
  // A fetch for the provider that was shown before may still be running; the
  // panel now belongs to this one, so its Refresh button starts enabled.
  doc.getElementById("pref-refresh-models")?.removeAttribute("disabled");

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

    // Add only fetched or user-added models. Built-in provider metadata is not
    // used as a visible fallback because the Refresh button can fetch live models.
    const models = config.availableModels || [];
    models.forEach((model) => {
      const menuitem = doc.createXULElement("menuitem");
      menuitem.setAttribute("label", model);
      menuitem.setAttribute("value", model);
      modelPopup.appendChild(menuitem);
    });

    modelSelect.value =
      config.defaultModel && models.includes(config.defaultModel)
        ? config.defaultModel
        : models[0] || "";
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
 *
 * Returns false when the panel holds input that cannot be saved (invalid
 * JSON), so callers can tell the user instead of fetching models with a config
 * that was never stored.
 */
export function saveCurrentProviderConfig(
  doc: Document,
  currentProviderId: string,
): boolean {
  if (currentProviderId === "paperchat") return true;

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
    return false;
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

  return true;
}

/**
 * Refresh a provider's model list and merge the result into its config.
 *
 * Callers are the moments that follow a credential edit - pasting a key,
 * leaving the API key or Base URL field, opening the panel - plus the Refresh
 * button. The automatic triggers are filtered by the fetch policy and
 * serialized, so one edit produces one request instead of one per trigger.
 */
export function requestModelFetch(
  doc: Document,
  currentProviderId: string,
  options: { trigger?: ModelFetchTrigger; manual?: boolean } = {},
): Promise<void> {
  if (currentProviderId === "paperchat") return Promise.resolve();

  const providerManager = getProviderManager();
  const config = providerManager.getProviderConfig(
    currentProviderId,
  ) as ApiKeyProviderConfig | null;
  if (!config) return Promise.resolve();

  const credentials = getModelFetchCredentials(config);
  const manual = options.manual === true;
  if (
    !manual &&
    !shouldAutoFetchModels({
      trigger: options.trigger ?? "blur",
      credentials,
      hasApiKey: !!config.apiKey?.trim(),
      hasBaseUrl: !!config.baseUrl?.trim(),
      modelCount: config.availableModels?.length ?? 0,
      attempt: modelFetchAttempts.get(currentProviderId),
    })
  ) {
    return Promise.resolve();
  }

  pendingModelFetches.set(currentProviderId, { credentials, manual });
  const previous = modelFetchChains.get(currentProviderId) ?? Promise.resolve();
  const next = previous
    .then(() => flushModelFetch(doc, currentProviderId))
    // Never reject: the chain has to stay usable for the next trigger, and the
    // callers are event handlers that cannot handle a rejection.
    .catch((error) => {
      ztoolkit.log("[Preferences] Model fetch failed:", getErrorMessage(error));
    });
  modelFetchChains.set(currentProviderId, next);
  return next;
}

/**
 * Run the newest queued request, if any. Queued behind the provider's previous
 * request so responses cannot interleave, and a trigger that arrives while
 * another one runs replaces it instead of adding a request.
 */
async function flushModelFetch(
  doc: Document,
  currentProviderId: string,
): Promise<void> {
  const request = pendingModelFetches.get(currentProviderId);
  if (!request) return;
  pendingModelFetches.delete(currentProviderId);

  const providerManager = getProviderManager();
  const config = providerManager.getProviderConfig(
    currentProviderId,
  ) as ApiKeyProviderConfig | null;
  const provider = providerManager.getProvider(currentProviderId);
  if (!config || !provider) return;

  // The credentials moved on while this request waited its turn; the trigger
  // that changed them queued its own request.
  if (getModelFetchCredentials(config) !== request.credentials) return;

  modelFetchAttempts.set(currentProviderId, {
    credentials: request.credentials,
    status: "running",
  });
  setModelFetchBusy(doc, currentProviderId, true);

  let models: string[] | null = null;
  let status: ModelFetchStatus = "failed";
  try {
    models = await provider.getAvailableModels();
    status =
      models === null ? "unsupported" : models.length > 0 ? "loaded" : "empty";
  } catch (error) {
    ztoolkit.log(
      `[Preferences] Failed to fetch models for ${currentProviderId}:`,
      getErrorMessage(error),
    );
  } finally {
    modelFetchAttempts.set(currentProviderId, {
      credentials: request.credentials,
      status,
    });
    setModelFetchBusy(doc, currentProviderId, false);
  }

  applyModelFetchResult(doc, currentProviderId, request, models, status);
}

/**
 * Store a fetched model list and report the outcome in the panel.
 */
function applyModelFetchResult(
  doc: Document,
  currentProviderId: string,
  request: ModelFetchRequest,
  models: string[] | null,
  status: ModelFetchStatus,
): void {
  const providerManager = getProviderManager();
  const visible = isPanelShowingProvider(doc, currentProviderId);

  if (status === "loaded" && models) {
    const config = providerManager.getProviderConfig(
      currentProviderId,
    ) as ApiKeyProviderConfig | null;
    // No config left: the provider was removed while the request ran.
    if (!config) return;

    // Keep user-added models that the provider does not report, and keep the
    // current selection when it survived the refresh.
    const customModels = (config.models || []).filter(
      (model) => model.isCustom,
    );
    const customModelIds = new Set(customModels.map((model) => model.modelId));
    const availableModels = [
      ...models,
      ...customModels
        .map((model) => model.modelId)
        .filter((modelId) => !models.includes(modelId)),
    ];
    const modelInfos = [
      ...models
        .filter((modelId) => !customModelIds.has(modelId))
        .map((modelId) => ({ modelId })),
      ...customModels,
    ];
    const defaultModel = availableModels.includes(config.defaultModel)
      ? config.defaultModel
      : availableModels[0] || "";
    providerManager.updateProviderConfig(currentProviderId, {
      defaultModel,
      availableModels,
      models: modelInfos,
    });

    if (visible) {
      populateApiKeyPanel(
        doc,
        { ...config, defaultModel, availableModels, models: modelInfos },
        providerManager.getProviderMetadata(currentProviderId),
      );
      // After the re-render: populating the panel clears the status line.
      showTestResult(
        doc,
        getString("pref-models-loaded", { args: { count: models.length } }),
        false,
      );
    }
    return;
  }

  if (!visible) return;

  // An automatic fetch stays quiet when the provider simply has no model list,
  // so every paste into a Claude key does not look like a failure. The manual
  // Refresh button reports it, since the user asked for a list there.
  if (status === "unsupported") {
    if (request.manual) {
      showTestResult(doc, getString("pref-provider-models-unsupported"), true);
    } else {
      showTestResult(doc, "", false);
    }
    return;
  }

  if (status === "empty") {
    showTestResult(doc, getString("pref-provider-models-empty"), true);
    return;
  }

  showTestResult(doc, getString("pref-provider-models-failed"), true);
}

/**
 * Bind API key panel events
 *
 * Returns a cleanup function that cancels a pending paste-triggered fetch.
 */
export function bindApiKeyEvents(
  doc: Document,
  getCurrentProviderId: () => string,
  onProviderListRefresh: () => void,
  onActiveProviderRefresh: () => void,
  onProviderAdded?: (providerId: string) => void,
  onProviderRemoved?: () => void,
): () => void {
  const providerManager = getProviderManager();

  let pasteFetchTimer: ReturnType<typeof setTimeout> | undefined;

  const apikeyInput = doc.getElementById(
    "pref-provider-apikey",
  ) as HTMLInputElement;

  /**
   * Persist the field edits and keep the provider list in sync. Returns the
   * provider the fields belong to, or null when the fields could not be saved.
   */
  const savePanelFields = (): string | null => {
    const currentProviderId = getCurrentProviderId();
    const wasEnabled = (
      providerManager.getProviderConfig(
        currentProviderId,
      ) as ApiKeyProviderConfig
    )?.enabled;
    if (!saveCurrentProviderConfig(doc, currentProviderId)) {
      return null;
    }
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

    return currentProviderId;
  };

  // API Key input (save on blur and auto-fetch models)
  apikeyInput?.addEventListener("blur", () => {
    const currentProviderId = savePanelFields();
    if (currentProviderId) {
      void requestModelFetch(doc, currentProviderId, { trigger: "blur" });
    }
  });

  // A pasted key is the usual way to fill this field, and the user does not
  // have to click away for the model list to appear. The pasted text only
  // reaches the field after the event, so look at the value once it settled.
  apikeyInput?.addEventListener("paste", () => {
    if (pasteFetchTimer !== undefined) {
      clearTimeout(pasteFetchTimer);
    }
    pasteFetchTimer = setTimeout(() => {
      pasteFetchTimer = undefined;
      const currentProviderId = savePanelFields();
      if (currentProviderId) {
        void requestModelFetch(doc, currentProviderId, { trigger: "paste" });
      }
    }, PASTE_FETCH_DELAY_MS);
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

  // Base URL input. Also auto-fetch: a custom provider is often filled in
  // key-first, and the first fetch attempt then had no URL to call.
  const baseurlInput = doc.getElementById(
    "pref-provider-baseurl",
  ) as HTMLInputElement;
  baseurlInput?.addEventListener("blur", () => {
    const currentProviderId = savePanelFields();
    if (currentProviderId) {
      void requestModelFetch(doc, currentProviderId, { trigger: "blur" });
    }
  });

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
    requestModelFetch(doc, getCurrentProviderId(), { manual: true }),
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

  return () => {
    if (pasteFetchTimer !== undefined) {
      clearTimeout(pasteFetchTimer);
      pasteFetchTimer = undefined;
    }
  };
}
