import { DuckDuckGoProvider } from "./DuckDuckGoProvider";
import { EuropePmcProvider } from "./EuropePmcProvider";
import { OpenAlexProvider } from "./OpenAlexProvider";
import { SemanticScholarProvider } from "./SemanticScholarProvider";
import type { WebSearchProvider } from "./WebSearchProvider";

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
    id: "semantic_scholar",
    labelL10nId: "pref-web-search-provider-semantic-scholar",
  },
  {
    id: "openalex",
    labelL10nId: "pref-web-search-provider-openalex",
  },
  {
    id: "europe_pmc",
    labelL10nId: "pref-web-search-provider-europe-pmc",
  },
  {
    id: "duckduckgo",
    labelL10nId: "pref-web-search-provider-duckduckgo",
  },
];

export function listWebSearchProviders(): WebSearchProviderDescriptor[] {
  return [...WEB_SEARCH_PROVIDER_DESCRIPTORS];
}

export function normalizeWebSearchProviderId(providerId?: string): string {
  if (
    providerId &&
    WEB_SEARCH_PROVIDER_DESCRIPTORS.some(
      (descriptor) => descriptor.id === providerId,
    )
  ) {
    return providerId;
  }

  return DEFAULT_WEB_SEARCH_PROVIDER_ID;
}

export function createWebSearchProvider(
  providerId?: string,
): WebSearchProvider {
  const normalizedId = normalizeWebSearchProviderId(providerId);

  switch (normalizedId) {
    case DEFAULT_WEB_SEARCH_PROVIDER_ID:
      return new AutoWebSearchProvider();
    case "semantic_scholar":
      return new SemanticScholarProvider();
    case "openalex":
      return new OpenAlexProvider();
    case "europe_pmc":
      return new EuropePmcProvider();
    case "duckduckgo":
    default:
      return new DuckDuckGoProvider();
  }
}
