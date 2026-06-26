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
import { normalizeAgentMaxPlanningIterations } from "../chat/agent-runtime/IterationLimitConfig";
import {
  CONTEXT_AUTO_COMPACT_WINDOW_TOKEN_STEPS,
  normalizeContextAutoCompactWindowTokens,
} from "../chat/ContextManager";
import { getErrorMessage } from "../../utils/common";
import type { PrefsRefreshOptions } from "./types";
import type {
  ToolPermissionMode,
  ToolPermissionRiskLevel,
} from "../../types/tool";
import { ANALYTICS_EVENTS, getAnalyticsService } from "../analytics";
import { refreshPaperChatNoticeUI } from "./PaperChatNoticeRenderer";

// Current selected provider ID
let currentProviderId: string = "paperchat";

const TOOL_PERMISSION_MODE_L10N: Record<ToolPermissionMode, string> = {
  auto_allow: "pref-tool-permission-mode-auto-allow",
  ask: "pref-tool-permission-mode-ask",
  deny: "pref-tool-permission-mode-deny",
};

const CONTEXT_AUTO_COMPACT_SLIDER_POSITIONS: ReadonlyArray<{
  position: number;
  tokens: (typeof CONTEXT_AUTO_COMPACT_WINDOW_TOKEN_STEPS)[number];
}> = [
  { position: 0, tokens: 40000 },
  { position: 6, tokens: 50000 },
  { position: 12, tokens: 60000 },
  { position: 20, tokens: 80000 },
  { position: 28, tokens: 100000 },
  { position: 34, tokens: 120000 },
  { position: 42, tokens: 150000 },
  { position: 48, tokens: 180000 },
  { position: 50, tokens: 200000 },
  { position: 62, tokens: 300000 },
  { position: 70, tokens: 400000 },
  { position: 78, tokens: 500000 },
  { position: 84, tokens: 600000 },
  { position: 92, tokens: 800000 },
  { position: 100, tokens: 1000000 },
];

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
  const doc = addon.data.prefs.window.document;
  const providerManager = getProviderManager();

  // Initialize auth manager
  await authManager.initialize();

  const initialProviderId = resolveCurrentProviderId(doc, providerManager, {});
  getAnalyticsService().track(ANALYTICS_EVENTS.settingsOpened, {
    selected_provider: initialProviderId,
  });

  await refreshPrefsUI({
    syncUserInfo: false,
    trackProviderView: true,
    providerViewSource: "settings_opened",
  });

  void refreshPaperChatNoticeUI(doc);
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
    selectedProviderId ||
    currentProviderId ||
    providerManager.getActiveProviderId();

  if (
    candidateProviderId &&
    providerManager.getProviderConfig(candidateProviderId)
  ) {
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

  // Initialize Reading Loop settings
  initReadingLoopSettings(doc);
  initNextQuestionHintSettings(doc);

  // Initialize AISummary settings
  initAISummarySettings(doc);
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
  initAgentIterationLimitControl(doc);
  initContextAutoCompactThresholdControl(doc);
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

  const invalidateEmbeddingProviderCache = () => {
    getEmbeddingProviderFactory().invalidateCache();
  };

  // Refresh callbacks for provider list
  const refreshProviderList = () => {
    populateProviderList(doc);
    invalidateEmbeddingProviderCache();
  };
  const refreshActiveProvider = () => {
    populateActiveProviderDropdown(doc);
    invalidateEmbeddingProviderCache();
  };

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
      invalidateEmbeddingProviderCache();
    });
  });

  // Bind API key events
  bindApiKeyEvents(
    doc,
    getCurrentProviderId,
    refreshProviderList,
    refreshActiveProvider,
    (providerId) => {
      selectProvider(doc, providerId, setCurrentProviderId, {
        trackAnalytics: true,
        analyticsSource: "provider_added",
      });
    },
    () => {
      const fallbackProviderId = getProviderManager().getActiveProviderId();
      selectProvider(doc, fallbackProviderId, setCurrentProviderId, {
        trackAnalytics: false,
      });
    },
  );

  // Bind provider list click events
  bindProviderListClickEvents(doc, setCurrentProviderId);

  // Bind active provider selection event
  bindActiveProviderEvent(doc);
  bindEmbeddingProviderCacheInvalidationEvent(doc);

  // Bind PDF settings checkbox event
  bindPdfSettingsEvent(doc);

  // Bind AI tools settings checkbox event
  bindAIToolsSettingsEvent(doc);

  // Bind Reading Loop settings event
  bindReadingLoopSettingsEvents(doc);
  bindNextQuestionHintSettingsEvents(doc);

  // Bind AISummary settings events
  bindAISummarySettingsEvents(doc);
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

  const contextAutoCompactThresholdInput = doc.getElementById(
    "pref-context-auto-compact-threshold",
  ) as HTMLInputElement | null;
  if (contextAutoCompactThresholdInput) {
    const persist = () => {
      const step = getNearestContextAutoCompactSliderStep(
        contextAutoCompactThresholdInput.value,
      );
      contextAutoCompactThresholdInput.value = String(step.position);
      setPref("contextAutoCompactWindowTokens", step.tokens);
      updateContextAutoCompactThresholdDisplay(doc);
    };

    contextAutoCompactThresholdInput.addEventListener("input", persist);
    contextAutoCompactThresholdInput.addEventListener("change", persist);
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

  const configured = getPref("agentMaxPlanningIterations") as
    | number
    | undefined;
  agentIterationInput.value = String(
    normalizeAgentMaxPlanningIterations(configured),
  );
}

