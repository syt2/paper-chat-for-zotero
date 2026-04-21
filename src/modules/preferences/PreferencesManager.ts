/**
 * PreferencesManager - Main preferences coordination
 */

import { getAuthManager } from "../auth";
import { getProviderManager } from "../providers";
import { loadCachedRatios, fetchPaperchatModels } from "./ModelsFetcher";
import { updateUserDisplay, bindUserAuthEvents } from "./UserAuthUI";
import {
  populatePaperchatModels,
  bindPaperchatEvents,
} from "./PaperchatProviderUI";
import { bindApiKeyEvents } from "./ApiKeyProviderUI";
import {
  populateProviderList,
  selectProvider,
  populateActiveProviderDropdown,
  bindProviderListClickEvents,
  bindActiveProviderEvent,
} from "./ProviderListUI";
import { getPref, setPref } from "../../utils/prefs";
import { getString } from "../../utils/locale";
import { getAISummaryManager } from "../ai-summary";
import { getAllTemplates } from "../ai-summary/defaultTemplates";
import { getEmbeddingProviderFactory } from "../embedding";
import {
  CONFIGURABLE_TOOL_PERMISSION_RISK_LEVELS,
  getToolPermissionDefaultMode,
  setToolPermissionDefaultMode,
} from "../chat/tool-permissions/ToolPermissionDefaults";
import {
  DEFAULT_WEB_SEARCH_PROVIDER_ID,
  listWebSearchProviders,
  normalizeWebSearchProviderId,
} from "../chat/web-search/WebSearchRegistry";
import { normalizeAgentMaxPlanningIterations } from "../chat/agent-runtime/IterationLimitConfig";
import { getErrorMessage } from "../../utils/common";
import type { PrefsRefreshOptions } from "./types";
import type {
  ToolPermissionMode,
  ToolPermissionRiskLevel,
} from "../../types/tool";
import { ANALYTICS_EVENTS, getAnalyticsService } from "../analytics";

// Current selected provider ID
let currentProviderId: string = "paperchat";

const TOOL_PERMISSION_MODE_L10N: Record<ToolPermissionMode, string> = {
  auto_allow: "pref-tool-permission-mode-auto-allow",
  ask: "pref-tool-permission-mode-ask",
  deny: "pref-tool-permission-mode-deny",
};

/**
 * Get current provider ID
 */
export function getCurrentProviderId(): string {
  return currentProviderId;
}

/**
 * Set current provider ID
 */
export function setCurrentProviderId(id: string): void {
  currentProviderId = id;
}

/**
 * Initialize preferences UI
 */
export async function initializePrefsUI(): Promise<void> {
  if (addon.data.prefs?.window == undefined) return;

  const authManager = getAuthManager();

  // Initialize auth manager
  await authManager.initialize();

  await refreshPrefsUI({
    syncUserInfo: false,
    trackProviderView: true,
    providerViewSource: "settings_opened",
  });

  getAnalyticsService().track(ANALYTICS_EVENTS.settingsOpened, {
    selected_provider: currentProviderId,
  });
}

function resolveCurrentProviderId(
  doc: Document,
  providerManager: ReturnType<typeof getProviderManager>,
  options: PrefsRefreshOptions,
): string {
  if (
    options.providerId &&
    providerManager.getProviderConfig(options.providerId)
  ) {
    return options.providerId;
  }

  const selectedProviderId = doc
    .querySelector('.provider-list-item[data-selected="true"]')
    ?.getAttribute("data-provider-id");

  const candidateProviderId =
    selectedProviderId || currentProviderId || providerManager.getActiveProviderId();

  if (candidateProviderId && providerManager.getProviderConfig(candidateProviderId)) {
    return candidateProviderId;
  }

  return providerManager.getActiveProviderId();
}

