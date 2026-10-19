/**
 * ModelsFetcher - Fetch models and ratios from PaperChat API
 */

import { parsePaperChatEmbeddingConfig } from "../embedding/PaperChatEmbeddingConfig";
import { isEmbeddingModel } from "../embedding/providers/PaperChatEmbedding";

import { getString } from "../../utils/locale";
import { getPref, setPref } from "../../utils/prefs";
import { getAuthManager } from "../auth";
import { showMessage } from "./utils";
import { getPaperchatLoadedModelCount } from "./paperchat-model-count";
import {
  getPaperChatApiBaseUrl,
  getPaperChatUrl,
} from "../providers/PaperChatUrls";
import {
  parseModelRoutingConfig,
  parseModelRoutingDefaults,
  sortModelsByRoutingWeight,
  sortModelsByTierThenWeight,
  type PaperChatModelRoutingMeta,
  type PaperChatModelRoutingDefaults,
} from "../providers/paperchat-routing-metadata";
import { getDeclaredUpgradeModels } from "./paperchat-upgrade-models";
import { getEffectivePricingModelRatio } from "./paperchat-effective-ratio";
import {
  getPaperChatClientHeaders,
  getPaperChatClientQuery,
  getPaperChatClientVersion,
} from "../../utils/clientIdentity";

// Store model ratios for PaperChat
let paperchatModelRatios: Record<string, number> = {};
let paperchatModelRoutingMeta: Record<string, PaperChatModelRoutingMeta> = {};
let paperchatModelRoutingDefaults: PaperChatModelRoutingDefaults = {};
let paperchatModelCacheGeneration = 0;

/** Special value stored in pref("model") to indicate auto-selection (cheapest) */
export const AUTO_MODEL = "auto";
/** Special value stored in pref("model") to indicate auto-selection (smartest) */
export const AUTO_MODEL_SMART = "auto-smart";
const MODEL_ROUTING_META_PATH = "/ext/paperchat/model-routing.json";
const ROUTING_CACHE_CLIENT_VERSION_PREF = "paperchatModelCacheClientVersion";

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

function readCachedModelRoutingMeta(): Record<
  string,
  PaperChatModelRoutingMeta
> {
  try {
    const cached = JSON.parse(getPref("paperchatRoutingConfigCache") || "{}");
    if (cached && typeof cached === "object" && !Array.isArray(cached)) {
      return Object.fromEntries(
        Object.entries(cached).filter(
          ([, meta]) =>
            meta && typeof meta === "object" && !Array.isArray(meta),
        ),
      ) as Record<string, PaperChatModelRoutingMeta>;
    }
  } catch {
    // A missing or invalid routing cache cannot authorize selectable models.
  }
  return {};
}

/**
 * Routing metadata for model selection: the freshly fetched map when it is
 * available, otherwise the copy cached from the last successful fetch.
 */
function resolveModelRoutingMeta(): Record<string, PaperChatModelRoutingMeta> {
  const routing = getModelRoutingMeta();
  return Object.keys(routing).length > 0
    ? routing
    : readCachedModelRoutingMeta();
}

/**
 * User-selectable models must be present in both the key list and routing
 * config. If routing config is temporarily unavailable, the last list derived
 * from it is used instead of raw key models.
 */
export function getSelectablePaperchatModels(
  models?: readonly string[],
): string[] {
  let keyModels: unknown = models;
  if (keyModels === undefined) {
    try {
      keyModels = JSON.parse(getPref("paperchatModelsCache") || "[]");
    } catch {
      return [];
    }
  }
  if (!Array.isArray(keyModels)) return [];
  const routing = resolveModelRoutingMeta();
  if (Object.keys(routing).length === 0) {
    // Routing metadata is the whitelist. When it is temporarily unavailable
    // (for example right after an upgrade), reuse the last known chat-model
    // list instead of falling back to arbitrary raw key models.
    const keyModelSet = new Set(keyModels);
    return readCachedPaperchatChatModels().filter(
      (model) => keyModelSet.has(model) && !isEmbeddingModel(model),
    );
  }
  return sortModelsByRoutingWeight(
    [...new Set(keyModels)].filter(
      (model): model is string =>
        typeof model === "string" &&
        model.length > 0 &&
        !isEmbeddingModel(model) &&
        Object.prototype.hasOwnProperty.call(routing, model),
    ),
    routing,
  );
}

function readCachedPaperchatChatModels(): string[] {
  try {
    const parsed = JSON.parse(
      getPref("paperchatChatModelsCache") || "[]",
    ) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (model): model is string =>
        typeof model === "string" &&
        model.length > 0 &&
        !isEmbeddingModel(model),
    );
  } catch {
    return [];
  }
}

/** Persist the last known chat-model list for offline/startup fallback. */
export function setPaperchatChatModelsCache(models: readonly string[]): void {
  const selectable = [
    ...new Set(
      models.filter(
        (model) =>
          typeof model === "string" &&
          model.length > 0 &&
          !isEmbeddingModel(model),
      ),
    ),
  ];
  setPref("paperchatChatModelsCache", JSON.stringify(selectable));
}

