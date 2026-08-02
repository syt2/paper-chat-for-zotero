import type {
  ChatMessage,
  HostedWebSearchCall,
  StreamCallbacks,
  StreamToolCallingCallbacks,
} from "../../types/chat";
import type {
  ApiKeyProviderConfig,
  PdfAttachment,
  ToolCallingOptions,
} from "../../types/provider";
import type { ToolCall, ToolDefinition } from "../../types/tool";
import { sanitizeOpenAIToolCallMessages } from "./openai-tool-call-messages";
import { HttpResponseError } from "./HttpResponseError";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
import {
  logPromptCacheUsage,
  stablePromptCacheStringify,
} from "./prompt-cache-diagnostics";
import { applyReasoningRequestOptions } from "./reasoning-request";

type ResponsesInputItem = Record<string, unknown>;
type ResponsesOutputItem = Record<string, unknown>;

interface ResponsesApiResponse {
  id?: string;
  status?: string;
  store?: boolean;
  output?: ResponsesOutputItem[];
  usage?: unknown;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
}

interface LocalMessageDescriptor {
  id: string;
  fingerprint: string;
  semanticFingerprint: string;
  allowIdChange: boolean;
}

interface PreviousOutputDescriptor {
  text: string;
  visibleText: string;
  toolCallIds: string[];
}

interface ResponsesConversationState {
  previousResponseId?: string;
  localMessages: LocalMessageDescriptor[];
  lastOutput: PreviousOutputDescriptor;
  statelessTranscript?: ResponsesInputItem[];
}

interface ResponsesRequestPlan {
  mode: "full" | "previous_response" | "stateless";
  localMessages: ChatMessage[];
  localDescriptors: LocalMessageDescriptor[];
  fullInput: ResponsesInputItem[];
  requestInput: ResponsesInputItem[];
  previousResponseId?: string;
}

interface ResponsesRequestResult {
  response: Response;
  plan: ResponsesRequestPlan;
  forceStateless: boolean;
}

export interface OpenAIResponsesRuntimeOptions {
  sessionId?: string;
  hostedWebSearch?: boolean;
}

export interface ResponsesStreamHandlers {
  onTextDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  onToolCallStart?: (toolCall: {
    index: number;
    id: string;
    name: string;
  }) => void;
  onToolCallDelta?: (index: number, argumentsDelta: string) => void;
  onHostedWebSearchStatus?: (event: HostedWebSearchCall) => void;
}

const conversationStates = new Map<string, ResponsesConversationState>();

function conversationKey(sessionId: string, modelId: string): string {
  return `${sessionId}\u0000${modelId}`;
}

export function resetOpenAIResponsesStateForTests(): void {
  conversationStates.clear();
}

function hashText(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

export function createResponsesPromptCacheKey(
  sessionId: string,
  modelId: string,
): string {
  return `paperchat_${hashText(sessionId)}_${hashText(modelId)}`;
}

function fingerprintMessage(message: ChatMessage): string {
  return hashText(
    stablePromptCacheStringify({
      id: message.id,
      role: message.role,
      content: message.content,
      reasoning: message.reasoning,
      images: message.images,
      tool_calls: message.tool_calls,
      tool_call_id: message.tool_call_id,
    }),
  );
}

function semanticFingerprintMessage(message: ChatMessage): string {
  return hashText(
    stablePromptCacheStringify({
      role: message.role,
      content: message.content,
      reasoning: message.reasoning,
      images: message.images,
      tool_calls: message.tool_calls,
      tool_call_id: message.tool_call_id,
    }),
  );
}

function describeMessages(messages: ChatMessage[]): LocalMessageDescriptor[] {
  return messages.map((message) => ({
    id: message.id,
    fingerprint: fingerprintMessage(message),
    semanticFingerprint: semanticFingerprintMessage(message),
    allowIdChange:
      message.role === "tool" ||
      (message.role === "assistant" && !!message.tool_calls?.length),
  }));
}

function isOptionalHistoryDescriptor(
  descriptor: LocalMessageDescriptor,
): boolean {
  return (
    descriptor.id === "cache-checkpoint-history" ||
    descriptor.id === "runtime-context-history"
  );
}

function isPreviousOutputMessage(
  message: ChatMessage,
  output: PreviousOutputDescriptor,
): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  if (output.toolCallIds.length > 0) {
    if (!message.tool_calls?.length) {
      return false;
    }
    const messageIds = new Set(message.tool_calls.map((call) => call.id));
    return (
      messageIds.size === output.toolCallIds.length &&
      output.toolCallIds.every((id) => messageIds.has(id))
    );
  }
  if (!output.text) {
    return false;
  }
  return normalizeVisibleAssistantText(message.content) === output.visibleText;
}

