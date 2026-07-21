/**
 * ProviderManager - Central management of all AI providers
 */

import type {
  AIProvider,
  ProviderConfig,
  ProviderMetadata,
  ProviderStorageData,
  BuiltinProviderId,
  ApiKeyProviderConfig,
  PaperChatProviderConfig,
  ModelInfo,
  FallbackConfig,
  FallbackExecutionResult,
} from "../../types/provider";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
import { AnthropicProvider } from "./AnthropicProvider";
import { GeminiProvider } from "./GeminiProvider";
import { PaperChatProvider } from "./PaperChatProvider";
import { config } from "../../../package.json";
import { getErrorMessage } from "../../utils/common";
import { getPref } from "../../utils/prefs";

/**
 * Built-in provider metadata. Model lists are loaded from provider APIs or
 * user-added entries, not hard-coded here.
 */
export const BUILTIN_PROVIDERS: Record<BuiltinProviderId, ProviderMetadata> = {
  paperchat: {
    id: "paperchat",
    name: "PaperChat",
    description: "Login-based AI service with multi-model support",
    defaultBaseUrl: "https://paperchat.zotero.store/v1",
    website: "https://paperchat.zotero.store",
    type: "paperchat",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    description: "Native OpenAI API - GPT-4o, o3, etc.",
    defaultBaseUrl: "https://api.openai.com/v1",
    website: "https://platform.openai.com",
    type: "openai",
  },
  claude: {
    id: "claude",
    name: "Claude",
    description: "Anthropic Claude API - Claude 4, Claude 3.5, etc.",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    website: "https://console.anthropic.com",
    type: "anthropic",
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    description: "Google AI Gemini API - Gemini 2.5, 2.0, etc.",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    website: "https://ai.google.dev",
    type: "gemini",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek AI - DeepSeek Chat, Reasoner",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    website: "https://platform.deepseek.com",
    type: "openai-compatible",
  },
};

const PREFS_KEY = `${config.prefsPrefix}.providersConfig`;
const REMOVED_BUILTIN_PROVIDER_IDS = new Set(["mistral", "groq", "openrouter"]);

/**
 * Default fallback configuration
 * Auto-fallback is enabled by default (no explicit 'enabled' flag needed)
 */
const DEFAULT_FALLBACK_CONFIG: FallbackConfig = {
  fallbackProviderIds: [], // Legacy preference field, no longer used for request routing
  maxRetries: 3,
};

/**
 * Error patterns that allow retrying the current provider and model
 */
const RETRYABLE_ERROR_PATTERNS = [
  /rate.?limit/i,
  /too.?many.?requests/i,
  /429/,
  /timeout/i,
  /timed?.?out/i,
  /ETIMEDOUT/,
  /service.?unavailable/i,
  /503/,
  /502/,
  /bad.?gateway/i,
  /network.?error/i,
  /ECONNREFUSED/,
  /ENOTFOUND/,
  /fetch.?failed/i,
  /quota.?exceeded/i,
  /insufficient.?quota/i,
  /insufficient_user_quota/i,
  /额度不足/,
];

export interface ProviderRetryOptions {
  shouldRetry?: (
    error: Error,
    provider: AIProvider,
    completedRetries: number,
  ) => boolean | Promise<boolean>;
}

export class ProviderManager {
  private providers: Map<string, AIProvider> = new Map();
  private activeProviderId: string = "paperchat";
  private configs: ProviderConfig[] = [];
  private fallbackConfig: FallbackConfig = { ...DEFAULT_FALLBACK_CONFIG };
  private onProviderChangeCallback?: (providerId: string) => void;
  private prefsObserver: symbol | null = null;
  private isSavingPrefs = false;

  constructor() {
    this.loadFromPrefs();
    this.initializeProviders();
    this.registerPrefsObserver();
  }

  /**
   * Set callback for when active provider changes
   */
  setOnProviderChange(callback: (providerId: string) => void): void {
    this.onProviderChangeCallback = callback;
  }

  private notifyProviderChange(
    providerId: string = this.activeProviderId,
  ): void {
    this.onProviderChangeCallback?.(providerId);
  }