/**
 * Same selection as `getSelectablePaperchatModels`, ordered by tier ladder and
 * then by routing weight. Pickers that list one option per tier, such as the
 * translation model dropdown, read in the order the tiers are meant to be used.
 */
export function getSelectablePaperchatModelsByTier(
  models?: readonly string[],
): string[] {
  return sortModelsByTierThenWeight(
    getSelectablePaperchatModels(models),
    resolveModelRoutingMeta(),
  );
}

export function getPaperchatModelCacheGeneration(): number {
  return paperchatModelCacheGeneration;
}

export function clearPaperchatModelCaches(): void {
  paperchatModelCacheGeneration += 1;
  paperchatModelRatios = {};
  paperchatModelRoutingMeta = {};
  paperchatModelRoutingDefaults = {};
  setPref("paperchatModelsCache", "");
  setPref("paperchatChatModelsCache", "");
  setPref("paperchatRatiosCache", "");
  setPref("paperchatRoutingConfigCache", "");
  setPref("paperchatRoutingDefaultsCache", "");
  setPref("paperchatEmbeddingConfigCache", "");
}

function clearPaperchatRoutingCaches(): void {
  paperchatModelCacheGeneration += 1;
  paperchatModelRoutingMeta = {};
  paperchatModelRoutingDefaults = {};
  setPref("paperchatRoutingConfigCache", "");
  setPref("paperchatRoutingDefaultsCache", "");
}

/**
 * Drop the cached routing metadata when this build changes so an upgraded
 * client never keeps capabilities it just learned about, and a downgraded one
 * stops advertising capabilities it cannot handle. Runs before anything reads
 * the routing cache; model, ratio, and routing-derived chat model caches are
 * kept so an offline client still lists its models.
 */
