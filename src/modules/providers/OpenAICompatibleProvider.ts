/**
 * OpenAICompatibleProvider - For OpenAI, DeepSeek, Mistral, Groq, OpenRouter, Custom
 */

import { getErrorMessage } from "../../utils/common";
import { BaseProvider } from "./BaseProvider";
import type {
  ChatMessage,
  StreamCallbacks,
  StreamToolCallingCallbacks,
} from "../../types/chat";
import type { PdfAttachment, ToolCallingOptions } from "../../types/provider";
import type { ToolDefinition, ToolCall } from "../../types/tool";
import { parseSSEStreamWithToolCalling } from "./SSEParser";
import { shouldIncludeReasoningContentForRequest } from "./reasoning-content";
import {
  canonicalizeForPromptCache,
  logPromptCacheUsage,
  normalizePromptCacheTools,
  recordPromptCacheRequestShape,
  stablePromptCacheStringify,
} from "./prompt-cache-diagnostics";

const EXTRA_REQUEST_BODY_PROTECTED_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "tools",
  "tool_choice",
  "temperature",
  "max_tokens",
  "max_completion_tokens",
]);

function isOfficialOpenAIEndpoint(config: { baseUrl: string }): boolean {
  try {
    return new URL(config.baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

export function shouldUseOpenAIMaxCompletionTokens(config: {
  id: string;
  type: string;
  baseUrl: string;
}): boolean {
  return isOfficialOpenAIEndpoint(config);
}

export function supportsOpenAITemperature(config: {
  id: string;
  type: string;
  baseUrl: string;
  defaultModel: string;
}): boolean {
  if (!isOfficialOpenAIEndpoint(config)) {
    return true;
  }
  return !/^(?:o\d|gpt-5)(?:[-.]|$)/i.test(config.defaultModel);
}

const DSML_TAG_PREFIX = String.raw`[|｜]\s*DSML\s*[|｜]`;
const DSML_TOOL_CALLS_START_REGEX = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>`,
  "i",
);
const DSML_TOOL_CALLS_BLOCK_REGEX = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>([\s\S]*?)<\s*\/\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>`,
  "gi",
);
const DSML_INVOKE_REGEX = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*invoke\b([^>]*)>([\s\S]*?)<\s*\/\s*${DSML_TAG_PREFIX}\s*invoke\s*>`,
  "gi",
);
const DSML_PARAMETER_REGEX = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*parameter\b([^>]*)>([\s\S]*?)<\s*\/\s*${DSML_TAG_PREFIX}\s*parameter\s*>`,
  "gi",
);
const XML_ATTRIBUTE_REGEX =
  /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const DSML_DETECTION_TAIL_LENGTH = 64;

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseXmlAttributes(rawAttributes: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let match: RegExpExecArray | null;
  XML_ATTRIBUTE_REGEX.lastIndex = 0;

  while ((match = XML_ATTRIBUTE_REGEX.exec(rawAttributes)) !== null) {
    attributes[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? "");
  }

  return attributes;
}

export function stripDsmlToolCallBlocks(content: string): string {
  DSML_TOOL_CALLS_BLOCK_REGEX.lastIndex = 0;
  return content.replace(DSML_TOOL_CALLS_BLOCK_REGEX, "").trim();
}

export function parseDsmlToolCallsFromContent(content: string): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  let blockMatch: RegExpExecArray | null;
  let index = 0;

  DSML_TOOL_CALLS_BLOCK_REGEX.lastIndex = 0;
  while ((blockMatch = DSML_TOOL_CALLS_BLOCK_REGEX.exec(content)) !== null) {
    const block = blockMatch[1];
    let invokeMatch: RegExpExecArray | null;
    DSML_INVOKE_REGEX.lastIndex = 0;

    while ((invokeMatch = DSML_INVOKE_REGEX.exec(block)) !== null) {
      const invokeAttributes = parseXmlAttributes(invokeMatch[1]);
      const functionName = invokeAttributes.name;
      if (!functionName) {
        continue;
      }

      const paramsBlock = invokeMatch[2];
      const params: Record<string, string> = {};
      let paramMatch: RegExpExecArray | null;
      DSML_PARAMETER_REGEX.lastIndex = 0;

      while ((paramMatch = DSML_PARAMETER_REGEX.exec(paramsBlock)) !== null) {
        const paramAttributes = parseXmlAttributes(paramMatch[1]);
        const paramName = paramAttributes.name;
        if (!paramName) {
          continue;
        }
        params[paramName] = decodeXmlEntities(paramMatch[2].trim());
      }

      toolCalls.push({
        id: `dsml_call_${index}`,
        type: "function",
        function: {
          name: functionName,
          arguments: JSON.stringify(params),
        },
      });
      index++;
    }
  }

  return toolCalls;
}

