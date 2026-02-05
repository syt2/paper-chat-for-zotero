/**
 * Cosine Similarity - Vector similarity calculation
 */

/**
 * Calculate cosine similarity between two vectors
 *
 * @param a First vector
 * @param b Second vector
 * @returns Similarity score between 0 and 1
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch: ${a.length} vs ${b.length}`,
    );
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (normA * normB);
}

/**
 * Find top-K similar vectors from a list
 *
 * @param query Query vector
 * @param vectors List of vectors with IDs
 * @param topK Number of results to return
 * @returns Top-K similar vectors with scores
 */
export function findTopKSimilar<T extends { id: string; vector: number[] }>(
  query: number[],
  vectors: T[],
  topK: number,
): Array<{ item: T; score: number }> {
  const scores = vectors.map((item) => ({
    item,
    score: cosineSimilarity(query, item.vector),
  }));

  scores.sort((a, b) => b.score - a.score);

  return scores.slice(0, topK);
}
