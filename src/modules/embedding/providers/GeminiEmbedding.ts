/**
 * GeminiEmbedding - Google Gemini Embedding API implementation
 *
 * Uses text-embedding-004 model (free tier available)
 * Docs: https://ai.google.dev/gemini-api/docs/embeddings
 */

import type { EmbeddingProvider } from "../../../types/embedding";
import { EMBEDDING_MODELS } from "../../../types/embedding";
import { getErrorMessage } from "../../../utils/common";

const MODEL_INFO = EMBEDDING_MODELS.gemini;
const BATCH_SIZE = 100; // Gemini supports up to 100 texts per batch

export class GeminiEmbedding implements EmbeddingProvider {
  readonly name = "Gemini Embedding";
  readonly type = "gemini" as const;
  readonly modelId = `gemini:${MODEL_INFO.modelId}`;
  readonly dimension = MODEL_INFO.dimension;

  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl =
      baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    if (!results[0]) {
      throw new Error("Failed to generate embedding: empty result");
    }
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    // Split into batches if needed
    if (texts.length > BATCH_SIZE) {
      const results: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const batchResults = await this.embedBatchInternal(batch);
        results.push(...batchResults);
      }
      return results;
    }

    return this.embedBatchInternal(texts);
  }

  private async embedBatchInternal(texts: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/models/${MODEL_INFO.modelId}:batchEmbedContents?key=${this.apiKey}`;

    const requests = texts.map((text) => ({
      model: `models/${MODEL_INFO.modelId}`,
      content: {
        parts: [{ text }],
      },
    }));

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Gemini Embedding API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      embeddings?: Array<{ values: number[] }>;
    };

    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw new Error("Invalid response from Gemini Embedding API");
    }

    return data.embeddings.map((e) => e.values);
  }

  async testConnection(): Promise<boolean> {
    try {
      // Try to embed a simple test text
      const result = await this.embed("test");
      return (
        Array.isArray(result) &&
        result.length === this.dimension
      );
    } catch (error) {
      ztoolkit.log(
        "[GeminiEmbedding] testConnection failed:",
        getErrorMessage(error),
      );
      return false;
    }
  }
}
