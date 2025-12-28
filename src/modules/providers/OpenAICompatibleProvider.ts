/**
 * OpenAICompatibleProvider - For OpenAI, DeepSeek, Mistral, Groq, OpenRouter, Custom
 */

import { BaseProvider } from "./BaseProvider";
import type { ChatMessage, StreamCallbacks } from "../../types/chat";
import type { PdfAttachment } from "../../types/provider";

export class OpenAICompatibleProvider extends BaseProvider {
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
      const apiMessages = this.formatOpenAIMessages(messages, pdfAttachment);

      if (this._config.systemPrompt) {
        apiMessages.unshift({ role: "system", content: this._config.systemPrompt });
      }

      const requestBody: Record<string, unknown> = {
        model: this._config.defaultModel,
        messages: apiMessages,
        temperature: this._config.temperature ?? 0.7,
        stream: true,
      };
      if (this._config.maxTokens && this._config.maxTokens > 0) {
        requestBody.max_tokens = this._config.maxTokens;
      }

      const response = await fetch(`${this._config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      await this.validateResponse(response);
      await this.streamWithCallbacks(response, "openai", callbacks);
    } catch (error) {
      onError(this.wrapError(error));
    }
  }

  async chatCompletion(messages: ChatMessage[]): Promise<string> {
    if (!this.isReady()) {
      throw new Error("Provider is not configured");
    }

    const apiMessages = this.formatOpenAIMessages(messages);

    if (this._config.systemPrompt) {
      apiMessages.unshift({ role: "system", content: this._config.systemPrompt });
    }

    const requestBody: Record<string, unknown> = {
      model: this._config.defaultModel,
      messages: apiMessages,
      temperature: this._config.temperature ?? 0.7,
      stream: false,
    };
    if (this._config.maxTokens && this._config.maxTokens > 0) {
      requestBody.max_tokens = this._config.maxTokens;
    }

    const response = await fetch(`${this._config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this._config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    await this.validateResponse(response);

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content || "";
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this._config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this._config.apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this._config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this._config.apiKey}` },
      });
      if (response.ok) {
        const data = (await response.json()) as { data?: Array<{ id: string }> };
        return data.data?.map((m) => m.id) || [];
      }
    } catch {
      // Ignore errors
    }
    return this._config.availableModels || [];
  }
}
