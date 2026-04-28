/**
 * PaperchatProviderUI - PaperChat provider settings panel
 */

import { getPref, setPref } from "../../utils/prefs";
import { getProviderManager, BUILTIN_PROVIDERS } from "../providers";
import {
  deriveTierPools,
  getAvailablePaperChatTiers,
  PAPERCHAT_TIERS,
  parseTierState,
  resolveSelectedTierModel,
  type PaperChatTier,
  type PaperChatTierState,
} from "../providers/paperchat-tier-routing";
import type { PaperChatProviderConfig } from "../../types/provider";
import {
  formatModelLabel,
  getModelRatios,
  getModelRoutingMeta,
} from "./ModelsFetcher";
import { clearElement } from "./utils";
import { isEmbeddingModel } from "../embedding/providers/PaperChatEmbedding";
import { getString } from "../../utils/locale";
import {
  bindPaperChatNoticeEvents,
  renderPaperChatNotice,
  syncPaperChatNoticeDebugUI,
} from "./PaperChatNoticeRenderer";
import {
  clearPaperChatNoticeDebugOverride,
  setPaperChatNoticeDebugOverride,
} from "../providers/PaperChatNoticeService";

const TIER_MODEL_SELECTORS: Record<PaperChatTier, string> = {
  "paperchat-lite": "pref-paperchat-lite-model",
  "paperchat-standard": "pref-paperchat-standard-model",
  "paperchat-pro": "pref-paperchat-pro-model",
  "paperchat-ultra": "pref-paperchat-ultra-model",
};

const TIER_MODEL_POPUPS: Record<PaperChatTier, string> = {
  "paperchat-lite": "pref-paperchat-lite-model-popup",
  "paperchat-standard": "pref-paperchat-standard-model-popup",
  "paperchat-pro": "pref-paperchat-pro-model-popup",
  "paperchat-ultra": "pref-paperchat-ultra-model-popup",
};

const TIER_SELECTOR_IDS = [
  "pref-paperchat-tier",
  ...Object.values(TIER_MODEL_SELECTORS),
] as const;

const PAPERCHAT_CONFIG_INPUT_IDS = [
  "pref-paperchat-maxtokens",
  "pref-paperchat-temperature",
  "pref-paperchat-systemprompt",
] as const;

const TIER_LABEL_KEYS: Record<PaperChatTier, string> = {
  "paperchat-lite": "pref-paperchat-tier-lite",
  "paperchat-standard": "pref-paperchat-tier-standard",
  "paperchat-pro": "pref-paperchat-tier-pro",
  "paperchat-ultra": "pref-paperchat-tier-ultra",
};

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  const trimmed = value?.trim() || "";
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function syncTierSelectorLabels(doc: Document): void {
  const tierSelect = doc.getElementById(
    "pref-paperchat-tier",
  ) as unknown as XULMenuListElement | null;
  const popup = doc.getElementById("pref-paperchat-tier-popup");
  if (!tierSelect || !popup) {
    return;
  }

  for (const tier of PAPERCHAT_TIERS) {
    const item = popup.querySelector(`menuitem[value="${tier}"]`) as Element | null;
    if (!item) {
      continue;
    }
    item.setAttribute("label", getString(TIER_LABEL_KEYS[tier]));
  }

  const selectedItem = tierSelect.selectedItem as XUL.MenuItem | null;
  if (selectedItem) {
    tierSelect.setAttribute("label", selectedItem.getAttribute("label") || "");
  }
}

function syncTierSelectorVisibility(
  doc: Document,
  tierPools: Record<PaperChatTier, string[]>,
): PaperChatTier {
  const tierSelect = doc.getElementById(
    "pref-paperchat-tier",
  ) as unknown as XULMenuListElement | null;
  const popup = doc.getElementById("pref-paperchat-tier-popup");
  const visibleTiers = getAvailablePaperChatTiers(tierPools);
  const fallbackTier = visibleTiers[0] ?? "paperchat-pro";
  const selectedTier =
    tierSelect && visibleTiers.includes(tierSelect.value as PaperChatTier)
      ? (tierSelect.value as PaperChatTier)
      : fallbackTier;

  if (tierSelect) {
    tierSelect.value = selectedTier;
  }

  for (const tier of PAPERCHAT_TIERS) {
    const shouldShow = tierPools[tier].length > 0;
    const item = popup?.querySelector(`menuitem[value="${tier}"]`);
    if (item) {
      if (shouldShow) {
        item.removeAttribute("hidden");
      } else {
        item.setAttribute("hidden", "true");
      }
    }

    const select = doc.getElementById(TIER_MODEL_SELECTORS[tier]);
    const row = select?.parentElement as HTMLElement | null;
    if (row) {
      row.style.display = shouldShow ? "" : "none";
    }
  }

  return selectedTier;
}

