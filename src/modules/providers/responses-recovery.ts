import type { ChatMessage } from "../../types/chat";
import type { ApiKeyProviderConfig } from "../../types/provider";
import { HttpResponseError } from "./HttpResponseError";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
import { isReasoningReplayRequiredError } from "./reasoning-request";

const DEFAULT_HANDOFF_COMPACTION_MODEL = "deepseek-flash";
const HANDOFF_TIMEOUT_MS = 20_000;
const MAX_HANDOFF_INPUT_CHARS = 120_000;
const MAX_HANDOFF_MESSAGE_CHARS = 24_000;
const MAX_HANDOFF_REASONING_CHARS = 4_000;
const MAX_HANDOFF_SUMMARY_CHARS = 20_000;
const MAX_HANDOFF_LIST_ITEMS = 12;
const MAX_HANDOFF_LIST_ITEM_CHARS = 2_000;

const NON_COMPRESSIBLE_ERROR_PATTERN =
  /unauthorized|invalid api key|permission denied|quota|billing|insufficient|rate limit|too many requests|model not found|does not exist|content policy|moderation|safety|blocked/i;

const CONTEXT_OVERFLOW_PATTERN =
  /context_length_exceeded|maximum context length|too many tokens|context window|exceeds? the (?:maximum|context)/i;

