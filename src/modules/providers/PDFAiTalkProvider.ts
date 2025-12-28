/**
 * PDFAiTalkProvider - Login-based authentication provider
 * Uses composition with OpenAICompatibleProvider for API calls
 */

import type { ChatMessage, StreamCallbacks } from "../../types/chat";
import type { AIProvider, ApiKeyProviderConfig, PDFAiTalkProviderConfig, PdfAttachment } from "../../types/provider";
import { getAuthManager } from "../auth";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
import { BUILTIN_PROVIDERS } from "./ProviderManager";
import { getPref } from "../../utils/prefs";

export class PDFAiTalkProvider implements AIProvider {
  private _config: PDFAiTalkProviderConfig;
  private _delegate: OpenAICompatibleProvider;

  constructor(config: PDFAiTalkProviderConfig) {
    this._config = config;
    this._delegate = new OpenAICompatibleProvider(this.createDelegateConfig());
  }

  private createDelegateConfig(): ApiKeyProviderConfig {
    const authManager = getAuthManager();
    const defaultModel = BUILTIN_PROVIDERS.pdfaitalk.defaultModels[0];

    return {
      id: this._config.id,
      name: this._config.name,
      type: "openai-compatible",
      enabled: this._config.enabled,
      isBuiltin: this._config.isBuiltin,
      order: this._config.order,
      apiKey: authManager.getApiKey() || "",
      baseUrl: BUILTIN_PROVIDERS.pdfaitalk.defaultBaseUrl,
      defaultModel: this._config.defaultModel || defaultModel,
      availableModels: this._config.availableModels || BUILTIN_PROVIDERS.pdfaitalk.defaultModels,
      maxTokens: this._config.maxTokens || 4096,
      temperature: this._config.temperature ?? 0.7,
      systemPrompt: this._config.systemPrompt || "",
    };
  }

  get config(): PDFAiTalkProviderConfig {
    return this._config;
  }

  getName(): string {
    return "PDFAiTalk";
  }

  isReady(): boolean {
    const authManager = getAuthManager();
    return authManager.isLoggedIn() && !!authManager.getApiKey();
  }

  updateConfig(config: Partial<PDFAiTalkProviderConfig>): void {
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
  ): Promise<void> {
    // Refresh config before each call (API key may have changed)
    this._delegate.updateConfig(this.createDelegateConfig());
    return this._delegate.streamChatCompletion(messages, callbacks, pdfAttachment);
  }

  async chatCompletion(messages: ChatMessage[]): Promise<string> {
    this._delegate.updateConfig(this.createDelegateConfig());
    return this._delegate.chatCompletion(messages);
  }

  async testConnection(): Promise<boolean> {
    this._delegate.updateConfig(this.createDelegateConfig());
    return this._delegate.testConnection();
  }

  async getAvailableModels(): Promise<string[]> {
    const cachedModels = getPref("pdfaitalkModelsCache") as string;
    if (cachedModels) {
      try {
        const models = JSON.parse(cachedModels) as string[];
        if (Array.isArray(models) && models.length > 0) {
          return models;
        }
      } catch {
        // ignore parse error
      }
    }
    return BUILTIN_PROVIDERS.pdfaitalk.defaultModels;
  }
}