function loadTierState(): PaperChatTierState {
  return parseTierState(getPref("paperchatTierState") as string | undefined);
}

function saveTierState(state: PaperChatTierState): void {
  setPref("paperchatTierState", JSON.stringify(state));
}

function getAvailableChatModels(
  config?: PaperChatProviderConfig,
  models?: string[],
): string[] {
  let modelList = models;
  if (!modelList && config?.availableModels && config.availableModels.length > 0) {
    modelList = config.availableModels;
  }
  if (!modelList) {
    const cachedModels = getPref("paperchatModelsCache") as string;
    if (cachedModels) {
      try {
        modelList = JSON.parse(cachedModels) as string[];
      } catch (error) {
        ztoolkit.log(
          "[Preferences] Invalid paperchatModelsCache, falling back to defaults:",
          error,
        );
        modelList = undefined;
      }
    }
  }
  if (!modelList || modelList.length === 0) {
    modelList = BUILTIN_PROVIDERS.paperchat.defaultModels;
  }

  return modelList.filter((model) => !isEmbeddingModel(model));
}

function populateTierOverridePopup(
  doc: Document,
  tier: PaperChatTier,
  models: string[],
  state: PaperChatTierState,
): void {
  const popup = doc.getElementById(TIER_MODEL_POPUPS[tier]);
  const select = doc.getElementById(
    TIER_MODEL_SELECTORS[tier],
  ) as unknown as XULMenuListElement | null;
  if (!popup || !select) {
    return;
  }

  clearElement(popup);

  const autoItem = doc.createXULElement("menuitem");
  autoItem.setAttribute("label", getString("pref-paperchat-model-auto"));
  autoItem.setAttribute("value", "auto");
  popup.appendChild(autoItem);

  for (const model of models) {
    const item = doc.createXULElement("menuitem");
    item.setAttribute("label", formatModelLabel(model, "paperchat"));
    item.setAttribute("value", model);
    popup.appendChild(item);
  }

  const entry = state.tiers[tier];
  select.value = entry.mode === "manual" && entry.modelId ? entry.modelId : "auto";
}

/**
 * Populate PaperChat panel with settings from provider config
 */
export function populatePaperchatPanel(doc: Document): void {
  const providerManager = getProviderManager();
  const config = providerManager.getProviderConfig(
    "paperchat",
  ) as PaperChatProviderConfig;

  if (!config) return;

  bindPaperChatNoticeEvents(doc);
  renderPaperChatNotice(doc);
  syncPaperChatNoticeDebugUI(doc);

  // Populate tier selector and per-tier override dropdowns
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

  if (maxTokensEl) {
    maxTokensEl.value =
      typeof config.maxTokens === "number" && config.maxTokens > 0
        ? String(config.maxTokens)
        : "";
  }
  if (temperatureEl) temperatureEl.value = String(config.temperature ?? 0.7);
  if (systemPromptEl) systemPromptEl.value = config.systemPrompt || "";
}

/**
 * Populate PaperChat tier and override dropdowns from cache, defaults, or API response
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
  const tierSelect = doc.getElementById(
    "pref-paperchat-tier",
  ) as unknown as XULMenuListElement | null;

  if (!tierSelect) {
    return;
  }

  const chatModels = getAvailableChatModels(config, models);

  if (saveToCache && models) {
    setPref("paperchatModelsCache", JSON.stringify(models));
    providerManager.updateProviderConfig("paperchat", {
      availableModels: chatModels,
    });
  }

  const state = loadTierState();
  tierSelect.value = state.selectedTier;
  const tierPools = deriveTierPools(
    chatModels,
    getModelRatios(),
    getModelRoutingMeta(),
  );
  state.selectedTier = syncTierSelectorVisibility(doc, tierPools);
  syncTierSelectorLabels(doc);

  for (const tier of PAPERCHAT_TIERS) {
    populateTierOverridePopup(doc, tier, tierPools[tier], state);
  }
}

/**
 * Save PaperChat provider settings
 */