function filterToolCallsByAllowedTools(
  toolCalls: ToolCall[],
  tools: ToolDefinition[] | undefined,
): ToolCall[] {
  if (!tools || tools.length === 0) {
    return [];
  }

  const allowedToolNames = new Set(tools.map((tool) => tool.function.name));
  return toolCalls.filter((toolCall) =>
    allowedToolNames.has(toolCall.function.name),
  );
}

function mergeExtraRequestBody(
  requestBody: Record<string, unknown>,
  extra: Record<string, unknown> | undefined,
): void {
  if (!extra) {
    return;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (EXTRA_REQUEST_BODY_PROTECTED_KEYS.has(key)) {
      continue;
    }
    requestBody[key] = canonicalizeForPromptCache(value);
  }
}

export function applyExtraRequestBody(
  requestBody: Record<string, unknown>,
  config: {
    defaultModel: string;
    extraRequestBody?: Record<string, unknown>;
    modelExtraRequestBody?: Record<string, Record<string, unknown>>;
  },
): void {
  mergeExtraRequestBody(requestBody, config.extraRequestBody);
  mergeExtraRequestBody(
    requestBody,
    config.modelExtraRequestBody?.[config.defaultModel],
  );
}

export class OpenAICompatibleProvider extends BaseProvider {
  private applyGenerationOptions(requestBody: Record<string, unknown>): void {
    if (supportsOpenAITemperature(this._config)) {
      requestBody.temperature = this._config.temperature ?? 0.7;
    }

    if (this._config.maxTokens && this._config.maxTokens > 0) {
      if (shouldUseOpenAIMaxCompletionTokens(this._config)) {
        requestBody.max_completion_tokens = this._config.maxTokens;
      } else {
        requestBody.max_tokens = this._config.maxTokens;
      }
    }
  }

  private prepareOpenAIRequestBody(
    requestKind: string,
    requestBody: Record<string, unknown>,
  ): string {
    recordPromptCacheRequestShape({
      providerId: this._config.id,
      model: this._config.defaultModel,
      requestKind,
      requestBody,
    });
    return stablePromptCacheStringify(requestBody);
  }

  private logUsage(requestKind: string, usage: unknown): void {
    logPromptCacheUsage({
      providerId: this._config.id,
      model: this._config.defaultModel,
      requestKind,
      usage,
    });
  }

  protected shouldIncludeReasoningContent(): boolean {
    return shouldIncludeReasoningContentForRequest({
      providerId: this._config.id,
      modelId: this._config.defaultModel,
      baseUrl: this._config.baseUrl,
    });
  }

  async streamChatCompletion(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    pdfAttachment?: PdfAttachment,
    signal?: AbortSignal,
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
        stream: true,
      };
      this.applyGenerationOptions(requestBody);
      applyExtraRequestBody(requestBody, this._config);

