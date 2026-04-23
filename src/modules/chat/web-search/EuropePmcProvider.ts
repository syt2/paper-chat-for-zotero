import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
} from "./WebSearchProvider";
import { requestJson } from "./WebSearchHttp";
import {
  buildEuropePmcQuery,
  cleanText,
  postProcessResults,
  toAuthorList,
} from "./WebSearchUtils";

const SEARCH_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";

interface EuropePmcResult {
  id?: string;
  source?: string;
  title?: string;
  authorString?: string;
  journalTitle?: string;
  pubYear?: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  isOpenAccess?: string;
  hasPdf?: string;
  abstractText?: string;
}

interface EuropePmcResponse {
  resultList?: {
    result?: EuropePmcResult[];
  };
}

export class EuropePmcProvider implements WebSearchProvider {
  readonly id = "europe_pmc";
  readonly displayName = "Europe PMC";
  private readonly timeoutMs = 8000;

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    const url = new URL(SEARCH_URL);
    url.searchParams.set("query", buildEuropePmcQuery(request.query));
    url.searchParams.set("format", "json");
    url.searchParams.set(
      "pageSize",
      String(Math.min(request.maxResults * 2, 20)),
    );
    url.searchParams.set("sort", "RELEVANCE");

    const response = await requestJson<EuropePmcResponse>(
      url.toString(),
      this.timeoutMs,
    );

    const rawResults = (response.resultList?.result || []).map((entry) =>
      this.mapResult(entry),
    );

    return {
      providerId: this.id,
      provider: this.displayName,
      results: postProcessResults(rawResults, request),
    };
  }

  private mapResult(entry: EuropePmcResult): WebSearchResult {
    const doi = cleanText(entry.doi || "");
    const pmcid = cleanText(entry.pmcid || "");
    const pmid = cleanText(entry.pmid || "");
    const url = pmcid
      ? `https://europepmc.org/article/PMC/${pmcid}`
      : pmid
        ? `https://europepmc.org/article/MED/${pmid}`
        : doi
          ? `https://doi.org/${doi}`
          : entry.id
            ? `https://europepmc.org/article/${cleanText(entry.source || "MED")}/${cleanText(entry.id)}`
            : "";
    const hasOpenAccess =
      entry.isOpenAccess === "Y" ||
      entry.isOpenAccess === "true" ||
      entry.hasPdf === "Y";

    return {
      title: cleanText(entry.title || ""),
      url,
      snippet: cleanText(entry.abstractText || ""),
      authors: toAuthorList(entry.authorString),
      year: entry.pubYear ? Number.parseInt(entry.pubYear, 10) : undefined,
      venue: cleanText(entry.journalTitle || ""),
      doi: doi || undefined,
      paperId: pmcid || pmid || cleanText(entry.id || "") || undefined,
      isOpenAccess: hasOpenAccess,
      openAccessPdfUrl:
        hasOpenAccess && pmcid
          ? `https://europepmc.org/articles/${pmcid}?pdf=render`
          : undefined,
    };
  }
}
