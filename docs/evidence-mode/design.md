# Evidence Mode: Trusted Inline Citations

## Goal

Ground assistant claims in exact passages returned by completed PaperChat
tools. The first vertical slice covers `search_paper_content` and renders
trusted inline citations that survive persistence, reload, and conversation
forking.

## Non-goals for the first slice

- Library-wide indexing or collection search
- Claim entailment verification
- Evidence matrices
- Treating model-authored item keys, page numbers, URLs, or evidence IDs as
  trusted provenance

## Trust boundary

The executor owns passage extraction and emits a fixed-position evidence
manifest containing result indexes and content hashes. The scheduler combines
that manifest with source identities already validated by
`SourceReferenceExtractor` and derives `EvidenceRecord` objects before artifact
compaction.

The model receives opaque evidence IDs and may place them only in the canonical
form:

```text
<evidence-ref ids="ev-0123456789abcdef"/>
```

Before a message is persisted or rendered, PaperChat removes unknown IDs and
canonicalizes known ones. The renderer never derives navigation targets from
the model-authored tag; it resolves the ID against the records persisted with
the assistant message.

## Data lifecycle

1. `search_paper_content` returns passage blocks plus a versioned evidence
   manifest.
2. `ToolScheduler` derives trusted records from the raw result before optional
   artifact compaction.
3. The agent runtime appends a compact citation catalog to the tool message sent
   to the model.
4. Final assistant content is sanitized against the turn's trusted records.
5. Only records actually referenced by the sanitized answer are copied onto the
   assistant `ChatMessage`.
6. The message row stores the records as JSON. Reload and session fork preserve
   them; fork cloning deep-copies the records.
7. The Markdown renderer resolves each inline tag from the message-local
   records and renders a citation control with an evidence preview and a
   trusted PDF navigation action.

## Evidence identity

Evidence IDs are deterministic hashes of the source type, Zotero library and
item identity, location metadata, and normalized quote hash. Tool-call IDs and
display result indexes are deliberately excluded so the same passage keeps the
same identity across retries. Stored records are normalized and their IDs and
content hashes are recomputed on load; malformed or tampered records are
dropped.

## Compatibility

- Existing `source-group` rendering and provenance checks remain unchanged.
- Messages without evidence records follow the old render and persistence path.
- Streaming content has no active evidence actions. Trusted citations become
  interactive only after the final message checkpoint.
- Old databases receive an additive nullable `messages.evidence` column.

## Required tests

- Executor manifest generation for semantic and keyword fallback results
- Scheduler extraction before artifact compaction
- Rejection of forged source keys, pages, result blocks, hashes, and IDs
- Message persistence and malformed stored JSON handling
- Conversation fork deep-copy behavior
- Inline render/copy behavior and click navigation callback
- Existing source-group, search projection, and agent runtime regression suites
