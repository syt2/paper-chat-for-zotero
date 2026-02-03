/**
 * OpenAICompatibleProvider - For OpenAI, DeepSeek, Mistral, Groq, OpenRouter, Custom
 */

import { BaseProvider } from "./BaseProvider";
import type { ChatMessage, StreamCallbacks } from "../../types/chat";
import type { PdfAttachment } from "../../types/provider";
import type { ToolDefinition, ToolCall } from "../../types/tool";

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
        apiMessages.unshift({
          role: "system",
          content: this._config.systemPrompt,
        });
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
      apiMessages.unshift({
        role: "system",
        content: this._config.systemPrompt,
      });
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
      const response = await fetch(`${this._config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this._config.apiKey}` },
      });
      if (response.ok) {
        const data = (await response.json()) as {
          data?: Array<{ id: string }>;
        };
        return data.data?.map((m) => m.id) || [];
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

  /**
   * Chat completion with tool calling support (non-streaming)
   * Returns both content and tool_calls
   */
  async chatCompletionWithTools(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
  ): Promise<{ content: string; toolCalls?: ToolCall[] }> {
    if (!this.isReady()) {
      throw new Error("Provider is not configured");
    }

    const apiMessages = this.formatOpenAIMessages(messages);

    if (this._config.systemPrompt) {
      apiMessages.unshift({
        role: "system",
        content: this._config.systemPrompt,
      });
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

    // Add tools if provided
    if (tools && tools.length > 0) {
      requestBody.tools = tools;
      requestBody.tool_choice = "auto";
      ztoolkit.log(
        "[chatCompletionWithTools] Sending request with",
        tools.length,
        "tools",
      );
      ztoolkit.log(
        "[chatCompletionWithTools] Tool names:",
        tools.map((t) => t.function.name).join(", "),
      );
    }

    ztoolkit.log(
      "[chatCompletionWithTools] Request URL:",
      `${this._config.baseUrl}/chat/completions`,
    );
    ztoolkit.log("[chatCompletionWithTools] Model:", this._config.defaultModel);

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
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: ToolCall[];
        };
        finish_reason?: string;
      }>;
    };

    const message = data.choices?.[0]?.message;
    const finishReason = data.choices?.[0]?.finish_reason;

    ztoolkit.log(
      "[chatCompletionWithTools] Response finish_reason:",
      finishReason,
    );
    ztoolkit.log(
      "[chatCompletionWithTools] Response has content:",
      !!message?.content,
    );
    ztoolkit.log(
      "[chatCompletionWithTools] Response tool_calls count:",
      message?.tool_calls?.length || 0,
    );
    if (message?.tool_calls) {
      ztoolkit.log(
        "[chatCompletionWithTools] Tool calls:",
        JSON.stringify(message.tool_calls),
      );
    }

    return {
      content: message?.content || "",
      toolCalls: message?.tool_calls,
    };
  }
}
