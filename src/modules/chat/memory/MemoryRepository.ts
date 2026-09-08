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

  async listEmbeddedRows(
    limit: number,
    modelId: string,
  ): Promise<Array<{ embedding: string }>> {
    const db = await this.getDb();
    return ((await db.queryAsync(
      `
      SELECT e.embedding FROM memories m
      JOIN memory_embeddings e ON e.memory_id = m.id AND e.model_id = ?
      WHERE m.library_id = ? ORDER BY m.created_at DESC LIMIT ?
    `,
      [modelId, this.libraryId, limit],
    )) || []) as Array<{ embedding: string }>;
  }

  async listMissingEmbeddings(
    modelId: string,
  ): Promise<Array<{ id: string; text: string }>> {
    const db = await this.getDb();
    return ((await db.queryAsync(
      `
      SELECT m.id, m.text FROM memories m
      LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model_id = ?
      WHERE m.library_id = ? AND e.memory_id IS NULL ORDER BY m.created_at DESC
    `,
      [modelId, this.libraryId],
    )) || []) as Array<{ id: string; text: string }>;
  }

  async saveEmbedding(
    id: string,
    modelId: string,
    text: string,
    vector: number[],
  ): Promise<void> {
    const db = await this.getDb();
    // Do not resurrect a deleted/edited memory after an in-flight API request.
    await db.queryAsync(
      `
      INSERT OR REPLACE INTO memory_embeddings (memory_id, model_id, embedding)
      SELECT id, ?, ? FROM memories WHERE id = ? AND library_id = ? AND text = ?
    `,
      [modelId, JSON.stringify(vector), id, this.libraryId, text],
    );
  }

  async listTextRows(limit: number): Promise<Array<{ text: string }>> {
    const db = await this.getDb();
    const rows =
      (await db.queryAsync(
        `SELECT text FROM memories
       WHERE library_id = ? ORDER BY created_at DESC LIMIT ?`,
        [this.libraryId, limit],
      )) || [];
    return rows as Array<{ text: string }>;
  }

  async listRecent(limit: number, modelId?: string | null): Promise<Memory[]> {
    const db = await this.getDb();
    const rows =
      (await db.queryAsync(
        `
      SELECT m.id, m.library_id, m.text, m.category, m.importance, m.created_at,
        m.access_count, m.last_accessed_at, e.embedding, e.model_id AS embedding_model
      FROM memories m LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model_id = ?
      WHERE m.library_id = ? ORDER BY m.created_at DESC LIMIT ?
    `,
        [modelId ?? "", this.libraryId, limit],
      )) || [];
    return (rows as Array<Record<string, unknown>>).map(rowToMemory);
  }

  async insert(record: MemoryInsertRecord): Promise<void> {
    await getStorageDatabase().executeTransaction(async (db) => {
      await db.queryAsync(
        `
        INSERT INTO memories (id, library_id, text, category, importance,
          created_at, access_count, last_accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      `,
        [
          record.id,
          this.libraryId,
          record.text,
          record.category,
          record.importance,
          record.createdAt,
          record.lastAccessedAt,
        ],
      );
      if (record.embedding && record.embeddingModel) {
        await db.queryAsync(
          `INSERT INTO memory_embeddings (memory_id, model_id, embedding) VALUES (?, ?, ?)`,
          [record.id, record.embeddingModel, JSON.stringify(record.embedding)],
        );
      }
    });
  }

  async count(): Promise<number> {
    const db = await this.getDb();
    const rows =
      (await db.queryAsync(
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
    const rows =
      (await db.queryAsync(
        `SELECT id, library_id, text, category, importance, created_at,
              access_count, last_accessed_at
       FROM memories WHERE library_id = ? ORDER BY created_at DESC`,
        [this.libraryId],
      )) || [];
    return (rows as Array<Record<string, unknown>>).map(rowToMemory);
  }
}
