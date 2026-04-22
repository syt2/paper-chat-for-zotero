import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
} from "./WebSearchProvider";
import { requestJson } from "./WebSearchHttp";
import { cleanText, postProcessResults } from "./WebSearchUtils";

const SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search";

interface SemanticScholarAuthor {
  name?: string;
}

interface SemanticScholarPaper {
  paperId?: string;
  title?: string;
  url?: string;
  abstract?: string;
  venue?: string;
  year?: number;
  authors?: SemanticScholarAuthor[];
  citationCount?: number;
  externalIds?: {
    DOI?: string;
  };
  openAccessPdf?: {
    url?: string;
  };
}

interface SemanticScholarSearchResponse {
  data?: SemanticScholarPaper[];
}

export class SemanticScholarProvider implements WebSearchProvider {
  readonly id = "semantic_scholar";
  readonly displayName = "Semantic Scholar";
  private readonly timeoutMs = 8000;

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    const url = new URL(SEARCH_URL);
    url.searchParams.set("query", this.buildQuery(request));
    url.searchParams.set("limit", String(Math.min(request.maxResults * 2, 20)));
    url.searchParams.set(
      "fields",
      [
        "paperId",
        "title",
        "url",
        "abstract",
        "venue",
        "year",
        "authors",
        "citationCount",
        "externalIds",
        "openAccessPdf",
      ].join(","),
    );

    const response = await requestJson<SemanticScholarSearchResponse>(
      url.toString(),
      this.timeoutMs,
    );

    const rawResults = (response.data || []).map((paper) =>
      this.mapResult(paper),
    );

    return {
      providerId: this.id,
      provider: this.displayName,
      results: postProcessResults(rawResults, request),
    };
  }

  private buildQuery(request: WebSearchRequest): string {
    const parts = [request.query];
    if (request.intent === "related" && request.seedTitle) {
      parts.push(request.seedTitle);
    }
    if (request.seedDoi) {
      parts.push(request.seedDoi);
    }
    if (request.seedPaperId) {
      parts.push(request.seedPaperId);
    }
    return parts
      .map((value) => cleanText(value))
      .filter(Boolean)
      .join(" ");
  }

  private mapResult(paper: SemanticScholarPaper): WebSearchResult {
    const doi = cleanText(paper.externalIds?.DOI || "");
    const openAccessPdfUrl = cleanText(paper.openAccessPdf?.url || "");
    const url =
      cleanText(paper.url || "") ||
      openAccessPdfUrl ||
      (paper.paperId
        ? `https://www.semanticscholar.org/paper/${paper.paperId}`
        : "");

    return {
      title: cleanText(paper.title || ""),
      url,
      snippet: cleanText(paper.abstract || ""),
      authors: (paper.authors || [])
        .map((author) => cleanText(author.name || ""))
        .filter(Boolean),
      year: paper.year,
      venue: cleanText(paper.venue || ""),
      doi: doi || undefined,
      paperId: cleanText(paper.paperId || "") || undefined,
      citationCount: paper.citationCount,
      isOpenAccess: Boolean(openAccessPdfUrl),
      openAccessPdfUrl: openAccessPdfUrl || undefined,
    };
  }
}
