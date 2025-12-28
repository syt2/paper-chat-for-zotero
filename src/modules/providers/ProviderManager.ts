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
  PDFAiTalkProviderConfig,
  ModelInfo,
} from "../../types/provider";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
import { AnthropicProvider } from "./AnthropicProvider";
import { GeminiProvider } from "./GeminiProvider";
import { PDFAiTalkProvider } from "./PDFAiTalkProvider";
import { config } from "../../../package.json";

/**
 * Built-in provider metadata with comprehensive model lists
 * Based on chatbox project (https://github.com/chatboxai/chatbox)
 */
export const BUILTIN_PROVIDERS: Record<BuiltinProviderId, ProviderMetadata> = {
  pdfaitalk: {
    id: "pdfaitalk",
    name: "PDFAiTalk",
    description: "Login-based AI service with multi-model support",
    defaultBaseUrl: "https://pdfaitalk.zotero.store/v1",
    defaultModels: [
      // claude-haiku-4-5-20251001 作为首选默认模型
      "claude-haiku-4-5-20251001",
      "Pro/deepseek-ai/DeepSeek-V3.2",
      "Pro/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
      "Pro/Qwen/Qwen2.5-VL-7B-Instruct",
      "Pro/THUDM/glm-4-9b-chat",
      "Pro/THUDM/GLM-4.1V-9B-Thinking",
      "claude-3-haiku-20240307",
      "claude-3-5-haiku-20241022",
      "claude-sonnet-4-5-20250929",
      "Pro/zai-org/GLM-4.7",
      "Pro/moonshotai/Kimi-K2-Instruct-0905",
      "claude-opus-4-5-20251101",
    ],
    defaultModelInfos: [
      { modelId: "claude-haiku-4-5-20251001", contextWindow: 200000, maxOutput: 8192, capabilities: ["vision", "tool_use"] },
      { modelId: "Pro/deepseek-ai/DeepSeek-V3.2", contextWindow: 64000, maxOutput: 8192, capabilities: ["tool_use"] },
      { modelId: "Pro/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B", contextWindow: 64000, maxOutput: 8192, capabilities: ["reasoning"] },
      { modelId: "Pro/Qwen/Qwen2.5-VL-7B-Instruct", contextWindow: 32000, maxOutput: 8192, capabilities: ["vision"] },
      { modelId: "Pro/THUDM/glm-4-9b-chat", contextWindow: 128000, maxOutput: 8192, capabilities: ["tool_use"] },
      { modelId: "Pro/THUDM/GLM-4.1V-9B-Thinking", contextWindow: 128000, maxOutput: 8192, capabilities: ["vision", "reasoning"] },
      { modelId: "claude-3-haiku-20240307", contextWindow: 200000, maxOutput: 4096, capabilities: ["vision", "tool_use"] },
      { modelId: "claude-3-5-haiku-20241022", contextWindow: 200000, maxOutput: 8192, capabilities: ["vision", "tool_use"] },
      { modelId: "claude-sonnet-4-5-20250929", contextWindow: 200000, maxOutput: 64000, capabilities: ["vision", "reasoning", "tool_use"] },
      { modelId: "Pro/zai-org/GLM-4.7", contextWindow: 128000, maxOutput: 8192, capabilities: ["tool_use"] },
      { modelId: "Pro/moonshotai/Kimi-K2-Instruct-0905", contextWindow: 128000, maxOutput: 8192, capabilities: ["tool_use"] },
      { modelId: "claude-opus-4-5-20251101", contextWindow: 200000, maxOutput: 32000, capabilities: ["vision", "reasoning", "tool_use"] },
    ],
    website: "https://pdfaitalk.zotero.store",
    type: "pdfaitalk",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    description: "Native OpenAI API - GPT-4o, o3, etc.",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModels: ["gpt-4o", "gpt-4o-mini", "o3-mini", "o1", "o1-mini", "gpt-4-turbo"],
    defaultModelInfos: [
      { modelId: "gpt-4o", contextWindow: 128000, maxOutput: 16384, capabilities: ["vision", "tool_use"] },
      { modelId: "gpt-4o-mini", contextWindow: 128000, maxOutput: 16384, capabilities: ["vision", "tool_use"] },
      { modelId: "o3-mini", contextWindow: 200000, maxOutput: 100000, capabilities: ["reasoning", "tool_use"] },
      { modelId: "o1", contextWindow: 200000, maxOutput: 100000, capabilities: ["reasoning"] },
      { modelId: "o1-mini", contextWindow: 128000, maxOutput: 65536, capabilities: ["reasoning"] },
      { modelId: "gpt-4-turbo", contextWindow: 128000, maxOutput: 4096, capabilities: ["vision", "tool_use"] },
    ],
    website: "https://platform.openai.com",
    type: "openai",
  },
  claude: {
    id: "claude",
    name: "Claude",
    description: "Anthropic Claude API - Claude 4, Claude 3.5, etc.",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModels: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
    defaultModelInfos: [
      { modelId: "claude-sonnet-4-20250514", contextWindow: 200000, maxOutput: 64000, capabilities: ["vision", "reasoning", "tool_use"] },
      { modelId: "claude-opus-4-20250514", contextWindow: 200000, maxOutput: 32000, capabilities: ["vision", "reasoning", "tool_use"] },
      { modelId: "claude-3-5-sonnet-20241022", contextWindow: 200000, maxOutput: 8192, capabilities: ["vision", "tool_use"] },
      { modelId: "claude-3-5-haiku-20241022", contextWindow: 200000, maxOutput: 8192, capabilities: ["vision", "tool_use"] },
    ],
    website: "https://console.anthropic.com",
    type: "anthropic",
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    description: "Google AI Gemini API - Gemini 2.5, 2.0, etc.",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModels: ["gemini-2.5-pro-preview-06-05", "gemini-2.5-flash-preview-05-20", "gemini-2.0-flash-exp", "gemini-1.5-pro", "gemini-1.5-flash"],
    defaultModelInfos: [
      { modelId: "gemini-2.5-pro-preview-06-05", contextWindow: 1000000, maxOutput: 65536, capabilities: ["vision", "reasoning", "tool_use"] },
      { modelId: "gemini-2.5-flash-preview-05-20", contextWindow: 1000000, maxOutput: 65536, capabilities: ["vision", "reasoning", "tool_use"] },
      { modelId: "gemini-2.0-flash-exp", contextWindow: 1000000, maxOutput: 8192, capabilities: ["vision", "tool_use"] },
      { modelId: "gemini-1.5-pro", contextWindow: 2000000, maxOutput: 8192, capabilities: ["vision", "tool_use"] },
      { modelId: "gemini-1.5-flash", contextWindow: 1000000, maxOutput: 8192, capabilities: ["vision", "tool_use"] },
    ],
    website: "https://ai.google.dev",
    type: "gemini",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek AI - DeepSeek Chat, Reasoner",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultModels: ["deepseek-chat", "deepseek-reasoner"],
    defaultModelInfos: [
      { modelId: "deepseek-chat", contextWindow: 64000, maxOutput: 8192, capabilities: ["tool_use"] },
      { modelId: "deepseek-reasoner", contextWindow: 64000, maxOutput: 8192, capabilities: ["reasoning"] },
    ],
    website: "https://platform.deepseek.com",
    type: "openai-compatible",
  },
  mistral: {
    id: "mistral",
    name: "Mistral",
    description: "Mistral AI - Pixtral, Mistral Large, etc.",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    defaultModels: ["pixtral-large-latest", "mistral-large-latest", "mistral-small-latest", "codestral-latest"],
    defaultModelInfos: [
      { modelId: "pixtral-large-latest", contextWindow: 128000, maxOutput: 4096, capabilities: ["vision", "tool_use"] },
      { modelId: "mistral-large-latest", contextWindow: 128000, maxOutput: 4096, capabilities: ["tool_use"] },
      { modelId: "mistral-small-latest", contextWindow: 32000, maxOutput: 4096, capabilities: ["tool_use"] },
      { modelId: "codestral-latest", contextWindow: 32000, maxOutput: 4096, capabilities: [] },
    ],
    website: "https://console.mistral.ai",
    type: "openai-compatible",
  },
  groq: {
    id: "groq",
    name: "Groq",
    description: "Groq Cloud - Ultra-fast inference",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768", "gemma2-9b-it"],
    defaultModelInfos: [
      { modelId: "llama-3.3-70b-versatile", contextWindow: 131072, maxOutput: 32768, capabilities: ["tool_use"] },
      { modelId: "llama-3.1-8b-instant", contextWindow: 131072, maxOutput: 8192, capabilities: ["tool_use"] },
      { modelId: "mixtral-8x7b-32768", contextWindow: 32768, maxOutput: 4096, capabilities: [] },
      { modelId: "gemma2-9b-it", contextWindow: 8192, maxOutput: 4096, capabilities: [] },
    ],
    website: "https://console.groq.com",
    type: "openai-compatible",
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    description: "OpenRouter - Access multiple AI providers",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModels: ["openai/gpt-4o", "anthropic/claude-sonnet-4-20250514", "google/gemini-2.0-flash-exp:free", "deepseek/deepseek-chat"],
    defaultModelInfos: [
      { modelId: "openai/gpt-4o", contextWindow: 128000, maxOutput: 16384, capabilities: ["vision", "tool_use"] },
      { modelId: "anthropic/claude-sonnet-4-20250514", contextWindow: 200000, maxOutput: 64000, capabilities: ["vision", "reasoning", "tool_use"] },
      { modelId: "google/gemini-2.0-flash-exp:free", contextWindow: 1000000, maxOutput: 8192, capabilities: ["vision", "tool_use"] },
      { modelId: "deepseek/deepseek-chat", contextWindow: 64000, maxOutput: 8192, capabilities: ["tool_use"] },
    ],
    website: "https://openrouter.ai",
    type: "openai-compatible",
  },
};

