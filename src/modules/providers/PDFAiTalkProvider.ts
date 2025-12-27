/**
 * PDFAiTalkProvider - Wrapper for existing AuthManager/ApiService
 * Delegates to existing implementation for login-based authentication
 */

import type { ChatMessage, StreamCallbacks } from "../../types/chat";
import type { AIProvider, PDFAiTalkProviderConfig, PdfAttachment } from "../../types/provider";
import { getAuthManager } from "../auth";
import { ApiService } from "../chat/ApiService";
import { BUILTIN_PROVIDERS } from "./ProviderManager";
import { getPref } from "../../utils/prefs";

export class PDFAiTalkProvider implements AIProvider {
  private _config: PDFAiTalkProviderConfig;
  private apiService: ApiService;

  constructor(config: PDFAiTalkProviderConfig) {
    this._config = config;
    this.apiService = new ApiService(this.getApiConfig());
  }

  get config(): PDFAiTalkProviderConfig {
    return this._config;
  }

  private getApiConfig() {
    const authManager = getAuthManager();
    const defaultModel = BUILTIN_PROVIDERS.pdfaitalk.defaultModels[0];

    return {
      apiKey: authManager.getApiKey() || "",
      baseUrl: BUILTIN_PROVIDERS.pdfaitalk.defaultBaseUrl,
      model: this._config.defaultModel || defaultModel,
      maxTokens: this._config.maxTokens || 4096,
      temperature: this._config.temperature ?? 0.7,
      systemPrompt: this._config.systemPrompt || "",
    };
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
    this.apiService.updateConfig(this.getApiConfig());
  }

  supportsPdfUpload(): boolean {
    return true;
  }

  async streamChatCompletion(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    pdfAttachment?: PdfAttachment,
  ): Promise<void> {
    // Refresh API config before each call
    this.apiService.updateConfig(this.getApiConfig());
    return this.apiService.streamChatCompletion(messages, callbacks, pdfAttachment);
  }

  async chatCompletion(messages: ChatMessage[]): Promise<string> {
    this.apiService.updateConfig(this.getApiConfig());
    return this.apiService.chatCompletion(messages);
  }

  async testConnection(): Promise<boolean> {
    this.apiService.updateConfig(this.getApiConfig());
    return this.apiService.testConnection();
  }

  async getAvailableModels(): Promise<string[]> {
    // Try to get models from cache first
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
    // Fallback to builtin defaults
    return BUILTIN_PROVIDERS.pdfaitalk.defaultModels;
  }
}
