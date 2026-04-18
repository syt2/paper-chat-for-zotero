import type { ToolCall, ToolExecutionResult } from "../../../types/tool";
import { preflightToolArguments } from "../tool-arguments/ToolArgumentPreflight";
import { formatToolError, parseToolError } from "../tool-errors/ToolErrorFormatter";

export interface BlockedRetryMatch {
  fingerprint: string;
  previousResult: ToolExecutionResult;
}

export function fingerprintToolCall(toolCall: ToolCall): string {
  return buildFingerprint(toolCall.function.name, getNormalizedArgsValue(toolCall));
}

export function fingerprintToolExecutionResult(
  result: ToolExecutionResult,
): string {
  const toolName = result.toolCall.function.name;
  if (result.args) {
    return buildFingerprint(toolName, normalizeArgsObject(toolName, result.args));
  }

  return fingerprintToolCall(result.toolCall);
}

export function findBlockedRetryMatch(
  toolCall: ToolCall,
  previousResults: ToolExecutionResult[],
): BlockedRetryMatch | null {
  const fingerprint = fingerprintToolCall(toolCall);
  let previousResult: ToolExecutionResult | null = null;

  for (const result of previousResults) {
    if (result.status !== "failed" && result.status !== "denied") {
      continue;
    }
    if (fingerprintToolExecutionResult(result) !== fingerprint) {
      continue;
    }
    previousResult = result;
  }

  if (!previousResult) {
    return null;
  }

  return {
    fingerprint,
    previousResult,
  };
}

export function createBlockedRetryResult(
  toolCall: ToolCall,
  previousResult: ToolExecutionResult,
): ToolExecutionResult {
  const toolName = toolCall.function.name;
  const parsedError = parseToolError(previousResult.content);
  const repeatedCallReason =
    previousResult.status === "denied"
      ? `This exact ${toolName} call was already denied earlier in this turn.`
      : `This exact ${toolName} call already failed earlier in this turn.`;
  const suggestedFix = parsedError?.suggestedFix
    ? `Do not retry unchanged. ${parsedError.suggestedFix}`
    : "Do not retry unchanged. Change the arguments or choose a different tool.";

  const args = getNormalizedArgsRecord(toolCall);

  return {
    toolCall,
    args: args || undefined,
    metadata: previousResult.metadata,
    permissionDecision: previousResult.permissionDecision,
    status: previousResult.status,
    content: formatToolError({
      summary: `Repeated unchanged tool call blocked for ${toolName}.`,
      category:
        previousResult.status === "denied"
          ? "permission_denied"
          : parsedError?.category || "execution_failed",
      retryable: false,
      cause: repeatedCallReason,
      suggestedFix,
      saferAlternative:
        parsedError?.saferAlternative ||
        "Use other successful tool results or explain the remaining limitation.",
    }),
    error: repeatedCallReason,
  };
}

export function summarizeRetryBlockedCalls(
  results: ToolExecutionResult[],
  limit: number = 3,
): string[] {
  return results
    .filter((result) => result.status === "failed" || result.status === "denied")
    .slice(-limit)
    .map((result) => {
      const label = formatToolCallLabel(result.toolCall, result.args);
      return `- [${result.status}] ${label}`;
    });
}

function getNormalizedArgsValue(toolCall: ToolCall): unknown {
  const normalized = getNormalizedArgsRecord(toolCall);
  if (normalized) {
    return normalized;
  }

  const raw = toolCall.function.arguments.trim();
  return {
    __raw_arguments__: raw,
  };
}

function getNormalizedArgsRecord(
  toolCall: ToolCall,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(toolCall.function.arguments);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return normalizeArgsObject(
      toolCall.function.name,
      parsed as Record<string, unknown>,
    );
  } catch {
    return null;
  }
}

function normalizeArgsObject(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return preflightToolArguments(toolName, clonePlainObject(args));
}

function clonePlainObject<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildFingerprint(toolName: string, args: unknown): string {
  return `${toolName}:${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortKeysDeep(entry));
  }

  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  return value;
}

function formatToolCallLabel(
  toolCall: ToolCall,
  args?: Record<string, unknown>,
): string {
  const rawArgs = args
    ? stableStringify(sortKeysDeep(args))
    : stableStringify(getNormalizedArgsValue(toolCall));
  return `${toolCall.function.name}(${truncateInline(rawArgs, 80)})`;
}

function truncateInline(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
