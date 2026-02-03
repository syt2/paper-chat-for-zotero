/**
 * BaseProvider - Abstract base class with shared functionality
 */

import type {
  ChatMessage,
  StreamCallbacks,
  OpenAIMessage,
  OpenAIMessageContent,
} from "../../types/chat";
import type {
  AIProvider,
  ApiKeyProviderConfig,
  PdfAttachment,
  AnthropicMessage,
  AnthropicContentBlock,
  GeminiContent,
  GeminiPart,
} from "../../types/provider";
import {
  parseSSEStream,
  type SSEFormat,
  type SSEParserCallbacks,
} from "./SSEParser";

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
    return (
      !!this._config.apiKey && !!this._config.baseUrl && this._config.enabled
    );
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
   * Validate fetch response and throw error if not ok
   */
  protected async validateResponse(response: Response): Promise<void> {
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Error: ${response.status} - ${errorText}`);
    }
  }

  /**
   * Get readable stream reader from response, throws if unavailable
   */
  protected getResponseReader(
    response: Response,
  ): ReadableStreamDefaultReader<Uint8Array> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Response body is not readable");
    return reader as ReadableStreamDefaultReader<Uint8Array>;
  }

  /**
   * Stream SSE response with content accumulation
   * Handles the common pattern of accumulating content and calling callbacks
   */
  protected async streamWithCallbacks(
    response: Response,
    format: SSEFormat,
    callbacks: StreamCallbacks,
  ): Promise<void> {
    const { onChunk, onComplete, onError } = callbacks;
    const reader = this.getResponseReader(response);
    let fullContent = "";

    await this.parseSSE(reader, format, {
      onText: (text) => {
        fullContent += text;
        onChunk(text);
      },
      onDone: () => onComplete(fullContent),
      onError,
    });
  }

  /**
   * Wrap unknown error as Error instance
   */
  protected wrapError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * Filter messages - remove empty content and error messages
   * Keep tool messages and messages with tool_calls
   */
  protected filterMessages(messages: ChatMessage[]): ChatMessage[] {
    const nonErrorMessages = messages.filter((msg) => msg.role !== "error");
    const lastIndex = nonErrorMessages.length - 1;

    return nonErrorMessages.filter((msg, index) => {
      // Always keep tool messages
      if (msg.role === "tool") {
        return true;
      }
      // Always keep messages with tool_calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        return true;
      }
      // Allow empty content for last assistant message (streaming placeholder)
      if (index === lastIndex && msg.role === "assistant") {
        return msg.content.trim() !== "";
      }
      return msg.content && msg.content.trim() !== "";
    });
  }

  /**
   * Format messages for OpenAI-compatible API (OpenAI, DeepSeek, Mistral, etc.)
   * Supports Vision API format for images, optional PDF attachment, and tool calling
   */
  protected formatOpenAIMessages(
    messages: ChatMessage[],
    pdfAttachment?: PdfAttachment,
  ): OpenAIMessage[] {
    const filtered = this.filterMessages(messages);
    const firstUserIndex = filtered.findIndex((m) => m.role === "user");

    return filtered.map((msg, index) => {
      // Handle tool messages
      if (msg.role === "tool") {
        return {
          role: "tool" as const,
          content: msg.content,
          tool_call_id: msg.tool_call_id,
        };
      }

      // Handle assistant messages with tool_calls
      if (
        msg.role === "assistant" &&
        msg.tool_calls &&
        msg.tool_calls.length > 0
      ) {
        return {
          role: "assistant" as const,
          content: msg.content || null,
          tool_calls: msg.tool_calls,
        };
      }

      const shouldAttachPdf =
        pdfAttachment && msg.role === "user" && index === firstUserIndex;
      const hasImages = msg.images && msg.images.length > 0;

      // Use multimodal format if has images or PDF
      if (hasImages || shouldAttachPdf) {
        const content: OpenAIMessageContent[] = [];

        // Add PDF as document (Anthropic format, supported by new-api)
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

        // Add text
        content.push({ type: "text", text: msg.content });

        // Add images
        if (msg.images) {
          for (const image of msg.images) {
            content.push({
              type: "image_url",
              image_url: {
                url:
                  image.type === "base64"
                    ? `data:${image.mimeType};base64,${image.data}`
                    : image.data,
                detail: "auto",
              },
            });
          }
        }

        return { role: msg.role as "user" | "assistant" | "system", content };
      }

      // Plain text message
      return {
        role: msg.role as "user" | "assistant" | "system",
        content: msg.content,
      };
    });
  }

  /**
   * Format messages for Anthropic API (Claude)
   * Supports PDF and image attachments in Anthropic format
   */
  protected formatAnthropicMessages(
    messages: ChatMessage[],
    pdfAttachment?: PdfAttachment,
  ): AnthropicMessage[] {
    const filtered = this.filterMessages(messages).filter(
      (msg) => msg.role !== "system",
    );
    const firstUserIndex = filtered.findIndex((m) => m.role === "user");

    return filtered.map((msg, index) => {
      const shouldAttachPdf =
        pdfAttachment && msg.role === "user" && index === firstUserIndex;
      const hasImages = msg.images && msg.images.length > 0;

      // Use multimodal format if has images or PDF
      if (hasImages || shouldAttachPdf) {
        const content: AnthropicContentBlock[] = [];

        // Add PDF document first
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
        content.push({ type: "text", text: msg.content });

        return { role: msg.role as "user" | "assistant", content };
      }

      // Plain text message
      return { role: msg.role as "user" | "assistant", content: msg.content };
    });
  }

  /**
   * Format messages for Gemini API
   * Supports image attachments in Gemini format
   */
  protected formatGeminiMessages(messages: ChatMessage[]): GeminiContent[] {
    return this.filterMessages(messages)
      .filter((msg) => msg.role !== "system")
      .map((msg) => {
        const parts: GeminiPart[] = [];

        // Add images first
        if (msg.images && msg.images.length > 0) {
          for (const img of msg.images) {
            parts.push({
              inline_data: {
                mime_type: img.mimeType,
                data: img.data,
              },
            });
          }
        }

        // Add text
        parts.push({ text: msg.content });

        return {
          role: msg.role === "assistant" ? "model" : "user",
          parts,
        };
      });
  }
}
