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
import { getAISummaryManager } from "../ai-summary";
import { DEFAULT_TEMPLATES } from "../ai-summary/defaultTemplates";

// Current selected provider ID
let currentProviderId: string = "paperchat";

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
  selectProvider(doc, currentProviderId, setCurrentProviderId);

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
  const enableAIWriteCheckbox = doc.getElementById(
    "pref-enable-ai-write-checkbox",
  ) as XUL.Checkbox | null;
  if (enableAIWriteCheckbox) {
    enableAIWriteCheckbox.checked = getPref(
      "enableAIWriteOperations",
    ) as boolean;
  }
}

/**
 * Bind all preference events
 */
export function bindPrefEvents(): void {
  if (!addon.data.prefs?.window) return;

  const doc = addon.data.prefs.window.document;
  const authManager = getAuthManager();

  // Refresh callbacks for provider list
  const refreshProviderList = () => populateProviderList(doc);
  const refreshActiveProvider = () => populateActiveProviderDropdown(doc);

  // Bind user auth events
  bindUserAuthEvents(doc, authManager, refreshProviderList);

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
  const enableAIWriteCheckbox = doc.getElementById(
    "pref-enable-ai-write-checkbox",
  ) as XUL.Checkbox | null;
  if (enableAIWriteCheckbox) {
    enableAIWriteCheckbox.addEventListener("command", () => {
      setPref("enableAIWriteOperations", enableAIWriteCheckbox.checked);
    });
  }
}

/**
 * Initialize AISummary settings
 */
function initAISummarySettings(doc: Document): void {
  const aiSummaryManager = getAISummaryManager();
  const config = aiSummaryManager.getConfig();

  // Schedule enabled checkbox (controls automatic execution)
  const scheduleEnabledCheckbox = doc.getElementById(
    "pref-aisummary-enabled",
  ) as XUL.Checkbox | null;
  if (scheduleEnabledCheckbox) {
    scheduleEnabledCheckbox.checked = config.scheduleEnabled;
  }

  // Interval hours
  const intervalHoursInput = doc.getElementById(
    "pref-aisummary-interval-hours",
  ) as HTMLInputElement | null;
  if (intervalHoursInput) {
    intervalHoursInput.value = String(config.scheduleIntervalHours || 24);
  }

  // Template dropdown
  populateAISummaryTemplates(doc, config.templateId);

  // Filter PDF checkbox
  const filterPdfCheckbox = doc.getElementById(
    "pref-aisummary-filter-pdf",
  ) as XUL.Checkbox | null;
  if (filterPdfCheckbox) {
    filterPdfCheckbox.checked = config.filterHasPdf;
  }

  // Processed tag
  const tagInput = doc.getElementById(
    "pref-aisummary-tag",
  ) as HTMLInputElement | null;
  if (tagInput) {
    tagInput.value = config.markProcessedTag || "ai-processed";
  }

  // Rate limit
  const rateLimitInput = doc.getElementById(
    "pref-aisummary-rate-limit",
  ) as HTMLInputElement | null;
  if (rateLimitInput) {
    rateLimitInput.value = String(config.rateLimitRpm || 10);
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
  for (const template of DEFAULT_TEMPLATES) {
    const menuitem = doc.createXULElement("menuitem");
    menuitem.setAttribute("label", template.name);
    menuitem.setAttribute("value", template.id);
    popup.appendChild(menuitem);
  }

  // Set selected value
  if (selectedTemplateId) {
    templateSelect.value = selectedTemplateId;
  } else if (DEFAULT_TEMPLATES.length > 0) {
    templateSelect.value = DEFAULT_TEMPLATES[0].id;
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
    statusLabel.textContent = `Processing ${progress.processedItems}/${progress.totalItems}...`;
    statusLabel.style.color = "#0078d4";
  } else if (progress.status === "paused") {
    statusLabel.textContent = `Paused (${progress.processedItems}/${progress.totalItems})`;
    statusLabel.style.color = "#ffa500";
  } else if (progress.status === "completed") {
    statusLabel.textContent = `Completed: ${progress.successfulItems} success, ${progress.failedItems} failed`;
    statusLabel.style.color = "#008000";
  } else if (progress.status === "error") {
    statusLabel.textContent = `Error: ${progress.errors[0]?.error || "Unknown"}`;
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

  // Schedule enabled checkbox (controls automatic execution)
  const scheduleEnabledCheckbox = doc.getElementById(
    "pref-aisummary-enabled",
  ) as XUL.Checkbox | null;
  if (scheduleEnabledCheckbox) {
    scheduleEnabledCheckbox.addEventListener("command", async () => {
      await aiSummaryManager.updateConfig({ scheduleEnabled: scheduleEnabledCheckbox.checked });
    });
  }

  // Interval hours
  const intervalHoursInput = doc.getElementById(
    "pref-aisummary-interval-hours",
  ) as HTMLInputElement | null;
  if (intervalHoursInput) {
    intervalHoursInput.addEventListener("change", async () => {
      const value = parseInt(intervalHoursInput.value, 10);
      if (value >= 1 && value <= 168) {
        await aiSummaryManager.updateConfig({ scheduleIntervalHours: value });
      }
    });
  }

  // Template
  const templateSelect = doc.getElementById(
    "pref-aisummary-template",
  ) as XUL.MenuList | null;
  if (templateSelect) {
    templateSelect.addEventListener("command", async () => {
      await aiSummaryManager.updateConfig({ templateId: templateSelect.value });
    });
  }

  // Filter PDF checkbox
  const filterPdfCheckbox = doc.getElementById(
    "pref-aisummary-filter-pdf",
  ) as XUL.Checkbox | null;
  if (filterPdfCheckbox) {
    filterPdfCheckbox.addEventListener("command", async () => {
      await aiSummaryManager.updateConfig({
        filterHasPdf: filterPdfCheckbox.checked,
      });
    });
  }

  // Processed tag
  const tagInput = doc.getElementById(
    "pref-aisummary-tag",
  ) as HTMLInputElement | null;
  if (tagInput) {
    tagInput.addEventListener("change", async () => {
      await aiSummaryManager.updateConfig({ markProcessedTag: tagInput.value });
    });
  }

  // Rate limit
  const rateLimitInput = doc.getElementById(
    "pref-aisummary-rate-limit",
  ) as HTMLInputElement | null;
  if (rateLimitInput) {
    rateLimitInput.addEventListener("change", async () => {
      const value = parseInt(rateLimitInput.value, 10);
      if (value > 0 && value <= 60) {
        await aiSummaryManager.updateConfig({ rateLimitRpm: value });
      }
    });
  }

  // Run now button
  const runNowBtn = doc.getElementById(
    "pref-aisummary-run-now",
  ) as HTMLButtonElement | null;
  if (runNowBtn) {
    runNowBtn.addEventListener("click", async () => {
      try {
        await aiSummaryManager.startBatch();
        updateAISummaryStatus(doc);

        // Set up periodic status updates while running
        const updateInterval = setInterval(() => {
          const progress = aiSummaryManager.getProgress();
          updateAISummaryStatus(doc);
          if (
            progress.status !== "running" &&
            progress.status !== "paused"
          ) {
            clearInterval(updateInterval);
          }
        }, 1000);
      } catch (error) {
        const statusLabel = doc.getElementById(
          "pref-aisummary-status",
        ) as HTMLElement | null;
        if (statusLabel) {
          statusLabel.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
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
