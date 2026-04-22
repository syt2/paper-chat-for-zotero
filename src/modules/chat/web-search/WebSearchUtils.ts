import type { WebSearchRequest, WebSearchResult } from "./WebSearchProvider";

export function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

export function matchesDomainFilter(
  url: string,
  domainFilter?: string[],
): boolean {
  if (!domainFilter || domainFilter.length === 0) {
    return true;
  }

  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return domainFilter.some((domain) => {
      const normalized = domain.toLowerCase();
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
  } catch {
    return false;
  }
}

export function dedupeResults(results: WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = result.doi?.toLowerCase() || result.url.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function postProcessResults(
  results: WebSearchResult[],
  request: WebSearchRequest,
): WebSearchResult[] {
  const filtered = results.filter((result) => {
    if (!result.title || !result.url) {
      return false;
    }
    if (
      typeof request.yearFrom === "number" &&
      typeof result.year === "number" &&
      result.year < request.yearFrom
    ) {
      return false;
    }
    if (
      typeof request.yearTo === "number" &&
      typeof result.year === "number" &&
      result.year > request.yearTo
    ) {
      return false;
    }
    if (request.openAccessOnly && result.isOpenAccess !== true) {
      return false;
    }
    return matchesDomainFilter(result.url, request.domainFilter);
  });

  return dedupeResults(filtered).slice(0, request.maxResults);
}
export function toAuthorList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const authors = value
    .split(/,|;|\band\b/i)
    .map((entry) => cleanText(entry))
    .filter(Boolean);
  return authors.length > 0 ? authors : undefined;
}
