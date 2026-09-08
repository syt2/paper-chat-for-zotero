import { MemoryRepository } from "./MemoryRepository";
import type { EmbeddingProvider } from "../../../types/embedding";
import { getErrorMessage } from "../../../utils/common";
import { getMemoryEmbeddingProvider } from "./MemoryEmbedding";
import { tryNormalizeEmbeddingInput } from "../../embedding/EmbeddingInput";

const REINDEX_BATCH_SIZE = 20;

export class MemoryIndexer {
  private running = new Map<string, Promise<void>>();
  private repository: MemoryRepository;

  constructor(libraryId: number) {
    this.repository = new MemoryRepository(libraryId);
  }

  async checkAndReindex(): Promise<void> {
    const provider = await getMemoryEmbeddingProvider();
    if (!provider || this.running.has(provider.modelId)) return;
    const run = this.reindexMissingEmbeddings(provider);
    this.running.set(provider.modelId, run);
    void run
      .catch((error) => {
        ztoolkit.log(
          "[MemoryIndexer] Background reindex failed:",
          getErrorMessage(error),
        );
      })
      .finally(() => {
        this.running.delete(provider.modelId);
      });
  }

  private async reindexMissingEmbeddings(
    provider: EmbeddingProvider,
  ): Promise<void> {
    const rows = await this.repository.listMissingEmbeddings(provider.modelId);
    for (let i = 0; i < rows.length; i += REINDEX_BATCH_SIZE) {
      const batch = rows
        .slice(i, i + REINDEX_BATCH_SIZE)
        .map((row) => ({
          ...row,
          input: tryNormalizeEmbeddingInput(row.text),
        }))
        .filter(
          (row): row is { id: string; text: string; input: string } =>
            row.input !== null,
        );
      if (!batch.length) continue;
      try {
        const vectors = await provider.embedBatch(
          batch.map((row) => row.input),
        );
        if (vectors.length !== batch.length)
          throw new Error("Memory embedding count mismatch");
        for (let j = 0; j < batch.length; j++) {
          if (
            !vectors[j]?.length ||
            vectors[j].some((value) => !Number.isFinite(value))
          ) {
            throw new Error("Invalid memory embedding vector");
          }
          await this.repository.saveEmbedding(
            batch[j].id,
            provider.modelId,
            batch[j].text,
            vectors[j],
          );
        }
      } catch (error) {
        ztoolkit.log(
          "[MemoryIndexer] Batch embed failed:",
          getErrorMessage(error),
        );
      }
    }
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
