import type { WebSearchRequest, WebSearchResult } from "./WebSearchProvider";

export function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Appends seed_title / seed_doi / seed_paper_id into the provider's query
 * string so related-work and citation-oriented searches have the anchor
 * information available to the external search engine.
 */
export function buildSeedEnrichedQuery(request: WebSearchRequest): string {
  const parts: string[] = [request.query];
  if (request.intent === "related" && request.seedTitle) {
    parts.push(request.seedTitle);
  }
  if (request.seedDoi) {
    parts.push(request.seedDoi);
  }
  if (request.seedPaperId) {
    parts.push(request.seedPaperId);
  }
  return parts
    .map((value) => cleanText(value || ""))
    .filter(Boolean)
    .join(" ");
}

const EUROPE_PMC_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

interface EuropePmcConceptRule {
  pattern: RegExp;
  clause: string;
  consumeTokens: string[];
}

const EUROPE_PMC_CONCEPT_RULES: EuropePmcConceptRule[] = [
  {
    pattern:
      /\b(?:immune\s+)?checkpoint inhibitors?\b|\bcheckpoint inhibitors?\b/i,
    clause:
      '("checkpoint inhibitor" OR "checkpoint inhibitors" OR "immune checkpoint inhibitor" OR "immune checkpoint inhibitors" OR PD-1 OR PD-L1 OR CTLA-4)',
    consumeTokens: ["immune", "checkpoint", "inhibitor", "inhibitors"],
  },
  {
    pattern: /\bcancer immunotherap(?:y|ies)\b|\bimmunotherap(?:y|ies)\b/i,
    clause:
      '(immunotherapy OR immunotherapies OR "immune therapy" OR "cancer immunotherapy")',
    consumeTokens: [
      "cancer",
      "immune",
      "immunotherapy",
      "immunotherapies",
      "therapy",
    ],
  },
  {
    pattern: /\bcancers?\b|\btumou?rs?\b|\bneoplasms?\b/i,
    clause: "(cancer OR tumor OR tumour OR neoplasm*)",
    consumeTokens: ["cancer", "cancers", "tumor", "tumors", "tumour", "tumours"],
  },
];

export function buildEuropePmcQuery(query: string): string {
  const normalized = cleanText(query);
  if (!normalized) {
    return "";
  }

  if (/[()"]/g.test(normalized) || /\b(?:AND|OR|NOT)\b/.test(normalized)) {
    return normalized;
  }

  const lower = normalized.toLowerCase();
  const clauses: string[] = [];
  const consumedTokens = new Set<string>();

  for (const rule of EUROPE_PMC_CONCEPT_RULES) {
    if (!rule.pattern.test(lower)) {
      continue;
    }
    clauses.push(rule.clause);
    for (const token of rule.consumeTokens) {
      consumedTokens.add(token);
    }
  }

  if (clauses.length === 0) {
    return normalized;
  }

  const remainingTerms = normalized
    .split(/[^\p{L}\p{N}+-]+/u)
    .map((term) => cleanText(term))
    .filter((term) => {
      if (!term) {
        return false;
      }
      const lowerTerm = term.toLowerCase();
      return (
        term.length > 1 &&
        !EUROPE_PMC_STOPWORDS.has(lowerTerm) &&
        !consumedTokens.has(lowerTerm)
      );
    });

  const uniqueRemainingTerms = Array.from(new Set(remainingTerms));
  return [...uniqueRemainingTerms, ...clauses].join(" AND ");
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
