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

      await this.parseAnthropicSSE(
        reader as ReadableStreamDefaultReader<Uint8Array>,
        (text) => {
          fullContent += text;
          onChunk(text);
        },
        () => onComplete(fullContent),
        onError,
      );
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Parse Anthropic SSE stream (different format than OpenAI)
   */
  private async parseAnthropicSSE(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onText: (text: string) => void,
    onDone: () => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";

    try {
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
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);

            // Anthropic events: content_block_delta contains text
            if (parsed.type === "content_block_delta") {
              const text = parsed.delta?.text || "";
              if (text) {
                onText(text);
              }
            }
            // Handle errors
            else if (parsed.type === "error") {
              onError(new Error(parsed.error?.message || "Unknown error"));
              return;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
      onDone();
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
      "claude-sonnet-4-20250514",
      "claude-3-7-sonnet-20250219",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-20240229",
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
