export interface WebSearchRequest {
  query: string;
  maxResults: number;
  domainFilter?: string[];
  includeContent: boolean;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  contentExcerpt?: string;
}

export interface WebSearchResponse {
  provider: string;
  results: WebSearchResult[];
}

export interface WebSearchProvider {
  readonly id: string;
  readonly displayName: string;
  search(request: WebSearchRequest): Promise<WebSearchResponse>;
}
