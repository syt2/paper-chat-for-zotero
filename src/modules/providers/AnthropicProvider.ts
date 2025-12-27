/**
 * AnthropicProvider - Claude API implementation
 * Uses Anthropic Messages API format (different from OpenAI)
 */

import { BaseProvider } from "./BaseProvider";
import type { ChatMessage, StreamCallbacks } from "../../types/chat";
import type { AnthropicMessage, AnthropicContentBlock, PdfAttachment } from "../../types/provider";

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
      const anthropicMessages = this.formatMessages(messages, pdfAttachment);

      const response = await fetch(
        `${this._config.baseUrl}/messages`,
        {
          method: "POST",
          headers: {
            "x-api-key": this._config.apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this._config.defaultModel,
            max_tokens: this._config.maxTokens || 8192, // Anthropic requires max_tokens
            system: this._config.systemPrompt || undefined,
            messages: anthropicMessages,
            stream: true,
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error: ${response.status} - ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response body is not readable");

      let fullContent = "";

      await this.parseSSE(
        reader as ReadableStreamDefaultReader<Uint8Array>,
        "anthropic",
        {
          onText: (text) => {
            fullContent += text;
            onChunk(text);
          },
          onDone: () => onComplete(fullContent),
          onError,
        },
      );
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async chatCompletion(messages: ChatMessage[]): Promise<string> {
    if (!this.isReady()) {
      throw new Error("Provider is not configured");
    }

    const anthropicMessages = this.formatMessages(messages);

    const response = await fetch(`${this._config.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this._config.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this._config.defaultModel,
        max_tokens: this._config.maxTokens || 8192, // Anthropic requires max_tokens
        system: this._config.systemPrompt || undefined,
        messages: anthropicMessages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };

    // Extract text from content blocks
    return data.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text || "")
      .join("") || "";
  }

  async testConnection(): Promise<boolean> {
    try {
      // Anthropic doesn't have a models endpoint, use a minimal message
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
    // Anthropic doesn't expose a models endpoint
    return this._config.availableModels || [
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-5-20251101",
      "claude-3-5-haiku-20241022",
      "claude-3-haiku-20240307",
    ];
  }

  /**
   * Format messages for Anthropic API
   */
  private formatMessages(messages: ChatMessage[], pdfAttachment?: PdfAttachment): AnthropicMessage[] {
    const filteredMessages = this.filterMessages(messages)
      .filter((msg) => msg.role !== "system"); // System handled separately

    return filteredMessages.map((msg, index) => {
      // For the first user message, attach PDF if provided
      const isFirstUserMessage = index === filteredMessages.findIndex(m => m.role === "user");
      const shouldAttachPdf = pdfAttachment && msg.role === "user" && isFirstUserMessage;

      // If has images or PDF, use multimodal format
      if ((msg.images && msg.images.length > 0) || shouldAttachPdf) {
        const content: AnthropicContentBlock[] = [];

        // Add PDF document first if provided
        if (shouldAttachPdf) {
          content.push({
            type: "document",
            source: {
              type: "base64",
              media_type: pdfAttachment.mimeType,
              data: pdfAttachment.data,
            },
          });
        }

        // Add images
        if (msg.images) {
          for (const img of msg.images) {
            content.push({
              type: "image",
              source: {
                type: "base64",
                media_type: img.mimeType,
                data: img.data,
              },
            });
          }
        }

        // Add text
        content.push({
          type: "text",
          text: msg.content,
        });

        return {
          role: msg.role as "user" | "assistant",
          content,
        };
      }

      // Plain text message
      return {
        role: msg.role as "user" | "assistant",
        content: msg.content,
      };
    });
  }
}
