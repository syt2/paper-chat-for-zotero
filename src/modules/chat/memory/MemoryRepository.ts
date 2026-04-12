import { getStorageDatabase } from "../db/StorageDatabase";
import type { Memory, MemoryCategory } from "./MemoryTypes";
import { rowToMemory } from "./MemoryScoring";

export interface MemoryInsertRecord {
  id: string;
  text: string;
  category: MemoryCategory;
  importance: number;
  createdAt: number;
  lastAccessedAt: number;
  embedding?: number[];
  embeddingModel?: string | null;
}

export class MemoryRepository {
  constructor(private libraryId: number) {}

  private async getDb() {
    return getStorageDatabase().ensureInit();
  }

  async listEmbeddedRows(limit: number): Promise<Array<{ embedding: string }>> {
    const db = await this.getDb();
    const rows = (await db.queryAsync(
      `SELECT embedding FROM memories
       WHERE library_id = ? AND embedding IS NOT NULL
       ORDER BY created_at DESC LIMIT ?`,
      [this.libraryId, limit],
    )) || [];
    return rows as Array<{ embedding: string }>;
  }

  async listTextRows(limit: number): Promise<Array<{ text: string }>> {
    const db = await this.getDb();
    const rows = (await db.queryAsync(
      `SELECT text FROM memories
       WHERE library_id = ? ORDER BY created_at DESC LIMIT ?`,
      [this.libraryId, limit],
    )) || [];
    return rows as Array<{ text: string }>;
  }

  async listRecent(limit: number): Promise<Memory[]> {
    const db = await this.getDb();
    const rows = (await db.queryAsync(
      `SELECT id, library_id, text, category, importance, created_at,
              access_count, last_accessed_at, embedding, embedding_model
       FROM memories WHERE library_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [this.libraryId, limit],
    )) || [];
    return (rows as Array<Record<string, unknown>>).map(rowToMemory);
  }

  async insert(record: MemoryInsertRecord): Promise<void> {
    const db = await this.getDb();
    await db.queryAsync(
      `INSERT INTO memories (
         id, library_id, text, category, importance,
         created_at, access_count, last_accessed_at, embedding, embedding_model
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        record.id,
        this.libraryId,
        record.text,
        record.category,
        record.importance,
        record.createdAt,
        record.lastAccessedAt,
        record.embedding ? JSON.stringify(record.embedding) : null,
        record.embeddingModel ?? null,
      ],
    );
  }

  async count(): Promise<number> {
    const db = await this.getDb();
    const rows = (await db.queryAsync(
      "SELECT COUNT(*) as cnt FROM memories WHERE library_id = ?",
      [this.libraryId],
    )) || [];
    return (rows[0]?.cnt as number) ?? 0;
  }

  async pruneOldestLowestImportance(excess: number): Promise<void> {
    if (excess <= 0) return;
    const db = await this.getDb();
    await db.queryAsync(
      `DELETE FROM memories WHERE id IN (
         SELECT id FROM memories WHERE library_id = ?
         ORDER BY importance ASC, last_accessed_at ASC
         LIMIT ?
       )`,
      [this.libraryId, excess],
    );
  }

  async updateAccessStats(ids: string[], now: number): Promise<void> {
    if (ids.length === 0) return;
    const db = await this.getDb();
    const placeholders = ids.map(() => "?").join(", ");
    await db.queryAsync(
      `UPDATE memories
       SET access_count = access_count + 1, last_accessed_at = ?
       WHERE id IN (${placeholders})`,
      [now, ...ids],
    );
  }

  async delete(id: string): Promise<void> {
    const db = await this.getDb();
    await db.queryAsync(
      "DELETE FROM memories WHERE id = ? AND library_id = ?",
      [id, this.libraryId],
    );
  }

  async listAll(): Promise<Memory[]> {
    const db = await this.getDb();
    const rows = (await db.queryAsync(
      `SELECT id, library_id, text, category, importance, created_at,
              access_count, last_accessed_at, embedding, embedding_model
       FROM memories WHERE library_id = ? ORDER BY created_at DESC`,
      [this.libraryId],
    )) || [];
    return (rows as Array<Record<string, unknown>>).map(rowToMemory);
  }
}
