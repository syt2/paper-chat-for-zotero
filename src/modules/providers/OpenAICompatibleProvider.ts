/**
 * OpenAICompatibleProvider - For OpenAI, DeepSeek, Mistral, Groq, OpenRouter, Custom
 */

import { BaseProvider } from "./BaseProvider";
import type {
  ChatMessage,
  StreamCallbacks,
  StreamToolCallingCallbacks,
} from "../../types/chat";
import type { PdfAttachment } from "../../types/provider";
import type { ToolDefinition, ToolCall } from "../../types/tool";
import { parseSSEStreamWithToolCalling } from "./SSEParser";

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

  /**
   * Stream chat completion with tool calling support
   * 流式 tool calling，实时返回文本和工具调用
   */
  async streamChatCompletionWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    callbacks: StreamToolCallingCallbacks,
  ): Promise<void> {
    const { onTextDelta, onToolCallStart, onToolCallDelta, onComplete, onError } =
      callbacks;

    if (!this.isReady()) {
      onError(new Error("Provider is not configured"));
      return;
    }

    try {
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
        stream: true,
        tools: tools,
        tool_choice: "auto",
      };

      if (this._config.maxTokens && this._config.maxTokens > 0) {
        requestBody.max_tokens = this._config.maxTokens;
      }

      ztoolkit.log(
        "[streamChatCompletionWithTools] Sending streaming request with",
        tools.length,
        "tools",
      );

      const response = await fetch(`${this._config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      await this.validateResponse(response);
      const reader = this.getResponseReader(response);

      // 累积状态
      let fullContent = "";
      const toolCallsMap = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let stopReason = "end_turn";

      await parseSSEStreamWithToolCalling(reader, "openai", {
        onEvent: (event) => {
          switch (event.type) {
            case "text_delta":
              fullContent += event.text;
              onTextDelta(event.text);
              break;

            case "tool_call_start":
              toolCallsMap.set(event.index, {
                id: event.id,
                name: event.name,
                arguments: "",
              });
              onToolCallStart({
                index: event.index,
                id: event.id,
                name: event.name,
              });
              break;

            case "tool_call_delta": {
              const tc = toolCallsMap.get(event.index);
              if (tc) {
                tc.arguments += event.argumentsDelta;
              }
              onToolCallDelta(event.index, event.argumentsDelta);
              break;
            }

            case "done":
              stopReason = event.stopReason;
              break;

            case "error":
              onError(event.error);
              break;
          }
        },
      });

      // 构建最终的 toolCalls 数组
      const toolCalls: ToolCall[] = [];
      for (const [, tc] of toolCallsMap) {
        toolCalls.push({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        });
      }

      onComplete({
        content: fullContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        stopReason: stopReason as "tool_calls" | "end_turn" | "max_tokens" | "stop",
      });
    } catch (error) {
      onError(this.wrapError(error));
    }
  }
}
