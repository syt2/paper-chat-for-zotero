/**
 * ModelsFetcher - Fetch models and ratios from PaperChat API
 */

import { getString } from "../../utils/locale";
import { getPref, setPref } from "../../utils/prefs";
import { BUILTIN_PROVIDERS } from "../providers";
import { getAuthManager } from "../auth";
import { showMessage } from "./utils";

// Store model ratios for PaperChat
let paperchatModelRatios: Record<string, number> = {};

/**
 * Get the model ratios map
 */
export function getModelRatios(): Record<string, number> {
  return paperchatModelRatios;
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
      data?: Array<{
        model_name: string;
        model_ratio: number;
      }>;
    };

    if (result.data && Array.isArray(result.data)) {
      // Build model_name -> model_ratio mapping
      paperchatModelRatios = {};
      for (const item of result.data) {
        if (item.model_name && typeof item.model_ratio === "number") {
          paperchatModelRatios[item.model_name] = item.model_ratio;
        }
      }
      // Cache ratios to prefs
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

  // Fetch ratios first (in parallel with models)
  const ratiosPromise = fetchPaperchatRatios(apiKey);

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

    // Wait for ratios to complete
    await ratiosPromise;

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