function initContextAutoCompactThresholdControl(doc: Document): void {
  const thresholdInput = doc.getElementById(
    "pref-context-auto-compact-threshold",
  ) as HTMLInputElement | null;
  if (!thresholdInput) {
    return;
  }

  const configured = getPref("contextAutoCompactWindowTokens") as
    | number
    | undefined;
  const normalized = normalizeContextAutoCompactWindowTokens(configured);
  const step = getContextAutoCompactSliderStepForTokens(normalized);
  thresholdInput.value = String(step.position);
  if (configured !== normalized) {
    setPref("contextAutoCompactWindowTokens", normalized);
  }
  updateContextAutoCompactThresholdDisplay(doc);
}

function getNearestContextAutoCompactSliderStep(value: unknown): {
  position: number;
  tokens: (typeof CONTEXT_AUTO_COMPACT_WINDOW_TOKEN_STEPS)[number];
} {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  const position = Number.isFinite(numeric) ? numeric : 50;
  return CONTEXT_AUTO_COMPACT_SLIDER_POSITIONS.reduce((nearest, candidate) => {
    const nearestDistance = Math.abs(nearest.position - position);
    const candidateDistance = Math.abs(candidate.position - position);
    return candidateDistance < nearestDistance ? candidate : nearest;
  }, CONTEXT_AUTO_COMPACT_SLIDER_POSITIONS[0]);
}

function getContextAutoCompactSliderStepForTokens(
  tokens: number,
): (typeof CONTEXT_AUTO_COMPACT_SLIDER_POSITIONS)[number] {
  return (
    CONTEXT_AUTO_COMPACT_SLIDER_POSITIONS.find(
      (step) => step.tokens === tokens,
    ) || getNearestContextAutoCompactSliderStep(50)
  );
}

function updateContextAutoCompactThresholdDisplay(doc: Document): void {
  const thresholdInput = doc.getElementById(
    "pref-context-auto-compact-threshold",
  ) as HTMLInputElement | null;
  const valueLabel = doc.getElementById(
    "pref-context-auto-compact-threshold-value",
  );
  if (!thresholdInput || !valueLabel) {
    return;
  }

  const step = getNearestContextAutoCompactSliderStep(thresholdInput.value);
  valueLabel.textContent = `${Math.round(step.tokens / 1000)}K`;
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

function initReadingLoopSettings(doc: Document): void {
  const enabledCheckbox = doc.getElementById(
    "pref-reading-loop-enabled",
  ) as XUL.Checkbox | null;
  if (enabledCheckbox) {
    enabledCheckbox.checked = getPref("readingLoopEnabled") !== false;
  }
}

function bindReadingLoopSettingsEvents(doc: Document): void {
  const enabledCheckbox = doc.getElementById(
    "pref-reading-loop-enabled",
  ) as XUL.Checkbox | null;
  if (enabledCheckbox) {
    enabledCheckbox.addEventListener("command", () => {
      setPref("readingLoopEnabled", enabledCheckbox.checked);
      void import("../reading-loop")
        .then(({ getReadingLoopService }) => {
          getReadingLoopService().refreshEnabledFromPrefs();
        })
        .catch((error) => {
          ztoolkit.log(
            "[Preferences] Failed to refresh Reading Loop setting:",
            error,
          );
        });
    });
  }
}

function initNextQuestionHintSettings(doc: Document): void {
  const enabledCheckbox = doc.getElementById(
    "pref-next-question-hint-enabled",
  ) as XUL.Checkbox | null;
  if (enabledCheckbox) {
    enabledCheckbox.checked = getPref("nextQuestionHintEnabled") !== false;
  }
}

function bindNextQuestionHintSettingsEvents(doc: Document): void {
  const enabledCheckbox = doc.getElementById(
    "pref-next-question-hint-enabled",
  ) as XUL.Checkbox | null;
  if (enabledCheckbox) {
    enabledCheckbox.addEventListener("command", () => {
      setPref("nextQuestionHintEnabled", enabledCheckbox.checked);
    });
  }
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

function bindEmbeddingProviderCacheInvalidationEvent(doc: Document): void {
  const activeProviderSelect = doc.getElementById(
    "pref-active-provider-select",
  ) as unknown as XULMenuListElement | null;

  activeProviderSelect?.addEventListener("command", () => {
    getEmbeddingProviderFactory().invalidateCache();
  });
}