export async function refreshPrefsUI(
  options: PrefsRefreshOptions = {},
): Promise<void> {
  if (addon.data.prefs?.window == undefined) return;

  const doc = addon.data.prefs.window.document;
  const authManager = getAuthManager();
  const providerManager = getProviderManager();

  if (options.syncUserInfo && authManager.isLoggedIn()) {
    await authManager.refreshUserInfo();
  }

  // Load cached model ratios
  loadCachedRatios();

  // Populate provider sidebar
  populateProviderList(doc);

  // Populate active provider dropdown
  populateActiveProviderDropdown(doc);

  // Preserve current sidebar selection when possible instead of resetting to active provider
  currentProviderId = resolveCurrentProviderId(doc, providerManager, options);
  selectProvider(doc, currentProviderId, setCurrentProviderId, {
    trackAnalytics: options.trackProviderView === true,
    analyticsSource: options.providerViewSource || "refresh",
  });

  // Update paperchat user status display
  updateUserDisplay(doc, authManager);

  // Populate PaperChat model dropdown
  populatePaperchatModels(doc);

  // Initialize PDF settings checkbox
  initPdfSettingsCheckbox(doc);

  // Initialize AI tools settings checkbox
  initAIToolsSettingsCheckbox(doc);

  // Initialize AISummary settings
  initAISummarySettings(doc);

  // Initialize Semantic Search settings
  await initSemanticSearchSettings(doc);
}

/**
 * Initialize PDF settings checkboxes
 */
function initPdfSettingsCheckbox(doc: Document): void {
  const uploadRawPdfCheckbox = doc.getElementById(
    "pref-upload-raw-pdf-checkbox",
  ) as XUL.Checkbox | null;
  if (uploadRawPdfCheckbox) {
    uploadRawPdfCheckbox.checked = getPref("uploadRawPdfOnFailure") as boolean;
  }
}

/**
 * Initialize AI tools settings checkbox
 */
function initAIToolsSettingsCheckbox(doc: Document): void {
  populateWebSearchProviderOptions(doc);
  initAgentIterationLimitControl(doc);
  initToolPermissionDefaultsControls(doc);
}

/**
 * Bind all preference events
 */
export function bindPrefEvents(): void {
  if (!addon.data.prefs?.window) return;

  const doc = addon.data.prefs.window.document;
  const win = addon.data.prefs.window;
  const authManager = getAuthManager();

  type PrefsWindowState = Window & {
    __paperchatPrefsFocusBound?: boolean;
    __paperchatPrefsCleanup?: Array<() => void>;
    __paperchatPrefsUnloadBound?: boolean;
  };
  const prefsWin = win as PrefsWindowState;

  if (!prefsWin.__paperchatPrefsFocusBound) {
    prefsWin.__paperchatPrefsFocusBound = true;
    win.addEventListener("focus", () => {
      void refreshPrefsUI({
        syncUserInfo: false,
        trackProviderView: false,
      });
    });
  }

  if (!prefsWin.__paperchatPrefsCleanup) {
    prefsWin.__paperchatPrefsCleanup = [];
  }

  if (!prefsWin.__paperchatPrefsUnloadBound) {
    prefsWin.__paperchatPrefsUnloadBound = true;
    win.addEventListener("unload", () => {
      for (const cleanup of prefsWin.__paperchatPrefsCleanup || []) {
        cleanup();
      }
      prefsWin.__paperchatPrefsCleanup = [];
      prefsWin.__paperchatPrefsFocusBound = false;
      prefsWin.__paperchatPrefsUnloadBound = false;
    });
  }

  // Refresh callbacks for provider list
  const refreshProviderList = () => populateProviderList(doc);
  const refreshActiveProvider = () => populateActiveProviderDropdown(doc);

  // Bind user auth events
  const cleanupUserAuthEvents = bindUserAuthEvents(
    doc,
    authManager,
    refreshProviderList,
  );
  prefsWin.__paperchatPrefsCleanup.push(cleanupUserAuthEvents);

  // Bind PaperChat events
  bindPaperchatEvents(doc, async () => {
    await fetchPaperchatModels(doc, (models) => {
      populatePaperchatModels(doc, models, true);
    });
  });

  // Bind API key events
  bindApiKeyEvents(
    doc,
    getCurrentProviderId,
    refreshProviderList,
    refreshActiveProvider,
  );

  // Bind provider list click events
  bindProviderListClickEvents(doc, setCurrentProviderId);

  // Bind active provider selection event
  bindActiveProviderEvent(doc);

  // Bind PDF settings checkbox event
  bindPdfSettingsEvent(doc);

  // Bind AI tools settings checkbox event
  bindAIToolsSettingsEvent(doc);

  // Bind AISummary settings events
  bindAISummarySettingsEvents(doc);

  // Bind Semantic Search settings events
  bindSemanticSearchSettingsEvents(doc);
}

