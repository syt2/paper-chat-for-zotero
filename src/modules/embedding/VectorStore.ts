/**
 * VectorStore - IndexedDB-based vector storage for RAG
 *
 * Stores embedding vectors and provides similarity search
 * Supports multiple embedding models - data from different models coexist
 */

import type {
  VectorEntry,
  SemanticSearchResult,
  SemanticSearchOptions,
  ItemIndexStatus,
} from "../../types/embedding";
import { cosineSimilarity } from "./utils/cosine";

const DB_NAME = "pdf-ai-talk-rag";
const DB_VERSION = 1;
const STORE_NAME = "vectors";

export class VectorStore {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize the IndexedDB database
   */
  async init(): Promise<void> {
    if (this.db) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        ztoolkit.log("[VectorStore] Failed to open database:", request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        ztoolkit.log("[VectorStore] Database opened successfully");
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create vectors store
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });

        // Index for querying by itemKey + modelId (most common query pattern)
        store.createIndex("itemKey_modelId", ["itemKey", "modelId"], {
          unique: false,
        });

        // Index for querying by itemKey only (for listing all models for an item)
        store.createIndex("itemKey", "itemKey", { unique: false });

        // Index for querying by modelId only (for stats)
        store.createIndex("modelId", "modelId", { unique: false });

        ztoolkit.log("[VectorStore] Database schema created/upgraded");
      };
    });

    return this.initPromise;
  }

  /**
   * Ensure database is initialized
   */
  private async ensureInit(): Promise<IDBDatabase> {
    await this.init();
    if (!this.db) {
      throw new Error("VectorStore database not initialized");
    }
    return this.db;
  }

  /**
   * Add or update vector entries for an item
   */
  async upsert(entries: VectorEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const db = await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);

      transaction.oncomplete = () => {
        ztoolkit.log(`[VectorStore] Upserted ${entries.length} entries`);
        resolve();
      };

      transaction.onerror = () => {
        ztoolkit.log("[VectorStore] Upsert failed:", transaction.error);
        reject(transaction.error);
      };

      for (const entry of entries) {
        store.put(entry);
      }
    });
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

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const results: SemanticSearchResult[] = [];

      let request: IDBRequest;

      // Use composite index for itemKey + modelId when filtering single item
      if (itemKeys && itemKeys.length === 1) {
        const index = store.index("itemKey_modelId");
        request = index.openCursor(
          IDBKeyRange.only([itemKeys[0], modelId]),
        );
      } else {
        // Use modelId index and filter itemKeys manually
        const index = store.index("modelId");
        request = index.openCursor(IDBKeyRange.only(modelId));
      }

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

        if (cursor) {
          const entry = cursor.value as VectorEntry;

          // Filter by itemKeys if multiple specified
          if (itemKeys && itemKeys.length > 1 && !itemKeys.includes(entry.itemKey)) {
            cursor.continue();
            return;
          }

          // Calculate similarity
          try {
            const score = cosineSimilarity(queryVector, entry.vector);

            if (score >= minScore) {
              results.push({
                text: entry.text,
                score,
                itemKey: entry.itemKey,
                chunkIndex: entry.chunkIndex,
                page: entry.metadata.page,
              });
            }
          } catch (error) {
            // Skip entries with dimension mismatch (shouldn't happen if modelId is correct)
            ztoolkit.log(
              "[VectorStore] Similarity calculation error:",
              error instanceof Error ? error.message : String(error),
            );
          }

          cursor.continue();
        }
      };

      transaction.oncomplete = () => {
        // Sort by score descending and take topK
        results.sort((a, b) => b.score - a.score);
        resolve(results.slice(0, topK));
      };

      transaction.onerror = () => {
        reject(transaction.error);
      };
    });
  }

  /**
   * Delete all entries for an item (all models)
   */
  async delete(itemKey: string): Promise<void> {
    const db = await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index("itemKey");
      const request = index.openCursor(IDBKeyRange.only(itemKey));

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      transaction.oncomplete = () => {
        ztoolkit.log(`[VectorStore] Deleted all entries for item: ${itemKey}`);
        resolve();
      };

      transaction.onerror = () => {
        reject(transaction.error);
      };
    });
  }

  /**
   * Delete entries for an item with specific modelId
   */
  async deleteByModel(itemKey: string, modelId: string): Promise<void> {
    const db = await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index("itemKey_modelId");
      const request = index.openCursor(IDBKeyRange.only([itemKey, modelId]));

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      transaction.oncomplete = () => {
        ztoolkit.log(
          `[VectorStore] Deleted entries for item: ${itemKey}, model: ${modelId}`,
        );
        resolve();
      };

      transaction.onerror = () => {
        reject(transaction.error);
      };
    });
  }

  /**
   * Check if an item has been indexed with specific modelId
   */
  async has(itemKey: string, modelId: string): Promise<boolean> {
    const db = await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index("itemKey_modelId");
      const request = index.count(IDBKeyRange.only([itemKey, modelId]));

      request.onsuccess = () => {
        resolve(request.result > 0);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Get index status for an item with specific modelId
   */
  async getItemStatus(itemKey: string, modelId: string): Promise<ItemIndexStatus> {
    const db = await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index("itemKey_modelId");
      const request = index.getAll(IDBKeyRange.only([itemKey, modelId]));

      request.onsuccess = () => {
        const entries = request.result as VectorEntry[];
        if (entries.length === 0) {
          resolve({
            indexed: false,
            chunkCount: 0,
          });
        } else {
          const lastIndexedAt = Math.max(...entries.map((e) => e.createdAt));
          resolve({
            indexed: true,
            chunkCount: entries.length,
            lastIndexedAt,
            modelId,
          });
        }
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Get all chunk hashes for an item with specific modelId (for change detection)
   */
  async getChunkHashes(
    itemKey: string,
    modelId: string,
  ): Promise<Map<number, string>> {
    const db = await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index("itemKey_modelId");
      const request = index.getAll(IDBKeyRange.only([itemKey, modelId]));

      request.onsuccess = () => {
        const entries = request.result as VectorEntry[];
        const hashes = new Map<number, string>();
        for (const entry of entries) {
          hashes.set(entry.chunkIndex, entry.metadata.hash);
        }
        resolve(hashes);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Clear all data
   */
  async clear(): Promise<void> {
    const db = await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onsuccess = () => {
        ztoolkit.log("[VectorStore] All data cleared");
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Get total entry count
   */
  async count(): Promise<number> {
    const db = await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.count();

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Get entry count by modelId
   */
  async countByModel(modelId: string): Promise<number> {
    const db = await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index("modelId");
      const request = index.count(IDBKeyRange.only(modelId));

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initPromise = null;
      ztoolkit.log("[VectorStore] Database closed");
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
