export { executeWebSearch } from "./WebSearchService";
export { isValidWebSearchArgs } from "./WebSearchArgs";
export {
  createWebSearchProvider,
  DEFAULT_WEB_SEARCH_PROVIDER_ID,
  listWebSearchProviders,
  normalizeWebSearchProviderId,
} from "./WebSearchRegistry";
export type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
} from "./WebSearchProvider";
export { SemanticScholarProvider } from "./SemanticScholarProvider";
export { OpenAlexProvider } from "./OpenAlexProvider";
export { EuropePmcProvider } from "./EuropePmcProvider";
