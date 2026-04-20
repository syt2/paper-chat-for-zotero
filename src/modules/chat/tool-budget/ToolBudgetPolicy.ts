import type { ToolCall, ToolExecutionResult } from "../../../types/tool";
import { preflightToolArguments } from "../tool-arguments/ToolArgumentPreflight";
import { formatToolError, parseToolError } from "../tool-errors/ToolErrorFormatter";
import { getToolRuntimeMetadata } from "../tool-scheduler/ToolMetadataRegistry";
import { normalizeAgentMaxPlanningIterations } from "../agent-runtime/IterationLimitConfig";

const CURRENT_PAPER_TARGET = "__current_paper__";
const MAX_FULL_TEXT_CEILING = 3;
const MAX_WEB_SEARCH_CEILING = 8;

const NARROW_PAPER_TOOLS = new Set([
  "get_paper_section",
  "search_paper_content",
  "get_pages",
  "search_with_regex",
  "get_outline",
  "list_sections",
  "get_page_count",
  "get_paper_metadata",
]);

export interface ToolBudgetState {
  getFullTextCalls: number;
  webSearchCalls: number;
  webSearchQueries: string[];
  narrowPaperTargets: Set<string>;
}

export interface ToolBudgetLimits {
  maxFullTextCallsPerTurn: number;
  maxWebSearchCallsPerTurn: number;
}

export function createToolBudgetState(
  previousResults: ToolExecutionResult[],
): ToolBudgetState {
  const state: ToolBudgetState = {
    getFullTextCalls: 0,
    webSearchCalls: 0,
    webSearchQueries: [],
    narrowPaperTargets: new Set<string>(),
  };

  for (const result of previousResults) {
    if (!shouldCountResultTowardBudget(result)) {
      continue;
    }

    const toolName = result.toolCall.function.name;
    if (toolName === "get_full_text") {
      state.getFullTextCalls += 1;
      continue;
    }
    if (toolName === "web_search") {
      state.webSearchCalls += 1;
      const query = normalizeWebSearchQuery(result.args?.query);
      if (query) {
        state.webSearchQueries.push(query);
      }
      continue;
    }
    if (NARROW_PAPER_TOOLS.has(toolName)) {
      state.narrowPaperTargets.add(getPaperTargetKey(result.args));
    }
  }

  return state;
}

export function getToolBudgetLimits(
  maxIterations: number,
): ToolBudgetLimits {
  const normalizedIterations = normalizeAgentMaxPlanningIterations(maxIterations);
  return {
    maxFullTextCallsPerTurn: Math.min(normalizedIterations, MAX_FULL_TEXT_CEILING),
    maxWebSearchCallsPerTurn: Math.min(
      MAX_WEB_SEARCH_CEILING,
      Math.max(1, Math.floor(normalizedIterations / 3)),
    ),
  };
}

export function applyToolBudgetPolicy(
  toolCall: ToolCall,
  state: ToolBudgetState,
  limits: ToolBudgetLimits,
): ToolExecutionResult | null {
  // This policy is intentionally stateful: allowed calls update the per-turn
  // budget snapshot so later calls in the same planning pass see the new usage.
  const toolName = toolCall.function.name;
  const args = getNormalizedArgsRecord(toolCall);

  if (NARROW_PAPER_TOOLS.has(toolName)) {
    state.narrowPaperTargets.add(getPaperTargetKey(args));
    return null;
  }

  if (toolName === "get_full_text") {
    const targetKey = getPaperTargetKey(args);
    if (state.getFullTextCalls >= limits.maxFullTextCallsPerTurn) {
      return createBudgetBlockedResult(toolCall, args, {
        summary: "Blocked get_full_text because the turn budget is exhausted.",
        cause:
          `High-cost tool limit reached: get_full_text may only run ${limits.maxFullTextCallsPerTurn} times per user turn.`,
        suggestedFix:
          "Use the full-text result already gathered in this turn, or wait for a new user turn before requesting full text again.",
        saferAlternative:
          "Continue with section/page tools or synthesize from evidence already collected.",
        data: {
          tool: toolName,
          targetKey,
          getFullTextCalls: state.getFullTextCalls,
          limit: limits.maxFullTextCallsPerTurn,
        },
      });
    }
    if (!state.narrowPaperTargets.has(targetKey)) {
      return createBudgetBlockedResult(toolCall, args, {
        summary:
          "Blocked get_full_text until a narrower paper tool has been used for the same target.",
        cause:
          "Use narrower tools first before calling get_full_text in the current turn.",
        suggestedFix:
          "Call get_paper_section, search_paper_content, get_pages, or another narrower paper tool first, then request full text only if it is still necessary.",
        saferAlternative:
          "Use targeted paper tools, metadata, notes, or annotations instead of full text.",
        data: {
          tool: toolName,
          targetKey,
          narrowPaperTargets: [...state.narrowPaperTargets],
        },
      });
    }

    state.getFullTextCalls += 1;
    return null;
  }

  if (toolName === "web_search") {
    const query = normalizeWebSearchQuery(args?.query);
    if (query && hasObviouslyRepeatedWebSearch(query, state.webSearchQueries)) {
      return createBudgetBlockedResult(toolCall, args, {
        summary: "Blocked web_search because this turn already used a similar query.",
        cause:
          "A similar web_search query already used this turn would likely return redundant results.",
        suggestedFix:
          "Use the search results already gathered, or materially narrow the question before searching again.",
        saferAlternative:
          "Use Zotero library tools or synthesize from current-turn evidence instead of repeating web search.",
        data: {
          tool: toolName,
          query,
          previousQueries: [...state.webSearchQueries],
        },
      });
    }
    if (state.webSearchCalls >= limits.maxWebSearchCallsPerTurn) {
      return createBudgetBlockedResult(toolCall, args, {
        summary: "Blocked web_search because the turn budget is exhausted.",
        cause:
          `High-cost tool limit reached: web_search may only run ${limits.maxWebSearchCallsPerTurn} times per user turn.`,
        suggestedFix:
          "Use the web results already gathered in this turn, or wait for a new user turn before searching again.",
        saferAlternative:
          "Prefer Zotero library tools or narrower local evidence before adding another web search.",
        data: {
          tool: toolName,
          query,
          webSearchCalls: state.webSearchCalls,
          limit: limits.maxWebSearchCallsPerTurn,
        },
      });
    }

    state.webSearchCalls += 1;
    if (query) {
      state.webSearchQueries.push(query);
    }
    return null;
  }

  return null;
}

