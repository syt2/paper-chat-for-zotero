/**
 * RAGService - Main service for Retrieval-Augmented Generation
 *
 * Provides semantic search capabilities for PDF content
 * Supports multiple embedding models - data from different models coexist
 */

import type {
  SemanticSearchResult,
  SemanticSearchOptions,
  VectorEntry,
  ItemIndexStatus,
  TextChunk,
} from "../../types/embedding";
import { getPref } from "../../utils/prefs";
import { getErrorMessage } from "../../utils/common";
import {
  getEmbeddingProviderFactory,
  EmbeddingProviderFactory,
} from "./EmbeddingProviderFactory";
import { getVectorStore, VectorStore } from "./VectorStore";
import { splitText } from "./ChunkSplitter";

/** Number of items to delete when quota is exceeded */
const ITEMS_TO_DELETE_ON_QUOTA = 5;

export class RAGService {
  private providerFactory: EmbeddingProviderFactory;
  private vectorStore: VectorStore;
  private indexingInProgress: Set<string> = new Set();

  constructor() {
    this.providerFactory = getEmbeddingProviderFactory();
    this.vectorStore = getVectorStore();
  }

  /**
   * Check if RAG/semantic search is available
   */
  async isAvailable(): Promise<boolean> {
    // Check if enabled in settings
    const enabled = getPref("enableSemanticSearch");
    if (!enabled) {
      return false;
    }

    // Check if provider is available
    const status = await this.providerFactory.getStatus();
    return status.available;
  }

  /**
   * Get embedding status for UI display
   */
  async getStatus() {
    return this.providerFactory.getStatus();
  }

  /**
   * Index a paper's content for semantic search
   *
   * @param itemKey Zotero item key
   * @param content PDF text content
   */
  async indexPaper(itemKey: string, content: string): Promise<void> {
    if (!(await this.isAvailable())) {
      ztoolkit.log("[RAGService] Semantic search not available, skipping index");
      return;
    }

    // Get provider first to get modelId
    const provider = await this.providerFactory.getProvider();
    if (!provider) {
      ztoolkit.log("[RAGService] No embedding provider available");
      return;
    }

    const modelId = provider.modelId;

    // Prevent concurrent indexing of same item+model
    const indexKey = `${itemKey}:${modelId}`;
    if (this.indexingInProgress.has(indexKey)) {
      ztoolkit.log(`[RAGService] Already indexing: ${indexKey}`);
      return;
    }

    this.indexingInProgress.add(indexKey);

    try {
      ztoolkit.log(`[RAGService] Starting to index item: ${itemKey} with model: ${modelId}`);

      // 1. Split content into chunks
      const chunks = splitText(content);
      if (chunks.length === 0) {
        ztoolkit.log(`[RAGService] No content to index for item: ${itemKey}`);
        return;
      }

      ztoolkit.log(`[RAGService] Split into ${chunks.length} chunks`);

      // 2. Check existing hashes for this model to avoid re-embedding unchanged content
      const existingHashes = await this.vectorStore.getChunkHashes(itemKey, modelId);
      const chunksToEmbed: TextChunk[] = [];
      const newChunkIndexes = new Set(chunks.map((c) => c.index));

      for (const chunk of chunks) {
        const existingHash = existingHashes.get(chunk.index);
        if (existingHash !== chunk.hash) {
          chunksToEmbed.push(chunk);
        }
      }

      // Check if we need to delete old chunks that no longer exist
      const staleChunkIndexes: number[] = [];
      for (const [existingIndex] of existingHashes) {
        if (!newChunkIndexes.has(existingIndex)) {
          staleChunkIndexes.push(existingIndex);
        }
      }

      // If content shrunk, we should re-index to clean up stale chunks
      if (staleChunkIndexes.length > 0) {
        ztoolkit.log(
          `[RAGService] Found ${staleChunkIndexes.length} stale chunks, will re-index`,
        );
        // Delete old data for this model and re-index everything
        await this.vectorStore.deleteByModel(itemKey, modelId);
        // Mark all chunks for embedding
        chunksToEmbed.length = 0;
        chunksToEmbed.push(...chunks);
      }

      if (chunksToEmbed.length === 0) {
        ztoolkit.log(`[RAGService] No changes detected for item: ${itemKey}`);
        return;
      }

      ztoolkit.log(`[RAGService] ${chunksToEmbed.length} chunks need embedding`);

      // 3. Get embeddings
      const texts = chunksToEmbed.map((c) => c.text);
      const vectors = await provider.embedBatch(texts);

      // Verify embedding count matches chunk count
      if (vectors.length !== chunksToEmbed.length) {
        throw new Error(
          `Embedding count mismatch: expected ${chunksToEmbed.length}, got ${vectors.length}`,
        );
      }

      ztoolkit.log(`[RAGService] Generated ${vectors.length} embeddings`);

      // 4. Create vector entries with modelId
      const entries: VectorEntry[] = chunksToEmbed.map((chunk, i) => ({
        id: `${itemKey}_${modelId}_${chunk.index}`,
        itemKey,
        modelId,
        chunkIndex: chunk.index,
        text: chunk.text,
        vector: vectors[i],
        metadata: {
          hash: chunk.hash,
          page: chunk.page,
        },
        createdAt: Date.now(),
      }));

      // 5. Store in vector database (with quota handling)
      await this.upsertWithQuotaHandling(entries, itemKey, modelId, chunks.length);

      ztoolkit.log(`[RAGService] Indexed item: ${itemKey} with model: ${modelId}`);
    } catch (error) {
      ztoolkit.log(
        `[RAGService] Failed to index item ${itemKey}:`,
        getErrorMessage(error),
      );
      throw error;
    } finally {
      this.indexingInProgress.delete(indexKey);
    }
  }

