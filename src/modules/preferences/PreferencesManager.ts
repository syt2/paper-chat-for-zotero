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
