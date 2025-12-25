import { getString } from "../utils/locale";
import { getAuthManager } from "./auth";
import { showAuthDialog } from "./ui/AuthDialog";
import {
  getProviderManager,
  BUILTIN_PROVIDERS,
} from "./providers";
import type { ProviderConfig, ApiKeyProviderConfig, PDFAiTalkProviderConfig, BuiltinProviderId } from "../types/provider";
import { getPref, setPref } from "../utils/prefs";

let currentProviderId: string = "pdfaitalk";

// Store model ratios for PDFAiTalk
let pdfaitalkModelRatios: Record<string, number> = {};

export async function registerPrefsScripts(_window: Window) {
  addon.data.prefs = {
    window: _window,
  };

  await initializePrefsUI();
  bindPrefEvents();
}

async function initializePrefsUI() {
  if (addon.data.prefs?.window == undefined) return;

  const doc = addon.data.prefs.window.document;
  const authManager = getAuthManager();
  const providerManager = getProviderManager();

  // Initialize auth manager
  await authManager.initialize();

  // Load cached model ratios
  loadCachedRatios();

  // Populate provider sidebar
  populateProviderList(doc);

  // Populate active provider dropdown
  populateActiveProviderDropdown(doc);

  // Select current active provider in sidebar
  currentProviderId = providerManager.getActiveProviderId();
  selectProvider(doc, currentProviderId);

  // Update OneAI user status display
  updateUserDisplay(doc, authManager);

  // Populate PDFAiTalk model dropdown
  populatePdfaitalkModels(doc);
}

/**
 * Populate PDFAiTalk panel with settings from provider config
 */
