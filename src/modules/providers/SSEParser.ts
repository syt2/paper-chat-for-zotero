/**
 * SSEParser - Unified Server-Sent Events stream parser
 *
 * Handles SSE parsing for different AI provider formats:
 * - OpenAI: choices[0].delta.content, choices[0].delta.tool_calls
 * - Anthropic: content_block_delta with delta.text or input_json_delta
 * - Gemini: candidates[0].content.parts[0].text
 */

export type SSEFormat = "openai" | "anthropic" | "gemini";

// ============ 基础回调（纯文本流式） ============

export interface SSEParserCallbacks {
  onText: (text: string) => void;
  onDone: () => void;
  onError?: (error: Error) => void;
}

// ============ Tool Calling 事件类型 ============

export type SSEToolCallingEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; argumentsDelta: string }
  | { type: "done"; stopReason: string }
  | { type: "error"; error: Error };

export interface SSEToolCallingCallbacks {
  onEvent: (event: SSEToolCallingEvent) => void;
}

// ============ OpenAI 响应类型 ============

interface OpenAIStreamDelta {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

// ============ Anthropic 响应类型 ============

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  content_block?: {
    type: string;
    id?: string;
    name?: string;
    text?: string;
    input?: Record<string, unknown>;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  message?: {
    id?: string;
    stop_reason?: string;
  };
  error?: {
    message?: string;
  };
}

// ============ 纯文本内容提取器（保持向后兼容） ============

const contentExtractors: Record<SSEFormat, (parsed: unknown) => string | null> =
  {
    openai: (parsed) => {
      const data = parsed as OpenAIStreamDelta;
      return data.choices?.[0]?.delta?.content || null;
    },

    anthropic: (parsed) => {
      const data = parsed as AnthropicStreamEvent;
      // Handle errors
      if (data.type === "error") {
        throw new Error(data.error?.message || "Unknown Anthropic error");
      }
      // Only extract text from content_block_delta events with text_delta
      if (
        data.type === "content_block_delta" &&
        data.delta?.type === "text_delta"
      ) {
        return data.delta?.text || null;
      }
      return null;
    },

    gemini: (parsed) => {
      const data = parsed as {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
        }>;
        error?: { message?: string };
      };
      // Handle errors
      if (data.error) {
        throw new Error(data.error.message || "Unknown Gemini error");
      }
      return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    },
  };

// ============ Tool Calling 事件解析器 ============

/**
 * 解析 OpenAI 流式事件为统一的 SSEToolCallingEvent
 */
function parseOpenAIToolCallingEvent(
  parsed: unknown,
): SSEToolCallingEvent | null {
  const data = parsed as OpenAIStreamDelta;
  const choice = data.choices?.[0];

  if (!choice) return null;

  // 检查完成原因
  if (choice.finish_reason) {
    return {
      type: "done",
      stopReason:
        choice.finish_reason === "tool_calls" ? "tool_calls" : "end_turn",
    };
  }

  const delta = choice.delta;
  if (!delta) return null;

  // 文本内容
  if (delta.content) {
    return { type: "text_delta", text: delta.content };
  }

  // Tool calls
  // Note: OpenAI streaming API sends one tool_call delta at a time,
  // so we only need to process the first element in the array
  if (delta.tool_calls && delta.tool_calls.length > 0) {
    const toolCall = delta.tool_calls[0];
    const index = toolCall.index;

    // 新的 tool call 开始（有 id 和 name）
    if (toolCall.id && toolCall.function?.name) {
      return {
        type: "tool_call_start",
        index,
        id: toolCall.id,
        name: toolCall.function.name,
      };
    }

    // tool call 参数增量
    if (toolCall.function?.arguments) {
      return {
        type: "tool_call_delta",
        index,
        argumentsDelta: toolCall.function.arguments,
      };
    }
  }

  return null;
}

/**
 * 解析 Anthropic 流式事件为统一的 SSEToolCallingEvent
 */