/**
 * Bind PDF settings checkbox events
 */
function bindPdfSettingsEvent(doc: Document): void {
  const uploadRawPdfCheckbox = doc.getElementById(
    "pref-upload-raw-pdf-checkbox",
  ) as XUL.Checkbox | null;
  if (uploadRawPdfCheckbox) {
    uploadRawPdfCheckbox.addEventListener("command", () => {
      setPref("uploadRawPdfOnFailure", uploadRawPdfCheckbox.checked);
    });
  }
}

/**
 * Bind AI tools settings checkbox events
 */
function bindAIToolsSettingsEvent(doc: Document): void {
  const webSearchProviderSelect = doc.getElementById(
    "pref-web-search-provider",
  ) as unknown as XULMenuListElement | null;
  if (webSearchProviderSelect) {
    webSearchProviderSelect.addEventListener("command", () => {
      setPref(
        "webSearchProvider",
        webSearchProviderSelect.value || "duckduckgo",
      );
    });
  }

  const agentIterationInput = doc.getElementById(
    "pref-agent-max-planning-iterations",
  ) as HTMLInputElement | null;
  if (agentIterationInput) {
    const persist = () => {
      const parsed = Number.parseInt(agentIterationInput.value, 10);
      const normalized = normalizeAgentMaxPlanningIterations(parsed);
      agentIterationInput.value = String(normalized);
      setPref("agentMaxPlanningIterations", normalized);
    };

    agentIterationInput.addEventListener("change", persist);
    agentIterationInput.addEventListener("blur", persist);
  }

  bindToolPermissionDefaultsEvents(doc);
}

function initAgentIterationLimitControl(doc: Document): void {
  const agentIterationInput = doc.getElementById(
    "pref-agent-max-planning-iterations",
  ) as HTMLInputElement | null;
  if (!agentIterationInput) {
    return;
  }

  const configured = getPref("agentMaxPlanningIterations") as number | undefined;
  agentIterationInput.value = String(
    normalizeAgentMaxPlanningIterations(configured),
  );
}

function populateWebSearchProviderOptions(doc: Document): void {
  const providerSelect = doc.getElementById(
    "pref-web-search-provider",
  ) as unknown as XULMenuListElement | null;
  const providerPopup = doc.getElementById(
    "pref-web-search-provider-popup",
  ) as XUL.MenuPopup | null;

  if (!providerSelect || !providerPopup) {
    return;
  }

  while (providerPopup.firstChild) {
    providerPopup.removeChild(providerPopup.firstChild);
  }

  for (const provider of listWebSearchProviders()) {
    const providerItem = doc.createXULElement("menuitem");
    providerItem.setAttribute("label", getString(provider.labelL10nId));
    providerItem.setAttribute("value", provider.id);
    providerPopup.appendChild(providerItem);
  }

  const selectedProvider =
    (getPref("webSearchProvider") as string) || DEFAULT_WEB_SEARCH_PROVIDER_ID;
  const normalizedProvider = normalizeWebSearchProviderId(selectedProvider);
  if (normalizedProvider !== selectedProvider) {
    setPref("webSearchProvider", normalizedProvider);
  }
  providerSelect.value = normalizedProvider;
}

function initToolPermissionDefaultsControls(doc: Document): void {
  for (const riskLevel of CONFIGURABLE_TOOL_PERMISSION_RISK_LEVELS) {
    const menulist = doc.getElementById(
      getToolPermissionMenulistId(riskLevel),
    ) as unknown as XULMenuListElement | null;
    const popup = doc.getElementById(
      getToolPermissionPopupId(riskLevel),
    ) as XUL.MenuPopup | null;
    if (!menulist || !popup) {
      continue;
    }

    populateToolPermissionModeOptions(doc, popup);
    menulist.value = getToolPermissionDefaultMode(riskLevel);
  }
}