export function ensurePaperchatRoutingCacheVersion(): void {
  const currentVersion = getPaperChatClientVersion();
  if (getPref(ROUTING_CACHE_CLIENT_VERSION_PREF) === currentVersion) {
    return;
  }
  // Preserve the last chat-model list before dropping routing metadata that
  // belongs to the previous plugin build.
  const chatModels = getSelectablePaperchatModels();
  if (chatModels.length > 0) {
    setPaperchatChatModelsCache(chatModels);
  }
  clearPaperchatRoutingCaches();
  setPref(ROUTING_CACHE_CLIENT_VERSION_PREF, currentVersion);
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
 * Load cached ratios from prefs
 */
export function loadCachedRatios(): void {
  paperchatModelRatios = {};
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

  paperchatModelRoutingMeta = readCachedModelRoutingMeta();
  ztoolkit.log(
    "[Preferences] Loaded cached routing metadata for",
    Object.keys(paperchatModelRoutingMeta).length,
    "models",
  );

  paperchatModelRoutingDefaults = {};
  const cachedRoutingDefaults = getPref(
    "paperchatRoutingDefaultsCache",
  ) as string;
  if (cachedRoutingDefaults) {
    try {
      paperchatModelRoutingDefaults = parseModelRoutingDefaults(
        JSON.parse(cachedRoutingDefaults),
      );
    } catch {
      // ignore parse error
    }
  }
}

export function getModelRoutingDefaults(): PaperChatModelRoutingDefaults {
  return paperchatModelRoutingDefaults;
}

/**
 * Routes the admin marked as requiring a purchase, in tier order. Which of
 * them an account is actually missing is decided per account.
 */
export function getUpgradeOnlyPaperchatModels(): string[] {
  return getDeclaredUpgradeModels(resolveModelRoutingMeta());
}

/**
 * Model ids the account's key reported, including any the routing config does
 * not list. The relay only reports models the account's group may use, so this
 * is what tells which declared upgrade routes the account is still missing.
 */
export function getPaperchatKeyModels(): string[] {
  try {
    const parsed = JSON.parse(getPref("paperchatModelsCache") || "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (model): model is string => typeof model === "string" && model.length > 0,
    );
  } catch {
    return [];
  }
}

export interface PaperchatModelEntry {
  id: string;
  supported_endpoint_types?: string[];
}

function isToolOnlyModelEndpoint(entry: PaperchatModelEntry): boolean {
  const types = entry.supported_endpoint_types;
  if (!Array.isArray(types) || types.length === 0) {
    return false;
  }
  return types.every(
    (type) => typeof type === "string" && type.startsWith("deepseek-tools"),
  );
}

/**
 * First-login fallback when routing metadata is unavailable: use the key's
 * `/v1/models` list, but drop models whose only supported endpoints are
 * DeepSeek tool routes such as search/fetch.
 */
export function getFallbackPaperchatChatModels(
  entries: readonly PaperchatModelEntry[],
): string[] {
  return [
    ...new Set(
      entries
        .filter(
          (entry) =>
            typeof entry.id === "string" &&
            entry.id.length > 0 &&
            !isEmbeddingModel(entry.id) &&
            !isToolOnlyModelEndpoint(entry),
        )
        .map((entry) => entry.id),
    ),
  ];
}

/**
 * True when the key's raw `/v1/models` list advertises NewAPI's DeepSeek
 * Search route. The route name is a search target, not a chat model, so it is
 * intentionally absent from model-routing.json.
 */
export function hasPaperchatServiceSearchModel(
  models?: readonly string[],
): boolean {
  return (models ?? getPaperchatKeyModels()).includes("deepseek-search");
}

export function hasPaperchatServiceFetchModel(
  models?: readonly string[],
): boolean {
  return (models ?? getPaperchatKeyModels()).includes("deepseek-fetch");
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

/**
 * Fetch model ratios from PaperChat pricing API
 */
export async function fetchPaperchatRatios(): Promise<void> {
  const generation = paperchatModelCacheGeneration;
  const url = getPaperChatUrl("/api/pricing");
  ztoolkit.log("[Preferences] Fetching ratios from:", url);

  try {
    const result = await getAuthManager().getPricing();

    if (generation !== paperchatModelCacheGeneration) {
      return;
    }

    if (!result.success) {
      ztoolkit.log("[Preferences] Failed to fetch ratios:", result.message);
      return;
    }

    if (result.data && Array.isArray(result.data)) {
      // Build model_name -> effective ratio mapping. NewAPI pricing returns
      // user-scoped usable groups, auto groups, and group ratios, so PaperChat
      // can route by the user's estimated real cost instead of raw model_ratio.
      paperchatModelRatios = {};
      for (const item of result.data) {
        const modelName = getPricingModelName(item);
        const ratio = getEffectivePricingModelRatio(item, {
          groupRatio: result.group_ratio,
          usableGroup: result.usable_group,
          autoGroups: result.auto_groups,
        });
        if (!modelName || ratio === undefined) {
          continue;
        }

        paperchatModelRatios[modelName] = ratio;
      }
      // Cache ratios to prefs.
      setPref("paperchatRatiosCache", JSON.stringify(paperchatModelRatios));
      ztoolkit.log(
        "[Preferences] Loaded effective ratios for",
        Object.keys(paperchatModelRatios).length,
        "models",
      );
    }
  } catch (e) {
    ztoolkit.log("[Preferences] Failed to fetch ratios:", e);
  }
}

/** Returns whether fresh routing metadata was applied. */
export async function fetchPaperchatRoutingMeta(): Promise<boolean> {
  const generation = paperchatModelCacheGeneration;
  const url = `${getPaperChatUrl(MODEL_ROUTING_META_PATH)}${getPaperChatClientQuery()}`;
  ztoolkit.log("[Preferences] Fetching routing metadata from:", url);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...getPaperChatClientHeaders(),
      },
    });

    if (!response.ok) {
      ztoolkit.log(
        "[Preferences] Failed to fetch routing metadata:",
        response.status,
      );
      return false;
    }

    const result = await response.json();
    if (generation !== paperchatModelCacheGeneration) {
      return false;
    }
    const parsed = parseModelRoutingConfig(result);
    const defaults = parseModelRoutingDefaults(result);
    const embedding = parsePaperChatEmbeddingConfig(
      (result as unknown as Record<string, unknown>)?.embedding,
    );
    setPref("paperchatEmbeddingConfigCache", JSON.stringify(embedding));
    paperchatModelRoutingMeta = parsed;
    paperchatModelRoutingDefaults = defaults;
    setPref("paperchatRoutingConfigCache", JSON.stringify(parsed));
    setPref("paperchatRoutingDefaultsCache", JSON.stringify({ defaults }));
    ztoolkit.log(
      "[Preferences] Loaded routing metadata for",
      Object.keys(parsed).length,
      "models",
    );
    return true;
  } catch (e) {
    ztoolkit.log("[Preferences] Failed to fetch routing metadata:", e);
    return false;
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
  const generation = paperchatModelCacheGeneration;
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
  const ratiosPromise = fetchPaperchatRatios();
  const routingMetaPromise = fetchPaperchatRoutingMeta();

  const url = `${getPaperChatApiBaseUrl()}/models`;
  ztoolkit.log("[Preferences] Fetching models from:", url);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...getPaperChatClientHeaders(),
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

    // Wait for ratios and routing metadata to complete. The routing result
    // decides whether the loaded count is the routing intersection or the raw
    // relay count fallback.
    const [, routingMetaApplied] = await Promise.all([
      ratiosPromise,
      routingMetaPromise,
    ]);

    if (generation !== paperchatModelCacheGeneration) {
      return;
    }

    if (result.data && Array.isArray(result.data)) {
      const models = result.data.map((m) => m.id).sort();
      ztoolkit.log("[Preferences] Parsed models count:", models.length);
      onModelsLoaded(models);
      const loadedCount = getPaperchatLoadedModelCount(
        models,
        Object.keys(getModelRoutingMeta()),
        routingMetaApplied,
      );
      ztoolkit.log(
        "[Preferences] Loaded PaperChat model count:",
        loadedCount,
        "routing metadata applied:",
        routingMetaApplied,
      );
      showMessage(
        doc,
        getString("pref-models-loaded", { args: { count: loadedCount } }),
        false,
      );
    }
  } catch (e) {
    ztoolkit.log("[Preferences] Failed to fetch PaperChat models:", e);
    showMessage(doc, getString("pref-fetch-models-failed"), true);
  }
}
