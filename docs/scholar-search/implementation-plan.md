# Scholar Search Implementation Plan

## Goal

Prepare the codebase to support academic-first external search with:

- unified tool schema
- provider routing
- result normalization
- fallback and dedupe
- prompt guidance for source selection

## Phase 0: Alignment And Doc Freeze

Deliverables:

- `design.md`
- `provider-mapping.md`
- `implementation-plan.md`

Exit criteria:

- tool name is agreed
- source list is agreed
- `auto` routing policy is agreed

## Phase 1: Internal API Skeleton

### Work

- create `src/modules/chat/web-search/ScholarSearchService.ts`
- create `src/modules/chat/web-search/ScholarSearchRegistry.ts`
- add provider interface for scholarly providers
- add unified `ScholarlyResult` normalization types
- keep DuckDuckGo wired through the new registry

### Deliverables

- shared provider contract
- request normalization
- response normalization
- source enum and intent enum

### Notes

- do not change user-facing behavior yet beyond internal plumbing
- keep existing `web_search` behavior working during migration

## Phase 2: OpenAlex Provider

### Why First

- strongest broad-discovery provider
- supports topic, author, institution, and semantic work search
- likely to become the backbone for `discover`

### Work

- implement `OpenAlexProvider`
- support `discover`, `lookup`, and `author`
- normalize works results
- add simple routing support for `source=openalex`

### Tests

- query normalization
- result normalization
- zero-result behavior
- provider failure surfacing

## Phase 3: Semantic Scholar Provider

### Why Second

- strongest provider for `related` workflows
- recommendations unlock "find similar papers" behavior

### Work

- implement `SemanticScholarProvider`
- support paper search
- support recommendation flow from a seed paper
- handle `seed_paper_id`, `seed_title`, and `seed_doi`

### Tests

- recommendation bootstrap from seed fields
- search result normalization
- related-work routing

## Phase 4: Europe PMC Provider

### Why Third

- domain-specific provider for biomedical content
- should not complicate the earlier general academic path

### Work

- implement `EuropePmcProvider`
- support `discover` and `lookup`
- add biomedical query heuristic to `auto` routing

### Tests

- biomedical query detection
- result normalization
- fallback when no biomedical hits are returned

## Phase 5: Unified Routing And Fallback

### Work

- implement `routing.ts`
- implement source fallback chains
- add notes for fallback decisions
- make `source=auto` deterministic

### Default Chains

- `discover`
  `openalex -> semantic_scholar -> duckduckgo`
- `related`
  `semantic_scholar -> openalex -> duckduckgo`
- biomedical `discover`
  `europe_pmc -> openalex -> semantic_scholar -> duckduckgo`
- `web`
  `duckduckgo`

### Tests

- route selection by intent
- route selection by biomedical heuristics
- fallback after transport failure
- fallback after zero results

## Phase 6: Dedupe And Merge

### Work

- implement `dedupe.ts`
- merge duplicates by DOI first
- title plus year fallback when DOI is missing
- preserve contributing sources

### Tests

- DOI dedupe
- title dedupe
- metadata merge precedence

## Phase 7: Prompt And Tool Description Integration

### Work

- update tool description to include source suitability guidance
- update prompt generation so the model prefers scholarly sources over general web search
- instruct the agent to use `auto` when unsure

### Tests

- prompt snapshot tests
- tool schema snapshot tests

## Phase 8: Permission, Budget, And Compatibility

### Work

- ensure scholarly search remains a `network` tool
- reuse existing permission prompts
- decide whether all scholarly sources share the same budget as current `web_search`
- keep compatibility alias if existing code still calls `web_search`

### Tests

- approval flow
- network budget interactions
- compatibility behavior

## Phase 9: Documentation And Examples

### Work

- add developer docs for provider behavior
- add examples of correct agent usage
- document fallback rules and provider strengths

## Proposed Code Layout

```text
src/modules/chat/web-search/
  ScholarSearchService.ts
  ScholarSearchRegistry.ts
  routing.ts
  normalize.ts
  dedupe.ts
  index.ts
  providers/
    DuckDuckGoProvider.ts
    OpenAlexProvider.ts
    SemanticScholarProvider.ts
    EuropePmcProvider.ts
    CrossrefProvider.ts
```

## Suggested Milestones

### Milestone A

- schema
- service skeleton
- registry
- OpenAlex provider

### Milestone B

- Semantic Scholar provider
- related-paper flow
- routing for `auto`

### Milestone C

- Europe PMC provider
- biomedical routing
- dedupe merge

### Milestone D

- prompt integration
- compatibility layer
- tests and docs

## Open Implementation Questions

- Keep the old tool name `web_search` or switch fully to `scholar_search`?
- Allow the model to request multiple sources in one call, or keep one routed source per call?
- Return merged multi-source results in phase 1, or only return the primary routed source plus fallback notes?
- Add provider-specific caching in phase 1, or defer it?

## Definition Of Done

The feature is ready when:

- the agent can request academic-first search with `source=auto`
- the routing layer selects an appropriate source deterministically
- results are normalized into one schema
- source suitability guidance is visible to the model
- DuckDuckGo is clearly a fallback, not the primary academic source
- tests cover routing, normalization, dedupe, and provider failure
