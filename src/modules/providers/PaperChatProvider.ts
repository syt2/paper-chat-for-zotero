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
  ToolCallingOptions,
} from "../../types/provider";
import type { ToolDefinition, ToolCall } from "../../types/tool";
import { getAuthManager } from "../auth";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
import { OpenAIResponsesProvider } from "./OpenAIResponsesProvider";
import { BUILTIN_PROVIDERS } from "./ProviderManager";
import { getPref } from "../../utils/prefs";
import {
  AUTO_MODEL,
  AUTO_MODEL_SMART,
  getModelRatios,
  getModelRoutingMeta,
  resolveAutoModel,
  resolveAutoModelSmart,
} from "../preferences/ModelsFetcher";
import { isEmbeddingModel } from "../embedding/providers/PaperChatEmbedding";
import { resolveSelectedTierModel } from "./paperchat-tier-routing";
import { getPaperChatApiCapabilities } from "./paperchat-routing-metadata";

export class PaperChatProvider implements AIProvider {
  private _config: PaperChatProviderConfig;
  private _delegate: OpenAICompatibleProvider;
  private _responsesDelegate: OpenAIResponsesProvider;

  constructor(config: PaperChatProviderConfig) {
    this._config = config;
    const delegateConfig = this.createDelegateConfig();
    this._delegate = new OpenAICompatibleProvider(delegateConfig);
    this._responsesDelegate = new OpenAIResponsesProvider(
      delegateConfig,
      this.createResponsesRuntimeOptions(delegateConfig.defaultModel),
    );
  }

  private createResponsesRuntimeOptions(modelId: string): {
    sessionId?: string;
    hostedWebSearch: boolean;
  } {
    return {
      sessionId: this._config.requestSessionId,
      hostedWebSearch: getPaperChatApiCapabilities(
        modelId,
        getModelRoutingMeta(),
      ).hostedWebSearch,
    };
  }

  private refreshDelegates(): {
    delegate: OpenAICompatibleProvider | OpenAIResponsesProvider;
    capabilities: { responses: boolean; hostedWebSearch: boolean };
  } {
    const delegateConfig = this.createDelegateConfig();
    const capabilities = getPaperChatApiCapabilities(
      delegateConfig.defaultModel,
      getModelRoutingMeta(),
    );
    this._delegate.updateConfig(delegateConfig);
    this._responsesDelegate.updateConfig(delegateConfig);
    this._responsesDelegate.setRuntimeOptions(
      this.createResponsesRuntimeOptions(delegateConfig.defaultModel),
    );
    return {
      delegate: capabilities.responses
        ? this._responsesDelegate
        : this._delegate,
      capabilities,
    };
  }

  private filterToolsForCapabilities(
    tools: ToolDefinition[] | undefined,
    capabilities: { hostedWebSearch: boolean },
  ): ToolDefinition[] | undefined {
    if (!tools || capabilities.hostedWebSearch) {
      return tools;
    }
    const hasUnifiedWebSearch = tools.some(
      (tool) => tool.function.name === "web_search",
    );
    return hasUnifiedWebSearch
      ? tools.filter(
          (tool) => tool.function.name !== "search_scholarly_sources",
        )
      : tools;
  }

  private getConfiguredModels(): string[] {
    const cachedModels = getPref("paperchatModelsCache") as string;
    if (cachedModels) {
      try {
        const models = JSON.parse(cachedModels) as string[];
        if (Array.isArray(models) && models.length > 0) {
          return models.filter((model) => !isEmbeddingModel(model));
        }
      } catch (error) {
        ztoolkit.log(
          "[PaperChatProvider] Invalid paperchatModelsCache, falling back to provider config:",
          error,
        );
      }
    }
    return (this._config.availableModels || []).filter(
      (model) => !isEmbeddingModel(model),
    );
  }

  private createDelegateConfig(): ApiKeyProviderConfig {
    const authManager = getAuthManager();
    const availableModels = this.getConfiguredModels();
    const fallbackModel = availableModels[0] || "";

    let model = this._config.resolvedModelOverride;

    if (!model) {
      const resolvedDefault = resolveSelectedTierModel(
        getPref("paperchatTierState") as string | undefined,
        availableModels,
        getModelRatios(),
        undefined,
        getModelRoutingMeta(),
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
      maxTokens:
        typeof this._config.maxTokens === "number" && this._config.maxTokens > 0
          ? this._config.maxTokens
          : undefined,
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
    return (
      authManager.isLoggedIn() &&
      !!authManager.getApiKey() &&
      this.getConfiguredModels().length > 0
    );
  }

  updateConfig(config: Partial<PaperChatProviderConfig>): void {
    this._config = { ...this._config, ...config };
    this.refreshDelegates();
  }

  supportsPdfUpload(): boolean {
    return true;
  }

  supportsHostedWebSearch(): boolean {
    const delegateConfig = this.createDelegateConfig();
    return getPaperChatApiCapabilities(
      delegateConfig.defaultModel,
      getModelRoutingMeta(),
    ).hostedWebSearch;
  }

  async streamChatCompletion(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    pdfAttachment?: PdfAttachment,
    signal?: AbortSignal,
  ): Promise<void> {
    // Refresh config before each call (API key or model metadata may have changed)
    const { delegate } = this.refreshDelegates();
    return delegate.streamChatCompletion(
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
    const { delegate } = this.refreshDelegates();
    return delegate.chatCompletion(messages, signal);
  }

  async testConnection(): Promise<boolean> {
    this._delegate.updateConfig(this.createDelegateConfig());
    return this._delegate.testConnection();
  }

  async getAvailableModels(): Promise<string[]> {
    return this.getConfiguredModels();
  }

  /**
   * Chat completion with tool calling support (non-streaming)
   * Delegates to the internal OpenAICompatibleProvider
   */
  async chatCompletionWithTools(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    options?: ToolCallingOptions,
  ): Promise<{ content: string; toolCalls?: ToolCall[] }> {
    const { delegate, capabilities } = this.refreshDelegates();
    return delegate.chatCompletionWithTools(
      messages,
      this.filterToolsForCapabilities(tools, capabilities),
      signal,
      options,
    );
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
    options?: ToolCallingOptions,
  ): Promise<void> {
    const { delegate, capabilities } = this.refreshDelegates();
    return delegate.streamChatCompletionWithTools(
      messages,
      this.filterToolsForCapabilities(tools, capabilities) || [],
      callbacks,
      signal,
      options,
    );
  }
}