function normalizeVisibleAssistantText(value: string): string {
  return value
    .split(/\n?<tool-call\b[^>]*>[\s\S]*?<\/tool-call>\n?/gi)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("\n");
}

function describeVisibleOutput(
  localMessages: ChatMessage[],
  responseText: string,
): string {
  const latestUserIndex = localMessages.findLastIndex(
    (message) => message.role === "user",
  );
  const precedingRoundText = localMessages
    .slice(latestUserIndex + 1)
    .filter(
      (message) =>
        message.role === "assistant" &&
        !!message.tool_calls?.length &&
        !!message.content,
    )
    .map((message) => message.content);
  return normalizeVisibleAssistantText(
    [...precedingRoundText, responseText].join("\n"),
  );
}

function findIncrementalMessages(
  messages: ChatMessage[],
  state: ResponsesConversationState,
): { compatible: boolean; messages: ChatMessage[] } {
  const matchedIndexes = new Set<number>();
  const updatedRuntimeIndexes = new Set<number>();
  let currentIndex = 0;
  for (const previous of state.localMessages) {
    let matched = false;
    let searchIndex = currentIndex;
    while (searchIndex < messages.length) {
      const current = messages[searchIndex];
      const currentFingerprint = fingerprintMessage(current);
      if (previous.id === current.id) {
        if (previous.fingerprint === currentFingerprint) {
          matchedIndexes.add(searchIndex);
          currentIndex = searchIndex + 1;
          matched = true;
          break;
        }
        // AgentRuntime may refresh this synthetic message in place between
        // requests. Send the updated instruction as new input while keeping
        // the existing Responses chain intact.
        if (current.id === "runtime-context") {
          matchedIndexes.add(searchIndex);
          updatedRuntimeIndexes.add(searchIndex);
          currentIndex = searchIndex + 1;
          matched = true;
          break;
        }
        if (isOptionalHistoryDescriptor(previous)) {
          searchIndex++;
          continue;
        }
        return { compatible: false, messages: [] };
      }

      const renamedToHistory =
        (previous.id === "cache-checkpoint" ||
          previous.id === "runtime-context") &&
        current.id === `${previous.id}-history`;
      if (renamedToHistory) {
        if (
          previous.fingerprint !==
          fingerprintMessage({ ...current, id: previous.id })
        ) {
          if (isOptionalHistoryDescriptor(previous)) {
            searchIndex++;
            continue;
          }
          return { compatible: false, messages: [] };
        }
        matchedIndexes.add(searchIndex);
        currentIndex = searchIndex + 1;
        matched = true;
        break;
      }
      if (
        previous.allowIdChange &&
        previous.semanticFingerprint === semanticFingerprintMessage(current)
      ) {
        matchedIndexes.add(searchIndex);
        currentIndex = searchIndex + 1;
        matched = true;
        break;
      }
      searchIndex++;
    }
    if (!matched && !isOptionalHistoryDescriptor(previous)) {
      return { compatible: false, messages: [] };
    }
  }

  const incremental = messages.filter(
    (_message, index) =>
      !matchedIndexes.has(index) || updatedRuntimeIndexes.has(index),
  );

  for (let index = incremental.length - 1; index >= 0; index--) {
    if (isPreviousOutputMessage(incremental[index], state.lastOutput)) {
      if (
        incremental.slice(0, index).some((message) => message.role === "user")
      ) {
        continue;
      }
      incremental.splice(index, 1);
      if (incremental.some((message) => message.role === "assistant")) {
        return { compatible: false, messages: [] };
      }
      return { compatible: true, messages: incremental };
    }
  }

  // Every committed Responses output must still have a matching local
  // assistant message. Otherwise a cancel/delete race could resume a chain
  // containing an answer that is no longer visible in PaperChat. Tool calls
  // additionally require their matching local output exchange.
  if (
    state.lastOutput.toolCallIds.length > 0 ||
    state.lastOutput.visibleText.length > 0
  ) {
    return { compatible: false, messages: [] };
  }

  // An unmatched assistant message may belong to a different model or a
  // replacement/reroll. Only skip a visible assistant message when the loop
  // above can positively identify it as this chain's previous output.
  if (incremental.some((message) => message.role === "assistant")) {
    return { compatible: false, messages: [] };
  }
  return { compatible: true, messages: incremental };
}

function toInputContent(
  message: ChatMessage,
  pdfAttachment: PdfAttachment | undefined,
): unknown {
  const hasImages = !!message.images?.length;
  if (!hasImages && !pdfAttachment) {
    return message.content;
  }

  const content: ResponsesInputItem[] = [];
  if (message.content) {
    content.push({ type: "input_text", text: message.content });
  }
  if (pdfAttachment) {
    content.push({
      type: "input_file",
      filename: pdfAttachment.name,
      file_data: `data:${pdfAttachment.mimeType};base64,${pdfAttachment.data}`,
    });
  }
  for (const image of message.images || []) {
    content.push({
      type: "input_image",
      image_url:
        image.type === "base64"
          ? `data:${image.mimeType};base64,${image.data}`
          : image.data,
      detail: "auto",
    });
  }
  return content;
}

