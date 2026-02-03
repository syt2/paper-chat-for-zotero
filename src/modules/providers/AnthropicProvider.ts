/**
 * AnthropicProvider - Claude API implementation
 * Uses Anthropic Messages API format (different from OpenAI)
 */

import { BaseProvider } from "./BaseProvider";
import type {
  ChatMessage,
  StreamCallbacks,
  StreamToolCallingCallbacks,
} from "../../types/chat";
import type {
  PdfAttachment,
  AnthropicTool,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicMessage,
  AnthropicTextBlock,
  AnthropicImageBlock,
} from "../../types/provider";
import type { ToolDefinition, ToolCall } from "../../types/tool";
import { parseSSEStreamWithToolCalling } from "./SSEParser";

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
      const anthropicMessages = this.formatAnthropicMessages(
        messages,
        pdfAttachment,
      );

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

    return (
      data.content
        ?.filter((block) => block.type === "text")
        .map((block) => block.text || "")
        .join("") || ""
    );
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
          model: this._config.defaultModel || "claude-haiku-4-5-20251001",
          max_tokens: 10,
          messages: [{ role: "user", content: "Hi" }],
        }),
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
    // Anthropic doesn't have a public models API, use config
    return this._config.availableModels || [];
  }

  /**
   * Convert OpenAI tool definition format to Anthropic format
   */
  private convertToAnthropicTools(tools: ToolDefinition[]): AnthropicTool[] {
    return tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: {
        type: "object" as const,
        properties: tool.function.parameters.properties,
        required: tool.function.parameters.required,
      },
    }));
  }

  /**
   * Format messages for Anthropic API with tool calling support
   * Handles tool_calls from assistant and tool results from user
   *
   * Key differences from OpenAI:
   * - Tool results must be wrapped in a "user" message
   * - Consecutive tool results are combined into one user message
   * - Tool calls use "tool_use" blocks in assistant messages
   */
  private formatMessagesWithTools(
    messages: ChatMessage[],
  ): AnthropicMessage[] {
    const result: AnthropicMessage[] = [];
    const filtered = messages.filter(
      (msg) => msg.role !== "system" && msg.role !== "error",
    );

    for (let i = 0; i < filtered.length; i++) {
      const msg = filtered[i];

      // Handle tool messages - combine consecutive tool results into one user message
      if (msg.role === "tool") {
        const toolResults: AnthropicToolResultBlock[] = [];
        let j = i;

        // Collect all consecutive tool result messages
        while (j < filtered.length && filtered[j].role === "tool") {
          const toolMsg = filtered[j];
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolMsg.tool_call_id!,
            content: toolMsg.content,
          });
          j++;
        }

        // Skip the messages we've processed
        i = j - 1;

        // Anthropic requires tool results in a "user" message
        result.push({
          role: "user",
          content: toolResults,
        });
        continue;
      }

      // Handle assistant messages with tool_calls
      if (
        msg.role === "assistant" &&
        msg.tool_calls &&
        msg.tool_calls.length > 0
      ) {
        const content: (AnthropicTextBlock | AnthropicToolUseBlock)[] = [];

        // Add text content if present
        if (msg.content && msg.content.trim()) {
          content.push({ type: "text", text: msg.content });
        }

        // Convert OpenAI tool_calls to Anthropic tool_use blocks
        for (const tc of msg.tool_calls) {
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(tc.function.arguments);
          } catch {
            // If JSON parse fails, wrap the raw string
            parsedInput = { raw: tc.function.arguments };
          }

          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: parsedInput,
          });
        }

        result.push({
          role: "assistant",
          content,
        });
        continue;
      }

      // Handle regular user/assistant messages
      if (msg.role === "user" || msg.role === "assistant") {
        const hasImages = msg.images && msg.images.length > 0;

        if (hasImages) {
          const content: (AnthropicTextBlock | AnthropicImageBlock)[] = [];

          // Add images first
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

          result.push({
            role: msg.role,
            content,
          });
        } else {
          // Plain text message
          result.push({
            role: msg.role,
            content: msg.content,
          });
        }
      }
    }

    return result;
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

    const anthropicMessages = this.formatMessagesWithTools(messages);

    const requestBody: Record<string, unknown> = {
      model: this._config.defaultModel,
      max_tokens: this._config.maxTokens || 8192,
      system: this._config.systemPrompt || undefined,
      messages: anthropicMessages,
    };

    // Add tools if provided
    if (tools && tools.length > 0) {
      requestBody.tools = this.convertToAnthropicTools(tools);
      requestBody.tool_choice = { type: "auto" };
      ztoolkit.log(
        "[AnthropicProvider.chatCompletionWithTools] Sending request with",
        tools.length,
        "tools",
      );
    }

    const response = await fetch(`${this._config.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this._config.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    await this.validateResponse(response);

    const data = (await response.json()) as {
      content?: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      stop_reason?: string;
    };

    // Extract text content
    const textContent =
      data.content
        ?.filter((block) => block.type === "text")
        .map((block) => block.text || "")
        .join("") || "";

    // Extract tool calls
    const toolUseBlocks =
      data.content?.filter((block) => block.type === "tool_use") || [];

    const toolCalls: ToolCall[] = toolUseBlocks.map((block) => ({
      id: block.id!,
      type: "function" as const,
      function: {
        name: block.name!,
        arguments: JSON.stringify(block.input || {}),
      },
    }));

    ztoolkit.log(
      "[AnthropicProvider.chatCompletionWithTools] Response stop_reason:",
      data.stop_reason,
    );
    ztoolkit.log(
      "[AnthropicProvider.chatCompletionWithTools] Tool calls count:",
      toolCalls.length,
    );

    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
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
    const {
      onTextDelta,
      onToolCallStart,
      onToolCallDelta,
      onComplete,
      onError,
    } = callbacks;

    if (!this.isReady()) {
      onError(new Error("Provider is not configured"));
      return;
    }

    try {
      const anthropicMessages = this.formatMessagesWithTools(messages);

      const requestBody: Record<string, unknown> = {
        model: this._config.defaultModel,
        max_tokens: this._config.maxTokens || 8192,
        system: this._config.systemPrompt || undefined,
        messages: anthropicMessages,
        stream: true,
        tools: this.convertToAnthropicTools(tools),
        tool_choice: { type: "auto" },
      };

      ztoolkit.log(
        "[AnthropicProvider.streamChatCompletionWithTools] Sending streaming request with",
        tools.length,
        "tools",
      );

      const response = await fetch(`${this._config.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": this._config.apiKey,
          "anthropic-version": "2023-06-01",
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

      await parseSSEStreamWithToolCalling(reader, "anthropic", {
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
        stopReason: stopReason as
          | "tool_calls"
          | "end_turn"
          | "max_tokens"
          | "stop",
      });
    } catch (error) {
      onError(this.wrapError(error));
    }
  }
}
