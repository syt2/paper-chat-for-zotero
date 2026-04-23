import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
} from "./WebSearchProvider";
import { loadPageWithHiddenBrowser } from "./HiddenBrowserSearch";
import {
  buildSeedEnrichedQuery,
  cleanText,
  postProcessResults,
} from "./WebSearchUtils";

const SEARCH_URL = "https://www.semanticscholar.org/search";

interface SemanticScholarWebProviderOptions {
  id?: string;
  displayName?: string;
}

export class SemanticScholarWebProvider implements WebSearchProvider {
  readonly id: string;
  readonly displayName: string;
  private readonly browserTimeoutMs = 20000;

  constructor(options: SemanticScholarWebProviderOptions = {}) {
    this.id = options.id || "semantic_scholar_web";
    this.displayName = options.displayName || "Semantic Scholar Web";
  }

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    const url = this.buildUrl(request);

    const pageData = await loadPageWithHiddenBrowser(url, {
      timeoutMs: this.browserTimeoutMs,
      settleDelayMs: 1200,
    });
    this.assertNotBlocked(pageData.title, pageData.bodyText, pageData.html);

    if (!pageData.html) {
      throw new Error(
        "Semantic Scholar web search returned an empty document from the hidden browser",
      );
    }

    const rawResults = this.parseResults(pageData.html);
    return {
      providerId: this.id,
      provider: this.displayName,
      results: postProcessResults(rawResults, request),
    };
  }

  private buildUrl(request: WebSearchRequest): string {
    const url = new URL(SEARCH_URL);
    url.searchParams.set("q", buildSeedEnrichedQuery(request));
    url.searchParams.set("sort", "relevance");
    return url.toString();
  }

  private assertNotBlocked(
    title: string,
    bodyText: string,
    html?: string,
  ): void {
    const combined = cleanText(`${title} ${bodyText} ${html || ""}`).toLowerCase();
    if (
      combined.includes("human verification") ||
      combined.includes("captcha") ||
      combined.includes("aws waf") ||
      combined.includes("our servers are having a bit of trouble") ||
      combined.includes("error: 405") ||
      combined.includes("error | semantic scholar")
    ) {
      throw new Error(
        "Semantic Scholar web search was blocked or unavailable",
      );
    }
  }

  private parseResults(html: string): WebSearchResult[] {
    const results: WebSearchResult[] = [];
    const seen = new Set<string>();

    for (const match of html.matchAll(
      /<a[^>]*href="([^"]*(?:\/paper\/|semanticscholar\.org\/paper\/)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    )) {
      const title = cleanText(this.stripTags(match[2] || ""));
      const url = this.resolveUrl(match[1] || "");
      if (!title || title.length < 12 || !url || seen.has(url)) {
        continue;
      }

      if (
        /^(homepage|about us|api overview|faq|learn more|go back to home page)$/i.test(
          title,
        )
      ) {
        continue;
      }

      seen.add(url);
      results.push({
        title,
        url,
        snippet: "",
      });
    }

    return results;
  }

  private resolveUrl(rawUrl: string): string {
    const normalized = cleanText(rawUrl);
    if (!normalized) {
      return "";
    }
    if (/^https?:\/\//i.test(normalized)) {
      return normalized;
    }
    if (normalized.startsWith("/")) {
      return `https://www.semanticscholar.org${normalized}`;
    }
    return normalized;
  }

  private stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, " ");
  }
}