  private registerPrefsObserver(): void {
    if (
      typeof Zotero?.Prefs?.registerObserver !== "function" ||
      this.prefsObserver
    ) {
      return;
    }

    this.prefsObserver = Zotero.Prefs.registerObserver(
      PREFS_KEY,
      () => {
        if (this.isSavingPrefs) {
          return;
        }
        this.refresh(true);
      },
      true,
    );
  }

  /**
   * Load configuration from Zotero preferences
   */
  private loadFromPrefs(): void {
    try {
      const stored = Zotero.Prefs.get(PREFS_KEY, true) as string | undefined;
      ztoolkit.log(
        "[ProviderManager] Loading from prefs, stored:",
        stored ? "has data" : "empty",
      );

      if (stored) {
        const data: ProviderStorageData = JSON.parse(stored);
        const providers = data.providers || [];
        ztoolkit.log(
          "[ProviderManager] Parsed providers:",
          providers.map((p) => p.id),
        );
        ztoolkit.log(
          "[ProviderManager] Active provider ID:",
          data.activeProviderId,
        );

        // Check if config is valid (has paperchat provider)
        const hasPaperchat = providers.some((p) => p.id === "paperchat");
        if (!hasPaperchat) {
          ztoolkit.log(
            "[ProviderManager] No paperchat found, resetting to defaults",
          );
          // Invalid config, reset to defaults
          this.configs = this.getDefaultConfigs();
          this.activeProviderId = "paperchat";
          this.saveToPrefs();
          return;
        }

        this.activeProviderId = data.activeProviderId || "paperchat";
        const { configs, changed } = this.normalizeLoadedConfigs(providers);
        this.configs = configs;
        let prefsChanged = changed;
        if (
          !this.configs.some(
            (provider) => provider.id === this.activeProviderId,
          )
        ) {
          this.activeProviderId = "paperchat";
          prefsChanged = true;
        }
        // Load fallback config
        if (data.fallbackConfig) {
          const fallbackProviderIds = (
            data.fallbackConfig.fallbackProviderIds || []
          ).filter((id) => !REMOVED_BUILTIN_PROVIDER_IDS.has(id));
          this.fallbackConfig = {
            ...DEFAULT_FALLBACK_CONFIG,
            ...data.fallbackConfig,
            fallbackProviderIds,
          };
          if (
            fallbackProviderIds.length !==
            (data.fallbackConfig.fallbackProviderIds || []).length
          ) {
            prefsChanged = true;
          }
        }
        if (prefsChanged) {
          this.saveToPrefs();
        }
        ztoolkit.log(
          "[ProviderManager] Loaded configs:",
          this.configs.map((c) => ({ id: c.id, enabled: c.enabled })),
        );
        ztoolkit.log("[ProviderManager] Fallback config:", this.fallbackConfig);
      } else {
        ztoolkit.log("[ProviderManager] No stored config, using defaults");
        this.configs = this.getDefaultConfigs();
      }
    } catch (e) {
      ztoolkit.log("[ProviderManager] Error loading prefs:", e);
      this.configs = this.getDefaultConfigs();
    }
  }

  /**
   * Save configuration to Zotero preferences
   */
  saveToPrefs(): void {
    const data: ProviderStorageData = {
      activeProviderId: this.activeProviderId,
      providers: this.configs,
      fallbackConfig: this.fallbackConfig,
    };
    this.isSavingPrefs = true;
    try {
      Zotero.Prefs.set(PREFS_KEY, JSON.stringify(data), true);
    } finally {
      this.isSavingPrefs = false;
    }
  }

  /**
   * Get default provider configurations
   */
  private getDefaultConfigs(): ProviderConfig[] {
    const configs: ProviderConfig[] = [
      {
        id: "paperchat",
        name: "PaperChat",
        type: "paperchat",
        enabled: true,
        isBuiltin: true,
        order: 0,
        defaultModel: undefined,
        availableModels: [],
        temperature: 0.7,
        systemPrompt: "",
      } as PaperChatProviderConfig,
    ];

    // Add API key providers
    const apiKeyProviders: BuiltinProviderId[] = [
      "openai",
      "claude",
      "gemini",
      "deepseek",
    ];

    apiKeyProviders.forEach((id, index) => {
      const meta = BUILTIN_PROVIDERS[id];
      configs.push({
        id,
        name: meta.name,
        type: meta.type,
        enabled: false,
        isBuiltin: true,
        order: index + 1,
        apiKey: "",
        baseUrl: meta.defaultBaseUrl,
        defaultModel: "",
        availableModels: [],
      } as ApiKeyProviderConfig);
    });

    return configs;
  }

