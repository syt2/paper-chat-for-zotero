/**
 * OpenAICompatibleProvider - For OpenAI, DeepSeek, Mistral, Groq, OpenRouter, Custom
 */

import { getErrorMessage } from "../../utils/common";
import { BaseProvider } from "./BaseProvider";
import type {
  ChatMessage,
  StreamCallbacks,
  StreamToolCallingCallbacks,
  ToolCallingStopReason,
} from "../../types/chat";
import type {
  PdfAttachment,
  ToolCallingCompletionResult,
  ToolCallingOptions,
} from "../../types/provider";
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
import { applyReasoningRequestOptions } from "./reasoning-request";
import { normalizeToolCallingStopReason } from "./stopReason";

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

const DSML_TAG_PREFIX = String.raw`[|｜]+\s*DSML\s*[|｜]+`;
const DSML_TOOL_CALLS_START_REGEX = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>`,
  "i",
);
const DSML_TOOL_CALLS_START_SCAN_REGEX = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>`,
  "gi",
);
const DSML_TOOL_CALLS_END_SCAN_REGEX = new RegExp(
  String.raw`<\s*\/\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>`,
  "gi",
);
const XML_TOOL_CALLS_START_REGEX = /<\s*function_calls\s*>/i;
const XML_TOOL_CALLS_START_SCAN_REGEX = /<\s*function_calls\s*>/gi;
const XML_TOOL_CALLS_END_SCAN_REGEX = /<\s*\/\s*function_calls\s*>/gi;
const DSML_INVOKE_REGEX = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*invoke\b([^>]*)>([\s\S]*?)<\s*\/\s*${DSML_TAG_PREFIX}\s*invoke\s*>`,
  "gi",
);
const DSML_PARAMETER_REGEX = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*parameter\b([^>]*)>([\s\S]*?)<\s*\/\s*${DSML_TAG_PREFIX}\s*parameter\s*>`,
  "gi",
);
const XML_ATTRIBUTE_REGEX =
  /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+))/g;

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
  const normalizedAttributes = rawAttributes
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
  XML_ATTRIBUTE_REGEX.lastIndex = 0;

  while ((match = XML_ATTRIBUTE_REGEX.exec(normalizedAttributes)) !== null) {
    attributes[match[1]] = decodeXmlEntities(
      match[2] ?? match[3] ?? match[4] ?? "",
    );
  }

  return attributes;
}

interface ToolCallProtocolBlock {
  start: number;
  end: number;
  body: string;
  complete: boolean;
}

function isPotentialDsmlToolCallsStart(candidate: string): boolean {
  const compact = candidate
    .replace(/\s/g, "")
    .replace(/｜/g, "|")
    .toLowerCase();
  if (!compact.startsWith("<")) {
    return false;
  }

  let rest = compact.slice(1);
  if (!rest.startsWith("|")) {
    return false;
  }
  rest = rest.replace(/^\|+/, "");
  if (!rest) {
    return true;
  }
  if ("dsml".startsWith(rest)) {
    return true;
  }
  if (!rest.startsWith("dsml")) {
    return false;
  }

  rest = rest.slice("dsml".length);
  if (!rest) {
    return true;
  }
  if (!rest.startsWith("|")) {
    return false;
  }
  rest = rest.replace(/^\|+/, "");
  return !rest || "tool_calls>".startsWith(rest);
}

function isPotentialXmlToolCallsStart(candidate: string): boolean {
  const compact = candidate.replace(/\s/g, "").toLowerCase();
  return (
    compact.length > 1 &&
    compact.startsWith("<") &&
    "<function_calls>".startsWith(compact)
  );
}

function isPotentialFallbackToolCallsStart(candidate: string): boolean {
  return (
    isPotentialDsmlToolCallsStart(candidate) ||
    isPotentialXmlToolCallsStart(candidate)
  );
}

/**
 * Scan DSML envelopes without asking one backtracking regex to search from
 * every opening marker. An opening marker without a close consumes through
 * EOF: it is still provider protocol text and must never become chat content.
 */
function scanDsmlToolCallBlocks(content: string): ToolCallProtocolBlock[] {
  const blocks: ToolCallProtocolBlock[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    DSML_TOOL_CALLS_START_SCAN_REGEX.lastIndex = cursor;
    const startMatch = DSML_TOOL_CALLS_START_SCAN_REGEX.exec(content);
    if (!startMatch) {
      const trailingTagStart = content.lastIndexOf("<");
      if (
        trailingTagStart >= cursor &&
        isPotentialDsmlToolCallsStart(content.slice(trailingTagStart))
      ) {
        blocks.push({
          start: trailingTagStart,
          end: content.length,
          body: "",
          complete: false,
        });
      }
      break;
    }

    const bodyStart = startMatch.index + startMatch[0].length;
    DSML_TOOL_CALLS_END_SCAN_REGEX.lastIndex = bodyStart;
    const endMatch = DSML_TOOL_CALLS_END_SCAN_REGEX.exec(content);
    if (!endMatch) {
      blocks.push({
        start: startMatch.index,
        end: content.length,
        body: content.slice(bodyStart),
        complete: false,
      });
      break;
    }

    const end = endMatch.index + endMatch[0].length;
    blocks.push({
      start: startMatch.index,
      end,
      body: content.slice(bodyStart, endMatch.index),
      complete: true,
    });
    cursor = end;
  }

  return blocks;
}

