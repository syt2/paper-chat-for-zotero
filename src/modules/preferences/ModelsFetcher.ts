/**
 * ModelsFetcher - Fetch models and ratios from PaperChat API
 */

import { getString } from "../../utils/locale";
import { getPref, setPref } from "../../utils/prefs";
import { BUILTIN_PROVIDERS } from "../providers";
import { getAuthManager } from "../auth";
import { showMessage } from "./utils";
import {
  parseModelRoutingConfig,
  type PaperChatModelRoutingMeta,
} from "../providers/paperchat-routing-metadata";

// Store model ratios for PaperChat
let paperchatModelRatios: Record<string, number> = {};
let paperchatModelRoutingMeta: Record<string, PaperChatModelRoutingMeta> = {};

/** Special value stored in pref("model") to indicate auto-selection (cheapest) */
export const AUTO_MODEL = "auto";
/** Special value stored in pref("model") to indicate auto-selection (smartest) */
export const AUTO_MODEL_SMART = "auto-smart";
const DEFAULT_ROUTING_META_URL =
  "https://paperchat.zotero.store/ext/paperchat/model-routing.json";

/** Check if a model value is any auto mode */
export function isAutoModel(model: string): boolean {
  return model === AUTO_MODEL || model === AUTO_MODEL_SMART;
}

/**
 * Get the model ratios map
 */
export function getModelRatios(): Record<string, number> {
  return paperchatModelRatios;
}

export function getModelRoutingMeta(): Record<
  string,
  PaperChatModelRoutingMeta
> {
  return paperchatModelRoutingMeta;
}

/**
 * Resolve "auto" to the cheapest available model by ratio.
 * If ratios are unavailable, returns the first model in the list.
 */
export function resolveAutoModel(availableModels: string[]): string | null {
  if (availableModels.length === 0) return null;

  // Sort by ratio ascending (cheapest first), models without ratio go last
  const sorted = [...availableModels].sort((a, b) => {
    const ra = paperchatModelRatios[a];
    const rb = paperchatModelRatios[b];
    if (ra === undefined && rb === undefined) return 0;
    if (ra === undefined) return 1;
    if (rb === undefined) return -1;
    return ra - rb;
  });
  return sorted[0];
}

/**
 * Resolve "auto-smart" to the most capable (most expensive) available model by ratio.
 * If ratios are unavailable, returns the last model in the list.
 */
export function resolveAutoModelSmart(
  availableModels: string[],
): string | null {
  if (availableModels.length === 0) return null;

  // Sort by ratio descending (most expensive first), models without ratio go last
  const sorted = [...availableModels].sort((a, b) => {
    const ra = paperchatModelRatios[a];
    const rb = paperchatModelRatios[b];
    if (ra === undefined && rb === undefined) return 0;
    if (ra === undefined) return 1;
    if (rb === undefined) return -1;
    return rb - ra;
  });
  return sorted[0];
}

/**
 * Format model label with ratio if available (for PaperChat models)
 * @param model Model ID
 * @param providerId Provider ID (only shows ratio for paperchat)
 * @returns Formatted label like "model-name (2x)" or just "model-name"
 */
export function formatModelLabel(model: string, providerId?: string): string {
  if (providerId !== "paperchat") {
    return model;
  }
  const ratio = paperchatModelRatios[model];
  return ratio !== undefined ? `${model} (${ratio}x)` : model;
}

/**
 * Load cached ratios from prefs
 */
export function loadCachedRatios(): void {
  const cached = getPref("paperchatRatiosCache") as string;
  if (cached) {
    try {
      paperchatModelRatios = JSON.parse(cached);
      ztoolkit.log(
        "[Preferences] Loaded cached ratios for",
        Object.keys(paperchatModelRatios).length,
        "models",
      );
    } catch {
      // ignore parse error
    }
  }

  const cachedRoutingMeta = getPref("paperchatRoutingConfigCache") as string;
  if (cachedRoutingMeta) {
    try {
      paperchatModelRoutingMeta = JSON.parse(cachedRoutingMeta);
      ztoolkit.log(
        "[Preferences] Loaded cached routing metadata for",
        Object.keys(paperchatModelRoutingMeta).length,
        "models",
      );
    } catch {
      // ignore parse error
    }
  }
}

function getPricingModelName(
  item: Record<string, unknown>,
): string | undefined {
  if (typeof item.model_name === "string" && item.model_name.length > 0) {
    return item.model_name;
  }
  if (typeof item.ModelName === "string" && item.ModelName.length > 0) {
    return item.ModelName;
  }
  return undefined;
}

