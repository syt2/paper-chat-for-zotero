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
  toAuthorList,
} from "./WebSearchUtils";

const SEARCH_URL = "https://scholar.google.com/scholar";

export class GoogleScholarProvider implements WebSearchProvider {
  readonly id = "google_scholar";
  readonly displayName = "Google Scholar";
  private readonly browserTimeoutMs = 20000;

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    const url = this.buildUrl(request);

    const pageData = await loadPageWithHiddenBrowser(url, {
      timeoutMs: this.browserTimeoutMs,
      settleDelayMs: 1200,
    });
    this.assertNotBlocked(pageData.title, pageData.bodyText, pageData.html);

    if (!pageData.html) {
      throw new Error(
        "Google Scholar search returned an empty document from the hidden browser",
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
    url.searchParams.set("hl", "en");
    url.searchParams.set("as_sdt", "0,5");
    if (typeof request.yearFrom === "number") {
      url.searchParams.set("as_ylo", String(request.yearFrom));
    }
    if (typeof request.yearTo === "number") {
      url.searchParams.set("as_yhi", String(request.yearTo));
    }
    return url.toString();
  }

  private assertNotBlocked(
    title: string,
    bodyText: string,
    html?: string,
  ): void {
    const combined = cleanText(`${title} ${bodyText} ${html || ""}`).toLowerCase();
    if (
      combined.includes("unusual traffic") ||
      combined.includes("not a robot") ||
      combined.includes("our systems have detected") ||
      combined.includes("detected unusual traffic") ||
      combined.includes("系统检测到") ||
      combined.includes("验证码") ||
      combined.includes("/sorry/")
    ) {
      throw new Error("Google Scholar search was blocked by anti-bot verification");
    }
  }

  private parseResults(html: string): WebSearchResult[] {
    const blocks = this.extractResultBlocks(html);
    const results: WebSearchResult[] = [];

    for (const block of blocks) {
      const titleMatch = block.match(
        /<h3[^>]*class="[^"]*\bgs_rt\b[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
      );
      const title = cleanText(this.stripTags(titleMatch?.[2] || ""));
      const url = this.resolveUrl(titleMatch?.[1] || "");
      if (!title || !url) {
        continue;
      }

      const pdfMatch = block.match(
        /<div[^>]*class="[^"]*\bgs_or_ggsm\b[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>/i,
      );
      const metadata = cleanText(
        this.stripTags(
          block.match(
            /<div[^>]*class="[^"]*\bgs_a\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
          )?.[1] || "",
        ),
      );
      const snippet = cleanText(
        this.stripTags(
          block.match(
            /<div[^>]*class="[^"]*\b(?:gs_rs|gs_snippet)\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
          )?.[1] || "",
        ),
      );
      const citationCount = this.parseCitationCount(block);
      const year = this.parseYear(metadata);
      const { authors, venue } = this.parseMetadata(metadata);
      const pdfUrl = cleanText(pdfMatch?.[1] || "");

      results.push({
        title,
        url,
        snippet,
        authors,
        year,
        venue,
        citationCount,
        isOpenAccess: Boolean(pdfUrl),
        openAccessPdfUrl: pdfUrl || undefined,
      });
    }

    return results;
  }

  private extractResultBlocks(html: string): string[] {
    const starts = Array.from(
      html.matchAll(
        /<div[^>]*class="[^"]*\bgs_r\b[^"]*\bgs_scl\b[^"]*"[^>]*>/gi,
      ),
    ).map((match) => match.index ?? 0);

    if (starts.length === 0) {
      return [];
    }

    const blocks: string[] = [];
    for (let index = 0; index < starts.length; index++) {
      const start = starts[index];
      const end = starts[index + 1] ?? html.length;
      blocks.push(html.slice(start, end));
    }
    return blocks;
  }

  private parseCitationCount(block: string): number | undefined {
    const match =
      block.match(/Cited by\s*(\d+)/i) ||
      block.match(/被引用次数[:：]\s*(\d+)/i);
    return match ? Number.parseInt(match[1], 10) : undefined;
  }

  private parseYear(metadata: string): number | undefined {
    const match = metadata.match(/(?:19|20)\d{2}/);
    return match ? Number.parseInt(match[0], 10) : undefined;
  }

  private parseMetadata(metadata: string): {
    authors?: string[];
    venue?: string;
  } {
    if (!metadata) {
      return {};
    }

    const parts = metadata
      .split(/\s+-\s+/)
      .map((part) => cleanText(part))
      .filter(Boolean);
    const authors = toAuthorList(parts[0]);
    const venue = parts.length > 1 ? parts[1] : undefined;
    return {
      authors,
      venue,
    };
  }

  private stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, " ");
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
      return `https://scholar.google.com${normalized}`;
    }
    return normalized;
  }
}
