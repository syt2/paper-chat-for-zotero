# Memory Module

This module stores durable user preferences/facts and injects the most relevant
items back into chat prompts.

## Layers

- `MemoryRepository` / `MemorySearchService` / `MemoryStore`
  - Persistence, dedup, search, and pruning.
- `MemoryService`
  - Application-facing facade for save/search/prompt-context operations.
- `MemoryExtractionPrompt` / `MemoryExtractionParser`
  - Pure helpers for extraction input building and response normalization.
- `MemoryExtractor`
  - Provider adapter that turns chat history into normalized memory entries.
- `MemoryOrchestrator`
  - Extraction scheduling, save flow, and session extraction-state updates.
- `MemoryManager`
  - High-level entry point used by `ChatManager`.

## Dependency Direction

- `ChatManager` -> `MemoryManager`
- `MemoryManager` -> `MemoryOrchestrator`, `MemoryService`, `MemoryExtractor`
- `MemoryOrchestrator` -> `MemoryExtractor`, `MemoryService`
- `MemoryExtractor` -> prompt/parser helpers + provider adapter
- `MemoryService` -> `MemoryStore`
- `MemoryStore` -> repository/search service

The goal is to keep provider access, extraction parsing, scheduling, and
storage concerns isolated so each layer can evolve and be tested separately.
