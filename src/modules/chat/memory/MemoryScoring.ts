import { cosineSimilarity } from "../../embedding/utils/cosine";
import type { Memory } from "./MemoryTypes";

const W_JACCARD = 0.5;
const W_CONTAINS = 0.25;
const W_RECENCY = 0.15;
const W_IMPORTANCE = 0.1;

const W_COSINE = 0.7;
const WE_RECENCY = 0.15;
const WE_IMPORTANCE = 0.15;

export function tokenise(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/\w+/g) || []);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

export function scoreJaccard(
  memory: Memory,
  queryTokens: Set<string>,
  queryRaw: string,
  now: number,
): number {
  const memoryTokens = tokenise(memory.text);
  const jaccardScore = jaccard(queryTokens, memoryTokens);
  const containsBoost = memory.text
    .toLowerCase()
    .includes(queryRaw.toLowerCase())
    ? 1
    : 0;
  const ageDays = (now - memory.createdAt) / (1000 * 86400);
  const recencyScore = Math.exp(-ageDays / 30);

  return (
    W_JACCARD * jaccardScore +
    W_CONTAINS * containsBoost +
    W_RECENCY * recencyScore +
    W_IMPORTANCE * memory.importance
  );
}

export function scoreEmbedding(
  cosine: number,
  memory: Memory,
  now: number,
): number {
  const ageDays = (now - memory.createdAt) / (1000 * 86400);
  const recencyScore = Math.exp(-ageDays / 30);
  return (
    W_COSINE * cosine +
    WE_RECENCY * recencyScore +
    WE_IMPORTANCE * memory.importance
  );
}

export function embeddingSimilarity(a: number[], b: number[]): number {
  return cosineSimilarity(a, b);
}

export function rowToMemory(row: Record<string, unknown>): Memory {
  const memory: Memory = {
    id: row.id as string,
    libraryId: row.library_id as number,
    text: row.text as string,
    category: row.category as Memory["category"],
    importance: row.importance as number,
    createdAt: row.created_at as number,
    accessCount: row.access_count as number,
    lastAccessedAt: row.last_accessed_at as number,
  };
  if (row.embedding) {
    try {
      memory.embedding = JSON.parse(row.embedding as string);
    } catch {
      // Ignore malformed rows and continue with text-only search.
    }
  }
  if (row.embedding_model) {
    memory.embeddingModel = row.embedding_model as string;
  }
  return memory;
}
