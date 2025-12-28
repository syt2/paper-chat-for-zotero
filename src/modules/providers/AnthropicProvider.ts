/**
 * AnthropicProvider - Claude API implementation
 * Uses Anthropic Messages API format (different from OpenAI)
 */

import { BaseProvider } from "./BaseProvider";
import type { ChatMessage, StreamCallbacks } from "../../types/chat";
import type { PdfAttachment } from "../../types/provider";

export class AnthropicProvider extends BaseProvider {
  supportsPdfUpload(): boolean {
    return true;
  }

  async streamChatCompletion(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    pdfAttachment?: PdfAttachment,
  ): Promise<void> {
    const { onChunk, onComplete, onError } = callbacks;

    if (!this.isReady()) {
      onError(new Error("Provider is not configured"));
      return;
    }

    try {
      const anthropicMessages = this.formatAnthropicMessages(messages, pdfAttachment);

      const response = await fetch(`${this._config.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": this._config.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this._config.defaultModel,
          max_tokens: this._config.maxTokens || 8192,
          system: this._config.systemPrompt || undefined,
          messages: anthropicMessages,
          stream: true,
        }),
      });

      await this.validateResponse(response);
      await this.streamWithCallbacks(response, "anthropic", callbacks);
    } catch (error) {
      onError(this.wrapError(error));
    }
  }

  async chatCompletion(messages: ChatMessage[]): Promise<string> {
    if (!this.isReady()) {
      throw new Error("Provider is not configured");
    }

    const anthropicMessages = this.formatAnthropicMessages(messages);

    const response = await fetch(`${this._config.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this._config.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this._config.defaultModel,
        max_tokens: this._config.maxTokens || 8192,
        system: this._config.systemPrompt || undefined,
        messages: anthropicMessages,
      }),
    });

    await this.validateResponse(response);

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };

    return data.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text || "")
      .join("") || "";
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this._config.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": this._config.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this._config.defaultModel || "claude-3-5-haiku-20241022",
          max_tokens: 10,
          messages: [{ role: "user", content: "Hi" }],
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    // Anthropic doesn't have a public models API, use config
    return this._config.availableModels || [];
  }
}