  private shouldClearUnfetchedBuiltinModels(config: ProviderConfig): boolean {
    if (!config.isBuiltin || !(config.id in BUILTIN_PROVIDERS)) {
      return false;
    }
    if (config.type === "paperchat") {
      const cachedModels = getPref("paperchatModelsCache") as string;
      return !cachedModels && (config.availableModels || []).length > 0;
    }
    return (
      !config.apiKey.trim() &&
      (config.availableModels || []).some(
        (modelId) => !this.getCustomModelIds(config).includes(modelId),
      )
    );
  }

  private getCustomModelIds(config: ProviderConfig): string[] {
    if (!("models" in config)) {
      return [];
    }
    return (config.models || [])
      .filter((model) => model.isCustom)
      .map((model) => model.modelId);
  }

  private normalizeLoadedConfigs(providers: ProviderConfig[]): {
    configs: ProviderConfig[];
    changed: boolean;
  } {
    let changed = false;
    const configs: ProviderConfig[] = [];
    for (const provider of providers) {
      if (provider.isBuiltin && REMOVED_BUILTIN_PROVIDER_IDS.has(provider.id)) {
        changed = true;
        continue;
      }

      if (
        this.shouldClearUnfetchedBuiltinModels(provider) &&
        provider.availableModels &&
        provider.availableModels.length > 0
      ) {
        changed = true;
        const customModelIds = this.getCustomModelIds(provider);
        if (provider.type === "paperchat") {
          configs.push({
            ...provider,
            defaultModel: undefined,
            availableModels: [],
          } as PaperChatProviderConfig);
          continue;
        }
        configs.push({
          ...provider,
          defaultModel: customModelIds.includes(provider.defaultModel)
            ? provider.defaultModel
            : customModelIds[0] || "",
          availableModels: customModelIds,
        } as ApiKeyProviderConfig);
        continue;
      }

      if (
        provider.type !== "paperchat" &&
        provider.availableModels.length > 0 &&
        (!provider.defaultModel ||
          !provider.availableModels.includes(provider.defaultModel))
      ) {
        changed = true;
        configs.push({
          ...provider,
          defaultModel: provider.availableModels[0],
        } as ApiKeyProviderConfig);
        continue;
      }

      if (provider.id !== "paperchat" || provider.type !== "paperchat") {
        configs.push(provider);
        continue;
      }

      const paperchat = { ...provider } as PaperChatProviderConfig;
      if ("maxTokens" in paperchat) {
        delete paperchat.maxTokens;
        changed = true;
      }
      configs.push(paperchat);
    }

    return { configs, changed };
  }

  /**
   * Initialize provider instances
   */
  private initializeProviders(): void {
    this.providers.clear();

    for (const config of this.configs) {
      if (!config.enabled) continue;

      const provider = this.createProvider(config);
      if (provider) {
        this.providers.set(config.id, provider);
      }
    }
  }

  /**
   * Create provider instance from config
   */
  private createProvider(config: ProviderConfig): AIProvider | null {
    switch (config.type) {
      case "paperchat":
        return new PaperChatProvider(config as PaperChatProviderConfig);
      case "anthropic":
        return new AnthropicProvider(config as ApiKeyProviderConfig);
      case "gemini":
        return new GeminiProvider(config as ApiKeyProviderConfig);
      case "openai":
      case "openai-compatible":
      case "custom":
        return new OpenAICompatibleProvider(config as ApiKeyProviderConfig);
      default:
        return null;
    }
  }

  /**
   * Get active provider
   */
  getActiveProvider(): AIProvider | null {
    return this.providers.get(this.activeProviderId) || null;
  }

  /**
   * Get active provider ID
   */
  getActiveProviderId(): string {
    return this.activeProviderId;
  }

  /**
   * Set active provider
   */
  setActiveProvider(providerId: string): void {
    if (this.configs.some((c) => c.id === providerId)) {
      this.activeProviderId = providerId;
      this.saveToPrefs();
      // Notify listeners about the provider change
      this.notifyProviderChange(providerId);
    }
  }

