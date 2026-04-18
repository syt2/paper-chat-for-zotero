import type { ChatMessage } from "../../../types/chat";
import type {
  PaperStructure,
  PaperStructureExtended,
  ToolCall,
  ToolExecutionResult,
} from "../../../types/tool";
import type { ToolSchedulerRequest } from "../tool-scheduler/ToolScheduler";
import {
  createBlockedRetryResult,
  findBlockedRetryMatch,
} from "../tool-retry/ToolRetryPolicy";

export type ToolExecutionBatchEntry =
  | {
      kind: "execute";
      requests: ToolSchedulerRequest[];
    }
  | {
      kind: "synthetic";
      results: ToolExecutionResult[];
    };

export function planToolExecutionEntries(params: {
  sessionId: string;
  assistantMessage: ChatMessage;
  toolCalls: ToolCall[];
  previousResults: ToolExecutionResult[];
  paperStructure?: PaperStructure | PaperStructureExtended | null;
  createExecutionBatches: (
    requests: ToolSchedulerRequest[],
  ) => ToolSchedulerRequest[][];
}): ToolExecutionBatchEntry[] {
  const {
    sessionId,
    assistantMessage,
    toolCalls,
    previousResults,
    paperStructure,
    createExecutionBatches,
  } = params;
  const entries: ToolExecutionBatchEntry[] = [];
  let runnableSegment: ToolSchedulerRequest[] = [];

  const flushRunnableSegment = () => {
    if (runnableSegment.length === 0) {
      return;
    }
    entries.push(
      ...createExecutionBatches(runnableSegment).map((requests) => ({
        kind: "execute" as const,
        requests,
      })),
    );
    runnableSegment = [];
  };

  for (const toolCall of toolCalls) {
    const blockedRetry = findBlockedRetryMatch(toolCall, previousResults);
    if (blockedRetry) {
      flushRunnableSegment();
      entries.push({
        kind: "synthetic",
        results: [createBlockedRetryResult(toolCall, blockedRetry.previousResult)],
      });
      continue;
    }

    runnableSegment.push({
      toolCall,
      sessionId,
      assistantMessageId: assistantMessage.id,
      fallbackStructure: paperStructure || undefined,
    });
  }

  flushRunnableSegment();
  return entries;
}
