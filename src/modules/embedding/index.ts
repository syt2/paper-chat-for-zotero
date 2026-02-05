/**
 * Embedding Module - RAG and semantic search capabilities
 */

// Main service
export { RAGService, getRAGService, destroyRAGService } from "./RAGService";

// Provider factory
export {
  EmbeddingProviderFactory,
  getEmbeddingProviderFactory,
  destroyEmbeddingProviderFactory,
} from "./EmbeddingProviderFactory";

// Vector store
export {
  VectorStore,
  getVectorStore,
  destroyVectorStore,
} from "./VectorStore";

// Chunk splitter
export { ChunkSplitter, splitText, splitTextWithPages } from "./ChunkSplitter";

// Providers
export {
  GeminiEmbedding,
  OpenAIEmbedding,
  OllamaEmbedding,
} from "./providers";

// Utils
export { cosineSimilarity, findTopKSimilar } from "./utils/cosine";
export { hashText, hashTexts } from "./utils/hash";

// Re-export types
export type {
  EmbeddingProvider,
  EmbeddingProviderType,
  EmbeddingStatus,
  TextChunk,
  VectorEntry,
  SemanticSearchResult,
  SemanticSearchOptions,
  ItemIndexStatus,
  ChunkOptions,
} from "../../types/embedding";
