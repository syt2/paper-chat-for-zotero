/**
 * MemoryStore - Per-library persistent memory for user preferences and facts
 *
 * Stores memories in the existing paper-chat/storage SQLite database (schema v4).
 * Persistence + search facade for per-library user memories.
 * Retrieval/scoring helpers and embedding reindexing live in sibling modules.
 */

import { getStorageDatabase } from "../db/StorageDatabase";
import { getErrorMessage } from "../../../utils/common";
import { getMemoryEmbeddingProvider } from "./MemoryEmbedding";
import {
  embeddingSimilarity,
  jaccard,
  rowToMemory,
  scoreEmbedding,
  scoreJaccard,
  tokenise,
} from "./MemoryScoring";

export type MemoryCategory = "preference" | "decision" | "entity" | "fact" | "other";

export interface Memory {
  id: string;
  libraryId: number;
  text: string;
  category: MemoryCategory;
  importance: number; // 0.0 – 1.0
  createdAt: number;
  accessCount: number;
  lastAccessedAt: number;
  embedding?: number[];
  embeddingModel?: string;
}

// ── Tunables ─────────────────────────────────────────────────────────────────

const DEDUP_THRESHOLD = 0.9;          // Jaccard score to treat as duplicate
const EMBEDDING_DEDUP_THRESHOLD = 0.92; // Cosine similarity to treat as duplicate
const DEDUP_WINDOW = 80;              // Newest N memories checked for Jaccard dedup
const MAX_INJECT = 5;                 // Max memories injected per prompt
const MIN_SCORE = 0.25;               // Minimum relevance score to include in results
const MIN_LEN = 10;                   // Min character length for a memory
const MAX_LEN = 500;                  // Max character length for a memory
const SEARCH_FETCH_LIMIT = 300;       // Max rows loaded from DB for client-side scoring
const MAX_MEMORIES = 500;             // Hard cap per library; least-important pruned first
// ── MemoryStore ───────────────────────────────────────────────────────────────

export class MemoryStore {
  private libraryId: number;
  // Guards concurrent save() calls: prevents two in-flight saves for the same
  // text from both passing isDuplicate() before either INSERT completes.
  private saveLock = new Set<string>();

  constructor(libraryId: number) {
    this.libraryId = libraryId;
  }

  private async getDb() {
    return getStorageDatabase().ensureInit();
  }

  private async getEmbeddingProvider() {
    return getMemoryEmbeddingProvider();
  }

  // ── Deduplication ─────────────────────────────────────────────────────────

  private async isDuplicate(text: string, embedding?: number[]): Promise<boolean> {
    const db = await this.getDb();

    // Embedding-based dedup (preferred)
    if (embedding) {
      const rows = (await db.queryAsync(
        `SELECT embedding FROM memories WHERE library_id = ? AND embedding IS NOT NULL ORDER BY created_at DESC LIMIT ?`,
        [this.libraryId, DEDUP_WINDOW],
      )) || [];

      for (const row of rows as Array<{ embedding: string }>) {
        try {
          const vec = JSON.parse(row.embedding) as number[];
          if (embeddingSimilarity(embedding, vec) >= EMBEDDING_DEDUP_THRESHOLD) {
            return true;
          }
        } catch { /* ignore malformed */ }
      }
      return false;
    }

    // Jaccard fallback
    const rows = (await db.queryAsync(
      `SELECT text FROM memories WHERE library_id = ? ORDER BY created_at DESC LIMIT ?`,
      [this.libraryId, DEDUP_WINDOW],
    )) || [];

    const newTokens = tokenise(text);
    for (const row of rows as Array<{ text: string }>) {
      if (jaccard(newTokens, tokenise(row.text)) >= DEDUP_THRESHOLD) return true;
    }
    return false;
  }

  // ── Save ──────────────────────────────────────────────────────────────────

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
      // Try to generate embedding upfront so dedup can use it
      const provider = await this.getEmbeddingProvider();
      let embedding: number[] | undefined;
      if (provider) {
        try {
          embedding = await provider.embed(trimmed);
        } catch {
          // Fall back to Jaccard dedup and text-only persistence.
        }
      }

      if (await this.isDuplicate(trimmed, embedding)) {
        return { saved: false, reason: "duplicate" };
      }

      const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();
      const db = await this.getDb();