function scanXmlToolCallBlocks(content: string): ToolCallProtocolBlock[] {
  const blocks: ToolCallProtocolBlock[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    XML_TOOL_CALLS_START_SCAN_REGEX.lastIndex = cursor;
    const startMatch = XML_TOOL_CALLS_START_SCAN_REGEX.exec(content);
    if (!startMatch) {
      const trailingTagStart = content.lastIndexOf("<");
      if (
        trailingTagStart >= cursor &&
        isPotentialXmlToolCallsStart(content.slice(trailingTagStart))
      ) {
        blocks.push({
          start: trailingTagStart,
          end: content.length,
          body: "",
          complete: false,
        });
      }
      break;
    }

    const bodyStart = startMatch.index + startMatch[0].length;
    XML_TOOL_CALLS_END_SCAN_REGEX.lastIndex = bodyStart;
    const endMatch = XML_TOOL_CALLS_END_SCAN_REGEX.exec(content);
    if (!endMatch) {
      blocks.push({
        start: startMatch.index,
        end: content.length,
        body: content.slice(bodyStart),
        complete: false,
      });
      break;
    }

    const end = endMatch.index + endMatch[0].length;
    blocks.push({
      start: startMatch.index,
      end,
      body: content.slice(bodyStart, endMatch.index),
      complete: true,
    });
    cursor = end;
  }

  return blocks;
}

function stripToolCallProtocolBlocks(
  content: string,
  blocks: ToolCallProtocolBlock[],
): string {
  if (blocks.length === 0) {
    return content.trim();
  }

  const cleanParts: string[] = [];
  let cursor = 0;
  for (const block of blocks) {
    cleanParts.push(content.slice(cursor, block.start));
    cursor = block.end;
  }
  cleanParts.push(content.slice(cursor));
  return cleanParts.join("").trim();
}

export function stripDsmlToolCallBlocks(content: string): string {
  const blocks = scanDsmlToolCallBlocks(content);
  return stripToolCallProtocolBlocks(content, blocks);
}

export function hasDsmlToolCallBlock(content: string): boolean {
  return scanDsmlToolCallBlocks(content).length > 0;
}