  /**
   * Get provider by ID
   */
  getProvider(providerId: string): AIProvider | null {
    return this.providers.get(providerId) || null;
  }

  /**
   * Get all provider configs
   */
  getAllConfigs(): ProviderConfig[] {
    return [...this.configs].sort((a, b) => a.order - b.order);
  }

  /**
   * Get all configured (enabled) provider instances
   */
  getConfiguredProviders(): AIProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get provider config by ID
   */
  getProviderConfig(providerId: string): ProviderConfig | null {
    return this.configs.find((c) => c.id === providerId) || null;
  }

  /**
   * Update provider config
   */
  updateProviderConfig(
    providerId: string,
    updates: Partial<ProviderConfig>,
  ): void {
    const index = this.configs.findIndex((c) => c.id === providerId);
    if (index >= 0) {
      this.configs[index] = {
        ...this.configs[index],
        ...updates,
      } as ProviderConfig;
      this.saveToPrefs();
      this.initializeProviders();
      // Notify listeners (model or config changed)
      this.notifyProviderChange(providerId);
    }
  }

  /**
   * Add custom provider
   */
  addCustomProvider(name: string): string {
    const id = `custom-${Date.now()}`;
    const config: ApiKeyProviderConfig = {
      id,
      name,
      type: "custom",
      enabled: true,
      isBuiltin: false,
      order: this.configs.length,
      apiKey: "",
      baseUrl: "",
      defaultModel: "",
      availableModels: [],
    };
    this.configs.push(config);
    this.saveToPrefs();
    this.initializeProviders();
    this.notifyProviderChange(id);
    return id;
  }

  /**
   * Remove custom provider
   */
  removeCustomProvider(providerId: string): boolean {
    const index = this.configs.findIndex(
      (c) => c.id === providerId && !c.isBuiltin,
    );
    if (index >= 0) {
      this.configs.splice(index, 1);
      if (this.activeProviderId === providerId) {
        this.activeProviderId = "paperchat";
      }
      this.saveToPrefs();
      this.initializeProviders();
      this.notifyProviderChange(this.activeProviderId);
      return true;
    }
    return false;
  }

  /**
   * Get provider metadata for UI
   */
  getProviderMetadata(providerId: string): ProviderMetadata | null {
    return BUILTIN_PROVIDERS[providerId as BuiltinProviderId] || null;
  }

  /**
   * Get all built-in provider metadata
   */
  getAllProviderMetadata(): ProviderMetadata[] {
    return Object.values(BUILTIN_PROVIDERS);
  }

  /**
   * Add custom model to a provider
   */
  addCustomModel(providerId: string, modelId: string): boolean {
    if (providerId === "paperchat") return false;
    const config = this.getProviderConfig(
      providerId,
    ) as ApiKeyProviderConfig | null;
    if (!config) return false;

    // Check if model already exists
    if (config.availableModels.includes(modelId)) return false;

    // Add to availableModels
    const newModels = [...config.availableModels, modelId];

    // Add to models array with isCustom flag
    const modelInfo: ModelInfo = { modelId, isCustom: true };
    const newModelInfos = [...(config.models || []), modelInfo];

    this.updateProviderConfig(providerId, {
      defaultModel: config.defaultModel || modelId,
      availableModels: newModels,
      models: newModelInfos,
    });
    return true;
  }

  /**
   * Remove custom model from a provider
   */
  removeCustomModel(providerId: string, modelId: string): boolean {
    if (providerId === "paperchat") return false;
    const config = this.getProviderConfig(
      providerId,
    ) as ApiKeyProviderConfig | null;
    if (!config) return false;

    // Check if model exists and is custom
    const modelInfo = config.models?.find((m) => m.modelId === modelId);
    if (!modelInfo?.isCustom) return false;

    // Remove from availableModels
    const newModels = config.availableModels.filter((m) => m !== modelId);

    // Remove from models array
    const newModelInfos = (config.models || []).filter(
      (m) => m.modelId !== modelId,
    );

    // Update default model if it was removed
    const updates: Partial<ApiKeyProviderConfig> = {
      availableModels: newModels,
      models: newModelInfos,
    };
    if (config.defaultModel === modelId) {
      updates.defaultModel = newModels[0] || "";
    }

    this.updateProviderConfig(providerId, updates);
    return true;
  }