function convertMessagesToResponsesInput(
  messages: ChatMessage[],
  pdfAttachment?: PdfAttachment,
): ResponsesInputItem[] {
  const firstUserIndex = messages.findIndex(
    (message) => message.role === "user",
  );
  const input: ResponsesInputItem[] = [];

  messages.forEach((message, index) => {
    if (message.role === "tool") {
      if (message.tool_call_id) {
        input.push({
          type: "function_call_output",
          call_id: message.tool_call_id,
          output: message.content,
        });
      }
      return;
    }

    if (message.role === "error") {
      return;
    }

    if (message.content || message.images?.length) {
      input.push({
        role: message.role,
        content: toInputContent(
          message,
          index === firstUserIndex ? pdfAttachment : undefined,
        ),
      });
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      for (const toolCall of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        });
      }
    }
  });

  return input;
}

function convertTools(
  tools: ToolDefinition[] | undefined,
  hostedWebSearch: boolean,
): ResponsesInputItem[] {
  const converted: ResponsesInputItem[] = [];
  let addedHostedWebSearch = false;
  for (const tool of tools || []) {
    if (hostedWebSearch && tool.function.name === "web_search") {
      if (!addedHostedWebSearch) {
        converted.push({ type: "web_search_preview" });
        addedHostedWebSearch = true;
      }
      continue;
    }
    converted.push({
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    });
  }
  return converted;
}

function extractToolCalls(response: ResponsesApiResponse): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const item of response.output || []) {
    if (item.type !== "function_call") {
      continue;
    }
    const id =
      typeof item.call_id === "string"
        ? item.call_id
        : typeof item.id === "string"
          ? item.id
          : "";
    const name = typeof item.name === "string" ? item.name : "";
    if (!id || !name) {
      continue;
    }
    calls.push({
      id,
      type: "function",
      function: {
        name,
        arguments: typeof item.arguments === "string" ? item.arguments : "{}",
      },
    });
  }
  return calls;
}

function collectUrlCitations(response: ResponsesApiResponse): Array<{
  title: string;
  url: string;
}> {
  const citations: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  for (const item of response.output || []) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content as ResponsesInputItem[]) {
      if (!Array.isArray(part.annotations)) {
        continue;
      }
      for (const rawAnnotation of part.annotations) {
        if (!rawAnnotation || typeof rawAnnotation !== "object") {
          continue;
        }
        const annotation = rawAnnotation as Record<string, unknown>;
        if (
          annotation.type !== "url_citation" ||
          typeof annotation.url !== "string" ||
          seen.has(annotation.url)
        ) {
          continue;
        }
        seen.add(annotation.url);
        citations.push({
          url: annotation.url,
          title:
            typeof annotation.title === "string" && annotation.title.trim()
              ? annotation.title.trim()
              : annotation.url,
        });
      }
    }
  }
  return citations;
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([[\]\\])/g, "\\$1");
}

function linkifyUrlCitations(text: string, annotations: unknown): string {
  if (!Array.isArray(annotations)) {
    return text;
  }
  const ranges = annotations
    .flatMap((rawAnnotation) => {
      if (!rawAnnotation || typeof rawAnnotation !== "object") {
        return [];
      }
      const annotation = rawAnnotation as Record<string, unknown>;
      if (
        annotation.type !== "url_citation" ||
        typeof annotation.url !== "string" ||
        typeof annotation.start_index !== "number" ||
        typeof annotation.end_index !== "number" ||
        !Number.isInteger(annotation.start_index) ||
        !Number.isInteger(annotation.end_index) ||
        annotation.start_index < 0 ||
        annotation.end_index <= annotation.start_index ||
        annotation.end_index > text.length
      ) {
        return [];
      }
      return [
        {
          start: annotation.start_index,
          end: annotation.end_index,
          url: annotation.url,
        },
      ];
    })
    .sort((left, right) => right.start - left.start);

  let linked = text;
  let earliestAppliedStart = text.length;
  for (const range of ranges) {
    if (range.end > earliestAppliedStart) {
      continue;
    }
    const label = text.slice(range.start, range.end);
    linked = `${linked.slice(0, range.start)}[${escapeMarkdownLabel(label)}](${range.url})${linked.slice(range.end)}`;
    earliestAppliedStart = range.start;
  }
  return linked;
}