function bindToolPermissionDefaultsEvents(doc: Document): void {
  for (const riskLevel of CONFIGURABLE_TOOL_PERMISSION_RISK_LEVELS) {
    const menulist = doc.getElementById(
      getToolPermissionMenulistId(riskLevel),
    ) as unknown as XULMenuListElement | null;
    if (!menulist) {
      continue;
    }

    menulist.addEventListener("command", () => {
      const mode = menulist.value as ToolPermissionMode;
      if (!isToolPermissionMode(mode)) {
        return;
      }
      setToolPermissionDefaultMode(riskLevel, mode);
    });
  }
}

function populateToolPermissionModeOptions(
  doc: Document,
  popup: XUL.MenuPopup,
): void {
  if (popup.childElementCount > 0) {
    return;
  }

  for (const mode of Object.keys(
    TOOL_PERMISSION_MODE_L10N,
  ) as ToolPermissionMode[]) {
    const menuitem = doc.createXULElement("menuitem");
    menuitem.setAttribute("label", getString(TOOL_PERMISSION_MODE_L10N[mode]));
    menuitem.setAttribute("value", mode);
    popup.appendChild(menuitem);
  }
}

function getToolPermissionMenulistId(
  riskLevel: ToolPermissionRiskLevel,
): string {
  return `pref-tool-permission-${riskLevel.replace(/_/g, "-")}`;
}

function getToolPermissionPopupId(riskLevel: ToolPermissionRiskLevel): string {
  return `${getToolPermissionMenulistId(riskLevel)}-popup`;
}

function isToolPermissionMode(value: string): value is ToolPermissionMode {
  return value === "auto_allow" || value === "ask" || value === "deny";
}

/**
 * Initialize AISummary settings
 */
function initAISummarySettings(doc: Document): void {
  const aiSummaryManager = getAISummaryManager();
  const config = aiSummaryManager.getConfig();

  // Template dropdown
  populateAISummaryTemplates(doc, config.templateId);

  // Include Annotations checkbox
  const includeAnnotationsCheckbox = doc.getElementById(
    "pref-aisummary-include-annotations",
  ) as XUL.Checkbox | null;
  if (includeAnnotationsCheckbox) {
    includeAnnotationsCheckbox.checked = config.includeAnnotations ?? true;
  }

  // Update status display
  updateAISummaryStatus(doc);
}

/**
 * Populate AISummary template dropdown
 */
function populateAISummaryTemplates(
  doc: Document,
  selectedTemplateId?: string,
): void {
  const templateSelect = doc.getElementById(
    "pref-aisummary-template",
  ) as XUL.MenuList | null;
  const popup = doc.getElementById(
    "pref-aisummary-template-popup",
  ) as XUL.MenuPopup | null;

  if (!templateSelect || !popup) return;

  // Clear existing items
  while (popup.firstChild) {
    popup.removeChild(popup.firstChild);
  }

  // Add templates
  const templates = getAllTemplates();
  for (const template of templates) {
    const menuitem = doc.createXULElement("menuitem");
    menuitem.setAttribute("label", template.name);
    menuitem.setAttribute("value", template.id);
    popup.appendChild(menuitem);
  }

  // Set selected value
  if (selectedTemplateId) {
    templateSelect.value = selectedTemplateId;
  } else if (templates.length > 0) {
    templateSelect.value = templates[0].id;
  }
}

/**
 * Update AISummary status display
 */
function updateAISummaryStatus(doc: Document): void {
  const statusLabel = doc.getElementById(
    "pref-aisummary-status",
  ) as HTMLElement | null;
  if (!statusLabel) return;

  const aiSummaryManager = getAISummaryManager();
  const progress = aiSummaryManager.getProgress();

  if (progress.status === "running") {
    statusLabel.textContent = getString("aisummary-progress-running", {
      args: { processed: progress.processedItems, total: progress.totalItems },
    });
    statusLabel.style.color = "#0078d4";
  } else if (progress.status === "paused") {
    statusLabel.textContent = getString("aisummary-progress-paused", {
      args: { processed: progress.processedItems, total: progress.totalItems },
    });
    statusLabel.style.color = "#ffa500";
  } else if (progress.status === "completed") {
    statusLabel.textContent = getString("aisummary-progress-completed", {
      args: { success: progress.successfulItems, failed: progress.failedItems },
    });
    statusLabel.style.color = "#008000";
  } else if (progress.status === "error") {
    statusLabel.textContent = getString("aisummary-progress-error", {
      args: { error: progress.errors[0]?.error || getString("unknown") },
    });
    statusLabel.style.color = "#c00";
  } else {
    statusLabel.textContent = "";
  }
}

