export { executeScholarlySearch, executeWebSearch } from "./WebSearchService";
export {
  isValidScholarlySearchArgs,
  isValidWebSearchArgs,
} from "./WebSearchArgs";
export {
  createWebSearchProvider,
  DEFAULT_WEB_SEARCH_PROVIDER_ID,
  normalizeWebSearchProviderId,
} from "./WebSearchRegistry";
export type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
} from "./WebSearchProvider";
export { SemanticScholarWebProvider } from "./SemanticScholarWebProvider";
export { GoogleScholarProvider } from "./GoogleScholarProvider";
export { OpenAlexProvider } from "./OpenAlexProvider";
export { BingProvider } from "./BingProvider";
export { EuropePmcProvider } from "./EuropePmcProvider";
