const MAX_EMBEDDING_INPUT_LENGTH = 8192;

export function normalizeEmbeddingInput(text: string, index = 0): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (normalized.length === 0) {
    throw new Error(`Embedding input at index ${index} is empty`);
  }

  return normalized.length > MAX_EMBEDDING_INPUT_LENGTH
    ? normalized.slice(0, MAX_EMBEDDING_INPUT_LENGTH)
    : normalized;
}

export function normalizeEmbeddingBatch(texts: string[]): string[] {
  return texts.map((text, index) => normalizeEmbeddingInput(text, index));
}

export function tryNormalizeEmbeddingInput(text: string): string | null {
  try {
    return normalizeEmbeddingInput(text);
  } catch {
    return null;
  }
}