function parseAnthropicToolCallingEvent(
  parsed: unknown,
): SSEToolCallingEvent | null {
  const data = parsed as AnthropicStreamEvent;

  // 错误处理
  if (data.type === "error") {
    return {
      type: "error",
      error: new Error(data.error?.message || "Unknown Anthropic error"),
    };
  }

  // 内容块开始
  if (data.type === "content_block_start") {
    const block = data.content_block;
    if (block?.type === "tool_use" && block.id && block.name) {
      return {
        type: "tool_call_start",
        index: data.index ?? 0,
        id: block.id,
        name: block.name,
      };
    }
    // text 块开始不需要特殊处理
    return null;
  }

  // 内容块增量
  if (data.type === "content_block_delta") {
    const delta = data.delta;

    // 文本增量
    if (delta?.type === "text_delta" && delta.text) {
      return { type: "text_delta", text: delta.text };
    }

    // Tool 参数增量
    if (delta?.type === "input_json_delta" && delta.partial_json) {
      return {
        type: "tool_call_delta",
        index: data.index ?? 0,
        argumentsDelta: delta.partial_json,
      };
    }
  }

  // 消息结束
  if (data.type === "message_delta") {
    const stopReason = data.delta?.stop_reason;
    if (stopReason) {
      return {
        type: "done",
        stopReason: stopReason === "tool_use" ? "tool_calls" : "end_turn",
      };
    }
  }

  // message_stop 作为备用完成信号
  if (data.type === "message_stop") {
    return { type: "done", stopReason: "end_turn" };
  }

  return null;
}

// ============ 流式解析函数 ============

/**
 * Parse SSE stream with unified handling for different API formats
 * (纯文本模式，保持向后兼容)
 *
 * @param reader - ReadableStream reader from fetch response
 * @param format - The API format to use for content extraction
 * @param callbacks - Callbacks for text, completion, and errors
 */
export async function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  format: SSEFormat,
  callbacks: SSEParserCallbacks,
): Promise<void> {
  const { onText, onDone, onError } = callbacks;
  const extractContent = contentExtractors[format];
  const decoder = new TextDecoder();
  let buffer = "";

  try {
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
          const text = extractContent(parsed);
          if (text) {
            onText(text);
          }
        } catch (extractError) {
          // If extractor threw an error (not JSON parse error), propagate it
          if (
            extractError instanceof Error &&
            extractError.message !== "Unexpected end of JSON input"
          ) {
            if (onError) {
              onError(extractError);
            }
            return;
          }
          // Ignore JSON parse errors for incomplete chunks
        }
      }
    }
    onDone();
  } catch (error) {
    if (onError) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/**
 * Parse SSE stream with tool calling support
 * (支持 tool calling 的新版本)
 *
 * @param reader - ReadableStream reader from fetch response
 * @param format - The API format (openai or anthropic)
 * @param callbacks - Callbacks for events
 */
export async function parseSSEStreamWithToolCalling(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  format: "openai" | "anthropic",
  callbacks: SSEToolCallingCallbacks,
): Promise<void> {
  const { onEvent } = callbacks;
  const parseEvent =
    format === "openai"
      ? parseOpenAIToolCallingEvent
      : parseAnthropicToolCallingEvent;
  const decoder = new TextDecoder();
  let buffer = "";
  let hasReceivedDone = false;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const value = result.value as Uint8Array;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        // 处理 Anthropic 的 event: 行
        if (trimmed.startsWith("event:")) {
          // Anthropic 格式的事件类型行，跳过
          continue;
        }

        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          // OpenAI 的完成标记
          if (!hasReceivedDone) {
            hasReceivedDone = true;
            onEvent({ type: "done", stopReason: "end_turn" });
          }
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          const event = parseEvent(parsed);
          if (event) {
            if (event.type === "done") {
              hasReceivedDone = true;
            }
            onEvent(event);
          }
        } catch (parseError) {
          // JSON.parse throws SyntaxError for invalid JSON
          // Only propagate non-syntax errors (e.g., errors from parseEvent)
          if (parseError instanceof SyntaxError) {
            // Ignore JSON parse errors for incomplete chunks - this is expected
            // when streaming data arrives in pieces
            continue;
          }
          // Propagate other errors (from parseEvent or unexpected errors)
          if (parseError instanceof Error) {
            onEvent({ type: "error", error: parseError });
            return;
          }
        }
      }
    }

    // 如果流结束但没有收到 done 事件，发送一个
    if (!hasReceivedDone) {
      onEvent({ type: "done", stopReason: "end_turn" });
    }
  } catch (error) {
    onEvent({
      type: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}