export function extractResponsesText(response: ResponsesApiResponse): string {
  const textParts: string[] = [];
  for (const item of response.output || []) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content as ResponsesInputItem[]) {
      if (part.type === "output_text" && typeof part.text === "string") {
        textParts.push(linkifyUrlCitations(part.text, part.annotations));
      } else if (part.type === "refusal" && typeof part.refusal === "string") {
        textParts.push(part.refusal);
      }
    }
  }
  const text = textParts.join("");
  const citations = collectUrlCitations(response);
  if (citations.length === 0) {
    return text;
  }
  const sources = citations
    .map(
      (citation, index) =>
        `${index + 1}. [${escapeMarkdownLabel(citation.title)}](${citation.url})`,
    )
    .join("\n");
  return `${text}\n\nSources:\n${sources}`;
}

function responseError(response: ResponsesApiResponse): Error | null {
  if (response.status === "failed" || response.error) {
    return new Error(response.error?.message || "Responses API request failed");
  }
  if (
    response.status &&
    response.status !== "completed" &&
    response.status !== "incomplete"
  ) {
    return new Error(
      `Responses API returned unexpected status: ${response.status}`,
    );
  }

  const functionCalls = (response.output || []).filter(
    (item) => item.type === "function_call",
  );
  const unfinishedFunctionCall = functionCalls.find(
    (item) => typeof item.status === "string" && item.status !== "completed",
  );
  if (unfinishedFunctionCall) {
    return new Error("Responses API returned an unfinished function call");
  }

  if (response.status !== "incomplete") {
    return null;
  }
  const reason = response.incomplete_details?.reason;
  if (
    reason === "max_output_tokens" &&
    functionCalls.length === 0 &&
    extractResponsesText(response).trim()
  ) {
    return null;
  }
  return new Error(
    reason
      ? `Responses API response incomplete: ${reason}`
      : "Responses API response incomplete",
  );
}

function parseSseDataLine(line: string): string | null {
  if (!line.startsWith("data:")) {
    return null;
  }
  return line.slice(5).trimStart();
}

function extractHostedWebSearchDetails(item: Record<string, unknown>): {
  actionType?: string;
  queries?: string[];
  sources?: Array<{ title?: string; url: string }>;
} {
  const action = item.action;
  if (!action || typeof action !== "object") {
    return {};
  }
  const record = action as Record<string, unknown>;
  const queries: string[] = [];
  if (typeof record.query === "string" && record.query.trim()) {
    queries.push(record.query.trim());
  }
  if (Array.isArray(record.queries)) {
    for (const query of record.queries) {
      if (typeof query === "string" && query.trim()) {
        queries.push(query.trim());
      }
    }
  }

  const sources: Array<{ title?: string; url: string }> = [];
  if (Array.isArray(record.sources)) {
    for (const source of record.sources) {
      if (typeof source === "string" && source.trim()) {
        sources.push({ url: source.trim() });
        continue;
      }
      if (!source || typeof source !== "object") {
        continue;
      }
      const sourceRecord = source as Record<string, unknown>;
      if (typeof sourceRecord.url !== "string" || !sourceRecord.url.trim()) {
        continue;
      }
      sources.push({
        url: sourceRecord.url.trim(),
        title:
          typeof sourceRecord.title === "string" && sourceRecord.title.trim()
            ? sourceRecord.title.trim()
            : undefined,
      });
    }
  }

  return {
    actionType: typeof record.type === "string" ? record.type : undefined,
    queries: [...new Set(queries)],
    sources: sources.filter(
      (source, index) =>
        sources.findIndex((candidate) => candidate.url === source.url) ===
        index,
    ),
  };
}

function extractHostedWebSearchCalls(
  response: ResponsesApiResponse,
): HostedWebSearchCall[] {
  const calls: HostedWebSearchCall[] = [];
  for (const [index, item] of (response.output || []).entries()) {
    if (item.type !== "web_search_call") {
      continue;
    }
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) {
      continue;
    }
    calls.push({
      index,
      id,
      status:
        item.status === "completed"
          ? "completed"
          : item.status === "failed"
            ? "error"
            : "searching",
      ...extractHostedWebSearchDetails(item),
    });
  }
  return calls;
}