const REPLAY_INCOMPATIBILITY_PATTERNS = [
  /input\[\d+\][\s\S]{0,140}(?:content|reasoning|logprobs|status|annotations)/i,
  /messages\[\d+\][\s\S]{0,140}(?:content|tool|reasoning)/i,
  /unknown (?:parameter|variant|field)[\s\S]{0,120}(?:input|messages|content|tool)/i,
  /tool result[\s\S]{0,120}does not follow/i,
  /missing required parameter:\s*['"]?(?:messages|input|content|tool)/i,
  /invalid_value[\s\S]{0,120}(?:message|content|tool)/i,
];

const HANDOFF_SYSTEM_PROMPT = `You compress a chat and tool history into a portable handoff for another model.
Return ONLY valid JSON with this shape:
{
  "goal": string,
  "constraints": string[],
  "confirmed_facts": string[],
  "tool_results": string[],
  "open_questions": string[],
  "recent_context": string[]
}
Preserve exact numbers, dates, DOIs, page numbers, URLs, user constraints, and unresolved tasks.
Do not invent facts. Omit uncertain details. Do not include hidden reasoning or provider-specific metadata.`;

export function isContextOverflowError(error: unknown): boolean {
  return (
    error instanceof HttpResponseError &&
    CONTEXT_OVERFLOW_PATTERN.test(error.responseBody)
  );
}

/**
 * Only history/protocol incompatibility is eligible for a model-generated
 * handoff. Authentication, quota, missing-model, and content-policy failures
 * must continue through the normal routing/error path.
 */
export function isHandoffEligibleError(error: unknown): boolean {
  if (!(error instanceof HttpResponseError)) {
    return false;
  }
  if (error.status !== 400 && error.status !== 413 && error.status !== 422) {
    return false;
  }
  if (NON_COMPRESSIBLE_ERROR_PATTERN.test(error.responseBody)) {
    return false;
  }
  if (CONTEXT_OVERFLOW_PATTERN.test(error.responseBody)) {
    return true;
  }
  if (isReasoningReplayRequiredError(error)) {
    return true;
  }
  return REPLAY_INCOMPATIBILITY_PATTERNS.some((pattern) =>
    pattern.test(error.responseBody),
  );
}

function truncate(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars)}\n[... truncated ...]`;
}

export function boundHandoffReplayMessage(value: string): string {
  return truncate(value, MAX_HANDOFF_MESSAGE_CHARS);
}

function formatMessageEntry(message: ChatMessage): string | null {
  if (message.role === "error") {
    return null;
  }

  const parts: string[] = [];
  const content = truncate(message.content, MAX_HANDOFF_MESSAGE_CHARS);
  if (content) {
    parts.push(`${message.role.toUpperCase()}: ${content}`);
  }

  if (message.role === "assistant" && message.tool_calls?.length) {
    for (const toolCall of message.tool_calls) {
      parts.push(
        `ASSISTANT_TOOL_CALL: ${toolCall.function.name}(${toolCall.function.arguments})`,
      );
    }
  }
  if (message.role === "tool" && message.tool_call_id) {
    parts.push(`TOOL_CALL_ID: ${message.tool_call_id}`);
  }
  if (message.reasoning?.trim()) {
    parts.push(
      `PREVIOUS_MODEL_REASONING_SUMMARY: ${truncate(
        message.reasoning,
        MAX_HANDOFF_REASONING_CHARS,
      )}`,
    );
  }
  if (message.images?.length) {
    parts.push(`ATTACHMENTS: ${message.images.length} image(s)`);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Keep the system/task-defining head and the most recent turns. The exact
 * provider-native history is intentionally not sent to the compactor.
 */
export function buildHandoffTranscript(
  messages: ChatMessage[],
  maxChars = MAX_HANDOFF_INPUT_CHARS,
): string {
  const entries = messages
    .map((message) => formatMessageEntry(message))
    .filter((entry): entry is string => !!entry);
  if (entries.length === 0) {
    return "";
  }

  const headCount = Math.min(2, entries.length);
  const head = entries.slice(0, headCount);
  const tail: string[] = [];
  let used = head.join("\n\n").length;
  let omitted = 0;

  for (let index = entries.length - 1; index >= headCount; index--) {
    const entry = entries[index];
    const separator = tail.length + head.length > 0 ? 2 : 0;
    if (used + entry.length + separator > maxChars) {
      omitted++;
      continue;
    }
    tail.unshift(entry);
    used += entry.length + separator;
  }

  const sections = [...head];
  if (omitted > 0) {
    sections.push(`[... ${omitted} earlier message(s) omitted ...]`);
  }
  sections.push(...tail);
  const transcript = sections.join("\n\n");
  return truncate(transcript, maxChars);
}

function normalizeList(value: unknown): string[] {
  const values =
    typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => truncate(item, MAX_HANDOFF_LIST_ITEM_CHARS))
    .filter(Boolean)
    .slice(0, MAX_HANDOFF_LIST_ITEMS);
}

function formatSection(title: string, values: string[]): string | null {
  if (values.length === 0) {
    return null;
  }
  return `${title}:\n${values.map((value) => `- ${value}`).join("\n")}`;
}

function normalizeHandoffSummary(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const goal =
    typeof record.goal === "string"
      ? truncate(record.goal, MAX_HANDOFF_LIST_ITEM_CHARS)
      : "";
  const sections = [
    goal ? `Goal:\n- ${goal}` : null,
    formatSection("Constraints", normalizeList(record.constraints)),
    formatSection("Confirmed facts", normalizeList(record.confirmed_facts)),
    formatSection("Tool results", normalizeList(record.tool_results)),
    formatSection("Open questions", normalizeList(record.open_questions)),
    formatSection("Recent context", normalizeList(record.recent_context)),
  ].filter((section): section is string => !!section);

  if (sections.length === 0) {
    return null;
  }
  return truncate(sections.join("\n\n"), MAX_HANDOFF_SUMMARY_CHARS);
}

function parseHandoffSummary(raw: string): string | null {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  if (!trimmed) {
    return null;
  }
  try {
    const normalized = normalizeHandoffSummary(JSON.parse(trimmed));
    if (normalized) {
      return normalized;
    }
  } catch {
    // Fall through to the plain-text fallback below.
  }
  if (
    trimmed.length < 20 ||
    /^(?:i cannot|i can't|as an ai|sorry,? i)/i.test(trimmed)
  ) {
    return null;
  }
  return truncate(`Handoff summary:\n${trimmed}`, MAX_HANDOFF_SUMMARY_CHARS);
}

function isDeepSeekModel(model: string): boolean {
  return /^deepseek(?:-|$)/i.test(model.trim());
}

/**
 * The compactor is deliberately a text-only Chat Completions call. It must not
 * reuse the failed Responses history or expose tools to the utility model.
 */
export async function createHandoffSummary(
  config: ApiKeyProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string | null> {
  if (!config.apiKey || !config.baseUrl) {
    return null;
  }
  const transcript = buildHandoffTranscript(messages);
  if (!transcript) {
    return null;
  }

  const model =
    config.handoffCompactionModel || DEFAULT_HANDOFF_COMPACTION_MODEL;
  const compactor = new OpenAICompatibleProvider({
    id: "paperchat-handoff-compactor",
    name: "PaperChat Handoff Compactor",
    type: "openai-compatible",
    enabled: true,
    isBuiltin: true,
    order: 0,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    defaultModel: model,
    availableModels: [model],
    maxTokens: 4096,
    temperature: 0.1,
    systemPrompt: "",
    reasoningEffort: isDeepSeekModel(model) ? "none" : "default",
    ...(isDeepSeekModel(model)
      ? {
          reasoningCapability: {
            protocol: "deepseek" as const,
            efforts: ["none" as const],
            default: "none" as const,
          },
        }
      : {}),
  });

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) {
    return null;
  }
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), HANDOFF_TIMEOUT_MS);

  try {
    const raw = await compactor.chatCompletion(
      [
        {
          id: "paperchat-handoff-system",
          role: "system",
          content: HANDOFF_SYSTEM_PROMPT,
          timestamp: 0,
        },
        {
          id: "paperchat-handoff-input",
          role: "user",
          content: `Conversation to compact:\n\n${transcript}`,
          timestamp: 0,
        },
      ],
      controller.signal,
    );
    return parseHandoffSummary(raw);
  } catch (error) {
    ztoolkit.log(
      "[Handoff] Context compaction failed; using existing recovery path.",
      error,
    );
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