function getPricingModelRatio(
  item: Record<string, unknown>,
): number | undefined {
  const value = item.model_ratio ?? item.ModelRatio;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Fetch model ratios from PaperChat pricing API
 */
export async function fetchPaperchatRatios(apiKey: string): Promise<void> {
  const baseUrl = BUILTIN_PROVIDERS.paperchat.defaultBaseUrl.replace("/v1", "");
  const url = `${baseUrl}/api/pricing`;
  ztoolkit.log("[Preferences] Fetching ratios from:", url);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      ztoolkit.log("[Preferences] Failed to fetch ratios:", response.status);
      return;
    }

    const result = (await response.json()) as {
      data?: Array<Record<string, unknown>>;
    };

    if (result.data && Array.isArray(result.data)) {
      // Build model_name -> model_ratio mapping. Routing metadata is fetched
      // from a separate static JSON endpoint so newapi can stay unmodified.
      paperchatModelRatios = {};
      for (const item of result.data) {
        const modelName = getPricingModelName(item);
        const ratio = getPricingModelRatio(item);
        if (!modelName || ratio === undefined) {
          continue;
        }

        paperchatModelRatios[modelName] = ratio;
      }
      // Cache ratios to prefs.
      setPref("paperchatRatiosCache", JSON.stringify(paperchatModelRatios));
      ztoolkit.log(
        "[Preferences] Loaded ratios for",
        Object.keys(paperchatModelRatios).length,
        "models",
      );
    }
  } catch (e) {
    ztoolkit.log("[Preferences] Failed to fetch ratios:", e);
  }
}

export async function fetchPaperchatRoutingMeta(): Promise<void> {
  ztoolkit.log(
    "[Preferences] Fetching routing metadata from:",
    DEFAULT_ROUTING_META_URL,
  );

  try {
    const response = await fetch(DEFAULT_ROUTING_META_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      ztoolkit.log(
        "[Preferences] Failed to fetch routing metadata:",
        response.status,
      );
      return;
    }

    const result = await response.json();
    const parsed = parseModelRoutingConfig(result);
    paperchatModelRoutingMeta = parsed;
    setPref("paperchatRoutingConfigCache", JSON.stringify(parsed));
    ztoolkit.log(
      "[Preferences] Loaded routing metadata for",
      Object.keys(parsed).length,
      "models",
    );
  } catch (e) {
    ztoolkit.log("[Preferences] Failed to fetch routing metadata:", e);
  }
}

/**
 * Fetch PaperChat models from API
 * Returns the list of model IDs, or null if failed
 */
export async function fetchPaperchatModels(
  doc: Document,
  onModelsLoaded: (models: string[]) => void,
): Promise<void> {
  ztoolkit.log("[Preferences] fetchPaperchatModels called");

  const authManager = getAuthManager();
  const apiKey = authManager.getApiKey();
  ztoolkit.log("[Preferences] apiKey:", apiKey ? "exists" : "empty");

  if (!apiKey) {
    showMessage(doc, getString("user-panel-not-logged-in"), true);
    return;
  }

  showMessage(doc, getString("pref-fetching-models"), false);

  // Fetch ratios and routing metadata in parallel with models.
  const ratiosPromise = fetchPaperchatRatios(apiKey);
  const routingMetaPromise = fetchPaperchatRoutingMeta();

  const url = `${BUILTIN_PROVIDERS.paperchat.defaultBaseUrl}/models`;
  ztoolkit.log("[Preferences] Fetching models from:", url);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    ztoolkit.log("[Preferences] Response status:", response.status);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = (await response.json()) as { data?: Array<{ id: string }> };
    ztoolkit.log(
      "[Preferences] Models response:",
      JSON.stringify(result).substring(0, 200),
    );

    // Wait for ratios and routing metadata to complete
    await Promise.all([ratiosPromise, routingMetaPromise]);

    if (result.data && Array.isArray(result.data)) {
      const models = result.data.map((m) => m.id).sort();
      ztoolkit.log("[Preferences] Parsed models count:", models.length);
      onModelsLoaded(models);
      showMessage(
        doc,
        getString("pref-models-loaded", { args: { count: models.length } }),
        false,
      );
    }
  } catch (e) {
    ztoolkit.log("[Preferences] Failed to fetch PaperChat models:", e);
    showMessage(doc, getString("pref-fetch-models-failed"), true);
  }
}