  /**
   * Get model info for a provider
   */
  getModelInfo(providerId: string, modelId: string): ModelInfo | null {
    const config = this.getProviderConfig(
      providerId,
    ) as ApiKeyProviderConfig | null;
    if (!config) return null;

    // First check provider config models
    const configModel = config.models?.find((m) => m.modelId === modelId);
    if (configModel) return configModel;

    // Return basic info if not found
    return { modelId };
  }

  /**
   * Check if a model is custom (user-added)
   */
  isCustomModel(providerId: string, modelId: string): boolean {
    const config = this.getProviderConfig(
      providerId,
    ) as ApiKeyProviderConfig | null;
    if (!config) return false;

    const modelInfo = config.models?.find((m) => m.modelId === modelId);
    return modelInfo?.isCustom === true;
  }

  // ============================================
  // Legacy Fallback Configuration Methods
  // ============================================

  /**
   * Get the persisted legacy configuration and current attempt limit.
   */
  getFallbackConfig(): FallbackConfig {
    return { ...this.fallbackConfig };
  }

  /**
   * Update the persisted legacy configuration and current attempt limit.
   */
  updateFallbackConfig(updates: Partial<FallbackConfig>): void {
    this.fallbackConfig = { ...this.fallbackConfig, ...updates };
    this.saveToPrefs();
    ztoolkit.log(
      "[ProviderManager] Fallback config updated:",
      this.fallbackConfig,
    );
  }

  /**
   * @deprecated Provider ordering is no longer used by request execution.
   */
  setFallbackProviders(providerIds: string[]): void {
    // Filter to only include valid, enabled providers
    const validIds = providerIds.filter((id) => {
      const provider = this.providers.get(id);
      return provider && provider.isReady();
    });
    this.updateFallbackConfig({ fallbackProviderIds: validIds });
  }

  /**
   * @deprecated Provider ordering is no longer used by request execution.
   */
  clearFallbackProviders(): void {
    this.updateFallbackConfig({ fallbackProviderIds: [] });
  }

  // ============================================
  // Legacy fallback configuration helpers and retry execution
  // ============================================

  /**
   * @deprecated Retained for compatibility with callers that inspect the old
   * provider order. Chat execution does not use this chain.
   */
  getFallbackChain(): AIProvider[] {
    const chain: AIProvider[] = [];

    // 1. Add active provider first
    const activeProvider = this.getActiveProvider();
    if (activeProvider?.isReady()) {
      chain.push(activeProvider);
    }

    // 2. If user has explicitly configured fallback order, use it
    if (this.fallbackConfig.fallbackProviderIds.length > 0) {
      for (const providerId of this.fallbackConfig.fallbackProviderIds) {
        // Skip if already in chain (e.g., active provider)
        if (providerId === this.activeProviderId) continue;

        const provider = this.providers.get(providerId);
        if (provider?.isReady()) {
          chain.push(provider);
        }
      }
    } else {
      // 3. Auto-fallback: add all other ready providers
      for (const [providerId, provider] of this.providers) {
        // Skip active provider (already added)
        if (providerId === this.activeProviderId) continue;

        if (provider.isReady()) {
          chain.push(provider);
        }
      }
    }

    return chain;
  }

  /**
   * Check if an error can be retried on the current provider and model
   */
  isRetryableError(error: unknown): boolean {
    const errorMessage = getErrorMessage(error);
    return RETRYABLE_ERROR_PATTERNS.some((pattern) =>
      pattern.test(errorMessage),
    );
  }

  /** Retry the active provider without silently switching providers or models. */
  async executeWithFallback<T>(
    operation: (provider: AIProvider) => Promise<T>,
    options: ProviderRetryOptions = {},
  ): Promise<T> {
    const provider = this.getActiveProvider();
    if (!provider?.isReady()) {
      throw new Error("No available providers configured");
    }

    return this.executeWithRetry(provider, () => operation(provider), options);
  }

