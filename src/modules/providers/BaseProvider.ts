/**
 * BaseProvider - Abstract base class with shared functionality
 */

import type { ChatMessage, StreamCallbacks } from "../../types/chat";
import type { AIProvider, ApiKeyProviderConfig, PdfAttachment } from "../../types/provider";

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
   * Parse SSE stream (shared utility)
   */
  protected async parseSSEStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onData: (data: string) => void,
    onDone: () => void,
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const value = result.value as Uint8Array;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (trimmed.startsWith("data: ")) {
          onData(trimmed.slice(6));
        }
      }
    }
    onDone();
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
