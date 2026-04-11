/**
 * MemoryStore - Per-library persistent memory for user preferences and facts
 *
 * Stores memories in the existing paper-chat/storage SQLite database (schema v4).
 * Supports two retrieval modes:
 *   - Embedding-based (cosine similarity) when an embedding provider is available
 *   - Jaccard token-overlap fallback when no provider is configured
 *
 * Model change detection: when the active embedding model changes, all stored
 * embeddings are invalidated and a background reindex job re-embeds everything.
 */

import { getStorageDatabase } from "../db/StorageDatabase";
import { getEmbeddingProviderFactory } from "../../embedding/EmbeddingProviderFactory";
import { cosineSimilarity } from "../../embedding/utils/cosine";
import { getErrorMessage } from "../../../utils/common";

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
const REINDEX_BATCH_SIZE = 20;        // Memories embedded per batch during reindex

// Jaccard scoring weights — must sum to ≤1.0 so scores are comparable with
// the embedding path (which also maxes at 1.0) during the mixed-mode window.
const W_JACCARD = 0.50;
const W_CONTAINS = 0.25;
const W_RECENCY = 0.15;
const W_IMPORTANCE = 0.10;

// Embedding scoring weights (recency+importance as secondary factors only)
const W_COSINE = 0.70;
const WE_RECENCY = 0.15;
const WE_IMPORTANCE = 0.15;

// Settings key prefix for tracking active embedding model (one key per library)
const SETTING_EMBEDDING_MODEL_PREFIX = "memory_embedding_model_";

// ── Utilities ─────────────────────────────────────────────────────────────────

function tokenise(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/\w+/g) || []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

function scoreJaccard(mem: Memory, queryTokens: Set<string>, queryRaw: string, now: number): number {
  const memTokens = tokenise(mem.text);
  const jaccardScore = jaccard(queryTokens, memTokens);
  const containsBoost = mem.text.toLowerCase().includes(queryRaw.toLowerCase()) ? 1.0 : 0.0;
  const ageDays = (now - mem.createdAt) / (1000 * 86400);
  const recencyScore = Math.exp(-ageDays / 30);
  return W_JACCARD * jaccardScore + W_CONTAINS * containsBoost + W_RECENCY * recencyScore + W_IMPORTANCE * mem.importance;
}

function scoreEmbedding(cosine: number, mem: Memory, now: number): number {
  const ageDays = (now - mem.createdAt) / (1000 * 86400);
  const recencyScore = Math.exp(-ageDays / 30);
  return W_COSINE * cosine + WE_RECENCY * recencyScore + WE_IMPORTANCE * mem.importance;
}

function rowToMemory(row: Record<string, unknown>): Memory {
  const mem: Memory = {
    id: row.id as string,
    libraryId: row.library_id as number,
    text: row.text as string,
    category: row.category as MemoryCategory,
    importance: row.importance as number,
    createdAt: row.created_at as number,
    accessCount: row.access_count as number,
    lastAccessedAt: row.last_accessed_at as number,
  };
  if (row.embedding) {
    try { mem.embedding = JSON.parse(row.embedding as string); } catch { /* ignore */ }
  }
  if (row.embedding_model) {
    mem.embeddingModel = row.embedding_model as string;
  }
  return mem;
}

// ── MemoryStore ───────────────────────────────────────────────────────────────

export class MemoryStore {
  private libraryId: number;
  // Guards concurrent save() calls: prevents two in-flight saves for the same
  // text from both passing isDuplicate() before either INSERT completes.
  private saveLock = new Set<string>();

  private get embeddingModelKey(): string {
    return `${SETTING_EMBEDDING_MODEL_PREFIX}${this.libraryId}`;
  }

  constructor(libraryId: number) {
    this.libraryId = libraryId;
  }

  private async getDb() {
    return getStorageDatabase().ensureInit();
  }

  // ── Embedding helpers ─────────────────────────────────────────────────────

