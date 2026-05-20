/**
 * EmbeddingProviderFactory - Auto-detect and create embedding providers
 *
 * Reuses API keys from existing Chat Provider configurations.
 * PaperChat embedding is used only when PaperChat is the active chat provider.
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
import { getErrorMessage } from "../../utils/common";
import { getString } from "../../utils/locale";
import {
  PaperChatEmbedding,
  getAvailableEmbeddingModels,
} from "./providers/PaperChatEmbedding";

export class EmbeddingProviderFactory {
  private cachedProvider: EmbeddingProvider | null = null;
  private cachedStatus: EmbeddingStatus | null = null;
  private cacheTimestamp: number = 0;
  private cachedActiveProviderId: string | null = null;
  private readonly CACHE_TTL = 30000; // 30 seconds cache

  /**
   * Get current embedding status for UI display
   */
  async getStatus(): Promise<EmbeddingStatus> {
    const activeProviderId = getProviderManager().getActiveProviderId();

    // Return cached status if fresh
    if (
      this.cachedStatus &&
      this.cachedActiveProviderId === activeProviderId &&
      Date.now() - this.cacheTimestamp < this.CACHE_TTL
    ) {
      return this.cachedStatus;
    }

    const status = await this.detectStatus();
    this.cachedStatus = status;
    this.cacheTimestamp = Date.now();
    this.cachedActiveProviderId = activeProviderId;
    return status;
  }

  /**
   * Detect available embedding provider status
   */
  private async detectStatus(): Promise<EmbeddingStatus> {
    const providerManager = getProviderManager();
    const allConfigs = providerManager.getAllConfigs();
    const activeProviderId = providerManager.getActiveProviderId();

    const getApiKeyConfig = (providerId: string) =>
      allConfigs.find((c) => c.id === providerId && c.enabled) as
        | ApiKeyProviderConfig
        | undefined;

    if (activeProviderId === "paperchat") {
      const paperChatStatus = this.detectPaperChatStatus();
      if (paperChatStatus) {
        return paperChatStatus;
      }
    }

    if (activeProviderId === "gemini" && getApiKeyConfig("gemini")?.apiKey) {
      return this.createGeminiStatus();
    }

    if (activeProviderId === "openai" && getApiKeyConfig("openai")?.apiKey) {
      return this.createOpenAIStatus();
    }

    const geminiConfig = getApiKeyConfig("gemini");
    if (geminiConfig?.apiKey) {
      return this.createGeminiStatus();
    }

    let ollamaRunningWithoutModel = false;
    const ollamaStatus = await this.detectOllamaStatus();
    if (ollamaStatus.available) {
      return ollamaStatus;
    }
    ollamaRunningWithoutModel = ollamaStatus.runningWithoutModel;

    const openaiConfig = getApiKeyConfig("openai");
    if (openaiConfig?.apiKey) {
      return this.createOpenAIStatus();
    }

    if (ollamaRunningWithoutModel) {
      return {
        available: false,
        provider: null,
        message: `⚠️ ${getString("pref-embedding-unavailable-ollama")}`,
      };
    }

    return {
      available: false,
      provider: null,
      message: `⚠️ ${getString("pref-embedding-unavailable-none")}`,
    };
  }

  private detectPaperChatStatus(): EmbeddingStatus | null {
    const authManager = getAuthManager();
    if (authManager.isLoggedIn() && authManager.getApiKey()) {
      const embeddingModels = getAvailableEmbeddingModels();
      if (embeddingModels.length > 0) {
        return {
          available: true,
          provider: "paperchat",
          message: `✅ ${getString("pref-embedding-status-paperchat", { args: { model: embeddingModels[0] } })}`,
        };
      }
    }

    return null;
  }

  private createGeminiStatus(): EmbeddingStatus {
    return {
      available: true,
      provider: "gemini",
      message: `✅ ${getString("pref-embedding-status-gemini")}`,
    };
  }

  private createOpenAIStatus(): EmbeddingStatus {
    return {
      available: true,
      provider: "openai",
      message: `✅ ${getString("pref-embedding-status-openai")}`,
    };
  }

  private async detectOllamaStatus(): Promise<
    | (EmbeddingStatus & { runningWithoutModel: false })
    | { available: false; runningWithoutModel: boolean }
  > {
    try {
      const ollama = new OllamaEmbedding();
      if (await ollama.isOllamaRunning()) {
        if (await ollama.hasEmbeddingModel()) {
          return {
            available: true,
            provider: "ollama",
            message: `✅ ${getString("pref-embedding-status-ollama")}`,
            runningWithoutModel: false,
          };
        }
        return {
          available: false,
          runningWithoutModel: true,
        };
      }
    } catch {
      // Ollama not available, continue checking
    }

    return {
      available: false,
      runningWithoutModel: false,
    };
  }

  /**
   * Get embedding provider instance
   * Returns null if no provider is available
   *
   * This is intentionally a local resolution step only. Connectivity is
   * verified either by explicit health checks or the first real embedding
   * request, so startup/background callers do not proactively hit remote
   * embedding endpoints.
   */
  async getProvider(): Promise<EmbeddingProvider | null> {
    const status = await this.getStatus();

    if (!status.available || !status.provider) {
      return null;
    }

    // Return cached provider if same type
    const activeProviderId = getProviderManager().getActiveProviderId();
    if (
      this.cachedProvider &&
      this.cachedProvider.type === status.provider &&
      this.cachedActiveProviderId === activeProviderId
    ) {
      return this.cachedProvider;
    }

    // Create new provider
    const provider = this.createProvider(status.provider);
    this.cachedProvider = provider;
    return provider;
  }

  /**
   * Create provider instance by type
   */
  private createProvider(
    type: EmbeddingProviderType,
  ): EmbeddingProvider | null {
    const providerManager = getProviderManager();
    const allConfigs = providerManager.getAllConfigs();

    switch (type) {
      case "paperchat": {
        try {
          return new PaperChatEmbedding();
        } catch (error) {
          ztoolkit.log(
            "[EmbeddingProviderFactory] PaperChat embedding failed:",
            getErrorMessage(error),
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
        return new OllamaEmbedding();
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
    this.cachedActiveProviderId = null;
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
