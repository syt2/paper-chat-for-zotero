import type { ToolDefinition } from "../../../types/tool";
import {
  MODEL_VISIBLE_WEB_SEARCH_SOURCES,
  SCHOLARLY_SEARCH_INTENTS,
  SCHOLARLY_SEARCH_SOURCES,
  WEB_SEARCH_INTENTS,
} from "../../../types/tool";

export const SCHOLARLY_SEARCH_TOOL_NAME = "search_scholarly_sources";

export function createSearchToolDefinitions(): ToolDefinition[] {
  return [
    createGeneralWebSearchDefinition(),
    createScholarlySearchDefinition(),
  ];
}

function createGeneralWebSearchDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search external sources beyond the local Zotero library. On models without hosted web search this local tool supports scholarly sources and general websites. On hosted-search models PaperChat replaces it with the model vendor's web search, and search_scholarly_sources remains available for papers, citations, DOI, authors, and related-work discovery.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The search query. Be specific and include paper titles, topics, authors, organizations, dates, or claims to verify.",
          },
          source: {
            type: "string",
            enum: [...MODEL_VISIBLE_WEB_SEARCH_SOURCES],
            description:
              "Preferred local source selector. auto uses PaperChat's fallback routing; google_scholar and openalex target scholarly discovery, while bing and duckduckgo target general web pages. Hosted-search models use the vendor's routing instead.",
          },
          intent: {
            type: "string",
            enum: [...WEB_SEARCH_INTENTS],
            description:
              "Optional local routing intent. related and discover favor scholarly sources, biomedical favors biomedical literature, web favors general-web providers, and paper targets a known work. Hosted-search models may ignore this field.",
          },
          max_results: {
            type: "number",
            description:
              "Maximum number of local results to return (default: 5, max: 8). Hosted-search models may ignore this field.",
          },
          domain_filter: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional domains to keep in local search results, for example ['who.int', 'nature.com']. Hosted-search models may ignore this field.",
          },
          include_content: {
            type: "boolean",
            description:
              "Whether local search should fetch untrusted page excerpts for top results. Default: false. Hosted-search models may ignore this field.",
          },
          year_from: {
            type: "number",
            description:
              "Optional lower publication-year bound for local scholarly sources.",
          },
          year_to: {
            type: "number",
            description:
              "Optional upper publication-year bound for local scholarly sources.",
          },
          open_access_only: {
            type: "boolean",
            description:
              "For local scholarly sources, require structured open-access evidence when true.",
          },
          seed_title: {
            type: "string",
            description:
              "Optional seed-paper title for local related-work searches.",
          },
          seed_doi: {
            type: "string",
            description:
              "Optional seed DOI for local related-work or known-paper searches.",
          },
          seed_paper_id: {
            type: "string",
            description:
              "Optional source-specific paper ID from an earlier local search result.",
          },
        },
        required: ["query"],
      },
    },
  };
}

function createScholarlySearchDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: SCHOLARLY_SEARCH_TOOL_NAME,
      description:
        "Search scholarly sources outside Zotero using PaperChat's local Google Scholar and OpenAlex providers. Use this first for papers, authors, DOI, citation relationships, related work, literature discovery, publication-year filters, or open-access evidence. It never falls back to ordinary web providers. If it is unavailable or returns no useful results, use web_search only when general web evidence is acceptable.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The scholarly query. Include paper titles, topics, authors, DOI, or the claim whose academic evidence is needed.",
          },
          source: {
            type: "string",
            enum: [...SCHOLARLY_SEARCH_SOURCES],
            description:
              "Scholarly source selector. auto routes between Google Scholar and OpenAlex; google_scholar favors broad paper and citation-oriented lookup; openalex favors structured discovery, author, institution, and open-access metadata.",
          },
          intent: {
            type: "string",
            enum: [...SCHOLARLY_SEARCH_INTENTS],
            description:
              "Optional scholarly intent. paper targets a known work, related finds adjacent papers, discover broadens a topic, and biomedical prioritizes biomedical literature discovery.",
          },
          max_results: {
            type: "number",
            description:
              "Maximum number of results to return (default: 5, max: 8).",
          },
          year_from: {
            type: "number",
            description: "Optional lower publication-year bound.",
          },
          year_to: {
            type: "number",
            description: "Optional upper publication-year bound.",
          },
          open_access_only: {
            type: "boolean",
            description:
              "If true, require structured open-access evidence from the selected scholarly source.",
          },
          seed_title: {
            type: "string",
            description:
              "Optional seed-paper title for related-work or known-paper searches.",
          },
          seed_doi: {
            type: "string",
            description:
              "Optional seed DOI for related-work or known-paper searches.",
          },
          seed_paper_id: {
            type: "string",
            description:
              "Optional source-specific paper ID from an earlier scholarly result.",
          },
        },
        required: ["query"],
      },
    },
  };
}
