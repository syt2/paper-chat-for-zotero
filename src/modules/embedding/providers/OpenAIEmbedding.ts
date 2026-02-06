/**
 * OpenAIEmbedding - OpenAI Embedding API implementation
 *
 * Docs: https://platform.openai.com/docs/guides/embeddings
 */

import type { EmbeddingProvider } from "../../../types/embedding";
import { EMBEDDING_MODELS } from "../../../types/embedding";
import { getErrorMessage } from "../../../utils/common";

const MODEL_INFO = EMBEDDING_MODELS.openai;
const BATCH_SIZE = 2048; // OpenAI supports up to 2048 texts per batch

export class OpenAIEmbedding implements EmbeddingProvider {
  readonly name = "OpenAI Embedding";
  readonly type = "openai" as const;
  readonly modelId = `openai:${MODEL_INFO.modelId}`;
  readonly dimension = MODEL_INFO.dimension;

  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || "https://api.openai.com/v1";
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
    const url = `${this.baseUrl}/embeddings`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL_INFO.modelId,
        input: texts,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI Embedding API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      data?: Array<{ embedding: number[]; index: number }>;
    };

    if (!data.data || data.data.length !== texts.length) {
      throw new Error("Invalid response from OpenAI Embedding API");
    }

    // Sort by index to ensure correct order
    const sorted = data.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }

  async testConnection(): Promise<boolean> {
    try {
      const result = await this.embed("test");
      return Array.isArray(result) && result.length > 0;
    } catch (error) {
      ztoolkit.log(
        "[OpenAIEmbedding] testConnection failed:",
        getErrorMessage(error),
      );
      return false;
    }
  }
}
