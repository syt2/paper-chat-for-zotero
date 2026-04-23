# Scholar Search Provider Mapping

## Purpose

This document maps each planned provider to:

- the main endpoints we will use
- supported intents
- parameter translation rules
- normalized output fields
- expected limitations

## Shared Internal Model

All providers should produce `ScholarlyResult` objects with these preferred fields:

- `source`
- `id`
- `title`
- `url`
- `abstract`
- `year`
- `authors`
- `venue`
- `doi`
- `citation_count`
- `relevance_score`
- `related_reason`

## Semantic Scholar

### Best For

- related work
- similar papers
- recommendation expansion from a seed paper
- citation-neighborhood exploration

### Phase 1 Endpoints

- paper search
- paper recommendations

### Intents

- `discover`
- `related`
- `lookup`
- optional later: `citation`

### Input Mapping

- `query`
  map to paper search query
- `max_results`
  clamp to provider-safe limit
- `seed_paper_id`
  preferred for recommendations if already available
- `seed_doi` or `seed_title`
  first resolve to a paper, then request recommendations

### Output Mapping

- provider paper ID -> `id`
- title -> `title`
- abstract -> `abstract`
- year -> `year`
- authors -> `authors`
- venue -> `venue`
- DOI if present -> `doi`
- citation counts if present -> `citation_count`
- recommendation context -> `related_reason`

### Notes

- This should be the first-choice provider for `intent=related`.
- Recommendation expansion is the key differentiator.
- Some result sets may not include all metadata fields uniformly.

### Official References

- https://www.semanticscholar.org/product/api
- https://www.semanticscholar.org/product/api/tutorial

## OpenAlex

### Best For

- broad scholarly discovery
- topic search
- author search
- institution search
- semantic similar-work search

### Phase 1 Endpoints

- `works` search
- `find/works`

### Intents

- `discover`
- `related`
- `lookup`
- `author`
- optional later: `citation`

### Input Mapping

- `query`
  map to work search or semantic search query
- `year_from` and `year_to`
  translate to publication-year filters where available
- `open_access_only`
  map to OA filters later if needed
- `seed_title`
  useful for semantic search bootstrap
- `seed_doi`
  useful when known

### Output Mapping

- OpenAlex work ID -> `id`
- display name -> `title`
- primary location or landing page -> `url`
- abstract reconstruction if available -> `abstract`
- publication year -> `year`
- authorships -> `authors`
- host venue -> `venue`
- DOI -> `doi`
- cited-by count -> `citation_count`
- relevance score if available -> `relevance_score`

### Notes

- This should be the first-choice provider for `intent=discover`.
- It is also the best early provider for `intent=author`.
- Phase 1 should keep the mapping focused on works, not the full entity graph.

### Official References

- https://developers.openalex.org/api-reference/works
- https://developers.openalex.org/guides/searching

## Europe PMC

### Best For

- biomedical and life-science queries
- literature discovery in medicine and biology
- article lookup with domain-specific relevance

### Phase 1 Endpoints

- search endpoint

### Intents

- `discover`
- `lookup`
- optional later: `citation`

### Input Mapping

- `query`
  pass through using Europe PMC search syntax
- `max_results`
  clamp to a small first-page default
- `year_from` and `year_to`
  map to year constraints if needed
- `open_access_only`
  later map to appropriate availability filters

### Output Mapping

- source-specific article ID -> `id`
- title -> `title`
- abstract text if returned -> `abstract`
- publication year -> `year`
- author string or author list -> `authors`
- journal title -> `venue`
- DOI -> `doi`
- landing page URL -> `url`
- citation metadata if available -> `citation_count`

### Notes

- This should be the default domain-specific source for biomedical topics.
- It is not intended to replace broad discovery sources for non-biomedical fields.
- Query syntax is powerful; phase 1 should keep the integration simple and conservative.

### Official References

- https://europepmc.org/RestfulWebService
- https://europepmc.org/help
- https://dev.europepmc.org/searchsyntax

## DuckDuckGo

### Best For

- project homepages
- GitHub repositories
- blog posts
- documentation
- institutions and labs
- non-scholarly web results

### Existing Endpoint Style

- current HTML search scraping path already implemented in the repo

### Intents

- `web`
- fallback for failed scholarly discovery

### Input Mapping

- `query`
  use current web search formatting
- `max_results`
  continue using current cap behavior
- `domain_filter`
  keep existing support if still useful

### Output Mapping

- result title -> `title`
- result URL -> `url`
- snippet or extracted content -> `abstract` or leave in notes
- source -> always `duckduckgo`

### Notes

- Keep as the last academic fallback, not the first.
- Continue marking webpage content as untrusted text.

## Crossref

### Best For

- DOI verification
- title verification
- journal and publication metadata

### Phase 1 Status

- reserved in schema
- not implemented in phase 1

### Future Endpoints

- works lookup
- bibliographic query search

### Notes

- This is a metadata-verification source, not a semantic discovery source.

### Official Reference

- https://www.crossref.org/documentation/retrieve-metadata/rest-api/

## Parameter Translation Policy

Phase 1 should keep translation simple:

- ignore unsupported filters rather than forcing lossy mappings
- log normalized requests for debugging
- never pass provider-specific syntax directly from the model
- sanitize all provider-facing query strings in the service layer

## Scoring Policy

Phase 1 should not attempt a universal score calibration.

- preserve provider-native relevance signals when available
- do not compare those scores numerically across providers
- use routing order and dedupe merge order instead of cross-provider score math

## Rate Limit And Failure Handling

Each provider wrapper should surface:

- transport errors
- empty result sets
- provider throttling
- malformed responses

The unified search service should decide whether to:

- retry
- fall back
- or return partial results with notes
