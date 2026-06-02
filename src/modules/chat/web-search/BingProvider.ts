import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
} from "./WebSearchProvider";
import { requestHttp } from "./WebSearchHttp";
import {
  buildSeedEnrichedQuery,
  cleanText,
  matchesDomainFilter,
} from "./WebSearchUtils";

const SEARCH_URL = "https://www.bing.com/search";

export class BingProvider implements WebSearchProvider {
  readonly id = "bing";
  readonly displayName = "Bing";
  private readonly searchTimeoutMs = 8000;

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    const url = this.buildUrl(request);
    const response = await requestHttp(url, {
      timeoutMs: this.searchTimeoutMs,
      accept: "text/html,application/xhtml+xml",
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Bing search failed: ${response.status} ${response.statusText}`,
      );
    }

    return {
      providerId: this.id,
      provider: this.displayName,
      results: this.parseResults(response.body, request),
    };
  }

  private buildUrl(request: WebSearchRequest): string {
    return `${SEARCH_URL}?q=${encodeURIComponent(buildSeedEnrichedQuery(request))}`;
  }

  private parseResults(
    html: string,
    request: WebSearchRequest,
  ): WebSearchResult[] {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const results: WebSearchResult[] = [];

    for (const node of Array.from(
      doc.querySelectorAll("#b_results>li.b_algo"),
    ) as Element[]) {
      const linkEl = (node.querySelector("h2>a") ||
        node.querySelector("a.tilk")) as Element | null;
      if (!linkEl) {
        continue;
      }

      const title = cleanText(
        linkEl.getAttribute("aria-label") || linkEl.textContent || "",
      );
      const url = linkEl.getAttribute("href") || "";
      const snippet = cleanText(
        node.querySelector("p[class^='b_lineclamp']")?.textContent ||
          node.querySelector(".b_caption p")?.textContent ||
          "",
      );

      if (!title || !url) {
        continue;
      }
      if (!matchesDomainFilter(url, request.domainFilter)) {
        continue;
      }

      results.push({ title, url, snippet });

      if (results.length >= request.maxResults) {
        break;
      }
    }

    return results;
  }
}