/** Parse OpenAI Responses SSE events into the provider's existing callbacks. */
export async function parseResponsesSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  handlers: ResponsesStreamHandlers,
): Promise<ResponsesApiResponse> {
  const decoder = new TextDecoder();
  let buffer = "";
  let completedResponse: ResponsesApiResponse | undefined;
  let createdResponse: ResponsesApiResponse | undefined;
  let accumulatedText = "";
  let accumulatedRefusal = "";
  let accumulatedReasoning = "";
  const toolCalls = new Map<
    number,
    { id: string; name: string; arguments: string; started: boolean }
  >();

  const emitToolStart = (
    index: number,
    item: Record<string, unknown>,
  ): void => {
    const id =
      typeof item.call_id === "string"
        ? item.call_id
        : typeof item.id === "string"
          ? item.id
          : "";
    const name = typeof item.name === "string" ? item.name : "";
    if (!id || !name) {
      return;
    }
    const current = toolCalls.get(index) || {
      id,
      name,
      arguments: "",
      started: false,
    };
    current.id = id;
    current.name = name;
    toolCalls.set(index, current);
    if (!current.started) {
      current.started = true;
      handlers.onToolCallStart?.({ index, id, name });
    }
  };

  const handleEvent = (event: Record<string, unknown>): void => {
    const type = typeof event.type === "string" ? event.type : "";
    if (
      type === "response.web_search_call.in_progress" ||
      type === "response.web_search_call.searching" ||
      type === "response.web_search_call.completed"
    ) {
      const id = typeof event.item_id === "string" ? event.item_id : "";
      if (id) {
        handlers.onHostedWebSearchStatus?.({
          index:
            typeof event.output_index === "number" ? event.output_index : 0,
          id,
          status:
            type === "response.web_search_call.completed"
              ? "completed"
              : "searching",
        });
      }
      return;
    }
    if (
      type === "response.output_text.delta" &&
      typeof event.delta === "string"
    ) {
      accumulatedText += event.delta;
      handlers.onTextDelta?.(event.delta);
      return;
    }
    if (type === "response.refusal.delta" && typeof event.delta === "string") {
      accumulatedRefusal += event.delta;
      handlers.onTextDelta?.(event.delta);
      return;
    }
    if (type === "response.refusal.done" && typeof event.refusal === "string") {
      const completeRefusal = event.refusal;
      if (completeRefusal.startsWith(accumulatedRefusal)) {
        const remaining = completeRefusal.slice(accumulatedRefusal.length);
        if (remaining) {
          handlers.onTextDelta?.(remaining);
        }
      }
      accumulatedRefusal = completeRefusal;
      return;
    }
    if (
      type === "response.reasoning_summary_text.delta" &&
      typeof event.delta === "string"
    ) {
      accumulatedReasoning += event.delta;
      handlers.onReasoningDelta?.(event.delta);
      return;
    }
    if (type === "response.output_item.added") {
      const item = event.item;
      if (
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).type === "function_call"
      ) {
        emitToolStart(
          typeof event.output_index === "number" ? event.output_index : 0,
          item as Record<string, unknown>,
        );
      }
      if (
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).type === "web_search_call"
      ) {
        const record = item as Record<string, unknown>;
        const id =
          typeof record.id === "string"
            ? record.id
            : typeof event.item_id === "string"
              ? event.item_id
              : "";
        if (id) {
          handlers.onHostedWebSearchStatus?.({
            index:
              typeof event.output_index === "number" ? event.output_index : 0,
            id,
            status:
              record.status === "completed"
                ? "completed"
                : record.status === "failed"
                  ? "error"
                  : "searching",
            ...extractHostedWebSearchDetails(record),
          });
        }
      }
      return;
    }
    if (
      type === "response.function_call_arguments.delta" &&
      typeof event.delta === "string"
    ) {
      const index =
        typeof event.output_index === "number" ? event.output_index : 0;
      const current = toolCalls.get(index);
      if (current) {
        current.arguments += event.delta;
      }
      handlers.onToolCallDelta?.(index, event.delta);
      return;
    }
    if (type === "response.output_item.done") {
      const item = event.item;
      if (
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).type === "function_call"
      ) {
        const index =
          typeof event.output_index === "number" ? event.output_index : 0;
        const record = item as Record<string, unknown>;
        emitToolStart(index, record);
        const current = toolCalls.get(index);
        const completeArguments =
          typeof record.arguments === "string" ? record.arguments : "";
        if (current && completeArguments.startsWith(current.arguments)) {
          const remaining = completeArguments.slice(current.arguments.length);
          if (remaining) {
            current.arguments += remaining;
            handlers.onToolCallDelta?.(index, remaining);
          }
        }
      }
      if (
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).type === "web_search_call"
      ) {
        const record = item as Record<string, unknown>;
        const id =
          typeof record.id === "string"
            ? record.id
            : typeof event.item_id === "string"
              ? event.item_id
              : "";
        if (id) {
          handlers.onHostedWebSearchStatus?.({
            index:
              typeof event.output_index === "number" ? event.output_index : 0,
            id,
            status: record.status === "completed" ? "completed" : "error",
            ...extractHostedWebSearchDetails(record),
          });
        }
      }
      return;
    }
    if (type === "response.created") {
      createdResponse = (event.response || {}) as ResponsesApiResponse;
      return;
    }
    if (
      type === "response.completed" ||
      type === "response.incomplete" ||
      type === "response.done"
    ) {
      completedResponse = {
        ...createdResponse,
        ...((event.response || {}) as ResponsesApiResponse),
      };
      return;
    }
    if (type === "response.failed") {
      const failed = (event.response || {}) as ResponsesApiResponse;
      throw responseError(failed) || new Error("Responses API request failed");
    }
    if (type === "error") {
      const error = event.error as { message?: string } | undefined;
      throw new Error(error?.message || "Responses API streaming error");
    }
  };

  while (true) {
    const result = await reader.read();
    if (result.done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(result.value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const data = parseSseDataLine(line);
      if (!data || data === "[DONE]") {
        continue;
      }
      handleEvent(JSON.parse(data) as Record<string, unknown>);
    }
  }

  const trailingData = parseSseDataLine(buffer.trim());
  if (trailingData && trailingData !== "[DONE]") {
    handleEvent(JSON.parse(trailingData) as Record<string, unknown>);
  }
  if (!completedResponse) {
    throw new Error("Responses API stream ended before response.completed");
  }
  if (!completedResponse.output?.length) {
    const synthesized: ResponsesOutputItem[] = [];
    if (accumulatedReasoning) {
      synthesized.push({
        type: "reasoning",
        summary: [{ type: "summary_text", text: accumulatedReasoning }],
      });
    }
    for (const [index, toolCall] of [...toolCalls.entries()].sort(
      ([left], [right]) => left - right,
    )) {
      synthesized.push({
        type: "function_call",
        id: `fc_stream_${index}`,
        call_id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      });
    }
    if (accumulatedText || accumulatedRefusal) {
      const content: ResponsesInputItem[] = [];
      if (accumulatedText) {
        content.push({
          type: "output_text",
          text: accumulatedText,
          annotations: [],
        });
      }
      if (accumulatedRefusal) {
        content.push({ type: "refusal", refusal: accumulatedRefusal });
      }
      synthesized.push({
        type: "message",
        role: "assistant",
        content,
      });
    }
    completedResponse.output = synthesized;
  }
  return completedResponse;
}

