import { getErrorMessage } from "../../../utils/common";
import { getMemoryEmbeddingProvider } from "./MemoryEmbedding";
import { MemoryRepository } from "./MemoryRepository";
import type { Memory } from "./MemoryTypes";
import {
  embeddingSimilarity,
  jaccard,
  scoreEmbedding,
  scoreJaccard,
  tokenise,
} from "./MemoryScoring";

const DEDUP_THRESHOLD = 0.9;
const EMBEDDING_DEDUP_THRESHOLD = 0.92;
const DEDUP_WINDOW = 80;
const MAX_INJECT = 5;
const MIN_SCORE = 0.25;
const SEARCH_FETCH_LIMIT = 300;

export class MemorySearchService {
  constructor(private repository: MemoryRepository) {}

  private async getEmbeddingProvider() {
    return getMemoryEmbeddingProvider();
  }

  async createEmbedding(text: string): Promise<{
    embedding?: number[];
    embeddingModel?: string | null;
  }> {
    const provider = await this.getEmbeddingProvider();
    if (!provider) return {};

    try {
      const embedding = await provider.embed(text);
      return { embedding, embeddingModel: provider.modelId };
    } catch {
      return {};
    }
  }

  async isDuplicate(text: string, embedding?: number[]): Promise<boolean> {
    if (embedding) {
      const rows = await this.repository.listEmbeddedRows(DEDUP_WINDOW);
      for (const row of rows) {
        try {
          const vector = JSON.parse(row.embedding) as number[];
          if (
            embeddingSimilarity(embedding, vector) >= EMBEDDING_DEDUP_THRESHOLD
          ) {
            return true;
          }
        } catch {
          // Ignore malformed rows and keep checking.
        }
      }
      return false;
    }

    const rows = await this.repository.listTextRows(DEDUP_WINDOW);
    const newTokens = tokenise(text);
    for (const row of rows) {
      if (jaccard(newTokens, tokenise(row.text)) >= DEDUP_THRESHOLD) {
        return true;
      }
    }
    return false;
  }

  async search(query: string): Promise<Memory[]> {
    if (!query.trim()) return [];

    const memories = await this.repository.listRecent(SEARCH_FETCH_LIMIT);
    if (memories.length === 0) return [];

    const { embedding: queryEmbedding } = await this.createEmbedding(query);
    const now = Date.now();
    const queryTokens = tokenise(query);

    const scored = memories.map((memory) => {
      let score: number;
      if (
        queryEmbedding &&
        memory.embedding &&
        memory.embedding.length === queryEmbedding.length
      ) {
        try {
          const cosine = embeddingSimilarity(queryEmbedding, memory.embedding);
          score = scoreEmbedding(cosine, memory, now);
        } catch {
          score = scoreJaccard(memory, queryTokens, query, now);
        }
      } else {
        score = scoreJaccard(memory, queryTokens, query, now);
      }
      return { memory, score };
    });

    const top = scored
      .filter((entry) => entry.score > MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_INJECT)
      .map((entry) => entry.memory);

    if (top.length > 0) {
      this.repository
        .updateAccessStats(
          top.map((memory) => memory.id),
          now,
        )
        .catch((err) => {
          ztoolkit.log(
            "[MemorySearchService] Failed to update access stats:",
            getErrorMessage(err),
          );
        });
    }

    return top;
  }
}
