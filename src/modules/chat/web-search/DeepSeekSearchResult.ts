import type { WebSearchRequest, WebSearchResult } from "./WebSearchProvider";
import {
  buildSeedEnrichedQuery,
  cleanText,
  matchesDomainFilter,
  truncate,
} from "./WebSearchUtils";

const MAX_QUERY_CHARACTERS = 128;
const CONTENT_EXCERPT_LENGTH = 1200;

export interface DeepSeekSearchResponse {
  results?: unknown[];
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function truncateUnicode(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

export function buildDeepSeekSearchQuery(request: WebSearchRequest): string {
  const baseQuery = cleanText(buildSeedEnrichedQuery(request));
  const filters: string[] = [];
  if (request.domainFilter?.length) {
    filters.push(
      request.domainFilter
        .map((domain) => `site:${domain.trim()}`)
        .filter((filter) => filter !== "site:")
        .join(" OR "),
    );
  }
  if (typeof request.yearFrom === "number") {
    filters.push(`after:${request.yearFrom}`);
  }
  if (typeof request.yearTo === "number") {
    filters.push(`before:${request.yearTo + 1}`);
  }

  const filteredQuery = cleanText([baseQuery, ...filters].join(" "));
  if (unicodeLength(filteredQuery) <= MAX_QUERY_CHARACTERS) {
    return filteredQuery;
  }
  // Filters are optional; a valid base query is more useful than a truncated
  // operator that DeepSeek would reject.
  return truncateUnicode(baseQuery, MAX_QUERY_CHARACTERS);
}

export function getDeepSeekSearchCount(request: WebSearchRequest): number {
  return !request.includeContent && request.domainFilter?.length
    ? Math.min(50, Math.max(request.maxResults, 20))
    : request.maxResults;
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseResultYear(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/^(\d{4})-/);
  if (!match) {
    return undefined;
  }
  const year = Number.parseInt(match[1], 10);
  return year >= 1900 && year <= 2100 ? year : undefined;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseDeepSeekSearchResults(
  payload: DeepSeekSearchResponse,
  request: WebSearchRequest,
): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  for (const raw of payload.results || []) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const title = cleanText(readString(record, "title") || "");
    const url = readString(record, "url");
    if (!title || !url || !isValidHttpUrl(url)) {
      continue;
    }
    if (!matchesDomainFilter(url, request.domainFilter)) {
      continue;
    }

    const content = readString(record, "content");
    const result: WebSearchResult = {
      title,
      url,
      snippet: cleanText(
        readString(record, "summary") || readString(record, "snippet") || "",
      ),
      year: parseResultYear(readString(record, "date")),
      venue: readString(record, "site_name"),
    };
    if (request.includeContent && content) {
      result.contentExcerpt = truncate(
        cleanText(content),
        CONTENT_EXCERPT_LENGTH,
      );
      result.contentType = "webpage_excerpt";
    }
    results.push(result);
    if (results.length >= request.maxResults) {
      break;
    }
  }
  return results;
}
