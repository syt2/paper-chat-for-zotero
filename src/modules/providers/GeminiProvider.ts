/**
 * GeminiProvider - Google AI Gemini API implementation
 */

import { BaseProvider } from "./BaseProvider";
import type { ChatMessage, StreamCallbacks } from "../../types/chat";
import type { GeminiContent, GeminiPart, PdfAttachment } from "../../types/provider";

export class GeminiProvider extends BaseProvider {
  // Gemini doesn't support PDF upload in the same way
  supportsPdfUpload(): boolean {
    return false;
  }

  async streamChatCompletion(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    _pdfAttachment?: PdfAttachment,
  ): Promise<void> {
    const { onChunk, onComplete, onError } = callbacks;

    if (!this.isReady()) {
      onError(new Error("Provider is not configured"));
      return;
    }

    try {
      const geminiContents = this.formatMessages(messages);

      // Gemini uses URL query param for API key
      const url = `${this._config.baseUrl}/models/${this._config.defaultModel}:streamGenerateContent?key=${this._config.apiKey}&alt=sse`;

      const generationConfig: Record<string, unknown> = {
        temperature: this._config.temperature ?? 0.7,
      };
      if (this._config.maxTokens && this._config.maxTokens > 0) {
        generationConfig.maxOutputTokens = this._config.maxTokens;
      }

      const requestBody: Record<string, unknown> = {
        contents: geminiContents,
        generationConfig,
      };

      // Add system instruction if present
      if (this._config.systemPrompt) {
        requestBody.systemInstruction = {
          parts: [{ text: this._config.systemPrompt }],
        };
      }

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error: ${response.status} - ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response body is not readable");

      let fullContent = "";

      await this.parseGeminiSSE(
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
   * Parse Gemini SSE stream
   */
  private async parseGeminiSSE(
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

          try {
            const parsed = JSON.parse(data);

            // Gemini response format
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if (text) {
              onText(text);
            }

            // Check for errors
            if (parsed.error) {
              onError(new Error(parsed.error.message || "Unknown error"));
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

    const geminiContents = this.formatMessages(messages);

    const url = `${this._config.baseUrl}/models/${this._config.defaultModel}:generateContent?key=${this._config.apiKey}`;

    const generationConfig: Record<string, unknown> = {
      temperature: this._config.temperature ?? 0.7,
    };
    if (this._config.maxTokens && this._config.maxTokens > 0) {
      generationConfig.maxOutputTokens = this._config.maxTokens;
    }

    const requestBody: Record<string, unknown> = {
      contents: geminiContents,
      generationConfig,
    };

    if (this._config.systemPrompt) {
      requestBody.systemInstruction = {
        parts: [{ text: this._config.systemPrompt }],
      };
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }

  async testConnection(): Promise<boolean> {
    try {
      const url = `${this._config.baseUrl}/models?key=${this._config.apiKey}`;
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    try {
      const url = `${this._config.baseUrl}/models?key=${this._config.apiKey}`;
      const response = await fetch(url);
      if (response.ok) {
        const data = (await response.json()) as {
          models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
        };
        return (
          data.models
            ?.filter((m) =>
              m.supportedGenerationMethods?.includes("generateContent") &&
              m.name.includes("gemini")
            )
            .map((m) => m.name.replace("models/", "")) || []
        );
      }
    } catch {
      // Ignore errors
    }
    return this._config.availableModels || [
      "gemini-2.0-flash-exp",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    ];
  }

  /**
   * Format messages for Gemini API
   */
  private formatMessages(messages: ChatMessage[]): GeminiContent[] {
    return this.filterMessages(messages)
      .filter((msg) => msg.role !== "system") // System handled separately
      .map((msg) => {
        const parts: GeminiPart[] = [];

        // Add images first if present
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
