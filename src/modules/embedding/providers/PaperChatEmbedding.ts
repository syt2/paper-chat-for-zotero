/**
 * PaperChatEmbedding - PaperChat Embedding API implementation
 *
 * Uses login-based authentication via AuthManager
 * Automatically selects embedding model from available models
 */

import type { EmbeddingProvider, EmbeddingProviderType } from "../../../types/embedding";
import { getAuthManager } from "../../auth";
import { getPref } from "../../../utils/prefs";
import { getErrorMessage } from "../../../utils/common";
import { BUILTIN_PROVIDERS } from "../../providers/ProviderManager";

// Preferred embedding models in priority order
const PREFERRED_MODELS = [
  "text-embedding-3-small",
  "text-embedding-3-large",
  "text-embedding-ada-002",
];

// Batch size for embedding requests
const BATCH_SIZE = 2048;

/**
 * Check if a model name indicates it's an embedding model
 */
export function isEmbeddingModel(modelName: string): boolean {
  const lowerName = modelName.toLowerCase();
  return lowerName.includes("embedding") || lowerName.includes("text-embed");
}

/**
 * Get available embedding models from cached PaperChat models
 */
export function getAvailableEmbeddingModels(): string[] {
  const cachedModels = getPref("paperchatModelsCache") as string;
  if (!cachedModels) {
    return [];
  }

  try {
    const allModels = JSON.parse(cachedModels) as string[];
    return allModels.filter(isEmbeddingModel);
  } catch {
    return [];
  }
}

/**
 * Select the best embedding model from available models
 */
function selectBestModel(availableModels: string[]): string | null {
  if (availableModels.length === 0) {
    return null;
  }

  // Try preferred models first
  for (const preferred of PREFERRED_MODELS) {
    const found = availableModels.find(
      (m) => m.toLowerCase() === preferred.toLowerCase(),
    );
    if (found) {
      return found;
    }
  }

  // Fall back to first available embedding model
  return availableModels[0];
}

export class PaperChatEmbedding implements EmbeddingProvider {
  readonly name = "PaperChat Embedding";
  readonly type: EmbeddingProviderType = "paperchat";
  readonly dimension = 0; // Unknown until first embedding

  private baseUrl: string;
  private selectedModel: string;

  constructor(model?: string) {
    this.baseUrl = BUILTIN_PROVIDERS.paperchat.defaultBaseUrl;

    // Select model
    if (model) {
      this.selectedModel = model;
    } else {
      const availableModels = getAvailableEmbeddingModels();
      const bestModel = selectBestModel(availableModels);
      if (!bestModel) {
        throw new Error("No embedding model available in PaperChat");
      }
      this.selectedModel = bestModel;
    }
  }

  get modelId(): string {
    return `paperchat:${this.selectedModel}`;
  }

  private getApiKey(): string {
    const authManager = getAuthManager();
    const apiKey = authManager.getApiKey();
    if (!apiKey) {
      throw new Error("PaperChat not logged in");
    }
    return apiKey;
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
    const apiKey = this.getApiKey();

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.selectedModel,
        input: texts,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `PaperChat Embedding API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      data?: Array<{ embedding: number[]; index: number }>;
    };

    if (!data.data || data.data.length !== texts.length) {
      throw new Error("Invalid response from PaperChat Embedding API");
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
        "[PaperChatEmbedding] testConnection failed:",
        getErrorMessage(error),
      );
      return false;
    }
  }

  /**
   * Get the currently selected model
   */
  getSelectedModel(): string {
    return this.selectedModel;
  }
}
