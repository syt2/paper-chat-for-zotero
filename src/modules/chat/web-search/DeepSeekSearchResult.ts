import type { WebSearchRequest, WebSearchResult } from "./WebSearchProvider";
import {
  buildSeedEnrichedQuery,
  cleanText,
  matchesDomainFilter,
  truncate,
} from "./WebSearchUtils";

const MAX_QUERY_CHARACTERS = 128;
const MAX_ORIGINAL_QUESTION_CHARACTERS = 128;
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

/**
 * DeepSeek accepts ori_question only as a short 1-128 character hint. The
 * latest user turn can be much longer, so keep a compact, whitespace-normalized
 * prefix instead of sending an invalid request that would fall back to Bing.
 */
export function normalizeDeepSeekOriginalQuestion(
  value?: string,
): string | undefined {
  const normalized = cleanText(value || "");
  if (!normalized) {
    return undefined;
  }
  return truncateUnicode(normalized, MAX_ORIGINAL_QUESTION_CHARACTERS);
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
  if (
    request.language &&
    /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(request.language)
  ) {
    filters.push(`lang:${request.language}`);
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

function readScore(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, value));
}

function readInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
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

    const summary = cleanText(
      readString(record, "summary") || readString(record, "snippet") || "",
    );
    const content = readString(record, "content");
    const rerankScore = readScore(record, "rerank_score", 0, 3);
    const authority = readInteger(record, "authority");
    const result: WebSearchResult = {
      title,
      url,
      snippet: summary,
      ...(summary ? { summary } : {}),
      ...(rerankScore !== undefined ? { rerankScore } : {}),
      ...(authority !== undefined && authority >= -1 && authority <= 4
        ? { authority }
        : {}),
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
  }

  // DeepSeek already returns a ranked list, but keep the contract explicit:
  // stable-sort by rerank_score, using authority only when both scores are
  // known and the relevance scores are tied. Results without a score follow
  // scored results while preserving their own relative order.
  return results
    .map((result, index) => ({ result, index }))
    .sort((left, right) => {
      const leftScore = left.result.rerankScore;
      const rightScore = right.result.rerankScore;
      if (leftScore !== undefined && rightScore === undefined) {
        return -1;
      }
      if (leftScore === undefined && rightScore !== undefined) {
        return 1;
      }
      if (
        leftScore !== undefined &&
        rightScore !== undefined &&
        leftScore !== rightScore
      ) {
        return rightScore - leftScore;
      }
      const leftAuthority = left.result.authority;
      const rightAuthority = right.result.authority;
      if (
        leftScore !== undefined &&
        rightScore !== undefined &&
        leftAuthority !== undefined &&
        rightAuthority !== undefined &&
        leftAuthority >= 0 &&
        rightAuthority >= 0 &&
        leftAuthority !== rightAuthority
      ) {
        return rightAuthority - leftAuthority;
      }
      return left.index - right.index;
    })
    .slice(0, request.maxResults)
    .map(({ result }) => result);
}