export function savePaperchatConfig(doc: Document): void {
  const providerManager = getProviderManager();

  const tierSelect = doc.getElementById(
    "pref-paperchat-tier",
  ) as unknown as XULMenuListElement | null;
  const maxTokensEl = doc.getElementById(
    "pref-paperchat-maxtokens",
  ) as HTMLInputElement;
  const temperatureEl = doc.getElementById(
    "pref-paperchat-temperature",
  ) as HTMLInputElement;
  const systemPromptEl = doc.getElementById(
    "pref-paperchat-systemprompt",
  ) as HTMLTextAreaElement;

  const state = loadTierState();
  const availableModels = getAvailableChatModels(
    providerManager.getProviderConfig("paperchat") as PaperChatProviderConfig,
  );
  const tierPools = deriveTierPools(
    availableModels,
    getModelRatios(),
    getModelRoutingMeta(),
  );
  const visibleTiers = getAvailablePaperChatTiers(tierPools);
  const selectedTier = tierSelect?.value as PaperChatTier | "";
  state.selectedTier =
    selectedTier && visibleTiers.includes(selectedTier)
      ? selectedTier
      : (visibleTiers[0] ?? "paperchat-pro");

  for (const tier of PAPERCHAT_TIERS) {
    const select = doc.getElementById(
      TIER_MODEL_SELECTORS[tier],
    ) as unknown as XULMenuListElement | null;
    const value = select?.value || "auto";
    state.tiers[tier] =
      value === "auto"
        ? { mode: "auto", modelId: null }
        : { mode: "manual", modelId: value };
  }

  saveTierState(state);
  const resolvedDefaultModel = resolveSelectedTierModel(
    state,
    availableModels,
    getModelRatios(),
    undefined,
    getModelRoutingMeta(),
  ).modelId;
  providerManager.updateProviderConfig("paperchat", {
    defaultModel: resolvedDefaultModel || undefined,
    maxTokens: parseOptionalPositiveInt(maxTokensEl?.value),
    temperature: parseFloat(temperatureEl?.value) || 0.7,
    systemPrompt: systemPromptEl?.value || "",
  });
}

/**
 * Bind PaperChat panel events
 */
export function bindPaperchatEvents(
  doc: Document,
  onRefreshModels: () => Promise<void>,
): void {
  for (const id of TIER_SELECTOR_IDS) {
    const select = doc.getElementById(id) as unknown as XULMenuListElement | null;
    select?.addEventListener("command", function () {
      savePaperchatConfig(doc);
    });
  }

  for (const id of PAPERCHAT_CONFIG_INPUT_IDS) {
    const input = doc.getElementById(id) as HTMLElement | null;
    input?.addEventListener("blur", function () {
      savePaperchatConfig(doc);
    });
  }

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

  const noticeDebugApplyBtn = doc.getElementById(
    "pref-paperchat-notice-debug-apply",
  ) as HTMLButtonElement | null;
  const noticeDebugClearBtn = doc.getElementById(
    "pref-paperchat-notice-debug-clear",
  ) as HTMLButtonElement | null;
  const noticeDebugInput = doc.getElementById(
    "pref-paperchat-notice-debug-input",
  ) as HTMLTextAreaElement | null;

  noticeDebugApplyBtn?.addEventListener("click", () => {
    const content = noticeDebugInput?.value || "";
    const applied = setPaperChatNoticeDebugOverride(content);
    if (!applied) {
      clearPaperChatNoticeDebugOverride();
    }
    renderPaperChatNotice(doc);
    syncPaperChatNoticeDebugUI(doc);
  });

  noticeDebugClearBtn?.addEventListener("click", () => {
    clearPaperChatNoticeDebugOverride();
    renderPaperChatNotice(doc);
    syncPaperChatNoticeDebugUI(doc);
  });
}
