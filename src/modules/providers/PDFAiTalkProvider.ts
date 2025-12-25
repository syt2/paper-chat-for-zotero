/**
 * PDFAiTalkProvider - Wrapper for existing AuthManager/ApiService
 * Delegates to existing implementation for login-based authentication
 */

import type { ChatMessage, StreamCallbacks } from "../../types/chat";
import type { AIProvider, PDFAiTalkProviderConfig, PdfAttachment } from "../../types/provider";
import { getAuthManager } from "../auth";
import { ApiService } from "../chat/ApiService";
import { BUILTIN_PROVIDERS } from "./ProviderManager";

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
    // PDFAiTalk provides a wide variety of models
    return [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4-turbo",
      "gpt-3.5-turbo",
      "claude-sonnet-4-20250514",
      "claude-3-5-haiku-20241022",
      "gemini-2.0-flash-exp",
      "deepseek-chat",
    ];
  }
}
