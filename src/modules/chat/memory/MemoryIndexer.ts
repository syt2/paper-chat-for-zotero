import { getStorageDatabase } from "../db/StorageDatabase";
import { getErrorMessage } from "../../../utils/common";
import { getMemoryEmbeddingProvider } from "./MemoryEmbedding";
import { tryNormalizeEmbeddingInput } from "../../embedding/EmbeddingInput";

const REINDEX_BATCH_SIZE = 20;
const SETTING_EMBEDDING_MODEL_PREFIX = "memory_embedding_model_";

export class MemoryIndexer {
  constructor(private libraryId: number) {}

  private async getDb() {
    return getStorageDatabase().ensureInit();
  }

  private get embeddingModelKey(): string {
    return `${SETTING_EMBEDDING_MODEL_PREFIX}${this.libraryId}`;
  }

  async checkAndReindex(): Promise<void> {
    const provider = await getMemoryEmbeddingProvider();
    if (!provider) return;

    const db = await this.getDb();
    const rows = (await db.queryAsync(
      "SELECT value FROM settings WHERE key = ?",
      [this.embeddingModelKey],
    )) || [];
    const storedModel: string | null =
      rows.length > 0 ? (rows[0].value as string) : null;
    const currentModel = provider.modelId;

    if (storedModel !== currentModel) {
      ztoolkit.log(
        `[MemoryIndexer] Embedding model changed (${storedModel} -> ${currentModel}), reindexing...`,
      );
      await db.queryAsync(
        "UPDATE memories SET embedding = NULL, embedding_model = NULL WHERE library_id = ?",
        [this.libraryId],
      );
      await db.queryAsync(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        [this.embeddingModelKey, currentModel],
      );
    }

    this.reindexMissingEmbeddings().catch((err) => {
      ztoolkit.log(
        "[MemoryIndexer] Background reindex failed:",
        getErrorMessage(err),
      );
    });
  }

  private async reindexMissingEmbeddings(): Promise<void> {
    const provider = await getMemoryEmbeddingProvider();
    if (!provider) return;

    const db = await this.getDb();
    const rows = (await db.queryAsync(
      "SELECT id, text FROM memories WHERE library_id = ? AND embedding IS NULL ORDER BY created_at DESC",
      [this.libraryId],
    )) || [];

    if (rows.length === 0) return;
    ztoolkit.log(`[MemoryIndexer] Reindexing ${rows.length} memories...`);

    const items = rows as Array<{ id: string; text: string }>;
    let indexed = 0;

    for (let i = 0; i < items.length; i += REINDEX_BATCH_SIZE) {
      const batch = items.slice(i, i + REINDEX_BATCH_SIZE);
      const normalizedBatch = batch
        .map((row) => ({
          ...row,
          text: tryNormalizeEmbeddingInput(row.text),
        }))
        .filter((row): row is { id: string; text: string } => row.text !== null);
      if (normalizedBatch.length === 0) {
        continue;
      }

      try {
        const vectors = await provider.embedBatch(
          normalizedBatch.map((row) => row.text),
        );
        for (let j = 0; j < normalizedBatch.length; j++) {
          if (!vectors[j]) continue;
          await db.queryAsync(
            "UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?",
            [JSON.stringify(vectors[j]), provider.modelId, normalizedBatch[j].id],
          );
          indexed++;
        }
      } catch (err) {
        ztoolkit.log(
          "[MemoryIndexer] Batch embed failed:",
          getErrorMessage(err),
        );
      }
    }

    ztoolkit.log(
      `[MemoryIndexer] Reindex complete: ${indexed}/${rows.length} memories embedded`,
    );
  }
}

const memoryIndexers = new Map<number, MemoryIndexer>();

export function getMemoryIndexer(libraryId?: number): MemoryIndexer {
  const libId = libraryId ?? Zotero.Libraries.userLibraryID;
  if (!memoryIndexers.has(libId)) {
    memoryIndexers.set(libId, new MemoryIndexer(libId));
  }
  return memoryIndexers.get(libId)!;
}

export function destroyMemoryIndexers(): void {
  memoryIndexers.clear();
}