const PREFS_KEY = `${config.prefsPrefix}.providersConfig`;

export class ProviderManager {
  private providers: Map<string, AIProvider> = new Map();
  private activeProviderId: string = "pdfaitalk";
  private configs: ProviderConfig[] = [];
  private onProviderChangeCallback?: (providerId: string) => void;

  constructor() {
    this.loadFromPrefs();
    this.initializeProviders();
  }

  /**
   * Set callback for when active provider changes
   */
  setOnProviderChange(callback: (providerId: string) => void): void {
    this.onProviderChangeCallback = callback;
  }

  /**
   * Load configuration from Zotero preferences
   */
  private loadFromPrefs(): void {
    try {
      const stored = Zotero.Prefs.get(PREFS_KEY, true) as string | undefined;
      ztoolkit.log("[ProviderManager] Loading from prefs, stored:", stored ? "has data" : "empty");

      if (stored) {
        const data: ProviderStorageData = JSON.parse(stored);
        const providers = data.providers || [];
        ztoolkit.log("[ProviderManager] Parsed providers:", providers.map(p => p.id));
        ztoolkit.log("[ProviderManager] Active provider ID:", data.activeProviderId);

        // Check if config is valid (has pdfaitalk provider)
        const hasPdfaitalk = providers.some((p) => p.id === "pdfaitalk");
        if (!hasPdfaitalk) {
          ztoolkit.log("[ProviderManager] No pdfaitalk found, resetting to defaults");
          // Invalid config, reset to defaults
          this.configs = this.getDefaultConfigs();
          this.activeProviderId = "pdfaitalk";
          this.saveToPrefs();
          return;
        }

        this.activeProviderId = data.activeProviderId || "pdfaitalk";
        this.configs = providers;
        ztoolkit.log("[ProviderManager] Loaded configs:", this.configs.map(c => ({ id: c.id, enabled: c.enabled })));
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
    };
    Zotero.Prefs.set(PREFS_KEY, JSON.stringify(data), true);
  }

  /**
   * Get default provider configurations
   */
  private getDefaultConfigs(): ProviderConfig[] {
    const configs: ProviderConfig[] = [
      {
        id: "pdfaitalk",
        name: "PDFAiTalk",
        type: "pdfaitalk",
        enabled: true,
        isBuiltin: true,
        order: 0,
        defaultModel: BUILTIN_PROVIDERS.pdfaitalk.defaultModels[0],
        availableModels: BUILTIN_PROVIDERS.pdfaitalk.defaultModels,
        maxTokens: 4096,
        temperature: 0.7,
        systemPrompt: "",
      } as PDFAiTalkProviderConfig,
    ];

    // Add API key providers
    const apiKeyProviders: BuiltinProviderId[] = [
      "openai", "claude", "gemini", "deepseek", "mistral", "groq", "openrouter"
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
        defaultModel: meta.defaultModels[0],
        availableModels: meta.defaultModels,
      } as ApiKeyProviderConfig);
    });

    return configs;
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
      case "pdfaitalk":
        return new PDFAiTalkProvider(config as PDFAiTalkProviderConfig);
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
      this.onProviderChangeCallback?.(providerId);
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
   * Get provider config by ID
   */
  getProviderConfig(providerId: string): ProviderConfig | null {
    return this.configs.find((c) => c.id === providerId) || null;
  }

  /**
   * Update provider config
   */
  updateProviderConfig(providerId: string, updates: Partial<ProviderConfig>): void {
    const index = this.configs.findIndex((c) => c.id === providerId);
    if (index >= 0) {
      this.configs[index] = { ...this.configs[index], ...updates } as ProviderConfig;
      this.saveToPrefs();
      this.initializeProviders();
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
    return id;
  }

  /**
   * Remove custom provider
   */
  removeCustomProvider(providerId: string): boolean {
    const index = this.configs.findIndex(
      (c) => c.id === providerId && !c.isBuiltin
    );
    if (index >= 0) {
      this.configs.splice(index, 1);
      if (this.activeProviderId === providerId) {
        this.activeProviderId = "pdfaitalk";
      }
      this.saveToPrefs();
      this.initializeProviders();
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
    if (providerId === "pdfaitalk") return false;
    const config = this.getProviderConfig(providerId) as ApiKeyProviderConfig | null;
    if (!config) return false;

    // Check if model already exists
    if (config.availableModels.includes(modelId)) return false;

    // Add to availableModels
    const newModels = [...config.availableModels, modelId];

    // Add to models array with isCustom flag
    const modelInfo: ModelInfo = { modelId, isCustom: true };
    const newModelInfos = [...(config.models || []), modelInfo];

    this.updateProviderConfig(providerId, {
      availableModels: newModels,
      models: newModelInfos,
    });
    return true;
  }

  /**
   * Remove custom model from a provider
   */
  removeCustomModel(providerId: string, modelId: string): boolean {
    if (providerId === "pdfaitalk") return false;
    const config = this.getProviderConfig(providerId) as ApiKeyProviderConfig | null;
    if (!config) return false;

    // Check if model exists and is custom
    const modelInfo = config.models?.find(m => m.modelId === modelId);
    if (!modelInfo?.isCustom) return false;

    // Remove from availableModels
    const newModels = config.availableModels.filter(m => m !== modelId);

    // Remove from models array
    const newModelInfos = (config.models || []).filter(m => m.modelId !== modelId);

    // Update default model if it was removed
    const updates: Partial<ApiKeyProviderConfig> = {
      availableModels: newModels,
      models: newModelInfos,
    };
    if (config.defaultModel === modelId && newModels.length > 0) {
      updates.defaultModel = newModels[0];
    }

    this.updateProviderConfig(providerId, updates);
    return true;
  }

  /**
   * Get model info for a provider
   */
  getModelInfo(providerId: string, modelId: string): ModelInfo | null {
    const config = this.getProviderConfig(providerId) as ApiKeyProviderConfig | null;
    if (!config) return null;

    // First check provider config models
    const configModel = config.models?.find(m => m.modelId === modelId);
    if (configModel) return configModel;

    // Then check built-in provider defaults
    const metadata = BUILTIN_PROVIDERS[providerId as BuiltinProviderId];
    if (metadata) {
      const builtinModel = metadata.defaultModelInfos.find(m => m.modelId === modelId);
      if (builtinModel) return builtinModel;
    }

    // Return basic info if not found
    return { modelId };
  }

  /**
   * Check if a model is custom (user-added)
   */
  isCustomModel(providerId: string, modelId: string): boolean {
    const config = this.getProviderConfig(providerId) as ApiKeyProviderConfig | null;
    if (!config) return false;

    const modelInfo = config.models?.find(m => m.modelId === modelId);
    return modelInfo?.isCustom === true;
  }

  /**
   * Refresh providers (reload from prefs)
   */
  refresh(): void {
    this.loadFromPrefs();
    this.initializeProviders();
  }

  /**
   * Destroy all providers
   */
  destroy(): void {
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
