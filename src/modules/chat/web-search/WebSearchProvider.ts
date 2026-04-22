import type { WebSearchIntent, WebSearchSource } from "../../../types/tool";

export interface WebSearchRequest {
  query: string;
  source: WebSearchSource;
  intent: WebSearchIntent;
  maxResults: number;
  domainFilter?: string[];
  includeContent: boolean;
  yearFrom?: number;
  yearTo?: number;
  openAccessOnly: boolean;
  seedTitle?: string;
  seedDoi?: string;
  seedPaperId?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  authors?: string[];
  year?: number;
  venue?: string;
  doi?: string;
  paperId?: string;
  citationCount?: number;
  isOpenAccess?: boolean;
  openAccessPdfUrl?: string;
  contentExcerpt?: string;
  contentType?: "webpage_excerpt";
}

export interface WebSearchResponse {
  providerId: string;
  provider: string;
  results: WebSearchResult[];
  routeSummary?: string;
}

export interface WebSearchProvider {
  readonly id: string;
  readonly displayName: string;
  search(request: WebSearchRequest): Promise<WebSearchResponse>;
}
