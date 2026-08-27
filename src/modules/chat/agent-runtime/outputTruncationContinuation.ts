import type { ChatMessage, StreamToolCallingResult } from "../../../types/chat";

export const MAX_OUTPUT_TRUNCATION_CONTINUATIONS = 3;

export const OUTPUT_TRUNCATION_CONTINUATION_USER_MESSAGE =
  "Continue your previous answer from exactly where you stopped. Do not repeat content you already provided.";

export const REASONING_TRUNCATION_CONTINUATION_USER_MESSAGE =
  "Continue your reasoning and complete your answer from where you stopped. Do not repeat content you already provided.";

export const OUTPUT_CONTINUATION_TOOL_PROTOCOL_ERROR =
  "Provider returned tool protocol during text-only output continuation.";

export type TruncatableOutputResult = Partial<StreamToolCallingResult>;

export function shouldContinueTruncatedOutput(
  result: TruncatableOutputResult,
): boolean {
  return (
    result.stopReason === "max_tokens" &&
    !result.suppressedToolCall &&
    !result.incompleteToolProtocol &&
    !result.toolCalls?.length &&
    (!!(result.content || "").trim() || !!(result.reasoning || "").trim())
  );
}

export function hasUnexpectedContinuationToolProtocol(
  result: TruncatableOutputResult,
  continuationCount: number,
): boolean {
  return (
    continuationCount > 0 &&
    (result.stopReason === "tool_calls" ||
      !!result.suppressedToolCall ||
      !!result.incompleteToolProtocol ||
      !!result.toolCalls?.length ||
      !!result.hostedWebSearches?.length)
  );
}

export function getOutputTruncationContinuationUserMessage(
  partialContent: string,
  partialReasoning?: string,
): string {
  return !partialContent.trim() && partialReasoning?.trim()
    ? REASONING_TRUNCATION_CONTINUATION_USER_MESSAGE
    : OUTPUT_TRUNCATION_CONTINUATION_USER_MESSAGE;
}

/**
 * Add request-only continuation context. Reasoning-only responses intentionally
 * omit an empty assistant message because several chat APIs reject it.
 */
export function appendOutputContinuationMessages(
  messages: ChatMessage[],
  partialContent: string,
  partialReasoning: string | undefined,
  generateId: () => string,
): void {
  if (partialContent.trim()) {
    messages.push({
      id: generateId(),
      role: "assistant",
      content: partialContent,
      ...(partialReasoning?.trim()
        ? { reasoning: partialReasoning.trim() }
        : {}),
      apiOnly: true,
      outputContinuation: true,
      timestamp: Date.now(),
    });
  }
  messages.push({
    id: generateId(),
    role: "user",
    content: getOutputTruncationContinuationUserMessage(
      partialContent,
      partialReasoning,
    ),
    apiOnly: true,
    outputContinuation: true,
    timestamp: Date.now(),
  });
}

export async function continueTruncatedOutput<
  T extends TruncatableOutputResult,
>(params: {
  initialResult: T;
  displayBeforeRound: string;
  currentMessages: ChatMessage[];
  generateId: () => string;
  getSupplementalDisplay?: (result: T) => string;
  beforeContinuation?: (
    accumulatedDisplay: string,
    result: T,
    continuation: number,
  ) => void | Promise<void>;
  requestNext: (accumulatedDisplay: string, continuation: number) => Promise<T>;
}): Promise<{
  result: T;
  accumulatedDisplay: string;
  continuationCount: number;
  outputStillTruncated: boolean;
  unexpectedToolProtocol: boolean;
}> {
  const getSupplementalDisplay = params.getSupplementalDisplay || (() => "");
  let result = params.initialResult;
  let displayBeforeResult = params.displayBeforeRound;
  let continuationCount = 0;
  let unexpectedToolProtocol = false;

  while (
    shouldContinueTruncatedOutput(result) &&
    continuationCount < MAX_OUTPUT_TRUNCATION_CONTINUATIONS
  ) {
    continuationCount += 1;
    displayBeforeResult +=
      getSupplementalDisplay(result) + (result.content || "");
    appendOutputContinuationMessages(
      params.currentMessages,
      result.content || "",
      result.reasoning,
      params.generateId,
    );
    await params.beforeContinuation?.(
      displayBeforeResult,
      result,
      continuationCount,
    );
    result = await params.requestNext(displayBeforeResult, continuationCount);
    if (hasUnexpectedContinuationToolProtocol(result, continuationCount)) {
      unexpectedToolProtocol = true;
      break;
    }
  }

  return {
    result,
    accumulatedDisplay:
      displayBeforeResult +
      (unexpectedToolProtocol
        ? ""
        : getSupplementalDisplay(result) + (result.content || "")),
    continuationCount,
    outputStillTruncated: result.stopReason === "max_tokens",
    unexpectedToolProtocol,
  };
}