export function parseDsmlToolCallsFromContent(content: string): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  let index = 0;

  for (const block of scanDsmlToolCallBlocks(content)) {
    if (!block.complete) {
      continue;
    }
    let invokeMatch: RegExpExecArray | null;
    DSML_INVOKE_REGEX.lastIndex = 0;

    while ((invokeMatch = DSML_INVOKE_REGEX.exec(block.body)) !== null) {
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

function parseXmlToolCallsFromContent(content: string): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  let index = 0;

  for (const block of scanXmlToolCallBlocks(content)) {
    if (!block.complete) {
      continue;
    }
    const invokeRegex = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
    let invokeMatch: RegExpExecArray | null;

    while ((invokeMatch = invokeRegex.exec(block.body)) !== null) {
      const params: Record<string, string> = {};
      const paramRegex = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
      let paramMatch: RegExpExecArray | null;

      while ((paramMatch = paramRegex.exec(invokeMatch[2])) !== null) {
        params[paramMatch[1]] = paramMatch[2];
      }

      toolCalls.push({
        id: `xml_call_${index}`,
        type: "function",
        function: {
          name: invokeMatch[1],
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

type FallbackToolProtocolMode = "literal" | "allow" | "suppress";

function getFallbackToolProtocolMode(
  tools: ToolDefinition[] | undefined,
  toolChoice: ToolCallingOptions["toolChoice"],
): FallbackToolProtocolMode {
  if (toolChoice === "none") {
    return "suppress";
  }
  return tools?.length ? "allow" : "literal";
}

export function resolveDsmlFallbackContent(
  content: string,
  tools: ToolDefinition[] | undefined,
  mode: FallbackToolProtocolMode,
): {
  cleanContent: string;
  hasDsmlBlock: boolean;
  toolCalls: ToolCall[];
  suppressedToolCall: boolean;
  incompleteToolProtocol: boolean;
} {
  // DSML is normally provider protocol only while a tool contract is active.
  // Text-only continuation rounds explicitly detect it without a schema so a
  // provider cannot leak forbidden tool markup into displayed content.
  if (mode === "literal") {
    return {
      cleanContent: content,
      hasDsmlBlock: false,
      toolCalls: [],
      suppressedToolCall: false,
      incompleteToolProtocol: false,
    };
  }

  const hasDsmlBlock = hasDsmlToolCallBlock(content);
  const parsedToolCalls =
    hasDsmlBlock && mode === "allow"
      ? parseDsmlToolCallsFromContent(content)
      : [];
  const toolCalls =
    mode === "allow"
      ? filterToolCallsByAllowedTools(parsedToolCalls, tools)
      : [];
  return {
    cleanContent: hasDsmlBlock ? stripDsmlToolCallBlocks(content) : content,
    hasDsmlBlock,
    toolCalls,
    suppressedToolCall:
      hasDsmlBlock &&
      (mode === "suppress" ||
        (mode === "allow" && parsedToolCalls.length !== toolCalls.length)),
    incompleteToolProtocol:
      hasDsmlBlock && mode === "allow" && parsedToolCalls.length === 0,
  };
}

function resolveXmlFallbackContent(
  content: string,
  tools: ToolDefinition[] | undefined,
  mode: FallbackToolProtocolMode,
  stopReason: ToolCallingStopReason,
): {
  cleanContent: string;
  hasXmlBlock: boolean;
  toolCalls: ToolCall[];
  suppressedToolCall: boolean;
  incompleteToolProtocol: boolean;
} {
  const shouldInterpret =
    mode === "suppress" ||
    stopReason === "tool_calls" ||
    (mode === "allow" && stopReason === "max_tokens");
  if (!shouldInterpret) {
    return {
      cleanContent: content,
      hasXmlBlock: false,
      toolCalls: [],
      suppressedToolCall: false,
      incompleteToolProtocol: false,
    };
  }

  const blocks = scanXmlToolCallBlocks(content);
  if (blocks.length === 0) {
    return {
      cleanContent: content,
      hasXmlBlock: false,
      toolCalls: [],
      suppressedToolCall: false,
      incompleteToolProtocol: false,
    };
  }

  const parsedToolCalls =
    stopReason === "tool_calls" ? parseXmlToolCallsFromContent(content) : [];
  const toolCalls =
    mode === "allow"
      ? filterToolCallsByAllowedTools(parsedToolCalls, tools)
      : [];
  return {
    cleanContent: stripToolCallProtocolBlocks(content, blocks),
    hasXmlBlock: true,
    toolCalls,
    suppressedToolCall:
      mode !== "allow" || parsedToolCalls.length !== toolCalls.length,
    incompleteToolProtocol:
      mode === "allow" &&
      (stopReason === "max_tokens" ||
        blocks.some((block) => !block.complete) ||
        parsedToolCalls.length === 0),
  };
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

    applyReasoningRequestOptions(requestBody, this._config, "chat_completions");
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
    const { onError } = callbacks;

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
    return this.runTestConnection(() =>
      fetch(`${this._config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this._config.apiKey}` },
      }),
    );
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
  ): Promise<ToolCallingCompletionResult> {
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
    const stopReason = normalizeToolCallingStopReason(finishReason);

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
    const fallbackProtocolMode = getFallbackToolProtocolMode(
      tools,
      options?.toolChoice,
    );
    const allowFallbackToolCalls = fallbackProtocolMode === "allow";
    const xmlFallback = resolveXmlFallbackContent(
      rawContent,
      tools,
      fallbackProtocolMode,
      stopReason,
    );
    if (xmlFallback.toolCalls.length > 0) {
      ztoolkit.log(
        "[chatCompletionWithTools] Parsed",
        xmlFallback.toolCalls.length,
        "tool calls from XML fallback",
      );
    }

    const dsmlFallback = resolveDsmlFallbackContent(
      xmlFallback.cleanContent,
      tools,
      fallbackProtocolMode,
    );
    if (dsmlFallback.toolCalls.length > 0) {
      ztoolkit.log(
        "[chatCompletionWithTools] Parsed",
        dsmlFallback.toolCalls.length,
        "tool calls from DSML fallback",
      );
      return {
        content: dsmlFallback.cleanContent,
        reasoning: message?.reasoning_content || undefined,
        toolCalls:
          structuredToolCalls && structuredToolCalls.length > 0
            ? structuredToolCalls
            : dsmlFallback.toolCalls,
        suppressedToolCall:
          xmlFallback.suppressedToolCall || dsmlFallback.suppressedToolCall,
        incompleteToolProtocol:
          xmlFallback.incompleteToolProtocol ||
          dsmlFallback.incompleteToolProtocol,
        stopReason,
      };
    }

    const fallbackToolCalls =
      xmlFallback.toolCalls.length > 0 ? xmlFallback.toolCalls : undefined;
    return {
      content: dsmlFallback.cleanContent,
      reasoning: message?.reasoning_content || undefined,
      toolCalls: allowFallbackToolCalls
        ? structuredToolCalls && structuredToolCalls.length > 0
          ? structuredToolCalls
          : fallbackToolCalls
        : undefined,
      suppressedToolCall:
        xmlFallback.suppressedToolCall ||
        dsmlFallback.suppressedToolCall ||
        (!allowFallbackToolCalls && !!structuredToolCalls?.length),
      incompleteToolProtocol:
        xmlFallback.incompleteToolProtocol ||
        dsmlFallback.incompleteToolProtocol,
      stopReason: fallbackToolCalls?.length ? "tool_calls" : stopReason,
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
      let stopReason: ToolCallingStopReason = "end_turn";
      const fallbackProtocolMode = getFallbackToolProtocolMode(
        tools,
        options?.toolChoice,
      );
      const shouldHandleFallbackProtocol = fallbackProtocolMode !== "literal";
      const allowFallbackToolCalls = fallbackProtocolMode === "allow";
      let pendingTextDelta = "";
      let suppressFallbackProtocolTextDeltas = false;
      let emittedContent = "";

      const emitTextDelta = (text: string): void => {
        if (!text) {
          return;
        }
        emittedContent += text;
        onTextDelta(text);
      };

      const flushPendingTextDelta = (): void => {
        if (!pendingTextDelta) {
          return;
        }
        emitTextDelta(pendingTextDelta);
        pendingTextDelta = "";
      };

      const handleTextDelta = (text: string): void => {
        fullContent += text;

        if (!shouldHandleFallbackProtocol) {
          emitTextDelta(text);
          return;
        }

        if (suppressFallbackProtocolTextDeltas) {
          return;
        }

        let combined = pendingTextDelta + text;
        pendingTextDelta = "";

        while (combined) {
          const tagStart = combined.indexOf("<");
          if (tagStart < 0) {
            emitTextDelta(combined);
            return;
          }
          if (tagStart > 0) {
            emitTextDelta(combined.slice(0, tagStart));
            combined = combined.slice(tagStart);
          }

          const tagEnd = combined.indexOf(">");
          if (tagEnd < 0) {
            if (
              combined.replace(/\s/g, "") === "<" ||
              isPotentialFallbackToolCallsStart(combined)
            ) {
              pendingTextDelta = combined;
            } else {
              emitTextDelta(combined);
            }
            return;
          }

          const candidateTag = combined.slice(0, tagEnd + 1);
          const dsmlStartMatch = DSML_TOOL_CALLS_START_REGEX.exec(candidateTag);
          const xmlStartMatch = XML_TOOL_CALLS_START_REGEX.exec(candidateTag);
          if (
            (dsmlStartMatch?.index === 0 &&
              dsmlStartMatch[0].length === candidateTag.length) ||
            (xmlStartMatch?.index === 0 &&
              xmlStartMatch[0].length === candidateTag.length)
          ) {
            suppressFallbackProtocolTextDeltas = true;
            return;
          }

          emitTextDelta(candidateTag);
          combined = combined.slice(tagEnd + 1);
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

      const xmlFallback = resolveXmlFallbackContent(
        fullContent,
        tools,
        fallbackProtocolMode,
        stopReason,
      );
      const dsmlFallback = resolveDsmlFallbackContent(
        xmlFallback.cleanContent,
        tools,
        fallbackProtocolMode,
      );

      if (!xmlFallback.hasXmlBlock && !dsmlFallback.hasDsmlBlock) {
        flushPendingTextDelta();
        if (dsmlFallback.cleanContent.startsWith(emittedContent)) {
          emitTextDelta(dsmlFallback.cleanContent.slice(emittedContent.length));
        }
      }

      const fallbackToolCalls =
        xmlFallback.toolCalls.length > 0
          ? xmlFallback.toolCalls
          : dsmlFallback.toolCalls;

      onComplete({
        content: dsmlFallback.cleanContent,
        reasoning: fullReasoning || undefined,
        toolCalls:
          toolCalls.length > 0
            ? toolCalls
            : fallbackToolCalls.length > 0
              ? fallbackToolCalls
              : undefined,
        suppressedToolCall:
          xmlFallback.suppressedToolCall ||
          dsmlFallback.suppressedToolCall ||
          (!allowFallbackToolCalls && toolCalls.length > 0),
        incompleteToolProtocol:
          xmlFallback.incompleteToolProtocol ||
          dsmlFallback.incompleteToolProtocol,
        stopReason: fallbackToolCalls.length > 0 ? "tool_calls" : stopReason,
      });
    } catch (error) {
      onError(this.wrapError(error));
    }
  }
}
