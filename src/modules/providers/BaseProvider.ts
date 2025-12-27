/**
 * BaseProvider - Abstract base class with shared functionality
 */

import type { ChatMessage, StreamCallbacks } from "../../types/chat";
import type { AIProvider, ApiKeyProviderConfig, PdfAttachment } from "../../types/provider";
import { parseSSEStream, type SSEFormat, type SSEParserCallbacks } from "./SSEParser";

export abstract class BaseProvider implements AIProvider {
  protected _config: ApiKeyProviderConfig;

  constructor(config: ApiKeyProviderConfig) {
    this._config = config;
  }

  get config(): ApiKeyProviderConfig {
    return this._config;
  }

  getName(): string {
    return this._config.name;
  }

  isReady(): boolean {
    return !!this._config.apiKey && !!this._config.baseUrl && this._config.enabled;
  }

  updateConfig(config: Partial<ApiKeyProviderConfig>): void {
    this._config = { ...this._config, ...config };
  }

  supportsPdfUpload(): boolean {
    return false; // Override in providers that support PDF upload
  }

  abstract streamChatCompletion(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    pdfAttachment?: PdfAttachment,
  ): Promise<void>;

  abstract chatCompletion(messages: ChatMessage[]): Promise<string>;

  abstract testConnection(): Promise<boolean>;

  abstract getAvailableModels(): Promise<string[]>;

  /**
   * Parse SSE stream using unified parser
   */
  protected async parseSSE(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    format: SSEFormat,
    callbacks: SSEParserCallbacks,
  ): Promise<void> {
    return parseSSEStream(reader, format, callbacks);
  }

  /**
   * Filter messages - remove empty content and error messages
   */
  protected filterMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages
      // Filter out error messages (not sent to API)
      .filter((msg) => msg.role !== "error")
      .filter((msg, index, arr) => {
        // Allow last assistant message to be empty (placeholder)
        if (index === arr.length - 1 && msg.role === "assistant") {
          return msg.content.trim() !== "";
        }
        return msg.content && msg.content.trim() !== "";
      });
  }
}
