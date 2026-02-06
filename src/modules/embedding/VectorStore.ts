/**
 * VectorStore - Zotero SQLite-based vector storage for RAG
 *
 * Stores embedding vectors and provides similarity search
 * Uses Zotero.DBConnection for reliable persistence
 * Supports multiple embedding models - data from different models coexist
 */

import type {
  VectorEntry,
  SemanticSearchResult,
  SemanticSearchOptions,
  ItemIndexStatus,
  AccessRecord,
} from "../../types/embedding";
import { cosineSimilarity } from "./utils/cosine";
import { getErrorMessage } from "../../utils/common";

const DB_DIR = "paper-chat";
const DB_NAME = "paper-chat/vectors";

/**
 * Minimal type definition for Zotero.DBConnection
 * Based on actual API usage in this file
 */
interface ZoteroDBConnection {
  queryAsync(sql: string, params?: unknown[]): Promise<any[] | undefined>;
}

export class VectorStore {
  private db: ZoteroDBConnection | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize the SQLite database
   */
  async init(): Promise<void> {
    if (this.db) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.initDatabase();
    return this.initPromise;
  }

  private async initDatabase(): Promise<void> {
    try {
      // Ensure subdirectory exists
      const dataDir = Zotero.DataDirectory.dir;
      const subDir = PathUtils.join(dataDir, DB_DIR);
      await IOUtils.makeDirectory(subDir, { ignoreExisting: true });

      // Create database connection
      const db: ZoteroDBConnection = new Zotero.DBConnection(DB_NAME);
      this.db = db;

      // Create vectors table
      await db.queryAsync(`
        CREATE TABLE IF NOT EXISTS vectors (
          id TEXT PRIMARY KEY,
          item_key TEXT NOT NULL,
          model_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          text TEXT NOT NULL,
          vector BLOB NOT NULL,
          metadata TEXT,
          created_at INTEGER NOT NULL
        )
      `);

      // Create indexes for efficient queries
      await db.queryAsync(`
        CREATE INDEX IF NOT EXISTS idx_vectors_item_model
        ON vectors (item_key, model_id)
      `);

      await db.queryAsync(`
        CREATE INDEX IF NOT EXISTS idx_vectors_model
        ON vectors (model_id)
      `);

      // Create access_records table for LRU tracking
      await db.queryAsync(`
        CREATE TABLE IF NOT EXISTS access_records (
          id TEXT PRIMARY KEY,
          item_key TEXT NOT NULL,
          model_id TEXT NOT NULL,
          last_accessed_at INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL,
          chunk_count INTEGER NOT NULL
        )
      `);

      await db.queryAsync(`
        CREATE INDEX IF NOT EXISTS idx_access_last_accessed
        ON access_records (last_accessed_at)
      `);

      ztoolkit.log("[VectorStore] SQLite database initialized successfully");
    } catch (error) {
      ztoolkit.log(
        "[VectorStore] Failed to initialize database:",
        getErrorMessage(error),
      );
      this.db = null;
      this.initPromise = null;
      throw error;
    }
  }

  /**
   * Ensure database is initialized
   */
  private async ensureInit(): Promise<ZoteroDBConnection> {
    await this.init();
    if (!this.db) {
      throw new Error("VectorStore database not initialized");
    }
    return this.db;
  }

  /**
   * Serialize vector to BLOB
   */
  private vectorToBlob(vector: number[]): Uint8Array {
    const float32 = new Float32Array(vector);
    return new Uint8Array(float32.buffer);
  }