  /** Retry one specific provider without consulting or changing active state. */
  async executeWithRetry<T>(
    provider: AIProvider,
    operation: () => Promise<T>,
    options: ProviderRetryOptions = {},
  ): Promise<T> {
    if (!provider.isReady()) {
      throw new Error("Provider is not ready");
    }

    const maxAttempts = Math.max(1, this.fallbackConfig.maxRetries);
    let attemptNumber = 1;
    while (attemptNumber <= maxAttempts) {
      try {
        ztoolkit.log(
          `[ProviderManager] Attempting with provider: ${provider.getName()} (attempt ${attemptNumber})`,
        );
        return await operation();
      } catch (error) {
        const retryError =
          error instanceof Error ? error : new Error(String(error));

        ztoolkit.log(
          `[ProviderManager] Provider ${provider.getName()} failed:`,
          retryError.message,
        );

        const canRetry =
          attemptNumber < maxAttempts &&
          (await (options.shouldRetry?.(
            retryError,
            provider,
            attemptNumber - 1,
          ) ?? this.isRetryableError(retryError)));
        if (!canRetry) {
          ztoolkit.log(
            "[ProviderManager] Error is not retryable or retry limit was reached",
          );
          throw retryError;
        }

        attemptNumber += 1;
        ztoolkit.log(
          `[ProviderManager] Retrying the same provider and model (${attemptNumber}/${maxAttempts})`,
        );
      }
    }

    throw new Error("All retry attempts failed");
  }

  /** Execute same-provider retries and return detailed attempt information. */
  async executeWithFallbackDetailed<T>(
    operation: (provider: AIProvider) => Promise<T>,
  ): Promise<{
    result: T;
    providerId: string;
    providerName: string;
    attempts: FallbackExecutionResult<T>[];
  }> {
    const provider = this.getActiveProvider();
    const attempts: FallbackExecutionResult<T>[] = [];

    if (!provider?.isReady()) {
      throw new Error("No available providers configured");
    }

    const providerId = provider.config.id;
    const maxAttempts = Math.max(1, this.fallbackConfig.maxRetries);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await operation(provider);
        const successfulAttempt: FallbackExecutionResult<T> = {
          success: true,
          result,
          providerId,
          attemptNumber: attempt + 1,
        };
        attempts.push(successfulAttempt);

        return {
          result,
          providerId,
          providerName: provider.getName(),
          attempts,
        };
      } catch (error) {
        const errorObj =
          error instanceof Error ? error : new Error(String(error));
        attempts.push({
          success: false,
          error: errorObj,
          providerId,
          attemptNumber: attempt + 1,
        });

        if (!this.isRetryableError(error) || attempt >= maxAttempts - 1) {
          throw errorObj;
        }
      }
    }

    // All failed
    const lastAttempt = attempts[attempts.length - 1];
    throw lastAttempt?.error || new Error("All retry attempts failed");
  }

  /**
   * Get list of available providers for fallback configuration UI
   * Returns providers that are enabled and ready
   */
  getAvailableFallbackProviders(): {
    id: string;
    name: string;
    isActive: boolean;
  }[] {
    const result: { id: string; name: string; isActive: boolean }[] = [];

    for (const [id, provider] of this.providers) {
      if (provider.isReady()) {
        result.push({
          id,
          name: provider.getName(),
          isActive: id === this.activeProviderId,
        });
      }
    }

    return result;
  }

  /**
   * Refresh providers (reload from prefs)
   */
  refresh(notify: boolean = false): void {
    this.loadFromPrefs();
    this.initializeProviders();
    if (notify) {
      this.notifyProviderChange(this.activeProviderId);
    }
  }

  /**
   * Destroy all providers
   */
  destroy(): void {
    if (
      this.prefsObserver &&
      typeof Zotero?.Prefs?.unregisterObserver === "function"
    ) {
      Zotero.Prefs.unregisterObserver(this.prefsObserver);
      this.prefsObserver = null;
    }
    this.providers.clear();
  }
}

// Singleton instance
let providerManager: ProviderManager | null = null;

/**
 * Get the singleton ProviderManager instance
 */
export function getProviderManager(): ProviderManager {
  if (!providerManager) {
    providerManager = new ProviderManager();
  }
  return providerManager;
}

/**
 * Destroy the singleton ProviderManager instance
 */
export function destroyProviderManager(): void {
  if (providerManager) {
    providerManager.destroy();
    providerManager = null;
  }
}
