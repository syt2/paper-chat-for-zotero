/**
 * Embedding Types - RAG and semantic search type definitions
 */

/**
 * Supported embedding provider types
 */
export type EmbeddingProviderType = "paperchat" | "gemini" | "openai" | "ollama";

/**
 * Embedding provider status for UI display
 */
export interface EmbeddingStatus {
  /** Whether embedding service is available */
  available: boolean;
  /** Current provider type (null if unavailable) */
  provider: EmbeddingProviderType | null;
  /** Human-readable status message for UI */
  message: string;
}

/**
 * Embedding provider interface
 */
export interface EmbeddingProvider {
  /** Provider name for display */
  readonly name: string;
  /** Provider type */
  readonly type: EmbeddingProviderType;
  /** Full model identifier for storage (e.g., "gemini:text-embedding-004") */
  readonly modelId: string;
  /** Embedding vector dimension (may be 0 if unknown until first embedding) */
  readonly dimension: number;

  /** Generate embedding for single text */
  embed(text: string): Promise<number[]>;

  /** Generate embeddings for multiple texts (batch) */
  embedBatch(texts: string[]): Promise<number[][]>;

  /** Test if provider is available */
  testConnection(): Promise<boolean>;
}

/**
 * Text chunk after splitting
 */
export interface TextChunk {
  /** Chunk index within the document */
  index: number;
  /** Chunk text content */
  text: string;
  /** Hash of text for change detection (using djb2 algorithm) */
  hash: string;
  /** Optional page number */
  page?: number;
}

/**
 * Vector entry stored in VectorStore
 */
export interface VectorEntry {
  /** Unique ID: `${itemKey}_${modelId}_${chunkIndex}` */
  id: string;
  /** Zotero item key */
  itemKey: string;
  /** Embedding model identifier (e.g., "gemini:text-embedding-004") */
  modelId: string;
  /** Chunk index within the item */
  chunkIndex: number;
  /** Original text content */
  text: string;
  /** Embedding vector */
  vector: number[];
  /** Metadata */
  metadata: {
    /** Content hash for change detection */
    hash: string;
    /** Page number (if available) */
    page?: number;
    /** Section title (if available) */
    section?: string;
  };
  /** Timestamp when this entry was created */
  createdAt: number;
}

/**
 * Semantic search result
 */
export interface SemanticSearchResult {
  /** Original text content */
  text: string;
  /** Cosine similarity score (0-1) */
  score: number;
  /** Zotero item key */
  itemKey: string;
  /** Chunk index */
  chunkIndex: number;
  /** Page number (if available) */
  page?: number;
}

/**
 * Options for text chunking
 */
export interface ChunkOptions {
  /** Maximum tokens per chunk (default: 512) */
  maxTokens?: number;
  /** Overlap tokens between chunks (default: 50) */
  overlap?: number;
  /** Separators in priority order */
  separators?: string[];
}

/**
 * Options for semantic search
 */
export interface SemanticSearchOptions {
  /** Number of results to return (default: 5) */
  topK?: number;
  /** Minimum similarity threshold (default: 0) */
  minScore?: number;
  /** Filter by specific item keys */
  itemKeys?: string[];
  /** Filter by model ID (required for correct similarity matching) */
  modelId?: string;
}

/**
 * Index status for a Zotero item
 */
export interface ItemIndexStatus {
  /** Whether the item is indexed (for the specified modelId) */
  indexed: boolean;
  /** Number of chunks */
  chunkCount: number;
  /** Last indexed timestamp */
  lastIndexedAt?: number;
  /** Model ID used for indexing */
  modelId?: string;
}

/**
 * Access record for LRU eviction tracking
 * Stored separately from vectors for efficient access time updates
 */
export interface AccessRecord {
  /** Unique ID: `${itemKey}_${modelId}` */
  id: string;
  /** Zotero item key */
  itemKey: string;
  /** Embedding model identifier */
  modelId: string;
  /** Last access timestamp (updated on search) */
  lastAccessedAt: number;
  /** First indexed timestamp */
  indexedAt: number;
  /** Number of chunks for this item (for size estimation) */
  chunkCount: number;
}

/**
 * Embedding model information
 */
export interface EmbeddingModelInfo {
  /** Model ID */
  modelId: string;
  /** Display name */
  name: string;
  /** Vector dimension */
  dimension: number;
  /** Max input tokens */
  maxInputTokens: number;
}

/**
 * Built-in embedding models
 * Note: PaperChat uses dynamic model selection from available models
 */
export const EMBEDDING_MODELS: Record<EmbeddingProviderType, EmbeddingModelInfo> = {
  paperchat: {
    modelId: "text-embedding-3-small", // Default preferred model
    name: "PaperChat Embedding",
    dimension: 1536, // text-embedding-3-small dimension
    maxInputTokens: 8191,
  },
  gemini: {
    modelId: "text-embedding-004",
    name: "Gemini Embedding",
    dimension: 768,
    maxInputTokens: 2048,
  },
  openai: {
    modelId: "text-embedding-3-small",
    name: "OpenAI Embedding",
    dimension: 1536,
    maxInputTokens: 8191,
  },
  ollama: {
    modelId: "nomic-embed-text",
    name: "Ollama Embedding",
    dimension: 768,
    maxInputTokens: 8192,
  },
};