      await db.queryAsync(
        `INSERT INTO memories (id, library_id, text, category, importance, created_at, access_count, last_accessed_at, embedding, embedding_model)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [
          id,
          this.libraryId,
          trimmed,
          category,
          Math.max(0, Math.min(1, importance)),
          now,
          now,
          embedding ? JSON.stringify(embedding) : null,
          embedding && provider ? provider.modelId : null,
        ],
      );

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

  // ── Prune ─────────────────────────────────────────────────────────────────

  private async pruneIfNeeded(): Promise<void> {
    const db = await this.getDb();
    const countRows = (await db.queryAsync(
      "SELECT COUNT(*) as cnt FROM memories WHERE library_id = ?",
      [this.libraryId],
    )) || [];
    const count = (countRows[0]?.cnt as number) ?? 0;
    if (count <= MAX_MEMORIES) return;

    const excess = count - MAX_MEMORIES;
    await db.queryAsync(
      `DELETE FROM memories WHERE id IN (
         SELECT id FROM memories WHERE library_id = ?
         ORDER BY importance ASC, last_accessed_at ASC
         LIMIT ?
       )`,
      [this.libraryId, excess],
    );
    ztoolkit.log(`[MemoryStore] Pruned ${excess} memories (was ${count}, cap ${MAX_MEMORIES})`);
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /**
   * Search for memories relevant to the given query.
   * Uses embedding cosine similarity when available, Jaccard fallback otherwise.
   * Returns up to MAX_INJECT results sorted by relevance score.
   */
  async search(query: string): Promise<Memory[]> {
    if (!query.trim()) return [];

    const db = await this.getDb();
    const rows = (await db.queryAsync(
      `SELECT id, library_id, text, category, importance, created_at, access_count, last_accessed_at, embedding, embedding_model
       FROM memories WHERE library_id = ? ORDER BY created_at DESC LIMIT ?`,
      [this.libraryId, SEARCH_FETCH_LIMIT],
    )) || [];

    if (rows.length === 0) return [];

    // Try embedding-based search
    const provider = await this.getEmbeddingProvider();
    let queryEmbedding: number[] | undefined;
    if (provider) {
      try { queryEmbedding = await provider.embed(query); } catch { /* fall back */ }
    }

    const now = Date.now();
    const queryTokens = tokenise(query);

    const scored = (rows as Array<Record<string, unknown>>).map((row) => {
      const mem = rowToMemory(row);

      let score: number;
      if (queryEmbedding && mem.embedding && mem.embedding.length === queryEmbedding.length) {
        try {
          const cosine = embeddingSimilarity(queryEmbedding, mem.embedding);
          score = scoreEmbedding(cosine, mem, now);
        } catch {
          score = scoreJaccard(mem, queryTokens, query, now);
        }
      } else {
        score = scoreJaccard(mem, queryTokens, query, now);
      }

      return { mem, score };
    });

    const top = scored
      .filter((x) => x.score > MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_INJECT)
      .map((x) => x.mem);

    if (top.length > 0) {
      this.updateAccessStats(top.map((m) => m.id), now).catch((err) => {
        ztoolkit.log("[MemoryStore] Failed to update access stats:", getErrorMessage(err));
      });
    }

    return top;
  }

  private async updateAccessStats(ids: string[], now: number): Promise<void> {
    if (ids.length === 0) return;
    const db = await this.getDb();
    const placeholders = ids.map(() => "?").join(", ");
    await db.queryAsync(
      `UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id IN (${placeholders})`,
      [now, ...ids],
    );
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /** Delete a memory by ID */
  async delete(id: string): Promise<void> {
    const db = await this.getDb();
    await db.queryAsync(
      `DELETE FROM memories WHERE id = ? AND library_id = ?`,
      [id, this.libraryId],
    );
  }

  /** List all memories for this library (newest first) */
  async listAll(): Promise<Memory[]> {
    const db = await this.getDb();
    const rows = (await db.queryAsync(
      `SELECT id, library_id, text, category, importance, created_at, access_count, last_accessed_at, embedding, embedding_model
       FROM memories WHERE library_id = ? ORDER BY created_at DESC`,
      [this.libraryId],
    )) || [];
    return (rows as Array<Record<string, unknown>>).map(rowToMemory);
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