function createBudgetBlockedResult(
  toolCall: ToolCall,
  args: Record<string, unknown> | null,
  options: {
    summary: string;
    cause: string;
    suggestedFix: string;
    saferAlternative: string;
    data?: Record<string, unknown>;
  },
): ToolExecutionResult {
  return {
    toolCall,
    args: args || undefined,
    metadata: getToolRuntimeMetadata(toolCall.function.name) || undefined,
    policyTrace: [
      {
        stage: "planner",
        policy: "budget_block",
        outcome: "blocked",
        summary: options.summary,
        detail: options.cause,
        data: options.data,
      },
    ],
    status: "failed",
    content: formatToolError({
      summary: `Tool budget exhausted for ${toolCall.function.name}.`,
      category: "budget_exhausted",
      retryable: false,
      cause: options.cause,
      suggestedFix: options.suggestedFix,
      saferAlternative: options.saferAlternative,
    }),
    error: options.cause,
  };
}

function shouldCountResultTowardBudget(result: ToolExecutionResult): boolean {
  if (result.status === "denied") {
    return false;
  }

  const parsed = parseToolError(result.content);
  const summary = parsed?.summary || "";
  if (
    parsed?.category === "invalid_arguments" ||
    parsed?.category === "permission_denied" ||
    parsed?.category === "budget_exhausted" ||
    summary.startsWith("Repeated unchanged tool call blocked")
  ) {
    return false;
  }

  return true;
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
    return preflightToolArguments(
      toolCall.function.name,
      parsed as Record<string, unknown>,
    );
  } catch {
    return null;
  }
}

function getPaperTargetKey(args?: Record<string, unknown> | null): string {
  return typeof args?.itemKey === "string" && args.itemKey
    ? args.itemKey
    : CURRENT_PAPER_TARGET;
}

function normalizeWebSearchQuery(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasObviouslyRepeatedWebSearch(
  query: string,
  previousQueries: string[],
): boolean {
  return previousQueries.some((previous) => isObviouslyRepeatedQuery(query, previous));
}

function isObviouslyRepeatedQuery(query: string, previous: string): boolean {
  if (!query || !previous) {
    return false;
  }
  if (query === previous) {
    return true;
  }

  const shorter = query.length <= previous.length ? query : previous;
  const longer = query.length > previous.length ? query : previous;
  if (shorter.length >= 12 && longer.includes(shorter)) {
    return true;
  }

  const queryTokens = new Set(query.split(" ").filter(Boolean));
  const previousTokens = new Set(previous.split(" ").filter(Boolean));
  const intersectionSize = [...queryTokens].filter((token) =>
    previousTokens.has(token),
  ).length;
  const overlapRatio =
    intersectionSize / Math.max(1, Math.min(queryTokens.size, previousTokens.size));

  return overlapRatio >= 0.75 && Math.min(queryTokens.size, previousTokens.size) >= 3;
}
