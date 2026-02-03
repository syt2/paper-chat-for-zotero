/**
 * GeminiProvider - Google AI Gemini API implementation
 */

import { BaseProvider } from "./BaseProvider";
import type { ChatMessage, StreamCallbacks } from "../../types/chat";
import type { PdfAttachment } from "../../types/provider";

export class GeminiProvider extends BaseProvider {
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
      const geminiContents = this.formatGeminiMessages(messages);
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

      await this.validateResponse(response);
      await this.streamWithCallbacks(response, "gemini", callbacks);
    } catch (error) {
      onError(this.wrapError(error));
    }
  }

  async chatCompletion(messages: ChatMessage[]): Promise<string> {
    if (!this.isReady()) {
      throw new Error("Provider is not configured");
    }

    const geminiContents = this.formatGeminiMessages(messages);
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

    await this.validateResponse(response);

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(
        `${this._config.baseUrl}/models?key=${this._config.apiKey}`,
      );
      if (!response.ok) {
        ztoolkit.log(
          `[${this.getName()}] testConnection failed: ${response.status} ${response.statusText}`,
        );
      }
      return response.ok;
    } catch (error) {
      ztoolkit.log(
        `[${this.getName()}] testConnection error:`,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    try {
      const response = await fetch(
        `${this._config.baseUrl}/models?key=${this._config.apiKey}`,
      );
      if (response.ok) {
        const data = (await response.json()) as {
          models?: Array<{
            name: string;
            supportedGenerationMethods?: string[];
          }>;
        };
        return (
          data.models
            ?.filter(
              (m) =>
                m.supportedGenerationMethods?.includes("generateContent") &&
                m.name.includes("gemini"),
            )
            .map((m) => m.name.replace("models/", "")) || []
        );
      }
      ztoolkit.log(
        `[${this.getName()}] getAvailableModels failed: ${response.status}`,
      );
    } catch (error) {
      ztoolkit.log(
        `[${this.getName()}] getAvailableModels error:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    return this._config.availableModels || [];
  }
}