  /**
   * Deserialize BLOB to vector
   * Creates a properly aligned ArrayBuffer to ensure Float32Array works correctly
   */
  private blobToVector(blob: number[] | Uint8Array): number[] {
    const source = blob instanceof Uint8Array ? blob : new Uint8Array(blob);

    // Validate blob length (must be non-empty and multiple of 4 for Float32)
    if (source.length === 0) {
      ztoolkit.log("[VectorStore] Warning: empty blob in blobToVector");
      return [];
    }
    if (source.length % 4 !== 0) {
      ztoolkit.log(
        `[VectorStore] Warning: blob length ${source.length} is not a multiple of 4`,
      );
      return [];
    }

    // Create a new aligned ArrayBuffer and copy data
    // This ensures proper memory alignment for Float32Array
    const alignedBuffer = new ArrayBuffer(source.length);
    new Uint8Array(alignedBuffer).set(source);
    const float32 = new Float32Array(alignedBuffer);
    return Array.from(float32);
  }

  /**
   * Add or update vector entries for an item
   */
  async upsert(entries: VectorEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const db = await this.ensureInit();

    try {
      await db.queryAsync("BEGIN TRANSACTION");

      for (const entry of entries) {
        const vectorBlob = this.vectorToBlob(entry.vector);
        const metadata = JSON.stringify(entry.metadata);

        await db.queryAsync(
          `INSERT OR REPLACE INTO vectors
           (id, item_key, model_id, chunk_index, text, vector, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.id,
            entry.itemKey,
            entry.modelId,
            entry.chunkIndex,
            entry.text,
            vectorBlob,
            metadata,
            entry.createdAt,
          ],
        );
      }

      await db.queryAsync("COMMIT");
      ztoolkit.log(`[VectorStore] Upserted ${entries.length} entries`);
    } catch (error) {
      // Attempt rollback, but don't let rollback errors mask the original error
      try {
        await db.queryAsync("ROLLBACK");
      } catch (rollbackError) {
        ztoolkit.log(
          "[VectorStore] ROLLBACK failed:",
          getErrorMessage(rollbackError),
        );
      }
      throw error;
    }
  }

  /**
   * Search for similar vectors
   * @param queryVector Query embedding vector
   * @param options Search options (modelId is required for correct matching)
   */
  async search(
    queryVector: number[],
    options: SemanticSearchOptions = {},
  ): Promise<SemanticSearchResult[]> {
    const { topK = 5, minScore = 0, itemKeys, modelId } = options;

    if (!modelId) {
      ztoolkit.log("[VectorStore] Warning: search called without modelId");
      return [];
    }

    const db = await this.ensureInit();
    const results: SemanticSearchResult[] = [];

    // Build query based on filters
    let query = "SELECT * FROM vectors WHERE model_id = ?";
    const params: (string | number)[] = [modelId];

    if (itemKeys && itemKeys.length > 0) {
      const placeholders = itemKeys.map(() => "?").join(", ");
      query += ` AND item_key IN (${placeholders})`;
      params.push(...itemKeys);
    }

    const rows = (await db.queryAsync(query, params)) || [];

    for (const row of rows) {
      try {
        // Defensive checks for required fields
        if (!row.vector || !row.text) {
          ztoolkit.log(
            `[VectorStore] Skipping invalid row: missing vector or text`,
          );
          continue;
        }

        const vector = this.blobToVector(row.vector);

        // Skip if vector conversion failed or dimension mismatch
        if (vector.length === 0 || vector.length !== queryVector.length) {
          ztoolkit.log(
            `[VectorStore] Skipping row: vector dimension mismatch (${vector.length} vs ${queryVector.length})`,
          );
          continue;
        }

        const score = cosineSimilarity(queryVector, vector);

        if (score >= minScore) {
          // Safe metadata parsing with fallback
          let metadata: { page?: number } = {};
          try {
            metadata = row.metadata ? JSON.parse(row.metadata) : {};
          } catch {
            // Invalid JSON in metadata, use empty object
          }

          results.push({
            text: row.text,
            score,
            itemKey: row.item_key,
            chunkIndex: row.chunk_index,
            page: metadata.page,
          });
        }
      } catch (error) {
        ztoolkit.log(
          "[VectorStore] Similarity calculation error:",
          getErrorMessage(error),
        );
      }
    }

    // Sort by score descending and take topK
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /**
   * Delete all entries for an item (all models)
   */
  async delete(itemKey: string): Promise<void> {
    const db = await this.ensureInit();
    await db.queryAsync("DELETE FROM vectors WHERE item_key = ?", [itemKey]);
    ztoolkit.log(`[VectorStore] Deleted all entries for item: ${itemKey}`);
  }

  /**
   * Delete entries for an item with specific modelId
   */
  async deleteByModel(itemKey: string, modelId: string): Promise<void> {
    const db = await this.ensureInit();
    await db.queryAsync(
      "DELETE FROM vectors WHERE item_key = ? AND model_id = ?",
      [itemKey, modelId],
    );
    ztoolkit.log(
      `[VectorStore] Deleted entries for item: ${itemKey}, model: ${modelId}`,
    );
  }

  /**
   * Check if an item has been indexed with specific modelId
   */
  async has(itemKey: string, modelId: string): Promise<boolean> {
    const db = await this.ensureInit();
    const result = (await db.queryAsync(
      "SELECT COUNT(*) as count FROM vectors WHERE item_key = ? AND model_id = ?",
      [itemKey, modelId],
    )) || [];
    return result[0]?.count > 0;
  }

  /**
   * Get index status for an item with specific modelId
   */
  async getItemStatus(
    itemKey: string,
    modelId: string,
  ): Promise<ItemIndexStatus> {
    const db = await this.ensureInit();
    const rows = (await db.queryAsync(
      "SELECT created_at FROM vectors WHERE item_key = ? AND model_id = ?",
      [itemKey, modelId],
    )) || [];

    if (rows.length === 0) {
      return { indexed: false, chunkCount: 0 };
    }

    const lastIndexedAt = Math.max(...rows.map((r: any) => r.created_at));
    return {
      indexed: true,
      chunkCount: rows.length,
      lastIndexedAt,
      modelId,
    };
  }

  /**
   * Get all chunk hashes for an item with specific modelId (for change detection)
   */
  async getChunkHashes(
    itemKey: string,
    modelId: string,
  ): Promise<Map<number, string>> {
    const db = await this.ensureInit();
    const rows = (await db.queryAsync(
      "SELECT chunk_index, metadata FROM vectors WHERE item_key = ? AND model_id = ?",
      [itemKey, modelId],
    )) || [];

    const hashes = new Map<number, string>();
    for (const row of rows) {
      try {
        const metadata = row.metadata ? JSON.parse(row.metadata) : {};
        if (metadata.hash) {
          hashes.set(row.chunk_index, metadata.hash);
        }
      } catch {
        // Invalid JSON in metadata, skip this entry
      }
    }
    return hashes;
  }

  /**
   * Clear all data
   */
  async clear(): Promise<void> {
    const db = await this.ensureInit();
    await db.queryAsync("DELETE FROM vectors");
    ztoolkit.log("[VectorStore] All data cleared");
  }

  /**
   * Get total entry count
   */
  async count(): Promise<number> {
    const db = await this.ensureInit();
    const result = (await db.queryAsync("SELECT COUNT(*) as count FROM vectors")) || [];
    return result[0]?.count || 0;
  }

  /**
   * Get entry count by modelId
   */
  async countByModel(modelId: string): Promise<number> {
    const db = await this.ensureInit();
    const result = (await db.queryAsync(
      "SELECT COUNT(*) as count FROM vectors WHERE model_id = ?",
      [modelId],
    )) || [];
    return result[0]?.count || 0;
  }

  // ===========================================
  // Access Records Methods (for LRU tracking)
  // ===========================================

  /**
   * Create or update an access record
   */
  async upsertAccessRecord(
    itemKey: string,
    modelId: string,
    chunkCount: number,
  ): Promise<void> {
    const db = await this.ensureInit();
    const now = Date.now();
    const id = `${itemKey}_${modelId}`;

    // Check if record exists
    const existing = (await db.queryAsync(
      "SELECT indexed_at FROM access_records WHERE id = ?",
      [id],
    )) || [];

    const indexedAt = existing[0]?.indexed_at ?? now;

    await db.queryAsync(
      `INSERT OR REPLACE INTO access_records
       (id, item_key, model_id, last_accessed_at, indexed_at, chunk_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, itemKey, modelId, now, indexedAt, chunkCount],
    );
  }

  /**
   * Update last accessed time for an item
   */
  async updateLastAccessed(itemKey: string, modelId: string): Promise<void> {
    const db = await this.ensureInit();
    const id = `${itemKey}_${modelId}`;

    await db.queryAsync(
      "UPDATE access_records SET last_accessed_at = ? WHERE id = ?",
      [Date.now(), id],
    );
  }

  /**
   * Get oldest items by last accessed time (for LRU eviction)
   * @param limit Number of items to return
   * @param modelId Optional: filter by model ID
   */
  async getOldestItems(
    limit: number,
    modelId?: string,
  ): Promise<AccessRecord[]> {
    const db = await this.ensureInit();

    let query =
      "SELECT * FROM access_records ORDER BY last_accessed_at ASC LIMIT ?";
    const params: (string | number)[] = [limit];

    if (modelId) {
      query =
        "SELECT * FROM access_records WHERE model_id = ? ORDER BY last_accessed_at ASC LIMIT ?";
      params.unshift(modelId);
    }

    const rows = (await db.queryAsync(query, params)) || [];

    return rows.map((row: any) => ({
      id: row.id,
      itemKey: row.item_key,
      modelId: row.model_id,
      lastAccessedAt: row.last_accessed_at,
      indexedAt: row.indexed_at,
      chunkCount: row.chunk_count,
    }));
  }

  /**
   * Delete access record for an item
   */
  async deleteAccessRecord(itemKey: string, modelId: string): Promise<void> {
    const db = await this.ensureInit();
    const id = `${itemKey}_${modelId}`;
    await db.queryAsync("DELETE FROM access_records WHERE id = ?", [id]);
  }

  /**
   * Delete all access records for an item (all models)
   */
  async deleteAllAccessRecords(itemKey: string): Promise<void> {
    const db = await this.ensureInit();
    await db.queryAsync("DELETE FROM access_records WHERE item_key = ?", [
      itemKey,
    ]);
  }

  /**
   * Get access record for an item
   */
  async getAccessRecord(
    itemKey: string,
    modelId: string,
  ): Promise<AccessRecord | null> {
    const db = await this.ensureInit();
    const id = `${itemKey}_${modelId}`;

    const rows = (await db.queryAsync(
      "SELECT * FROM access_records WHERE id = ?",
      [id],
    )) || [];

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0];
    return {
      id: row.id,
      itemKey: row.item_key,
      modelId: row.model_id,
      lastAccessedAt: row.last_accessed_at,
      indexedAt: row.indexed_at,
      chunkCount: row.chunk_count,
    };
  }

  /**
   * Clear all access records
   */
  async clearAccessRecords(): Promise<void> {
    const db = await this.ensureInit();
    await db.queryAsync("DELETE FROM access_records");
    ztoolkit.log("[VectorStore] All access records cleared");
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      // Zotero.DBConnection doesn't have an explicit close method
      // but we can clear our reference
      this.db = null;
      this.initPromise = null;
      ztoolkit.log("[VectorStore] Database reference cleared");
    }
  }
}

// Singleton instance
let vectorStore: VectorStore | null = null;

export function getVectorStore(): VectorStore {
  if (!vectorStore) {
    vectorStore = new VectorStore();
  }
  return vectorStore;
}

export function destroyVectorStore(): void {
  if (vectorStore) {
    vectorStore.close();
    vectorStore = null;
  }
}
