/**
 * MemoryStore - Per-library persistent memory for user preferences and facts
 *
 * Stores memories in the existing paper-chat/storage SQLite database (schema v4).
 * Facade over repository + search service for per-library user memories.
 */

import { getErrorMessage } from "../../../utils/common";
import { MemoryRepository } from "./MemoryRepository";
import { MemorySearchService } from "./MemorySearchService";
import type { Memory, MemoryCategory } from "./MemoryTypes";

export type { Memory, MemoryCategory } from "./MemoryTypes";

// ── Tunables ─────────────────────────────────────────────────────────────────

const MIN_LEN = 10;
const MAX_LEN = 500;
const MAX_MEMORIES = 500;

export class MemoryStore {
  // Guards concurrent save() calls: prevents two in-flight saves for the same
  // text from both passing isDuplicate() before either INSERT completes.
  private saveLock = new Set<string>();
  private repository: MemoryRepository;
  private searchService: MemorySearchService;

  constructor(private libraryId: number) {
    this.repository = new MemoryRepository(libraryId);
    this.searchService = new MemorySearchService(this.repository);
  }

  /**
   * Save a memory. Returns whether it was actually saved (dedup may skip it).
   */
  async save(
    text: string,
    category: MemoryCategory = "other",
    importance: number = 0.5,
  ): Promise<{ saved: boolean; reason?: string }> {
    const trimmed = text.trim();
    if (trimmed.length < MIN_LEN) return { saved: false, reason: "too short" };
    if (trimmed.length > MAX_LEN) return { saved: false, reason: "too long" };

    // Prevent TOCTOU: two concurrent saves with the same text both passing
    // isDuplicate() before either INSERT completes. The lock is synchronous so
    // there is no interleaving at this check.
    if (this.saveLock.has(trimmed)) return { saved: false, reason: "duplicate" };
    this.saveLock.add(trimmed);

    try {
      const { embedding, embeddingModel } =
        await this.searchService.createEmbedding(trimmed);

      if (await this.searchService.isDuplicate(trimmed, embedding)) {
        return { saved: false, reason: "duplicate" };
      }

      const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();

      await this.repository.insert({
        id,
        text: trimmed,
        category,
        importance: Math.max(0, Math.min(1, importance)),
        createdAt: now,
        lastAccessedAt: now,
        embedding,
        embeddingModel,
      });

      ztoolkit.log(
        `[MemoryStore] Saved: "${trimmed.slice(0, 60)}" (${category}, importance=${importance}, embedded=${!!embedding})`,
      );

      this.pruneIfNeeded().catch((err) => {
        ztoolkit.log("[MemoryStore] Prune failed:", getErrorMessage(err));
      });

      return { saved: true };
    } finally {
      this.saveLock.delete(trimmed);
    }
  }

  private async pruneIfNeeded(): Promise<void> {
    const count = await this.repository.count();
    if (count <= MAX_MEMORIES) return;

    const excess = count - MAX_MEMORIES;
    await this.repository.pruneOldestLowestImportance(excess);
    ztoolkit.log(`[MemoryStore] Pruned ${excess} memories (was ${count}, cap ${MAX_MEMORIES})`);
  }

  /**
   * Search for memories relevant to the given query.
   * Uses embedding cosine similarity when available, Jaccard fallback otherwise.
   * Returns up to MAX_INJECT results sorted by relevance score.
   */
  async search(query: string): Promise<Memory[]> {
    return this.searchService.search(query);
  }

  /** Delete a memory by ID */
  async delete(id: string): Promise<void> {
    await this.repository.delete(id);
  }

  /** List all memories for this library (newest first) */
  async listAll(): Promise<Memory[]> {
    return this.repository.listAll();
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

const memoryStores = new Map<number, MemoryStore>();

export function getMemoryStore(libraryId?: number): MemoryStore {
  const libId = libraryId ?? Zotero.Libraries.userLibraryID;
  if (!memoryStores.has(libId)) {
    memoryStores.set(libId, new MemoryStore(libId));
  }
  return memoryStores.get(libId)!;
}

export function destroyMemoryStores(): void {
  memoryStores.clear();
}
