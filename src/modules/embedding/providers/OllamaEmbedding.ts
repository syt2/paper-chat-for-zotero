/**
 * OllamaEmbedding - Ollama local Embedding API implementation
 *
 * Uses nomic-embed-text model by default
 * Docs: https://ollama.ai/library/nomic-embed-text
 */

import type { EmbeddingProvider } from "../../../types/embedding";
import { EMBEDDING_MODELS } from "../../../types/embedding";
import { getErrorMessage } from "../../../utils/common";

const MODEL_INFO = EMBEDDING_MODELS.ollama;

export class OllamaEmbedding implements EmbeddingProvider {
  readonly name = "Ollama Embedding";
  readonly type = "ollama" as const;
  readonly dimension = MODEL_INFO.dimension;

  private baseUrl: string;
  private model: string;

  constructor(baseUrl?: string, model?: string) {
    this.baseUrl = baseUrl || "http://localhost:11434";
    this.model = model || MODEL_INFO.modelId;
  }

  get modelId(): string {
    return `ollama:${this.model}`;
  }

  async embed(text: string): Promise<number[]> {
    const url = `${this.baseUrl}/api/embed`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Ollama Embedding API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      embeddings?: number[][];
    };

    if (!data.embeddings || data.embeddings.length === 0 || !data.embeddings[0]) {
      throw new Error("Invalid response from Ollama Embedding API");
    }

    return data.embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    // Ollama supports batch embedding via array input
    const url = `${this.baseUrl}/api/embed`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Ollama Embedding API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      embeddings?: number[][];
    };

    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw new Error("Invalid response from Ollama Embedding API");
    }

    return data.embeddings;
  }

  async testConnection(): Promise<boolean> {
    try {
      // First check if Ollama is running and get available models
      const tagsResponse = await fetch(`${this.baseUrl}/api/tags`);
      if (!tagsResponse.ok) {
        return false;
      }

      // Check if the embedding model is available (reuse the response)
      const data = (await tagsResponse.json()) as {
        models?: Array<{ name: string }>;
      };

      if (!data.models) {
        return false;
      }

      // Check for common embedding models
      const embeddingModels = [
        "nomic-embed-text",
        "mxbai-embed-large",
        "all-minilm",
        "snowflake-arctic-embed",
      ];

      const hasModel = data.models.some((m) =>
        embeddingModels.some((em) => m.name.includes(em)),
      );

      if (!hasModel) {
        ztoolkit.log(
          "[OllamaEmbedding] Embedding model not found:",
          this.model,
        );
        return false;
      }

      // Try a test embedding
      const result = await this.embed("test");
      return Array.isArray(result) && result.length > 0;
    } catch (error) {
      ztoolkit.log(
        "[OllamaEmbedding] testConnection failed:",
        getErrorMessage(error),
      );
      return false;
    }
  }

  /**
   * Check if Ollama has an embedding model installed
   */
  async hasEmbeddingModel(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        return false;
      }

      const data = (await response.json()) as {
        models?: Array<{ name: string }>;
      };

      if (!data.models) {
        return false;
      }

      // Check for common embedding models
      const embeddingModels = [
        "nomic-embed-text",
        "mxbai-embed-large",
        "all-minilm",
        "snowflake-arctic-embed",
      ];

      return data.models.some((m) =>
        embeddingModels.some((em) => m.name.includes(em)),
      );
    } catch {
      return false;
    }
  }

  /**
   * Check if Ollama service is running
   */
  async isOllamaRunning(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