function populatePdfaitalkPanel(doc: Document) {
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
function populatePdfaitalkModels(doc: Document, models?: string[], saveToCache: boolean = false) {
  const providerManager = getProviderManager();
  const config = providerManager.getProviderConfig("pdfaitalk") as PDFAiTalkProviderConfig;
  const modelSelect = doc.getElementById("pref-pdfaitalk-model") as XULMenuListElement;
  const modelPopup = doc.getElementById("pref-pdfaitalk-model-popup");

  if (!modelSelect || !modelPopup) return;

  // Clear existing items
  while (modelPopup.firstChild) {
    modelPopup.removeChild(modelPopup.firstChild);
  }

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
function savePdfaitalkConfig(doc: Document) {
  const providerManager = getProviderManager();

  const modelSelect = doc.getElementById("pref-pdfaitalk-model") as XULMenuListElement;
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

function populateProviderList(doc: Document) {
  const providerManager = getProviderManager();
  const configs = providerManager.getAllConfigs();
  const listContainer = doc.getElementById("pref-provider-list");

  if (!listContainer) return;

  // Clear existing items
  while (listContainer.firstChild) {
    listContainer.removeChild(listContainer.firstChild);
  }

  // Add provider items
  configs.forEach((config) => {
    const item = createProviderListItem(doc, config);
    listContainer.appendChild(item);
  });
}

function createProviderListItem(doc: Document, config: ProviderConfig): Element {
  const providerManager = getProviderManager();
  const activeProviderId = providerManager.getActiveProviderId();

  const item = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  item.className = "provider-list-item";
  item.setAttribute("data-provider-id", config.id);
  item.style.cssText = `
    padding: 8px 12px;
    margin-bottom: 4px;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
  `;

  // Left side: name
  const nameSpan = doc.createElementNS("http://www.w3.org/1999/xhtml", "span") as HTMLSpanElement;
  nameSpan.textContent = config.name;
  item.appendChild(nameSpan);

  // Right side: status indicators container
  const statusContainer = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  statusContainer.style.cssText = "display: flex; align-items: center; gap: 4px;";

  // Green dot indicator for configured providers
  const isConfigured = isProviderConfigured(config);
  if (isConfigured) {
    const statusDot = doc.createElementNS("http://www.w3.org/1999/xhtml", "span") as HTMLSpanElement;
    statusDot.className = "provider-status-dot";
    statusDot.style.cssText = `
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: #4caf50;
      flex-shrink: 0;
    `;
    statusDot.title = getString("pref-provider-configured" as any) || "Configured";
    statusContainer.appendChild(statusDot);
  }

  // Checkmark for active provider
  if (config.id === activeProviderId) {
    const activeCheck = doc.createElementNS("http://www.w3.org/1999/xhtml", "span") as HTMLSpanElement;
    activeCheck.className = "provider-active-check";
    activeCheck.textContent = "✅";
    activeCheck.style.cssText = "font-size: 12px; flex-shrink: 0;";
    activeCheck.title = getString("pref-provider-active" as any) || "Active";
    statusContainer.appendChild(activeCheck);
  }

  item.appendChild(statusContainer);

  item.addEventListener("click", () => {
    selectProvider(doc, config.id);
  });

  item.addEventListener("mouseenter", () => {
    if (item.getAttribute("data-selected") !== "true") {
      item.style.backgroundColor = "#e8e8e8";
    }
  });

  item.addEventListener("mouseleave", () => {
    if (item.getAttribute("data-selected") !== "true") {
      item.style.backgroundColor = "";
    }
  });

  return item;
}

/**
 * Check if a provider is configured and ready to use
 */
function isProviderConfigured(config: ProviderConfig): boolean {
  if (config.id === "pdfaitalk") {
    // PDFAiTalk is configured if user is logged in
    const authManager = getAuthManager();
    return authManager.isLoggedIn();
  } else {
    // API key providers are configured if they have an API key and are enabled
    const apiKeyConfig = config as ApiKeyProviderConfig;
    return apiKeyConfig.enabled && !!apiKeyConfig.apiKey?.trim();
  }
}

function selectProvider(doc: Document, providerId: string) {
  currentProviderId = providerId;
  const providerManager = getProviderManager();

  // Update sidebar selection style
  const items = doc.querySelectorAll(".provider-list-item");
  items.forEach((item: Element) => {
    const el = item as HTMLElement;
    if (el.getAttribute("data-provider-id") === providerId) {
      el.style.backgroundColor = "#0060df";
      el.style.color = "#fff";
      el.setAttribute("data-selected", "true");
    } else {
      el.style.backgroundColor = "";
      el.style.color = "";
      el.setAttribute("data-selected", "false");
    }
  });

  // Show appropriate panel
  const pdfaitalkPanel = doc.getElementById("pref-panel-pdfaitalk");
  const apikeyPanel = doc.getElementById("pref-panel-apikey");

  if (providerId === "pdfaitalk") {
    pdfaitalkPanel?.removeAttribute("hidden");
    apikeyPanel?.setAttribute("hidden", "true");
    // Load PDFAiTalk settings
    populatePdfaitalkPanel(doc);
  } else {
    pdfaitalkPanel?.setAttribute("hidden", "true");
    apikeyPanel?.removeAttribute("hidden");

    // Populate API key panel with provider data
    const config = providerManager.getProviderConfig(providerId) as ApiKeyProviderConfig;
    const metadata = providerManager.getProviderMetadata(providerId);

    if (config) {
      populateApiKeyPanel(doc, config, metadata);
    }
  }
}

function populateApiKeyPanel(
  doc: Document,
  config: ApiKeyProviderConfig,
  metadata: ReturnType<typeof getProviderManager>["getProviderMetadata"] extends (id: string) => infer R ? R : never
) {
  const titleEl = doc.getElementById("pref-provider-title");
  const descEl = doc.getElementById("pref-provider-description");
  const apikeyEl = doc.getElementById("pref-provider-apikey") as HTMLInputElement;
  const baseurlEl = doc.getElementById("pref-provider-baseurl") as HTMLInputElement;
  const modelSelect = doc.getElementById("pref-provider-model") as XULMenuListElement;
  const maxTokensEl = doc.getElementById("pref-provider-maxtokens") as HTMLInputElement;
  const temperatureEl = doc.getElementById("pref-provider-temperature") as HTMLInputElement;
  const systemPromptEl = doc.getElementById("pref-provider-systemprompt") as HTMLTextAreaElement;
  const deleteBtn = doc.getElementById("pref-delete-provider");

  if (titleEl) titleEl.textContent = config.name;
  if (descEl) descEl.textContent = metadata?.description || "";
  if (apikeyEl) apikeyEl.value = config.apiKey || "";
  if (baseurlEl) baseurlEl.value = config.baseUrl || metadata?.defaultBaseUrl || "";
  if (maxTokensEl) maxTokensEl.value = String(config.maxTokens || 4096);
  if (temperatureEl) temperatureEl.value = String(config.temperature ?? 0.7);
  if (systemPromptEl) systemPromptEl.value = config.systemPrompt || "";

  // Populate model dropdown
  const modelPopup = doc.getElementById("pref-provider-model-popup");
  if (modelPopup && modelSelect) {
    // Clear existing items
    while (modelPopup.firstChild) {
      modelPopup.removeChild(modelPopup.firstChild);
    }

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
function populateModelList(doc: Document, config: ApiKeyProviderConfig) {
  const providerManager = getProviderManager();
  const listContainer = doc.getElementById("pref-model-list");
  if (!listContainer) return;

  // Clear existing items
  while (listContainer.firstChild) {
    listContainer.removeChild(listContainer.firstChild);
  }

  const models = config.availableModels || [];
  models.forEach((modelId) => {
    const isCustom = providerManager.isCustomModel(config.id, modelId);
    const modelInfo = providerManager.getModelInfo(config.id, modelId);

    const item = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
    item.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 8px;
      border-bottom: 1px solid var(--color-border, #eee);
    `;

    // Model info container
    const infoContainer = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
    infoContainer.style.cssText = "display: flex; flex-direction: column; flex: 1;";

    // Model ID with custom badge
    const nameRow = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
    nameRow.style.cssText = "display: flex; align-items: center; gap: 6px;";

    const nameSpan = doc.createElementNS("http://www.w3.org/1999/xhtml", "span") as HTMLSpanElement;
    nameSpan.textContent = modelId;
    nameSpan.style.cssText = "font-size: 12px;";
    nameRow.appendChild(nameSpan);

    if (isCustom) {
      const badge = doc.createElementNS("http://www.w3.org/1999/xhtml", "span") as HTMLSpanElement;
      badge.textContent = getString("pref-model-custom" as any);
      badge.style.cssText = "font-size: 10px; padding: 1px 4px; background: #e3f2fd; color: #1976d2; border-radius: 3px;";
      nameRow.appendChild(badge);
    }

    infoContainer.appendChild(nameRow);

    // Model metadata (if available)
    if (modelInfo?.contextWindow || modelInfo?.capabilities?.length) {
      const metaSpan = doc.createElementNS("http://www.w3.org/1999/xhtml", "span") as HTMLSpanElement;
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
      const deleteBtn = doc.createElementNS("http://www.w3.org/1999/xhtml", "button") as HTMLButtonElement;
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
          const updatedConfig = providerManager.getProviderConfig(config.id) as ApiKeyProviderConfig;
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
    const emptyItem = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
    emptyItem.textContent = "—";
    emptyItem.style.cssText = "padding: 8px; text-align: center; color: #888; font-size: 12px;";
    listContainer.appendChild(emptyItem);
  }
}

function populateActiveProviderDropdown(doc: Document) {
  const providerManager = getProviderManager();
  const configs = providerManager.getAllConfigs();
  const popup = doc.getElementById("pref-active-provider-popup");
  const select = doc.getElementById("pref-active-provider-select") as XULMenuListElement;

  if (!popup || !select) return;

  // Clear existing items
  while (popup.firstChild) {
    popup.removeChild(popup.firstChild);
  }

  // Add enabled providers
  configs.filter((c) => c.enabled || c.id === "pdfaitalk").forEach((config) => {
    const menuitem = doc.createXULElement("menuitem");
    menuitem.setAttribute("label", config.name);
    menuitem.setAttribute("value", config.id);
    popup.appendChild(menuitem);
  });

  // Set current active
  select.value = providerManager.getActiveProviderId();
}

function updateUserDisplay(doc: Document, authManager: ReturnType<typeof getAuthManager>) {
  const userStatusEl = doc.getElementById("pref-user-status") as HTMLElement | null;
  const userBalanceEl = doc.getElementById("pref-user-balance") as HTMLElement | null;
  const userUsedEl = doc.getElementById("pref-user-used") as HTMLElement | null;
  const loginBtn = doc.getElementById("pref-login-btn") as HTMLElement | null;
  const affCodeBar = doc.getElementById("pref-aff-code-bar") as HTMLElement | null;
  const affCodeInput = doc.getElementById("pref-aff-code") as HTMLInputElement | null;

  if (authManager.isLoggedIn()) {
    const user = authManager.getUser();
    if (userStatusEl) {
      userStatusEl.setAttribute("value", `${getString("user-panel-logged-in", { args: { username: user?.username || "" } })}`);
      userStatusEl.style.color = "#2e7d32";
    }
    if (userBalanceEl) {
      userBalanceEl.setAttribute("value", `${getString("user-panel-balance")}: ${authManager.formatBalance()}`);
    }
    if (userUsedEl) {
      userUsedEl.setAttribute("value", `${getString("user-panel-used")}: ${authManager.formatUsedQuota()}`);
    }
    if (loginBtn) {
      loginBtn.setAttribute("label", getString("user-panel-logout-btn"));
    }
    // Show invitation code
    if (affCodeBar && affCodeInput && user?.aff_code) {
      affCodeBar.style.display = "flex";
      affCodeInput.value = user.aff_code;
    }
  } else {
    if (userStatusEl) {
      userStatusEl.setAttribute("value", getString("user-panel-not-logged-in"));
      userStatusEl.style.color = "#666";
    }
    if (userBalanceEl) {
      userBalanceEl.setAttribute("value", "");
    }
    if (userUsedEl) {
      userUsedEl.setAttribute("value", "");
    }
    if (loginBtn) {
      loginBtn.setAttribute("label", getString("user-panel-login-btn"));
    }
    // Hide invitation code
    if (affCodeBar) {
      affCodeBar.style.display = "none";
    }
  }
}

function bindPrefEvents() {
  if (!addon.data.prefs?.window) return;

  const doc = addon.data.prefs.window.document;
  const authManager = getAuthManager();
  const providerManager = getProviderManager();

  // ===== PDFAiTalk Events =====

  // Login/Logout button
  const loginBtn = doc.getElementById("pref-login-btn");
  loginBtn?.addEventListener("click", async () => {
    if (authManager.isLoggedIn()) {
      await authManager.logout();
      updateUserDisplay(doc, authManager);
      showMessage(doc, getString("auth-success"), false);
    } else {
      const success = await showAuthDialog("login");
      if (success) {
        updateUserDisplay(doc, authManager);
        showMessage(doc, getString("auth-success"), false);
      }
    }
  });

  // Redeem button
  const redeemBtn = doc.getElementById("pref-redeem-btn");
  const redeemInput = doc.getElementById("pref-redeem-code") as HTMLInputElement;

  redeemBtn?.addEventListener("click", async () => {
    const code = redeemInput?.value?.trim();
    if (!code) {
      showMessage(doc, getString("auth-error-code-required"), true);
      return;
    }

    if (!authManager.isLoggedIn()) {
      const success = await showAuthDialog("login");
      if (!success) return;
      updateUserDisplay(doc, authManager);
    }

    (redeemBtn as HTMLButtonElement).disabled = true;
    try {
      const result = await authManager.redeemCode(code);
      if (result.success) {
        showMessage(doc, result.message, false);
        redeemInput.value = "";
        updateUserDisplay(doc, authManager);
      } else {
        showMessage(doc, result.message, true);
      }
    } finally {
      (redeemBtn as HTMLButtonElement).disabled = false;
    }
  });

  // Copy invitation code button
  const copyAffCodeBtn = doc.getElementById("pref-copy-aff-code");
  const affCodeInput = doc.getElementById("pref-aff-code") as HTMLInputElement;
  copyAffCodeBtn?.addEventListener("click", () => {
    const affCode = affCodeInput?.value;
    if (affCode) {
      // Copy to clipboard using Zotero's copyTextToClipboard
      new ztoolkit.Clipboard().addText(affCode, "text/plain").copy();
      // Show feedback
      showMessage(doc, getString("pref-copied"), false);
    }
  });

  // Official website link
  const websiteLink = doc.getElementById("pref-pdfaitalk-website");
  websiteLink?.addEventListener("click", (e: Event) => {
    e.preventDefault();
    // Open the console page
    Zotero.launchURL("https://oneai.tracepad.site/console");
  });

  // PDFAiTalk model selection - save to provider config
  const pdfaitalkModelSelect = doc.getElementById("pref-pdfaitalk-model") as XULMenuListElement;
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
    await fetchPdfaitalkModels(doc, authManager);
  });

  // Auth callbacks - refresh provider list on login status change
  authManager.setCallbacks({
    onBalanceUpdate: () => updateUserDisplay(doc, authManager),
    onLoginStatusChange: () => {
      updateUserDisplay(doc, authManager);
      // Refresh provider list to update green dot status
      populateProviderList(doc);
    },
  });

  // ===== API Key Provider Events =====

  // API Key input (save on blur and auto-fetch models)
  const apikeyInput = doc.getElementById("pref-provider-apikey") as HTMLInputElement;
  apikeyInput?.addEventListener("blur", async () => {
    saveCurrentProviderConfig(doc);
    // Refresh provider list to update green dot status
    populateProviderList(doc);
    // Auto-fetch models when API key is entered
    if (apikeyInput.value.trim()) {
      await autoFetchModels(doc, providerManager, currentProviderId);
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
  const baseurlInput = doc.getElementById("pref-provider-baseurl") as HTMLInputElement;
  baseurlInput?.addEventListener("blur", () => saveCurrentProviderConfig(doc));

  // Model selection
  const modelSelect = doc.getElementById("pref-provider-model") as XULMenuListElement;
  modelSelect?.addEventListener("command", () => saveCurrentProviderConfig(doc));

  // Max tokens
  const maxTokensInput = doc.getElementById("pref-provider-maxtokens") as HTMLInputElement;
  maxTokensInput?.addEventListener("blur", () => saveCurrentProviderConfig(doc));

  // Temperature
  const temperatureInput = doc.getElementById("pref-provider-temperature") as HTMLInputElement;
  temperatureInput?.addEventListener("blur", () => saveCurrentProviderConfig(doc));

  // System prompt
  const systemPromptInput = doc.getElementById("pref-provider-systemprompt") as HTMLTextAreaElement;
  systemPromptInput?.addEventListener("blur", () => saveCurrentProviderConfig(doc));

  // Refresh models button
  const refreshModelsBtn = doc.getElementById("pref-refresh-models");
  refreshModelsBtn?.addEventListener("click", async () => {
    const provider = providerManager.getProvider(currentProviderId);
    if (provider) {
      try {
        const models = await provider.getAvailableModels();
        const config = providerManager.getProviderConfig(currentProviderId) as ApiKeyProviderConfig;
        if (config && models.length > 0) {
          providerManager.updateProviderConfig(currentProviderId, { availableModels: models });
          // Refresh panel
          const metadata = providerManager.getProviderMetadata(currentProviderId);
          populateApiKeyPanel(doc, { ...config, availableModels: models }, metadata);
        }
      } catch (e) {
        showTestResult(doc, getString("pref-refresh-failed"), true);
      }
    }
  });

  // Test connection button
  const testConnectionBtn = doc.getElementById("pref-test-connection");
  testConnectionBtn?.addEventListener("click", async () => {
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
    if (providerManager.removeCustomProvider(currentProviderId)) {
      populateProviderList(doc);
      populateActiveProviderDropdown(doc);
      selectProvider(doc, "pdfaitalk");
    }
  });

  // Add custom provider button
  const addProviderBtn = doc.getElementById("pref-add-provider-btn");
  addProviderBtn?.addEventListener("click", () => {
    const name = addon.data.prefs?.window?.prompt(getString("pref-enter-provider-name"));
    if (name && name.trim()) {
      const newId = providerManager.addCustomProvider(name.trim());
      populateProviderList(doc);
      populateActiveProviderDropdown(doc);
      selectProvider(doc, newId);
    }
  });

  // Add custom model button
  const addModelBtn = doc.getElementById("pref-add-model-btn");
  addModelBtn?.addEventListener("click", () => {
    if (currentProviderId === "pdfaitalk") return;

    const modelId = addon.data.prefs?.window?.prompt(getString("pref-enter-model-id"));
    if (modelId && modelId.trim()) {
      const success = providerManager.addCustomModel(currentProviderId, modelId.trim());
      if (success) {
        const config = providerManager.getProviderConfig(currentProviderId) as ApiKeyProviderConfig;
        if (config) {
          const metadata = providerManager.getProviderMetadata(currentProviderId);
          populateApiKeyPanel(doc, config, metadata);
        }
      } else {
        showTestResult(doc, getString("pref-model-exists" as any), true);
      }
    }
  });

  // Active provider selection
  const activeProviderSelect = doc.getElementById("pref-active-provider-select") as XULMenuListElement;
  activeProviderSelect?.addEventListener("command", () => {
    providerManager.setActiveProvider(activeProviderSelect.value);
    // Refresh provider list to update checkmark
    populateProviderList(doc);
  });
}

function saveCurrentProviderConfig(doc: Document) {
  if (currentProviderId === "pdfaitalk") return;

  const providerManager = getProviderManager();

  const apikeyEl = doc.getElementById("pref-provider-apikey") as HTMLInputElement;
  const baseurlEl = doc.getElementById("pref-provider-baseurl") as HTMLInputElement;
  const modelSelect = doc.getElementById("pref-provider-model") as XULMenuListElement;
  const maxTokensEl = doc.getElementById("pref-provider-maxtokens") as HTMLInputElement;
  const temperatureEl = doc.getElementById("pref-provider-temperature") as HTMLInputElement;
  const systemPromptEl = doc.getElementById("pref-provider-systemprompt") as HTMLTextAreaElement;

  const apiKey = apikeyEl?.value || "";
  const wasEnabled = (providerManager.getProviderConfig(currentProviderId) as ApiKeyProviderConfig)?.enabled;
  const isNowEnabled = !!apiKey.trim();

  const updates: Partial<ApiKeyProviderConfig> = {
    enabled: isNowEnabled, // Auto-enable when API key is filled
    apiKey,
    baseUrl: baseurlEl?.value || "",
    defaultModel: modelSelect?.value || "",
    maxTokens: parseInt(maxTokensEl?.value) || 4096,
    temperature: parseFloat(temperatureEl?.value) || 0.7,
    systemPrompt: systemPromptEl?.value || "",
  };

  providerManager.updateProviderConfig(currentProviderId, updates);

  // Refresh active provider dropdown if enabled status changed
  if (wasEnabled !== isNowEnabled) {
    populateActiveProviderDropdown(doc);
  }
}

/**
 * Auto-fetch models from provider API after API key is entered
 */
async function autoFetchModels(
  doc: Document,
  providerManager: ReturnType<typeof getProviderManager>,
  providerId: string,
) {
  const provider = providerManager.getProvider(providerId);
  if (!provider) return;

  try {
    showTestResult(doc, getString("pref-fetching-models"), false);
    const models = await provider.getAvailableModels();
    const config = providerManager.getProviderConfig(providerId) as ApiKeyProviderConfig;
    if (config && models.length > 0) {
      providerManager.updateProviderConfig(providerId, { availableModels: models });
      // Refresh panel
      const metadata = providerManager.getProviderMetadata(providerId);
      populateApiKeyPanel(doc, { ...config, availableModels: models }, metadata);
      showTestResult(doc, getString("pref-models-loaded", { args: { count: models.length } }), false);
    } else {
      showTestResult(doc, "", false);
    }
  } catch {
    showTestResult(doc, getString("pref-fetch-models-failed"), true);
  }
}

function showTestResult(doc: Document, message: string, isError: boolean) {
  const resultEl = doc.getElementById("pref-test-result") as HTMLElement | null;
  if (resultEl) {
    resultEl.textContent = message;
    resultEl.style.color = isError ? "#c62828" : "#2e7d32";
  }
}

function showMessage(doc: Document, message: string, isError: boolean) {
  const messageEl = doc.getElementById("pref-redeem-message") as HTMLElement | null;
  if (messageEl) {
    messageEl.setAttribute("value", message);
    messageEl.style.color = isError ? "#c62828" : "#2e7d32";

    setTimeout(() => {
      messageEl.setAttribute("value", "");
    }, 5000);
  }
}

/**
 * Fetch model ratios from PDFAiTalk pricing API
 */
async function fetchPdfaitalkRatios(apiKey: string): Promise<void> {
  const baseUrl = BUILTIN_PROVIDERS.pdfaitalk.defaultBaseUrl.replace("/v1", "");
  const url = `${baseUrl}/api/pricing`;
  ztoolkit.log("[Preferences] Fetching ratios from:", url);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      ztoolkit.log("[Preferences] Failed to fetch ratios:", response.status);
      return;
    }

    const result = await response.json() as {
      data?: Array<{
        model_name: string;
        model_ratio: number;
      }>;
    };

    if (result.data && Array.isArray(result.data)) {
      // Build model_name -> model_ratio mapping
      pdfaitalkModelRatios = {};
      for (const item of result.data) {
        if (item.model_name && typeof item.model_ratio === "number") {
          pdfaitalkModelRatios[item.model_name] = item.model_ratio;
        }
      }
      // Cache ratios to prefs
      setPref("pdfaitalkRatiosCache", JSON.stringify(pdfaitalkModelRatios));
      ztoolkit.log("[Preferences] Loaded ratios for", Object.keys(pdfaitalkModelRatios).length, "models");
    }
  } catch (e) {
    ztoolkit.log("[Preferences] Failed to fetch ratios:", e);
  }
}

/**
 * Load cached ratios from prefs
 */
function loadCachedRatios(): void {
  const cached = getPref("pdfaitalkRatiosCache") as string;
  if (cached) {
    try {
      pdfaitalkModelRatios = JSON.parse(cached);
      ztoolkit.log("[Preferences] Loaded cached ratios for", Object.keys(pdfaitalkModelRatios).length, "models");
    } catch {
      // ignore parse error
    }
  }
}

/**
 * Fetch PDFAiTalk models from API
 */
async function fetchPdfaitalkModels(
  doc: Document,
  authManager: ReturnType<typeof getAuthManager>,
) {
  ztoolkit.log("[Preferences] fetchPdfaitalkModels called");

  const apiKey = authManager.getApiKey();
  ztoolkit.log("[Preferences] apiKey:", apiKey ? "exists" : "empty");

  if (!apiKey) {
    showMessage(doc, getString("user-panel-not-logged-in"), true);
    return;
  }

  showMessage(doc, getString("pref-fetching-models"), false);

  // Fetch ratios first (in parallel with models)
  const ratiosPromise = fetchPdfaitalkRatios(apiKey);

  const url = `${BUILTIN_PROVIDERS.pdfaitalk.defaultBaseUrl}/models`;
  ztoolkit.log("[Preferences] Fetching models from:", url);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
    });

    ztoolkit.log("[Preferences] Response status:", response.status);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json() as { data?: Array<{ id: string }> };
    ztoolkit.log("[Preferences] Models response:", JSON.stringify(result).substring(0, 200));

    // Wait for ratios to complete
    await ratiosPromise;

    if (result.data && Array.isArray(result.data)) {
      const models = result.data.map((m) => m.id).sort();
      ztoolkit.log("[Preferences] Parsed models count:", models.length);
      populatePdfaitalkModels(doc, models, true); // Save to cache
      showMessage(doc, getString("pref-models-loaded", { args: { count: models.length } }), false);
    }
  } catch (e) {
    ztoolkit.log("[Preferences] Failed to fetch PDFAiTalk models:", e);
    showMessage(doc, getString("pref-fetch-models-failed"), true);
  }
}
