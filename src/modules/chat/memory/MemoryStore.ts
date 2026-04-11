/**
 * MemoryStore - Per-library persistent memory for user preferences and facts
 *
 * Stores memories in the existing paper-chat/storage SQLite database (schema v4).
 * Uses Jaccard deduplication and multi-factor relevance scoring for retrieval.
 */

import { getStorageDatabase } from "../db/StorageDatabase";
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
}

// ── Tunables ─────────────────────────────────────────────────────────────────

const DEDUP_THRESHOLD = 0.9;   // Jaccard score to treat as duplicate
const DEDUP_WINDOW = 80;        // Newest N memories checked for dedup
const MAX_INJECT = 5;           // Max memories injected per prompt
const MIN_SCORE = 0.25;         // Minimum relevance score to include in results
const MIN_LEN = 10;             // Min character length for a memory
const MAX_LEN = 500;            // Max character length for a memory
const SEARCH_FETCH_LIMIT = 300; // Max rows loaded from DB for client-side scoring
const MAX_MEMORIES = 500;       // Hard cap per library; oldest+least-important pruned first

// Scoring weights (sum > 1 is intentional: boosts can compound)
const W_JACCARD = 0.65;
const W_CONTAINS = 0.30;
const W_RECENCY = 0.15;
const W_IMPORTANCE = 0.20;

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

function scoreMemory(mem: Memory, queryTokens: Set<string>, queryRaw: string, now: number): number {
  const memTokens = tokenise(mem.text);
  const jaccardScore = jaccard(queryTokens, memTokens);

  const containsBoost = mem.text.toLowerCase().includes(queryRaw.toLowerCase()) ? 1.0 : 0.0;

  const ageDays = (now - mem.createdAt) / (1000 * 86400);
  const recencyScore = Math.exp(-ageDays / 30);

  return (
    W_JACCARD * jaccardScore +
    W_CONTAINS * containsBoost +
    W_RECENCY * recencyScore +
    W_IMPORTANCE * mem.importance
  );
}

function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    id: row.id as string,
    libraryId: row.library_id as number,
    text: row.text as string,
    category: row.category as MemoryCategory,
    importance: row.importance as number,
    createdAt: row.created_at as number,
    accessCount: row.access_count as number,
    lastAccessedAt: row.last_accessed_at as number,
  };
}

// ── MemoryStore ───────────────────────────────────────────────────────────────

export class MemoryStore {
  private libraryId: number;

  constructor(libraryId: number) {
    this.libraryId = libraryId;
  }

  private async getDb() {
    return getStorageDatabase().ensureInit();
  }

  private async isDuplicate(text: string): Promise<boolean> {
    const db = await this.getDb();
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
    if (await this.isDuplicate(trimmed)) return { saved: false, reason: "duplicate" };

    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const db = await this.getDb();

    await db.queryAsync(
      `INSERT INTO memories (id, library_id, text, category, importance, created_at, access_count, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [id, this.libraryId, trimmed, category, Math.max(0, Math.min(1, importance)), now, now],
    );

    ztoolkit.log(`[MemoryStore] Saved: "${trimmed.slice(0, 60)}" (${category}, importance=${importance})`);

    // Fire-and-forget: prune if over the cap
    this.pruneIfNeeded().catch((err) => {
      ztoolkit.log("[MemoryStore] Prune failed:", getErrorMessage(err));
    });

    return { saved: true };
  }

  /**
   * Delete the lowest-value memories when the library exceeds MAX_MEMORIES.
   * Prune priority: lowest importance first, then oldest last_accessed_at.
   */
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

  /**
   * Search for memories relevant to the given query.
   * Returns up to MAX_INJECT results sorted by relevance score.
   */
  async search(query: string): Promise<Memory[]> {
    if (!query.trim()) return [];

    const db = await this.getDb();
    const rows = (await db.queryAsync(
      `SELECT id, library_id, text, category, importance, created_at, access_count, last_accessed_at
       FROM memories WHERE library_id = ? ORDER BY created_at DESC LIMIT ?`,
      [this.libraryId, SEARCH_FETCH_LIMIT],
    )) || [];

    if (rows.length === 0) return [];

    const queryTokens = tokenise(query);
    const now = Date.now();

    const scored = (rows as Array<Record<string, unknown>>).map((row) => {
      const mem = rowToMemory(row);
      return { mem, score: scoreMemory(mem, queryTokens, query, now) };
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
      `SELECT id, library_id, text, category, importance, created_at, access_count, last_accessed_at
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