  private async getEmbeddingProvider() {
    try {
      return await getEmbeddingProviderFactory().getProvider();
    } catch {
      return null;
    }
  }

  /**
   * On startup: detect if the embedding model has changed.
   * If so, invalidate all stored embeddings and trigger background reindex.
   * If model unchanged, only reindex memories that are missing embeddings.
   */
  async checkAndReindex(): Promise<void> {
    const provider = await this.getEmbeddingProvider();
    if (!provider) return;

    const db = await this.getDb();
    const rows = (await db.queryAsync(
      "SELECT value FROM settings WHERE key = ?",
      [this.embeddingModelKey],
    )) || [];
    const storedModel: string | null = rows.length > 0 ? (rows[0].value as string) : null;
    const currentModel = provider.modelId;

    if (storedModel !== currentModel) {
      // Model changed — invalidate all embeddings for this library
      ztoolkit.log(`[MemoryStore] Embedding model changed (${storedModel} → ${currentModel}), reindexing...`);
      await db.queryAsync(
        "UPDATE memories SET embedding = NULL, embedding_model = NULL WHERE library_id = ?",
        [this.libraryId],
      );
      // Update the stored model
      await db.queryAsync(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        [this.embeddingModelKey, currentModel],
      );
    }

    // Background reindex: embed all memories that still have no embedding
    this.reindexMissingEmbeddings().catch((err) => {
      ztoolkit.log("[MemoryStore] Background reindex failed:", getErrorMessage(err));
    });
  }

  private async reindexMissingEmbeddings(): Promise<void> {
    const provider = await this.getEmbeddingProvider();
    if (!provider) return;

    const db = await this.getDb();
    const rows = (await db.queryAsync(
      "SELECT id, text FROM memories WHERE library_id = ? AND embedding IS NULL ORDER BY created_at DESC",
      [this.libraryId],
    )) || [];

    if (rows.length === 0) return;
    ztoolkit.log(`[MemoryStore] Reindexing ${rows.length} memories...`);

    const items = rows as Array<{ id: string; text: string }>;
    let indexed = 0;

    for (let i = 0; i < items.length; i += REINDEX_BATCH_SIZE) {
      const batch = items.slice(i, i + REINDEX_BATCH_SIZE);
      try {
        const vectors = await provider.embedBatch(batch.map((r) => r.text));
        for (let j = 0; j < batch.length; j++) {
          if (!vectors[j]) continue;
          await db.queryAsync(
            "UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?",
            [JSON.stringify(vectors[j]), provider.modelId, batch[j].id],
          );
          indexed++;
        }
      } catch (err) {
        ztoolkit.log("[MemoryStore] Batch embed failed:", getErrorMessage(err));
      }
    }

    ztoolkit.log(`[MemoryStore] Reindex complete: ${indexed}/${rows.length} memories embedded`);
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
          if (cosineSimilarity(embedding, vec) >= EMBEDDING_DEDUP_THRESHOLD) return true;
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
      try { embedding = await provider.embed(trimmed); } catch { /* fall back to Jaccard dedup */ }
    }

    if (await this.isDuplicate(trimmed, embedding)) return { saved: false, reason: "duplicate" };

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

    ztoolkit.log(`[MemoryStore] Saved: "${trimmed.slice(0, 60)}" (${category}, importance=${importance}, embedded=${!!embedding})`);

    // Fire-and-forget: prune if over the cap
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
          const cosine = cosineSimilarity(queryEmbedding, mem.embedding);
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

/**
 * Format retrieved memories as a prompt block for injection into the system prompt.
 */
export function formatMemoriesForPrompt(memories: Memory[]): string {
  if (memories.length === 0) return "";

  const lines = memories.map((m) => `- [${m.category}] ${m.text}`).join("\n");
  return `\n=== USER MEMORIES ===\nThe following facts and preferences have been remembered from previous conversations:\n${lines}\nUse these to personalise your responses.\n`;
}
