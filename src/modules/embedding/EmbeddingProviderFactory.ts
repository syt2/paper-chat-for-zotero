/**
 * EmbeddingProviderFactory - Auto-detect and create embedding providers
 *
 * Reuses API keys from existing Chat Provider configurations
 * Priority: PaperChat (login-based) > Gemini (free) > Ollama (local) > OpenAI (paid)
 */

import type {
  EmbeddingProvider,
  EmbeddingStatus,
  EmbeddingProviderType,
} from "../../types/embedding";
import type { ApiKeyProviderConfig } from "../../types/provider";
import { getProviderManager } from "../providers/ProviderManager";
import { getAuthManager } from "../auth";
import { GeminiEmbedding } from "./providers/GeminiEmbedding";
import { OpenAIEmbedding } from "./providers/OpenAIEmbedding";
import { OllamaEmbedding } from "./providers/OllamaEmbedding";
import {
  PaperChatEmbedding,
  getAvailableEmbeddingModels,
} from "./providers/PaperChatEmbedding";

export class EmbeddingProviderFactory {
  private cachedProvider: EmbeddingProvider | null = null;
  private cachedStatus: EmbeddingStatus | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL = 30000; // 30 seconds cache

  /**
   * Get current embedding status for UI display
   */
  async getStatus(): Promise<EmbeddingStatus> {
    // Return cached status if fresh
    if (this.cachedStatus && Date.now() - this.cacheTimestamp < this.CACHE_TTL) {
      return this.cachedStatus;
    }

    const status = await this.detectStatus();
    this.cachedStatus = status;
    this.cacheTimestamp = Date.now();
    return status;
  }

  /**
   * Detect available embedding provider status
   */
  private async detectStatus(): Promise<EmbeddingStatus> {
    const providerManager = getProviderManager();
    const allConfigs = providerManager.getAllConfigs();

    // 1. Check PaperChat (priority: highest - login-based service)
    const authManager = getAuthManager();
    if (authManager.isLoggedIn() && authManager.getApiKey()) {
      const embeddingModels = getAvailableEmbeddingModels();
      if (embeddingModels.length > 0) {
        return {
          available: true,
          provider: "paperchat",
          message: `✅ 使用 PaperChat Embedding (${embeddingModels[0]})`,
        };
      }
    }

    // 2. Check Gemini (priority: free)
    const geminiConfig = allConfigs.find(
      (c) => c.id === "gemini" && c.enabled,
    ) as ApiKeyProviderConfig | undefined;

    if (geminiConfig?.apiKey) {
      return {
        available: true,
        provider: "gemini",
        message: "✅ 使用 Gemini Embedding (免费)",
      };
    }

    // 3. Check Ollama (priority: local)
    let ollamaRunningWithoutModel = false;
    try {
      const ollama = new OllamaEmbedding();
      if (await ollama.isOllamaRunning()) {
        if (await ollama.hasEmbeddingModel()) {
          return {
            available: true,
            provider: "ollama",
            message: "✅ 使用 Ollama 本地 Embedding",
          };
        } else {
          // Ollama is running but no embedding model - continue checking other providers
          ollamaRunningWithoutModel = true;
        }
      }
    } catch {
      // Ollama not available, continue checking
    }

    // 4. Check OpenAI
    const openaiConfig = allConfigs.find(
      (c) => c.id === "openai" && c.enabled,
    ) as ApiKeyProviderConfig | undefined;

    if (openaiConfig?.apiKey) {
      return {
        available: true,
        provider: "openai",
        message: "✅ 使用 OpenAI Embedding",
      };
    }

    // No embedding provider available
    // If Ollama is running without embedding model, show specific message
    if (ollamaRunningWithoutModel) {
      return {
        available: false,
        provider: null,
        message:
          "⚠️ Ollama 已运行但未安装 Embedding 模型\n请运行: ollama pull nomic-embed-text",
      };
    }

    return {
      available: false,
      provider: null,
      message: "⚠️ 无可用 Embedding 服务\n请登录 PaperChat 或配置 API Key",
    };
  }

  /**
   * Get embedding provider instance
   * Returns null if no provider is available
   */
  async getProvider(): Promise<EmbeddingProvider | null> {
    const status = await this.getStatus();

    if (!status.available || !status.provider) {
      return null;
    }

    // Return cached provider if same type
    if (this.cachedProvider && this.cachedProvider.type === status.provider) {
      return this.cachedProvider;
    }

    // Create new provider
    const provider = await this.createProvider(status.provider);
    this.cachedProvider = provider;
    return provider;
  }

  /**
   * Create provider instance by type
   */
  private async createProvider(
    type: EmbeddingProviderType,
  ): Promise<EmbeddingProvider | null> {
    const providerManager = getProviderManager();
    const allConfigs = providerManager.getAllConfigs();

    switch (type) {
      case "paperchat": {
        try {
          const provider = new PaperChatEmbedding();
          if (await provider.testConnection()) {
            return provider;
          }
        } catch (error) {
          ztoolkit.log(
            "[EmbeddingProviderFactory] PaperChat embedding failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
        return null;
      }

      case "gemini": {
        const config = allConfigs.find(
          (c) => c.id === "gemini" && c.enabled,
        ) as ApiKeyProviderConfig | undefined;

        if (config?.apiKey) {
          return new GeminiEmbedding(config.apiKey, config.baseUrl);
        }
        return null;
      }

      case "ollama": {
        const ollama = new OllamaEmbedding();
        if (await ollama.testConnection()) {
          return ollama;
        }
        return null;
      }

      case "openai": {
        const openaiConfig = allConfigs.find(
          (c) => c.id === "openai" && c.enabled,
        ) as ApiKeyProviderConfig | undefined;

        if (openaiConfig?.apiKey) {
          return new OpenAIEmbedding(openaiConfig.apiKey, openaiConfig.baseUrl);
        }
        return null;
      }

      default:
        return null;
    }
  }

  /**
   * Invalidate cache when provider config changes
   */
  invalidateCache(): void {
    this.cachedProvider = null;
    this.cachedStatus = null;
    this.cacheTimestamp = 0;
    ztoolkit.log("[EmbeddingProviderFactory] Cache invalidated");
  }

  /**
   * Test if current provider is working
   */
  async testConnection(): Promise<boolean> {
    const provider = await this.getProvider();
    if (!provider) {
      return false;
    }
    return provider.testConnection();
  }
}

// Singleton instance
let embeddingProviderFactory: EmbeddingProviderFactory | null = null;

export function getEmbeddingProviderFactory(): EmbeddingProviderFactory {
  if (!embeddingProviderFactory) {
    embeddingProviderFactory = new EmbeddingProviderFactory();
  }
  return embeddingProviderFactory;
}

export function destroyEmbeddingProviderFactory(): void {
  if (embeddingProviderFactory) {
    embeddingProviderFactory.invalidateCache();
    embeddingProviderFactory = null;
  }
}