  /**
   * Upsert entries with automatic quota handling
   * If quota is exceeded, delete oldest items and retry
   */
  private async upsertWithQuotaHandling(
    entries: VectorEntry[],
    itemKey: string,
    modelId: string,
    totalChunkCount: number,
  ): Promise<void> {
    const maxRetries = 10; // Max 10 rounds of deletion (50 items total)
    let retries = 0;

    while (retries < maxRetries) {
      try {
        await this.vectorStore.upsert(entries);

        // Success - update access record
        await this.vectorStore.upsertAccessRecord(itemKey, modelId, totalChunkCount);
        return;
      } catch (error) {
        // Check if it's a quota error
        if (this.isQuotaError(error)) {
          retries++;
          ztoolkit.log(
            `[RAGService] Quota exceeded, attempting cleanup (retry ${retries}/${maxRetries})`,
          );

          // Get oldest items from access_records (LRU tracking)
          const oldestItems = await this.vectorStore.getOldestItems(
            ITEMS_TO_DELETE_ON_QUOTA,
          );

          // If no access records exist, data is inconsistent - clear everything and retry
          if (oldestItems.length === 0) {
            ztoolkit.log(
              "[RAGService] No access records found, clearing all data to recover",
            );
            await this.vectorStore.clear();
            await this.vectorStore.clearAccessRecords();
            // Retry will happen in next loop iteration with empty database
            continue;
          }

          // Delete oldest items (skip current item being indexed)
          let deleted = 0;
          for (const item of oldestItems) {
            if (item.itemKey !== itemKey) {
              await this.vectorStore.deleteByModel(item.itemKey, item.modelId);
              await this.vectorStore.deleteAccessRecord(item.itemKey, item.modelId);
              deleted++;
              ztoolkit.log(
                `[RAGService] Evicted old index: ${item.itemKey} (last accessed: ${new Date(item.lastAccessedAt).toLocaleDateString()})`,
              );
            }
          }

          if (deleted === 0) {
            // All oldest items are the current item, cannot recover
            throw new Error(
              "Storage quota exceeded and cannot delete current item",
            );
          }

          // Retry will happen in next loop iteration
        } else {
          // Not a quota error, rethrow
          throw error;
        }
      }
    }

    throw new Error(
      `Storage quota exceeded after ${maxRetries} cleanup attempts`,
    );
  }

