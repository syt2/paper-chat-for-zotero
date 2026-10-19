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
  language?: string;
  originalQuestion?: string;
  openAccessOnly: boolean;
  seedTitle?: string;
  seedDoi?: string;
  seedPaperId?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Model-oriented summary returned by service search providers. */
  summary?: string;
  /** DeepSeek Search relevance score, 0-3. */
  rerankScore?: number;
  /** DeepSeek Search authority score, 0-4; -1 means unknown. */
  authority?: number;
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

export interface WebFetchResult {
  title: string;
  url: string;
  content: string;
  contentType: "markdown";
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
