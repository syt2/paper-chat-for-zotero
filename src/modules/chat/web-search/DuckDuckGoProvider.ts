import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
} from "./WebSearchProvider";

const SEARCH_URL = "https://html.duckduckgo.com/html/";

interface HtmlResponse {
  status: number;
  statusText: string;
  contentType: string;
  contentLength?: number;
  body: string;
}

export class DuckDuckGoProvider implements WebSearchProvider {
  readonly id = "duckduckgo";
  readonly displayName = "DuckDuckGo";
  private readonly contentFetchLimit = 3;
  private readonly contentExcerptLength = 900;
  private readonly searchTimeoutMs = 8000;
  private readonly preflightTimeoutMs = 2500;
  private readonly contentFetchTimeoutMs = 5000;
  private readonly maxContentBytes = 1_000_000;

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(request.query)}`;
    const response = await this.requestHtml(url, this.searchTimeoutMs);

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `DuckDuckGo search failed: ${response.status} ${response.statusText}`,
      );
    }

    const results = await this.parseResults(response.body, request);
    return {
      provider: this.displayName,
      results,
    };
  }

  private async parseResults(
    html: string,
    request: WebSearchRequest,
  ): Promise<WebSearchResult[]> {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const parsedResults: WebSearchResult[] = [];

    for (const node of Array.from(doc.querySelectorAll(".result")) as Element[]) {
      const linkEl = node.querySelector(
        ".result__title a.result__a, a.result__a",
      ) as Element | null;
      if (!linkEl) {
        continue;
      }

      const title = this.cleanText(linkEl.textContent || "");
      const url = this.resolveResultUrl(linkEl.getAttribute("href") || "");
      const snippet = this.cleanText(
        node.querySelector(".result__snippet")?.textContent || "",
      );

      if (!title || !url) {
        continue;
      }

      if (!this.matchesDomainFilter(url, request.domainFilter)) {
        continue;
      }

      parsedResults.push({
        title,
        url,
        snippet,
      });

      if (parsedResults.length >= request.maxResults) {
        break;
      }
    }

    if (request.includeContent) {
      await this.enrichWithContent(parsedResults);
    }

    return parsedResults;
  }

  private async enrichWithContent(results: WebSearchResult[]): Promise<void> {
    const targets = results.slice(0, this.contentFetchLimit);
    await Promise.all(
      targets.map(async (result) => {
        result.contentExcerpt = await this.fetchContentExcerpt(result.url);
      }),
    );
  }

  private async fetchContentExcerpt(url: string): Promise<string | undefined> {
    if (!this.isHtmlCandidate(url)) {
      return undefined;
    }

    try {
      const preflight = await this.preflightHtml(url);
      if (!preflight) {
        return undefined;
      }

      const response = await this.requestHtml(url, this.contentFetchTimeoutMs);

      if (response.status < 200 || response.status >= 300) {
        return undefined;
      }

      if (!response.contentType.includes("text/html")) {
        return undefined;
      }

      const extractedText = this.extractContentText(response.body);
      return extractedText
        ? this.truncate(extractedText, this.contentExcerptLength)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async preflightHtml(url: string): Promise<boolean> {
    try {
      const response = await this.requestHtml(
        url,
        this.preflightTimeoutMs,
        "HEAD",
      );

      if (response.status < 200 || response.status >= 300) {
        return false;
      }

      if (response.contentType && !response.contentType.includes("text/html")) {
        return false;
      }

      if (
        typeof response.contentLength === "number" &&
        response.contentLength > this.maxContentBytes
      ) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  private requestHtml(
    url: string,
    timeoutMs: number,
    method: "GET" | "HEAD" = "GET",
  ): Promise<HtmlResponse> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let timeoutTriggered = false;

      xhr.open(method, url, true);
      xhr.timeout = timeoutMs;
      xhr.setRequestHeader("Accept", "text/html,application/xhtml+xml");

      xhr.onload = () => {
        const contentLengthHeader = xhr.getResponseHeader("Content-Length");
        resolve({
          status: xhr.status,
          statusText: xhr.statusText,
          contentType: xhr.getResponseHeader("Content-Type") || "",
          contentLength: contentLengthHeader
            ? Number.parseInt(contentLengthHeader, 10)
            : undefined,
          body: xhr.responseText || "",
        });
      };

      xhr.onerror = () => {
        reject(new Error(`Request failed for ${url}`));
      };

      xhr.ontimeout = () => {
        timeoutTriggered = true;
        xhr.abort();
        reject(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
      };

      xhr.onabort = () => {
        if (timeoutTriggered) {
          return;
        }
        reject(new Error(`Request aborted: ${url}`));
      };

      xhr.send();
    });
  }

  private extractContentText(html: string): string {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const candidates = [
      doc.querySelector("article"),
      doc.querySelector("main"),
      doc.querySelector("[role='main']"),
      doc.body,
    ];

    let bestText = "";
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.textContent !== "string") {
        continue;
      }

      const text = this.cleanText(candidate.textContent || "");
      if (text.length > bestText.length) {
        bestText = text;
      }
    }

    return bestText;
  }

  private isHtmlCandidate(url: string): boolean {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname.toLowerCase();
      return !(
        pathname.endsWith(".pdf") ||
        pathname.endsWith(".epub") ||
        pathname.endsWith(".doc") ||
        pathname.endsWith(".docx")
      );
    } catch {
      return false;
    }
  }

  private resolveResultUrl(rawUrl: string): string {
    if (!rawUrl) {
      return "";
    }

    let normalizedUrl = rawUrl.trim();
    if (normalizedUrl.startsWith("//")) {
      normalizedUrl = `https:${normalizedUrl}`;
    } else if (normalizedUrl.startsWith("/")) {
      normalizedUrl = `https://duckduckgo.com${normalizedUrl}`;
    }

    try {
      const parsed = new URL(normalizedUrl);
      if (
        (parsed.hostname.endsWith("duckduckgo.com") ||
          parsed.hostname.endsWith("duck.com")) &&
        parsed.pathname.startsWith("/l/")
      ) {
        const actualUrl = parsed.searchParams.get("uddg");
        return actualUrl ? decodeURIComponent(actualUrl) : normalizedUrl;
      }
      return normalizedUrl;
    } catch {
      return normalizedUrl;
    }
  }

  private matchesDomainFilter(url: string, domainFilter?: string[]): boolean {
    if (!domainFilter || domainFilter.length === 0) {
      return true;
    }

    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return domainFilter.some((domain) => {
        const normalizedDomain = domain.toLowerCase();
        return (
          hostname === normalizedDomain ||
          hostname.endsWith(`.${normalizedDomain}`)
        );
      });
    } catch {
      return false;
    }
  }

  private cleanText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength - 3)}...`;
  }
}