  /**
   * Check if an error is a storage quota/disk full error
   * Supports both IndexedDB and SQLite error formats
   */
  private isQuotaError(error: unknown): boolean {
    if (error instanceof Error) {
      const name = error.name.toLowerCase();
      const message = error.message.toLowerCase();

      // IndexedDB quota error detection
      if (
        name === "quotaexceedederror" ||
        name.includes("quota") ||
        message.includes("quota exceeded") ||
        message.includes("storage quota")
      ) {
        return true;
      }

      // SQLite disk full error detection
      // SQLITE_FULL error code: database or disk is full
      if (
        message.includes("sqlite_full") ||
        message.includes("disk is full") ||
        message.includes("database is full") ||
        message.includes("no space left")
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Semantic search within a single paper
   *
   * @param query Search query
   * @param itemKey Zotero item key
   * @param topK Number of results (default: 5)
   */
  async searchPaper(
    query: string,
    itemKey: string,
    topK = 5,
  ): Promise<SemanticSearchResult[]> {
    if (!(await this.isAvailable())) {
      return [];
    }

    try {
      // Get query embedding
      const provider = await this.providerFactory.getProvider();
      if (!provider) {
        return [];
      }

      const modelId = provider.modelId;
      const queryVector = await provider.embed(query);

      // Search in vector store with modelId filter
      const results = await this.vectorStore.search(queryVector, {
        topK,
        itemKeys: [itemKey],
        modelId,
      });

      // Update last accessed time (fire and forget, don't block search)
      this.vectorStore.updateLastAccessed(itemKey, modelId).catch(() => {
        // Ignore errors from access record update
      });

      return results;
    } catch (error) {
      ztoolkit.log(
        "[RAGService] Search failed:",
        getErrorMessage(error),
      );
      return [];
    }
  }

  /**
   * Semantic search across multiple papers
   *
   * @param query Search query
   * @param itemKeys Array of Zotero item keys
   * @param options Search options
   */
  async searchAcrossPapers(
    query: string,
    itemKeys: string[],
    options: SemanticSearchOptions = {},
  ): Promise<SemanticSearchResult[]> {
    if (!(await this.isAvailable())) {
      return [];
    }

    try {
      const provider = await this.providerFactory.getProvider();
      if (!provider) {
        return [];
      }

      const modelId = provider.modelId;
      const queryVector = await provider.embed(query);

      const results = await this.vectorStore.search(queryVector, {
        ...options,
        itemKeys,
        modelId,
      });

      // Update last accessed time for all items with results (fire and forget)
      const itemsWithResults = new Set(results.map((r) => r.itemKey));
      for (const itemKey of itemsWithResults) {
        this.vectorStore.updateLastAccessed(itemKey, modelId).catch(() => {
          // Ignore errors from access record update
        });
      }

      return results;
    } catch (error) {
      ztoolkit.log(
        "[RAGService] Cross-paper search failed:",
        getErrorMessage(error),
      );
      return [];
    }
  }

  /**
   * Check if a paper has been indexed with the current model
   */
  async isIndexed(itemKey: string): Promise<boolean> {
    const provider = await this.providerFactory.getProvider();
    if (!provider) {
      return false;
    }
    return this.vectorStore.has(itemKey, provider.modelId);
  }

  /**
   * Get index status for a paper with the current model
   */
  async getItemStatus(itemKey: string): Promise<ItemIndexStatus> {
    const provider = await this.providerFactory.getProvider();
    if (!provider) {
      return { indexed: false, chunkCount: 0 };
    }
    return this.vectorStore.getItemStatus(itemKey, provider.modelId);
  }

  /**
   * Remove index for a paper (all models)
   */
  async removeIndex(itemKey: string): Promise<void> {
    await this.vectorStore.delete(itemKey);
    await this.vectorStore.deleteAllAccessRecords(itemKey);
    ztoolkit.log(`[RAGService] Removed index for item: ${itemKey}`);
  }

  /**
   * Remove index for a paper with specific model
   */
  async removeIndexByModel(itemKey: string, modelId: string): Promise<void> {
    await this.vectorStore.deleteByModel(itemKey, modelId);
    await this.vectorStore.deleteAccessRecord(itemKey, modelId);
    ztoolkit.log(`[RAGService] Removed index for item: ${itemKey}, model: ${modelId}`);
  }

  /**
   * Clear all indexes
   */
  async clearAllIndexes(): Promise<void> {
    await this.vectorStore.clear();
    await this.vectorStore.clearAccessRecords();
    ztoolkit.log("[RAGService] All indexes cleared");
  }

  /**
   * Get total indexed entry count
   */
  async getIndexCount(): Promise<number> {
    return this.vectorStore.count();
  }

  /**
   * Get indexed entry count for current model
   */
  async getIndexCountByModel(): Promise<number> {
    const provider = await this.providerFactory.getProvider();
    if (!provider) {
      return 0;
    }
    return this.vectorStore.countByModel(provider.modelId);
  }

  /**
   * Invalidate provider cache (call when settings change)
   */
  invalidateCache(): void {
    this.providerFactory.invalidateCache();
  }
}

// Singleton instance
let ragService: RAGService | null = null;

export function getRAGService(): RAGService {
  if (!ragService) {
    ragService = new RAGService();
  }
  return ragService;
}

export function destroyRAGService(): void {
  ragService = null;
}