      const response = await fetch(`${this._config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: this.prepareOpenAIRequestBody("stream", requestBody),
        signal,
      });

      await this.validateResponse(response);
      await this.streamWithCallbacks(response, "openai", callbacks);
    } catch (error) {
      onError(this.wrapError(error));
    }
  }

  async chatCompletion(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<string> {
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
      stream: false,
    };
    this.applyGenerationOptions(requestBody);
    applyExtraRequestBody(requestBody, this._config);

    const response = await fetch(`${this._config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this._config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: this.prepareOpenAIRequestBody("completion", requestBody),
      signal,
    });

    await this.validateResponse(response);

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: unknown;
    };
    this.logUsage("completion", data.usage);
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
        getErrorMessage(error),
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
        getErrorMessage(error),
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
    signal?: AbortSignal,
    options?: ToolCallingOptions,
  ): Promise<{ content: string; reasoning?: string; toolCalls?: ToolCall[] }> {
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
      stream: false,
    };

    this.applyGenerationOptions(requestBody);
    applyExtraRequestBody(requestBody, this._config);

    // Add tools if provided
    if (tools && tools.length > 0) {
      requestBody.tools = normalizePromptCacheTools(tools);
      requestBody.tool_choice = options?.toolChoice || "auto";
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
      body: this.prepareOpenAIRequestBody("tools", requestBody),
      signal,
    });

    await this.validateResponse(response);

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: ToolCall[];
        };
        finish_reason?: string;
      }>;
      usage?: unknown;
    };
    this.logUsage("tools", data.usage);

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

    const rawContent = message?.content || "";
    const structuredToolCalls = message?.tool_calls;
    const allowDsmlFallback =
      !!tools && tools.length > 0 && options?.toolChoice !== "none";

    // Fallback: some OpenAI-compatible backends leak native tool-call markup
    // into content instead of returning structured message.tool_calls.
    if (
      finishReason === "tool_calls" &&
      (!structuredToolCalls || structuredToolCalls.length === 0)
    ) {
      const xmlToolCalls = this.parseXmlToolCalls(rawContent);
      if (xmlToolCalls.length > 0) {
        ztoolkit.log(
          "[chatCompletionWithTools] Parsed",
          xmlToolCalls.length,
          "tool calls from XML fallback",
        );
        const cleanContent = rawContent
          .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "")
          .trim();
        return {
          content: cleanContent,
          reasoning: message?.reasoning_content || undefined,
          toolCalls: xmlToolCalls,
        };
      }
    }

    const dsmlToolCalls = allowDsmlFallback
      ? filterToolCallsByAllowedTools(
          parseDsmlToolCallsFromContent(rawContent),
          tools,
        )
      : [];
    if (dsmlToolCalls.length > 0) {
      ztoolkit.log(
        "[chatCompletionWithTools] Parsed",
        dsmlToolCalls.length,
        "tool calls from DSML fallback",
      );
      return {
        content: stripDsmlToolCallBlocks(rawContent),
        reasoning: message?.reasoning_content || undefined,
        toolCalls:
          structuredToolCalls && structuredToolCalls.length > 0
            ? structuredToolCalls
            : dsmlToolCalls,
      };
    }

    return {
      content: rawContent,
      reasoning: message?.reasoning_content || undefined,
      toolCalls: structuredToolCalls,
    };
  }

  /**
   * Parse XML-formatted tool calls from content string.
   * Some backends (e.g. Anthropic→OpenAI adapters) may emit tool calls
   * as XML in the content field instead of structured tool_calls.
   */
  private parseXmlToolCalls(content: string): ToolCall[] {
    try {
      const blockMatch = content.match(
        /<function_calls>([\s\S]*?)<\/function_calls>/,
      );
      if (!blockMatch) return [];

      const block = blockMatch[1];
      const invokeRegex = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
      const toolCalls: ToolCall[] = [];
      let invokeMatch: RegExpExecArray | null;
      let index = 0;

      while ((invokeMatch = invokeRegex.exec(block)) !== null) {
        const functionName = invokeMatch[1];
        const paramsBlock = invokeMatch[2];
        const paramRegex =
          /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
        const params: Record<string, string> = {};
        let paramMatch: RegExpExecArray | null;

        while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
          params[paramMatch[1]] = paramMatch[2];
        }

        toolCalls.push({
          id: `xml_call_${index}`,
          type: "function",
          function: {
            name: functionName,
            arguments: JSON.stringify(params),
          },
        });
        index++;
      }

      return toolCalls;
    } catch {
      return [];
    }
  }

  /**
   * Stream chat completion with tool calling support
   * 流式 tool calling，实时返回文本和工具调用
   */
  async streamChatCompletionWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    callbacks: StreamToolCallingCallbacks,
    signal?: AbortSignal,
    options?: ToolCallingOptions,
  ): Promise<void> {
    const {
      onTextDelta,
      onReasoningDelta,
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
        stream: true,
      };

      if (tools.length > 0) {
        requestBody.tools = normalizePromptCacheTools(tools);
        requestBody.tool_choice = options?.toolChoice || "auto";
      }

      this.applyGenerationOptions(requestBody);
      applyExtraRequestBody(requestBody, this._config);

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
        body: this.prepareOpenAIRequestBody("tools-stream", requestBody),
        signal,
      });

      await this.validateResponse(response);
      const reader = this.getResponseReader(response);

      // 累积状态
      let fullContent = "";
      let fullReasoning = "";
      const toolCallsMap = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let stopReason = "end_turn";
      const allowDsmlFallback =
        tools.length > 0 && options?.toolChoice !== "none";
      let pendingTextDelta = "";
      let suppressDsmlTextDeltas = false;

      const flushPendingTextDelta = (): void => {
        if (!pendingTextDelta) {
          return;
        }
        onTextDelta(pendingTextDelta);
        pendingTextDelta = "";
      };

      const handleTextDelta = (text: string): void => {
        fullContent += text;

        if (!allowDsmlFallback) {
          onTextDelta(text);
          return;
        }

        if (suppressDsmlTextDeltas) {
          return;
        }

        const combined = pendingTextDelta + text;
        const dsmlStartMatch = DSML_TOOL_CALLS_START_REGEX.exec(combined);
        if (dsmlStartMatch?.index !== undefined) {
          const safePrefix = combined.slice(0, dsmlStartMatch.index);
          pendingTextDelta = "";
          suppressDsmlTextDeltas = true;
          if (safePrefix) {
            onTextDelta(safePrefix);
          }
          return;
        }

        const emitLength = Math.max(
          0,
          combined.length - DSML_DETECTION_TAIL_LENGTH,
        );
        if (emitLength > 0) {
          onTextDelta(combined.slice(0, emitLength));
          pendingTextDelta = combined.slice(emitLength);
        } else {
          pendingTextDelta = combined;
        }
      };

      await parseSSEStreamWithToolCalling(reader, "openai", {
        onEvent: (event) => {
          switch (event.type) {
            case "text_delta":
              handleTextDelta(event.text);
              break;

            case "reasoning_delta":
              fullReasoning += event.text;
              if (onReasoningDelta) {
                onReasoningDelta(event.text);
              }
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

      const dsmlToolCalls = allowDsmlFallback
        ? filterToolCallsByAllowedTools(
            parseDsmlToolCallsFromContent(fullContent),
            tools,
          )
        : [];
      const cleanContent =
        dsmlToolCalls.length > 0
          ? stripDsmlToolCallBlocks(fullContent)
          : fullContent;

      if (dsmlToolCalls.length === 0) {
        flushPendingTextDelta();
      }

      onComplete({
        content: cleanContent,
        reasoning: fullReasoning || undefined,
        toolCalls:
          toolCalls.length > 0
            ? toolCalls
            : dsmlToolCalls.length > 0
              ? dsmlToolCalls
              : undefined,
        stopReason:
          dsmlToolCalls.length > 0
            ? "tool_calls"
            : (stopReason as "tool_calls" | "end_turn" | "max_tokens" | "stop"),
      });
    } catch (error) {
      onError(this.wrapError(error));
    }
  }
}
