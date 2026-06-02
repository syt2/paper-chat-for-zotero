import { BingProvider } from "./BingProvider";
import { DuckDuckGoProvider } from "./DuckDuckGoProvider";
import { GoogleScholarProvider } from "./GoogleScholarProvider";
import { OpenAlexProvider } from "./OpenAlexProvider";
import { SemanticScholarWebProvider } from "./SemanticScholarWebProvider";
import type { WebSearchProvider } from "./WebSearchProvider";

/*
 * Two id sets live here, intentionally distinct:
 *
 * - CONFIGURABLE_WEB_SEARCH_PROVIDER_IDS — ids accepted from the persisted
 *   webSearchProvider pref. The prefs UI no longer exposes this setting, but
 *   old fixed-provider values remain compatible.
 * - WEB_SEARCH_PROVIDER_IDS              — every id that
 *   `createWebSearchProvider` can instantiate. Superset of configurable ids.
 *   Includes `semantic_scholar` as a legacy alias (old prefs, old tool-arg
 *   usage) that is hidden from the UI but still callable, plus
 *   `semantic_scholar_web` which is only exposed via the tool `source`
 *   argument.
 *
 * `WEB_SEARCH_SOURCES` in `src/types/tool.ts` is the separate list of ids the
 * `source` tool arg accepts. Keep them in sync.
 */

class AutoWebSearchProvider implements WebSearchProvider {
  readonly id = "auto";
  readonly displayName = "Auto";

  async search(): Promise<never> {
    throw new Error("Auto provider must be routed by WebSearchService.");
  }
}

export const DEFAULT_WEB_SEARCH_PROVIDER_ID = "auto";

const CONFIGURABLE_WEB_SEARCH_PROVIDER_IDS = new Set<string>([
  DEFAULT_WEB_SEARCH_PROVIDER_ID,
  "google_scholar",
  "openalex",
  "bing",
  "duckduckgo",
]);

const WEB_SEARCH_PROVIDER_IDS = new Set<string>([
  ...CONFIGURABLE_WEB_SEARCH_PROVIDER_IDS,
  "semantic_scholar",
  "semantic_scholar_web",
]);

export function normalizeWebSearchProviderId(providerId?: string): string {
  if (providerId && CONFIGURABLE_WEB_SEARCH_PROVIDER_IDS.has(providerId)) {
    return providerId;
  }

  return DEFAULT_WEB_SEARCH_PROVIDER_ID;
}

function normalizeAvailableWebSearchProviderId(providerId?: string): string {
  if (providerId && WEB_SEARCH_PROVIDER_IDS.has(providerId)) {
    return providerId;
  }

  return DEFAULT_WEB_SEARCH_PROVIDER_ID;
}

export function createWebSearchProvider(
  providerId?: string,
): WebSearchProvider {
  const normalizedId = normalizeAvailableWebSearchProviderId(providerId);

  switch (normalizedId) {
    case DEFAULT_WEB_SEARCH_PROVIDER_ID:
      return new AutoWebSearchProvider();
    case "semantic_scholar":
      // Legacy id: old prefs / old tool-arg callers. The API-backed provider
      // has been retired; route through the web scraper but keep the display
      // name the user previously saw.
      return new SemanticScholarWebProvider({
        id: "semantic_scholar",
        displayName: "Semantic Scholar",
      });
    case "semantic_scholar_web":
      return new SemanticScholarWebProvider();
    case "google_scholar":
      return new GoogleScholarProvider();
    case "openalex":
      return new OpenAlexProvider();
    case "bing":
      return new BingProvider();
    case "duckduckgo":
    default:
      return new DuckDuckGoProvider();
  }
}
