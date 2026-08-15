import type { ChatMessage } from "../../../types/chat";
import type {
  PaperStructure,
  PaperStructureExtended,
  ToolCall,
  ToolExecutionResult,
} from "../../../types/tool";
import type {
  ToolSchedulerExecutionContext,
  ToolSchedulerRequest,
} from "../tool-scheduler/ToolScheduler";
import {
  applyToolBudgetPolicy,
  createToolBudgetState,
  getToolBudgetLimits,
  type ToolBudgetLimits,
} from "../tool-budget/ToolBudgetPolicy";
import { DEFAULT_AGENT_MAX_PLANNING_ITERATIONS } from "./IterationLimitConfig";
import {
  createBlockedRetryResult,
  fingerprintToolCall,
  fingerprintToolExecutionResult,
  findBlockedRetryMatch,
} from "../tool-retry/ToolRetryPolicy";
import { PRESENTATION_LAUNCH_TOOL_NAME } from "../../presentation/PresentationToolLaunchSession";

export type ToolExecutionBatchEntry =
  | {
      kind: "execute";
      requests: ToolSchedulerRequest[];
    }
  | {
      kind: "synthetic";
      results: ToolExecutionResult[];
    }
  | {
      kind: "reused";
      results: ToolExecutionResult[];
    };

export function findCompletedToolResultMatch(
  toolCall: ToolCall,
  previousResults: ToolExecutionResult[],
): ToolExecutionResult | null {
  // This result represents one turn's native confirmation and in-memory
  // capability, not a repeatable read. A recovered turn must run the guard
  // again so it can mint a fresh authorization for its new launch session.
  if (toolCall.function.name === PRESENTATION_LAUNCH_TOOL_NAME) return null;
  const fingerprint = fingerprintToolCall(toolCall);
  for (let index = previousResults.length - 1; index >= 0; index--) {
    const result = previousResults[index];
    if (
      result.status === "completed" &&
      fingerprintToolExecutionResult(result) === fingerprint
    ) {
      return result;
    }
  }
  return null;
}

export function createReusedCompletedToolResult(
  toolCall: ToolCall,
  previousResult: ToolExecutionResult,
): ToolExecutionResult {
  return {
    toolCall,
    args: previousResult.args,
    metadata: previousResult.metadata,
    artifact: previousResult.artifact,
    references: previousResult.references,
    evidence: previousResult.evidence,
    permissionDecision: previousResult.permissionDecision,
    policyTrace: previousResult.policyTrace,
    status: "completed",
    content: previousResult.content,
  };
}

export function planToolExecutionEntries(params: {
  sessionId: string;
  assistantMessage: ChatMessage;
  toolCalls: ToolCall[];
  previousResults: ToolExecutionResult[];
  paperStructure?: PaperStructure | PaperStructureExtended | null;
  createExecutionBatches: (
    requests: ToolSchedulerRequest[],
  ) => ToolSchedulerRequest[][];
  budgetLimits?: ToolBudgetLimits;
  reuseCompletedResults?: boolean;
  currentItemKey?: string | null;
  executionContext?: ToolSchedulerExecutionContext;
}): ToolExecutionBatchEntry[] {
  const {
    sessionId,
    assistantMessage,
    toolCalls,
    previousResults,
    paperStructure,
    createExecutionBatches,
    budgetLimits,
    reuseCompletedResults = false,
    currentItemKey,
    executionContext,
  } = params;
  const entries: ToolExecutionBatchEntry[] = [];
  let runnableSegment: ToolSchedulerRequest[] = [];
  const budgetState = createToolBudgetState(previousResults);
  const effectiveBudgetLimits =
    budgetLimits ?? getToolBudgetLimits(DEFAULT_AGENT_MAX_PLANNING_ITERATIONS);

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
    const completedResult = reuseCompletedResults
      ? findCompletedToolResultMatch(toolCall, previousResults)
      : null;
    if (completedResult) {
      flushRunnableSegment();
      entries.push({
        kind: "reused",
        results: [createReusedCompletedToolResult(toolCall, completedResult)],
      });
      continue;
    }

    const blockedRetry = findBlockedRetryMatch(toolCall, previousResults);
    if (blockedRetry) {
      flushRunnableSegment();
      entries.push({
        kind: "synthetic",
        results: [
          createBlockedRetryResult(toolCall, blockedRetry.previousResult),
        ],
      });
      continue;
    }

    const blockedByBudget = applyToolBudgetPolicy(
      toolCall,
      budgetState,
      effectiveBudgetLimits,
    );
    if (blockedByBudget) {
      flushRunnableSegment();
      entries.push({
        kind: "synthetic",
        results: [blockedByBudget],
      });
      continue;
    }

    runnableSegment.push({
      toolCall,
      sessionId,
      assistantMessageId: assistantMessage.id,
      fallbackStructure: paperStructure || undefined,
      currentItemKey,
      executionContext,
    });
  }

  flushRunnableSegment();
  return entries;
}