function isInvalidPreviousResponseError(error: unknown): boolean {
  if (!(error instanceof HttpResponseError)) {
    return false;
  }
  if (error.status !== 400 && error.status !== 404) {
    return false;
  }
  return /previous[_ ]response|previous_response_id|response.+(?:not found|expired|invalid)/i.test(
    error.responseBody,
  );
}

function supportsTemperature(modelId: string): boolean {
  return !/^(?:o\d|gpt-5)(?:[-.]|$)/i.test(modelId);
}

export class OpenAIResponsesProvider extends OpenAICompatibleProvider {
  private runtimeOptions: OpenAIResponsesRuntimeOptions;

  constructor(
    config: ApiKeyProviderConfig,
    runtimeOptions: OpenAIResponsesRuntimeOptions = {},
  ) {
    super(config);
    this.runtimeOptions = { ...runtimeOptions };
  }

  setRuntimeOptions(options: OpenAIResponsesRuntimeOptions): void {
    this.runtimeOptions = { ...options };
  }

  private getConversationState(): ResponsesConversationState | undefined {
    const sessionId = this.runtimeOptions.sessionId;
    return sessionId
      ? conversationStates.get(
          conversationKey(sessionId, this._config.defaultModel),
        )
      : undefined;
  }

  private setConversationState(state: ResponsesConversationState): void {
    const sessionId = this.runtimeOptions.sessionId;
    if (!sessionId) {
      return;
    }
    conversationStates.set(
      conversationKey(sessionId, this._config.defaultModel),
      state,
    );
  }

  private clearConversationState(): void {
    const sessionId = this.runtimeOptions.sessionId;
    if (!sessionId) {
      return;
    }
    conversationStates.delete(
      conversationKey(sessionId, this._config.defaultModel),
    );
  }

  private prepareLocalMessages(messages: ChatMessage[]): ChatMessage[] {
    const filtered = sanitizeOpenAIToolCallMessages(
      this.filterMessages(messages),
    );
    if (!this._config.systemPrompt) {
      return filtered;
    }
    return [
      {
        id: "paperchat-provider-system-prompt",
        role: "system",
        content: this._config.systemPrompt,
        timestamp: 0,
      },
      ...filtered,
    ];
  }

