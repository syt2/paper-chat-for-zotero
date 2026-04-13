import { DuckDuckGoProvider } from "./DuckDuckGoProvider";
import type { WebSearchProvider } from "./WebSearchProvider";

export interface WebSearchProviderDescriptor {
  id: string;
  labelL10nId: string;
}

export const DEFAULT_WEB_SEARCH_PROVIDER_ID = "duckduckgo";

const WEB_SEARCH_PROVIDER_DESCRIPTORS: WebSearchProviderDescriptor[] = [
  {
    id: DEFAULT_WEB_SEARCH_PROVIDER_ID,
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

export function createWebSearchProvider(providerId?: string): WebSearchProvider {
  const normalizedId = normalizeWebSearchProviderId(providerId);

  switch (normalizedId) {
    case DEFAULT_WEB_SEARCH_PROVIDER_ID:
      return new DuckDuckGoProvider();
    default:
      return new DuckDuckGoProvider();
  }
}
