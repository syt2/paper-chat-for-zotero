import { DuckDuckGoProvider } from "./DuckDuckGoProvider";
import { GoogleScholarProvider } from "./GoogleScholarProvider";
import { OpenAlexProvider } from "./OpenAlexProvider";
import { SemanticScholarWebProvider } from "./SemanticScholarWebProvider";
import type { WebSearchProvider } from "./WebSearchProvider";

/*
 * Three id sets live here, intentionally distinct:
 *
 * - WEB_SEARCH_PROVIDER_DESCRIPTORS  — ids shown in the prefs dropdown.
 * - VISIBLE_WEB_SEARCH_PROVIDER_IDS  — the same ids as a Set, used to
 *   validate the user-facing pref.
 * - WEB_SEARCH_PROVIDER_IDS          — every id that `createWebSearchProvider`
 *   can instantiate. Superset of the visible ids. Includes `semantic_scholar`
 *   as a legacy alias (old prefs, old tool-arg usage) that is hidden from the
 *   UI but still callable, plus `semantic_scholar_web` which is only exposed
 *   via the tool `source` argument.
 *
 * `WEB_SEARCH_SOURCES` in `src/types/tool.ts` is the separate list of ids the
 * `source` tool arg accepts. Keep them in sync.
 */

export interface WebSearchProviderDescriptor {
  id: string;
  labelL10nId: string;
}

class AutoWebSearchProvider implements WebSearchProvider {
  readonly id = "auto";
  readonly displayName = "Auto";

  async search(): Promise<never> {
    throw new Error("Auto provider must be routed by WebSearchService.");
  }
}

export const DEFAULT_WEB_SEARCH_PROVIDER_ID = "auto";

const WEB_SEARCH_PROVIDER_DESCRIPTORS: WebSearchProviderDescriptor[] = [
  {
    id: DEFAULT_WEB_SEARCH_PROVIDER_ID,
    labelL10nId: "pref-web-search-provider-auto",
  },
  {
    id: "google_scholar",
    labelL10nId: "pref-web-search-provider-google-scholar",
  },
  {
    id: "openalex",
    labelL10nId: "pref-web-search-provider-openalex",
  },
  {
    id: "duckduckgo",
    labelL10nId: "pref-web-search-provider-duckduckgo",
  },
];

const VISIBLE_WEB_SEARCH_PROVIDER_IDS = new Set<string>(
  WEB_SEARCH_PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.id),
);

const WEB_SEARCH_PROVIDER_IDS = new Set<string>([
  ...VISIBLE_WEB_SEARCH_PROVIDER_IDS,
  "semantic_scholar",
  "semantic_scholar_web",
]);

export function listWebSearchProviders(): WebSearchProviderDescriptor[] {
  return [...WEB_SEARCH_PROVIDER_DESCRIPTORS];
}

export function normalizeWebSearchProviderId(providerId?: string): string {
  if (providerId && VISIBLE_WEB_SEARCH_PROVIDER_IDS.has(providerId)) {
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
    case "duckduckgo":
    default:
      return new DuckDuckGoProvider();
  }
}