  private buildRequestPlan(
    messages: ChatMessage[],
    pdfAttachment: PdfAttachment | undefined,
    forceFull: boolean,
  ): ResponsesRequestPlan {
    const localMessages = this.prepareLocalMessages(messages);
    const localDescriptors = describeMessages(localMessages);
    const fullInput = convertMessagesToResponsesInput(
      localMessages,
      pdfAttachment,
    );
    let state = forceFull ? undefined : this.getConversationState();
    let incrementalMessages: ChatMessage[] = [];

    if (state) {
      const incremental = findIncrementalMessages(localMessages, state);
      if (!incremental.compatible) {
        this.clearConversationState();
        state = undefined;
      } else {
        incrementalMessages = incremental.messages;
      }
    }

    if (state?.statelessTranscript) {
      const delta = convertMessagesToResponsesInput(
        incrementalMessages,
        pdfAttachment,
      );
      return {
        mode: "stateless",
        localMessages,
        localDescriptors,
        fullInput,
        requestInput: [...state.statelessTranscript, ...delta],
      };
    }
    if (state?.previousResponseId) {
      return {
        mode: "previous_response",
        localMessages,
        localDescriptors,
        fullInput,
        requestInput: convertMessagesToResponsesInput(
          incrementalMessages,
          pdfAttachment,
        ),
        previousResponseId: state.previousResponseId,
      };
    }
    return {
      mode: "full",
      localMessages,
      localDescriptors,
      fullInput,
      requestInput: fullInput,
    };
  }

  private buildRequestBody(
    plan: ResponsesRequestPlan,
    tools: ToolDefinition[] | undefined,
    stream: boolean,
    options?: ToolCallingOptions,
  ): Record<string, unknown> {
    const convertedTools = convertTools(
      tools,
      this.runtimeOptions.hostedWebSearch === true,
    );
    const hasHostedWebSearch = convertedTools.some(
      (tool) => tool.type === "web_search_preview",
    );
    const body: Record<string, unknown> = {
      model: this._config.defaultModel,
      input: plan.requestInput,
      stream,
    };
    if (plan.previousResponseId) {
      body.previous_response_id = plan.previousResponseId;
    }
    if (convertedTools.length > 0) {
      body.tools = convertedTools;
      body.tool_choice = options?.toolChoice || "auto";
    }
    if (this._config.maxTokens && this._config.maxTokens > 0) {
      body.max_output_tokens = this._config.maxTokens;
    }
    if (supportsTemperature(this._config.defaultModel)) {
      body.temperature = this._config.temperature ?? 0.7;
    }
    if (this.runtimeOptions.sessionId) {
      body.prompt_cache_key = createResponsesPromptCacheKey(
        this.runtimeOptions.sessionId,
        this._config.defaultModel,
      );
    }
    if (hasHostedWebSearch) {
      body.include = ["web_search_call.action.sources"];
    }
    applyReasoningRequestOptions(body, this._config, "responses");
    return body;
  }

