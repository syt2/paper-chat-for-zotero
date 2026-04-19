/**
 * PaperChatProvider - Login-based authentication provider
 * Uses composition with OpenAICompatibleProvider for API calls
 */

import type {
  ChatMessage,
  StreamCallbacks,
  StreamToolCallingCallbacks,
} from "../../types/chat";
import type {
  AIProvider,
  ApiKeyProviderConfig,
  PaperChatProviderConfig,
  PdfAttachment,
} from "../../types/provider";
import type { ToolDefinition, ToolCall } from "../../types/tool";
import { getAuthManager } from "../auth";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
import { BUILTIN_PROVIDERS } from "./ProviderManager";
import { getPref } from "../../utils/prefs";
import {
  AUTO_MODEL,
  AUTO_MODEL_SMART,
  getModelRatios,
  resolveAutoModel,
  resolveAutoModelSmart,
} from "../preferences/ModelsFetcher";
import { resolveSelectedTierModel } from "./paperchat-tier-routing";

export class PaperChatProvider implements AIProvider {
  private _config: PaperChatProviderConfig;
  private _delegate: OpenAICompatibleProvider;

  constructor(config: PaperChatProviderConfig) {
    this._config = config;
    this._delegate = new OpenAICompatibleProvider(this.createDelegateConfig());
  }

  private createDelegateConfig(): ApiKeyProviderConfig {
    const authManager = getAuthManager();
    const availableModels =
      this._config.availableModels ||
      BUILTIN_PROVIDERS.paperchat.defaultModels;
    const fallbackModel = BUILTIN_PROVIDERS.paperchat.defaultModels[0];

    let model = this._config.resolvedModelOverride;

    if (!model) {
      const resolvedDefault = resolveSelectedTierModel(
        getPref("paperchatTierState") as string | undefined,
        availableModels,
        getModelRatios(),
      ).modelId;
      model = resolvedDefault || this._config.defaultModel;
    }

    if (model === AUTO_MODEL_SMART) {
      model = resolveAutoModelSmart(availableModels) || fallbackModel;
    } else if (model === AUTO_MODEL || !model) {
      model = resolveAutoModel(availableModels) || fallbackModel;
    }

    return {
      id: this._config.id,
      name: this._config.name,
      type: "openai-compatible",
      enabled: this._config.enabled,
      isBuiltin: this._config.isBuiltin,
      order: this._config.order,
      apiKey: authManager.getApiKey() || "",
      baseUrl: BUILTIN_PROVIDERS.paperchat.defaultBaseUrl,
      defaultModel: model,
      availableModels,
      maxTokens: this._config.maxTokens || 4096,
      temperature: this._config.temperature ?? 0.7,
      systemPrompt: this._config.systemPrompt || "",
    };
  }

  get config(): PaperChatProviderConfig {
    return this._config;
  }

  getName(): string {
    return "PaperChat";
  }

  isReady(): boolean {
    const authManager = getAuthManager();
    return authManager.isLoggedIn() && !!authManager.getApiKey();
  }

  updateConfig(config: Partial<PaperChatProviderConfig>): void {
    this._config = { ...this._config, ...config };
    this._delegate.updateConfig(this.createDelegateConfig());
  }

  supportsPdfUpload(): boolean {
    return true;
  }

  async streamChatCompletion(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    pdfAttachment?: PdfAttachment,
    signal?: AbortSignal,
  ): Promise<void> {
    // Refresh config before each call (API key may have changed)
    this._delegate.updateConfig(this.createDelegateConfig());
    return this._delegate.streamChatCompletion(
      messages,
      callbacks,
      pdfAttachment,
      signal,
    );
  }

  async chatCompletion(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<string> {
    this._delegate.updateConfig(this.createDelegateConfig());
    return this._delegate.chatCompletion(messages, signal);
  }

  async testConnection(): Promise<boolean> {
    this._delegate.updateConfig(this.createDelegateConfig());
    return this._delegate.testConnection();
  }

  async getAvailableModels(): Promise<string[]> {
    const cachedModels = getPref("paperchatModelsCache") as string;
    if (cachedModels) {
      try {
        const models = JSON.parse(cachedModels) as string[];
        if (Array.isArray(models) && models.length > 0) {
          return models;
        }
      } catch (error) {
        ztoolkit.log(
          "[PaperChatProvider] Invalid paperchatModelsCache, falling back to defaults:",
          error,
        );
      }
    }
    return BUILTIN_PROVIDERS.paperchat.defaultModels;
  }

  /**
   * Chat completion with tool calling support (non-streaming)
   * Delegates to the internal OpenAICompatibleProvider
   */
  async chatCompletionWithTools(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<{ content: string; toolCalls?: ToolCall[] }> {
    this._delegate.updateConfig(this.createDelegateConfig());
    return this._delegate.chatCompletionWithTools(messages, tools, signal);
  }

  /**
   * Stream chat completion with tool calling support
   * Delegates to the internal OpenAICompatibleProvider
   */
  async streamChatCompletionWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    callbacks: StreamToolCallingCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    this._delegate.updateConfig(this.createDelegateConfig());
    return this._delegate.streamChatCompletionWithTools(
      messages,
      tools,
      callbacks,
      signal,
    );
  }
}
