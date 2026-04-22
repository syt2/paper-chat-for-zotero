# Scholar Search Design

## Goal

Replace the current single-source web search path with an academic-first search layer that helps the agent discover, expand, and verify papers more reliably than DuckDuckGo alone.

Phase 1 sources:

- `semantic_scholar`
- `openalex`
- `europe_pmc`
- `duckduckgo`
- `crossref` reserved in the schema for later implementation

## Non-Goals

- Full citation graph analytics UI
- User-facing source configuration UI in the first phase
- Query-time learning-to-rank or ML rerank
- Automatic background crawling or indexing of external sources

## Core Decisions

1. Keep one unified tool entry instead of exposing many source-specific tools.
2. Prefer `scholar_search` as the internal tool name. Existing `web_search` can later become a compatibility alias if needed.
3. Support a `source` parameter, but default to `source="auto"`.
4. Let the model express intent; let the tool layer decide routing and fallback.
5. Include source suitability guidance directly in the tool description so the model knows when to use each source.
6. Treat `duckduckgo` as a fallback for general web content, not as the primary academic search source.

## Tool Interface

```ts
type SearchSource =
  | "auto"
  | "semantic_scholar"
  | "openalex"
  | "europe_pmc"
  | "duckduckgo"
  | "crossref";

type SearchIntent =
  | "discover"
  | "related"
  | "lookup"
  | "author"
  | "citation"
  | "web";

interface ScholarSearchArgs {
  query: string;
  source?: SearchSource;
  intent?: SearchIntent;
  max_results?: number;
  year_from?: number;
  year_to?: number;
  open_access_only?: boolean;
  seed_title?: string;
  seed_doi?: string;
  seed_paper_id?: string;
}
```

## Source Guidance For The Agent

The tool description should explicitly tell the model:

- `auto`
  Use when the model is unsure which source is best. The tool layer will route the request.
- `semantic_scholar`
  Best for related work, similar papers, recommendation-style expansion, and citation-neighborhood exploration.
- `openalex`
  Best for broad scholarly discovery, author or institution search, topic exploration, and semantic work search.
- `europe_pmc`
  Best for biomedical and life-science topics including disease, drugs, genes, proteins, and clinical questions.
- `duckduckgo`
  Best for general web pages such as GitHub, project homepages, blogs, documentation, institutions, and news.
- `crossref`
  Best for DOI, title, journal, and publication metadata verification. Not intended for semantic discovery.

## Routing Rules

When `source=auto`, route by intent and domain:

- `intent=related`
  First `semantic_scholar`, then `openalex`
- `intent=discover`
  First `openalex`, then `semantic_scholar`
- `intent=author`
  First `openalex`
- `intent=lookup`
  First `openalex` or `semantic_scholar`
  Later optionally validate with `crossref`
- `intent=web`
  Directly `duckduckgo`
- Biomedical queries
  Prefer `europe_pmc` before general scholarly sources
- If academic sources fail or return low-signal results
  Fall back to `duckduckgo`

## Query Classification Heuristics

The routing layer should infer likely biomedical intent when the query contains signals such as:

- disease names
- drug names
- gene or protein names
- clinical trial terms
- biomedical keywords like `cohort`, `tumor`, `pathway`, `therapeutic`, `patient`, `biomarker`

The router should infer `intent=related` when the query or tool-call context indicates:

- "related work"
- "similar papers"
- "papers like this"
- "what else should I read"
- a seed DOI or a seed paper title is provided

## Response Shape

All providers should normalize into one structure before returning to the model.

```ts
interface ScholarlyResult {
  source: string;
  id?: string;
  title: string;
  url?: string;
  abstract?: string;
  year?: number;
  authors?: string[];
  venue?: string;
  doi?: string;
  citation_count?: number;
  relevance_score?: number;
  related_reason?: string;
}

interface ScholarSearchResponse {
  query: string;
  source_used: string;
  intent?: string;
  results: ScholarlyResult[];
  notes?: string[];
}
```

## Normalization Rules

- Preserve provider-native IDs when available.
- Prefer DOI as the primary dedupe key.
- If DOI is missing, dedupe by normalized title plus year when possible.
- Keep provider-specific relevance scores if present, but do not assume they are comparable across providers.
- Include source in every result so the model can cite where the hit came from.

## Dedupe And Merge Strategy

Phase 1 should use a simple deterministic strategy:

1. Canonicalize DOI if present.
2. Normalize title by lowercasing, trimming, collapsing whitespace, and stripping punctuation where reasonable.
3. Merge duplicate hits across providers.
4. Prefer richer metadata in this order:
   `openalex` > `semantic_scholar` > `europe_pmc` > `duckduckgo`
5. Preserve all source names that contributed to a merged hit.

## Fallback Policy

- If the requested source errors, return a clear provider-level note.
- If `source=auto`, try the next source in the routing chain.
- If a provider returns zero results, that is not an error; continue to the next source when routing allows it.
- If all routed providers fail, return a structured error summary instead of a plain transport error.

## Tool Budget Expectations

Scholar search should remain a network-risk tool.

Expected policy:

- `network` permission still applies
- repeated equivalent queries in the same turn should be blocked or deduped
- `duckduckgo` and academic providers should share the same top-level network budget unless later split

## Prompt Integration

The system prompt should explicitly instruct the model to:

- prefer academic sources over general web search for paper discovery
- use `semantic_scholar` for related-work expansion
- use `openalex` for broad discovery and author or institution lookup
- use `europe_pmc` first for biomedical topics
- use `duckduckgo` only when scholarly sources are insufficient or the user clearly asks for general web content
- use `crossref` for metadata verification, not semantic discovery

## Open Questions

- Should `scholar_search` replace `web_search`, or should both coexist temporarily?
- Should source selection remain invisible to the user, or should the final answer mention which scholarly source was used?
- Do we want a second tool later for citation graph traversal, separate from general scholarly search?
- Should biomedical detection be purely heuristic in phase 1, or should the model be allowed to force `europe_pmc` explicitly whenever it wants?