  private async request(
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    stream: boolean,
    signal: AbortSignal | undefined,
    options?: ToolCallingOptions,
    pdfAttachment?: PdfAttachment,
  ): Promise<ResponsesRequestResult> {
    let plan = this.buildRequestPlan(messages, pdfAttachment, false);
    let body = this.buildRequestBody(plan, tools, stream, options);
    let forceStateless = false;
    const send = () =>
      fetch(`${this._config.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: stablePromptCacheStringify(body),
        signal,
      });

    let response = await send();
    try {
      await this.validateResponse(response);
    } catch (error) {
      if (!plan.previousResponseId || !isInvalidPreviousResponseError(error)) {
        throw error;
      }
      this.clearConversationState();
      forceStateless = true;
      plan = this.buildRequestPlan(messages, pdfAttachment, true);
      body = this.buildRequestBody(plan, tools, stream, options);
      response = await send();
      await this.validateResponse(response);
    }
    return { response, plan, forceStateless };
  }

  private commitResponseState(
    plan: ResponsesRequestPlan,
    response: ResponsesApiResponse,
    forceStateless = false,
  ): void {
    if (!response.id) {
      this.clearConversationState();
      return;
    }
    const toolCalls = extractToolCalls(response);
    const nextState: ResponsesConversationState = {
      localMessages: plan.localDescriptors,
      lastOutput: {
        text: extractResponsesText(response),
        visibleText: "",
        toolCallIds: toolCalls.map((call) => call.id),
      },
    };
    nextState.lastOutput.visibleText = describeVisibleOutput(
      plan.localMessages,
      nextState.lastOutput.text,
    );
    if (
      response.store === false ||
      (forceStateless && response.store !== true)
    ) {
      const transcriptBase =
        plan.mode === "stateless" ? plan.requestInput : plan.fullInput;
      nextState.statelessTranscript = [
        ...transcriptBase,
        ...(response.output || []),
      ];
    } else {
      nextState.previousResponseId = response.id;
    }
    this.setConversationState(nextState);
  }

  private logResponsesUsage(requestKind: string, usage: unknown): void {
    logPromptCacheUsage({
      providerId: this._config.id,
      model: this._config.defaultModel,
      requestKind,
      usage,
    });
  }

  async streamChatCompletion(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    pdfAttachment?: PdfAttachment,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.isReady()) {
      callbacks.onError(new Error("Provider is not configured"));
      return;
    }
    try {
      const { response, plan, forceStateless } = await this.request(
        messages,
        undefined,
        true,
        signal,
        undefined,
        pdfAttachment,
      );
      const completed = await parseResponsesSSEStream(
        this.getResponseReader(response),
        {
          onTextDelta: callbacks.onChunk,
          onReasoningDelta: callbacks.onReasoningChunk,
        },
      );
      const error = responseError(completed);
      if (error) {
        throw error;
      }
      this.commitResponseState(plan, completed, forceStateless);
      this.logResponsesUsage("responses-stream", completed.usage);
      callbacks.onComplete(extractResponsesText(completed));
    } catch (error) {
      callbacks.onError(this.wrapError(error));
    }
  }

  async chatCompletion(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.isReady()) {
      throw new Error("Provider is not configured");
    }
    const { response, plan, forceStateless } = await this.request(
      messages,
      undefined,
      false,
      signal,
    );
    const completed = (await response.json()) as ResponsesApiResponse;
    const error = responseError(completed);
    if (error) {
      throw error;
    }
    this.commitResponseState(plan, completed, forceStateless);
    this.logResponsesUsage("responses", completed.usage);
    return extractResponsesText(completed);
  }

  async chatCompletionWithTools(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    options?: ToolCallingOptions,
  ): Promise<{
    content: string;
    reasoning?: string;
    toolCalls?: ToolCall[];
    hostedWebSearches?: HostedWebSearchCall[];
    suppressedToolCall?: boolean;
  }> {
    if (!this.isReady()) {
      throw new Error("Provider is not configured");
    }
    const { response, plan, forceStateless } = await this.request(
      messages,
      tools,
      false,
      signal,
      options,
    );
    const completed = (await response.json()) as ResponsesApiResponse;
    const error = responseError(completed);
    if (error) {
      throw error;
    }
    const toolCalls = extractToolCalls(completed);
    const hostedWebSearches = extractHostedWebSearchCalls(completed);
    const allowToolCalls = options?.toolChoice !== "none";
    if (!allowToolCalls && toolCalls.length > 0) {
      this.clearConversationState();
    } else {
      this.commitResponseState(plan, completed, forceStateless);
    }
    this.logResponsesUsage("responses-tools", completed.usage);
    return {
      content: extractResponsesText(completed),
      toolCalls: allowToolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      hostedWebSearches:
        hostedWebSearches.length > 0 ? hostedWebSearches : undefined,
      suppressedToolCall: !allowToolCalls && toolCalls.length > 0,
    };
  }

  async streamChatCompletionWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    callbacks: StreamToolCallingCallbacks,
    signal?: AbortSignal,
    options?: ToolCallingOptions,
  ): Promise<void> {
    if (!this.isReady()) {
      callbacks.onError(new Error("Provider is not configured"));
      return;
    }
    try {
      const { response, plan, forceStateless } = await this.request(
        messages,
        tools,
        true,
        signal,
        options,
      );
      const completed = await parseResponsesSSEStream(
        this.getResponseReader(response),
        {
          onTextDelta: callbacks.onTextDelta,
          onReasoningDelta: callbacks.onReasoningDelta,
          onToolCallStart: callbacks.onToolCallStart,
          onToolCallDelta: callbacks.onToolCallDelta,
          onHostedWebSearchStatus: callbacks.onHostedWebSearchStatus,
        },
      );
      const error = responseError(completed);
      if (error) {
        throw error;
      }
      const toolCalls = extractToolCalls(completed);
      const hostedWebSearches = extractHostedWebSearchCalls(completed);
      const allowToolCalls = options?.toolChoice !== "none";
      if (!allowToolCalls && toolCalls.length > 0) {
        this.clearConversationState();
      } else {
        this.commitResponseState(plan, completed, forceStateless);
      }
      this.logResponsesUsage("responses-tools-stream", completed.usage);
      callbacks.onComplete({
        content: extractResponsesText(completed),
        toolCalls:
          allowToolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        hostedWebSearches:
          hostedWebSearches.length > 0 ? hostedWebSearches : undefined,
        suppressedToolCall: !allowToolCalls && toolCalls.length > 0,
        stopReason:
          allowToolCalls && toolCalls.length > 0
            ? "tool_calls"
            : completed.status === "incomplete" &&
                completed.incomplete_details?.reason === "max_output_tokens"
              ? "max_tokens"
              : "end_turn",
      });
    } catch (error) {
      callbacks.onError(this.wrapError(error));
    }
  }
}
