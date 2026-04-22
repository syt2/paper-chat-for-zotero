import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
} from "./WebSearchProvider";
import { requestJson } from "./WebSearchHttp";
import { cleanText, postProcessResults } from "./WebSearchUtils";

const SEARCH_URL = "https://api.openalex.org/works";

interface OpenAlexAuthor {
  author?: {
    display_name?: string;
  };
}

interface OpenAlexWork {
  id?: string;
  display_name?: string;
  publication_year?: number;
  authorships?: OpenAlexAuthor[];
  cited_by_count?: number;
  doi?: string;
  ids?: {
    doi?: string;
  };
  primary_location?: {
    landing_page_url?: string;
    pdf_url?: string;
    source?: {
      display_name?: string;
    };
  };
  open_access?: {
    oa_url?: string;
    is_oa?: boolean;
  };
  abstract_inverted_index?: Record<string, number[]>;
}

interface OpenAlexResponse {
  results?: OpenAlexWork[];
}

export class OpenAlexProvider implements WebSearchProvider {
  readonly id = "openalex";
  readonly displayName = "OpenAlex";
  private readonly timeoutMs = 8000;

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    const url = new URL(SEARCH_URL);
    url.searchParams.set("search", request.query);
    url.searchParams.set(
      "per-page",
      String(Math.min(request.maxResults * 2, 20)),
    );

    const filters: string[] = [];
    if (request.openAccessOnly) {
      filters.push("is_oa:true");
    }
    if (typeof request.yearFrom === "number") {
      filters.push(`from_publication_date:${request.yearFrom}-01-01`);
    }
    if (typeof request.yearTo === "number") {
      filters.push(`to_publication_date:${request.yearTo}-12-31`);
    }
    if (filters.length > 0) {
      url.searchParams.set("filter", filters.join(","));
    }

    const response = await requestJson<OpenAlexResponse>(
      url.toString(),
      this.timeoutMs,
    );

    const rawResults = (response.results || []).map((work) =>
      this.mapResult(work),
    );

    return {
      providerId: this.id,
      provider: this.displayName,
      results: postProcessResults(rawResults, request),
    };
  }

  private mapResult(work: OpenAlexWork): WebSearchResult {
    const doi =
      cleanText(work.doi || "") ||
      cleanText(work.ids?.doi || "").replace(/^https?:\/\/doi\.org\//i, "");
    const landingUrl = cleanText(work.primary_location?.landing_page_url || "");
    const pdfUrl =
      cleanText(work.primary_location?.pdf_url || "") ||
      cleanText(work.open_access?.oa_url || "");
    const url =
      landingUrl ||
      pdfUrl ||
      (doi ? `https://doi.org/${doi}` : cleanText(work.id || ""));

    return {
      title: cleanText(work.display_name || ""),
      url,
      snippet: cleanText(this.expandAbstract(work.abstract_inverted_index)),
      authors: (work.authorships || [])
        .map((authorship) => cleanText(authorship.author?.display_name || ""))
        .filter(Boolean),
      year: work.publication_year,
      venue: cleanText(work.primary_location?.source?.display_name || ""),
      doi: doi || undefined,
      paperId: cleanText(work.id || "") || undefined,
      citationCount: work.cited_by_count,
      isOpenAccess: work.open_access?.is_oa === true,
      openAccessPdfUrl: pdfUrl || undefined,
    };
  }

  private expandAbstract(invertedIndex?: Record<string, number[]>): string {
    if (!invertedIndex) {
      return "";
    }

    const entries = Object.entries(invertedIndex);
    if (entries.length === 0) {
      return "";
    }

    let maxPosition = -1;
    for (const positions of Object.values(invertedIndex)) {
      for (const position of positions) {
        if (position > maxPosition) {
          maxPosition = position;
        }
      }
    }

    if (maxPosition < 0) {
      return "";
    }

    const tokens = new Array<string>(maxPosition + 1).fill("");
    for (const [token, positions] of entries) {
      for (const position of positions) {
        if (!tokens[position]) {
          tokens[position] = token;
        }
      }
    }

    return tokens.filter(Boolean).join(" ");
  }
}
