/**
 * ProviderListUI - Provider list and selection
 */

import { getString } from "../../utils/locale";
import { prefColors } from "../../utils/colors";
import { getProviderManager } from "../providers";
import { getAuthManager } from "../auth";
import type {
  ProviderConfig,
  ApiKeyProviderConfig,
} from "../../types/provider";
import { clearElement } from "./utils";
import { populatePaperchatPanel } from "./PaperchatProviderUI";
import { populateApiKeyPanel } from "./ApiKeyProviderUI";

/**
 * Populate provider list in sidebar
 */
export function populateProviderList(doc: Document): void {
  const providerManager = getProviderManager();
  const configs = providerManager.getAllConfigs();
  const listContainer = doc.getElementById("pref-provider-list");

  if (!listContainer) return;

  // Clear existing items
  clearElement(listContainer);

  // Add provider items
  configs.forEach((config) => {
    const item = createProviderListItem(doc, config);
    listContainer.appendChild(item);
  });
}

/**
 * Create a provider list item element
 */
function createProviderListItem(
  doc: Document,
  config: ProviderConfig,
): Element {
  const providerManager = getProviderManager();
  const activeProviderId = providerManager.getActiveProviderId();

  const item = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLDivElement;
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
  const nameSpan = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "span",
  ) as HTMLSpanElement;
  nameSpan.textContent = config.name;
  item.appendChild(nameSpan);

  // Right side: status indicators container
  const statusContainer = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLDivElement;
  statusContainer.style.cssText =
    "display: flex; align-items: center; gap: 4px;";

  // Green dot indicator for configured providers
  const isConfigured = isProviderConfigured(config);
  if (isConfigured) {
    const statusDot = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "span",
    ) as HTMLSpanElement;
    statusDot.className = "provider-status-dot";
    statusDot.style.cssText = `
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: ${prefColors.statusDot};
      flex-shrink: 0;
    `;
    statusDot.title =
      getString("pref-provider-configured" as any) || "Configured";
    statusContainer.appendChild(statusDot);
  }

  // Checkmark for active provider
  if (config.id === activeProviderId) {
    const activeCheck = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "span",
    ) as HTMLSpanElement;
    activeCheck.className = "provider-active-check";
    activeCheck.textContent = "✅";
    activeCheck.style.cssText = "font-size: 12px; flex-shrink: 0;";
    activeCheck.title = getString("pref-provider-active" as any) || "Active";
    statusContainer.appendChild(activeCheck);
  }

  item.appendChild(statusContainer);

  item.addEventListener("mouseenter", () => {
    if (item.getAttribute("data-selected") !== "true") {
      item.style.backgroundColor = prefColors.providerItemHover;
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
  if (config.id === "paperchat") {
    // PaperChat is configured if user is logged in
    const authManager = getAuthManager();
    return authManager.isLoggedIn();
  } else {
    // API key providers are configured if they have an API key and are enabled
    const apiKeyConfig = config as ApiKeyProviderConfig;
    return apiKeyConfig.enabled && !!apiKeyConfig.apiKey?.trim();
  }
}

/**
 * Select a provider and show its settings panel
 */
export function selectProvider(
  doc: Document,
  providerId: string,
  setCurrentProviderId: (id: string) => void,
): void {
  setCurrentProviderId(providerId);
  const providerManager = getProviderManager();

  // Update sidebar selection style
  const items = doc.querySelectorAll(".provider-list-item");
  items.forEach((item: Element) => {
    const el = item as HTMLElement;
    if (el.getAttribute("data-provider-id") === providerId) {
      el.style.backgroundColor = prefColors.providerItemSelected;
      el.style.color = prefColors.providerItemSelectedText;
      el.setAttribute("data-selected", "true");
    } else {
      el.style.backgroundColor = "";
      el.style.color = "";
      el.setAttribute("data-selected", "false");
    }
  });

  // Show appropriate panel
  const paperchatPanel = doc.getElementById("pref-panel-paperchat");
  const apikeyPanel = doc.getElementById("pref-panel-apikey");

  if (providerId === "paperchat") {
    paperchatPanel?.removeAttribute("hidden");
    apikeyPanel?.setAttribute("hidden", "true");
    // Load PaperChat settings
    populatePaperchatPanel(doc);
  } else {
    paperchatPanel?.setAttribute("hidden", "true");
    apikeyPanel?.removeAttribute("hidden");

    // Populate API key panel with provider data
    const config = providerManager.getProviderConfig(
      providerId,
    ) as ApiKeyProviderConfig;
    const metadata = providerManager.getProviderMetadata(providerId);

    if (config) {
      populateApiKeyPanel(doc, config, metadata);
    }
  }
}

/**
 * Populate active provider dropdown
 */
export function populateActiveProviderDropdown(doc: Document): void {
  const providerManager = getProviderManager();
  const configs = providerManager.getAllConfigs();
  const popup = doc.getElementById("pref-active-provider-popup");
  const select = doc.getElementById(
    "pref-active-provider-select",
  ) as unknown as XULMenuListElement;

  if (!popup || !select) return;

  // Clear existing items
  clearElement(popup);

  // Add enabled providers
  configs
    .filter((c) => c.enabled || c.id === "paperchat")
    .forEach((config) => {
      const menuitem = doc.createXULElement("menuitem");
      menuitem.setAttribute("label", config.name);
      menuitem.setAttribute("value", config.id);
      popup.appendChild(menuitem);
    });

  // Set current active
  select.value = providerManager.getActiveProviderId();
}

/**
 * Bind provider list click events
 */
export function bindProviderListClickEvents(
  doc: Document,
  setCurrentProviderId: (id: string) => void,
): void {
  const listContainer = doc.getElementById("pref-provider-list");
  if (!listContainer) return;

  // Use event delegation for provider list items
  listContainer.addEventListener("click", (e: Event) => {
    const target = e.target as HTMLElement;
    const item = target.closest(".provider-list-item") as HTMLElement | null;
    if (item) {
      const providerId = item.getAttribute("data-provider-id");
      if (providerId) {
        selectProvider(doc, providerId, setCurrentProviderId);
      }
    }
  });
}

/**
 * Bind active provider selection event
 */
export function bindActiveProviderEvent(doc: Document): void {
  const providerManager = getProviderManager();
  const activeProviderSelect = doc.getElementById(
    "pref-active-provider-select",
  ) as unknown as XULMenuListElement;
  activeProviderSelect?.addEventListener("command", () => {
    providerManager.setActiveProvider(activeProviderSelect.value);
    // Refresh provider list to update checkmark
    populateProviderList(doc);
  });
}