/**
 * Bind AISummary settings events
 */
function bindAISummarySettingsEvents(doc: Document): void {
  const aiSummaryManager = getAISummaryManager();

  // Template
  const templateSelect = doc.getElementById(
    "pref-aisummary-template",
  ) as XUL.MenuList | null;
  if (templateSelect) {
    templateSelect.addEventListener("command", async () => {
      await aiSummaryManager.updateConfig({ templateId: templateSelect.value });
    });
  }

  // Include Annotations checkbox
  const includeAnnotationsCheckbox = doc.getElementById(
    "pref-aisummary-include-annotations",
  ) as XUL.Checkbox | null;
  if (includeAnnotationsCheckbox) {
    includeAnnotationsCheckbox.addEventListener("command", async () => {
      await aiSummaryManager.updateConfig({
        includeAnnotations: includeAnnotationsCheckbox.checked,
      });
    });
  }

  // Run now button
  const runNowBtn = doc.getElementById(
    "pref-aisummary-run-now",
  ) as HTMLButtonElement | null;
  if (runNowBtn) {
    runNowBtn.addEventListener("click", async () => {
      const progress = aiSummaryManager.getProgress();

      // 如果正在运行，不要再次启动
      if (progress.status === "running") {
        return;
      }

      // 更新按钮状态
      runNowBtn.disabled = true;
      updateAISummaryStatus(doc);

      try {
        await aiSummaryManager.startBatch();
        updateAISummaryStatus(doc);

        // Set up periodic status updates while running
        const updateInterval = setInterval(() => {
          const currentProgress = aiSummaryManager.getProgress();
          updateAISummaryStatus(doc);
          if (
            currentProgress.status !== "running" &&
            currentProgress.status !== "paused"
          ) {
            clearInterval(updateInterval);
            runNowBtn.disabled = false;
          }
        }, 1000);
      } catch (error) {
        runNowBtn.disabled = false;
        const statusLabel = doc.getElementById(
          "pref-aisummary-status",
        ) as HTMLElement | null;
        if (statusLabel) {
          statusLabel.textContent = getString("aisummary-progress-error", {
            args: { error: getErrorMessage(error) },
          });
          statusLabel.style.color = "#c00";
        }
      }
    });
  }

  // Set up progress callback
  aiSummaryManager.setOnProgressUpdate(() => {
    updateAISummaryStatus(doc);
  });
}

/**
 * Initialize Semantic Search settings
 */
async function initSemanticSearchSettings(doc: Document): Promise<void> {
  const checkbox = doc.getElementById(
    "pref-enable-semantic-search-checkbox",
  ) as XUL.Checkbox | null;
  if (checkbox) {
    // Default to true
    const enabled = getPref("enableSemanticSearch") ?? true;
    checkbox.checked = enabled;
  }

  // Update status display
  await updateSemanticSearchStatus(doc);
}

/**
 * Update Semantic Search status display
 */
async function updateSemanticSearchStatus(doc: Document): Promise<void> {
  const statusLabel = doc.getElementById(
    "pref-semantic-search-status",
  ) as HTMLElement | null;
  if (!statusLabel) return;

  try {
    const factory = getEmbeddingProviderFactory();
    const status = await factory.getStatus();

    statusLabel.textContent = status.message;
    statusLabel.style.color = status.available ? "#008000" : "#c00";
  } catch (error) {
    statusLabel.textContent = getString("aisummary-progress-error", {
      args: { error: getErrorMessage(error) },
    });
    statusLabel.style.color = "#c00";
  }
}

/**
 * Bind Semantic Search settings events
 */
function bindSemanticSearchSettingsEvents(doc: Document): void {
  const checkbox = doc.getElementById(
    "pref-enable-semantic-search-checkbox",
  ) as XUL.Checkbox | null;
  if (checkbox) {
    checkbox.addEventListener("command", () => {
      setPref("enableSemanticSearch", checkbox.checked);
    });
  }
}
