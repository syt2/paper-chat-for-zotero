import { normalizeSearchValue } from "./SearchProjection";
import { ChatHistorySearchError } from "./SearchTypes";

export interface ParsedSearchQuery {
  rawQuery: string;
  normalizedQuery: string;
  exactPhrase: string;
  terms: string[];
}

export const MAX_SEARCH_QUERY_CODE_POINTS = 512;
export const MAX_SEARCH_QUERY_TERMS = 32;
// HTML maxlength and String#length both count UTF-16 code units. Keep this
// deliberately above the normalized semantic limit so ordinary compatibility
// characters and surrogate pairs reach the canonical 512-code-point check.
export const MAX_SEARCH_QUERY_RAW_UTF16_LENGTH = 4096;

export function parseSearchQuery(rawQuery: string): ParsedSearchQuery {
  if (rawQuery.length > MAX_SEARCH_QUERY_RAW_UTF16_LENGTH) {
    throw new ChatHistorySearchError(
      "QUERY_TOO_LONG",
      `Search input is limited to ${MAX_SEARCH_QUERY_RAW_UTF16_LENGTH} UTF-16 code units`,
    );
  }
  const normalizedQuery = normalizeSearchValue(rawQuery);
  const codePointLength = Array.from(normalizedQuery).length;
  if (codePointLength < 2) {
    throw new ChatHistorySearchError(
      "QUERY_TOO_SHORT",
      "Search requires at least two normalized code points",
    );
  }
  if (codePointLength > MAX_SEARCH_QUERY_CODE_POINTS) {
    throw new ChatHistorySearchError(
      "QUERY_TOO_LONG",
      `Search is limited to ${MAX_SEARCH_QUERY_CODE_POINTS} normalized code points`,
    );
  }
  const terms = [...new Set(normalizedQuery.split(" ").filter(Boolean))];
  if (terms.length > MAX_SEARCH_QUERY_TERMS) {
    throw new ChatHistorySearchError(
      "QUERY_TOO_LONG",
      `Search is limited to ${MAX_SEARCH_QUERY_TERMS} distinct terms`,
    );
  }
  return {
    rawQuery,
    normalizedQuery,
    exactPhrase: normalizedQuery,
    terms,
  };
}

export function classifyTitleMatch(
  normalizedTitle: string,
  exactPhrase: string,
): "exact" | "prefix" | "contains" | null {
  if (!normalizedTitle || !exactPhrase) return null;
  if (normalizedTitle === exactPhrase) return "exact";
  if (normalizedTitle.startsWith(exactPhrase)) return "prefix";
  if (normalizedTitle.includes(exactPhrase)) return "contains";
  return null;
}

export function classifyMessageMatch(
  normalizedText: string,
  query: Pick<ParsedSearchQuery, "exactPhrase" | "terms">,
): 0 | 1 | null {
  if (!normalizedText) return null;
  if (normalizedText.includes(query.exactPhrase)) return 0;
  return query.terms.every((term) => normalizedText.includes(term)) ? 1 : null;
}

export function getSessionSearchCategory(
  titleMatchKind: "exact" | "prefix" | "contains" | null | undefined,
  bestMessageCategory: 0 | 1 | null | undefined,
): 0 | 1 | 2 | 3 | null {
  if (titleMatchKind === "exact") return 0;
  if (titleMatchKind === "prefix" || titleMatchKind === "contains") return 1;
  if (bestMessageCategory === 0) return 2;
  if (bestMessageCategory === 1) return 3;
  return null;
}
