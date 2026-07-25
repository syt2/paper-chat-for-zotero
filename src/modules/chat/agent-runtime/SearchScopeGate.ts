import type {
  ToolCall,
  ToolDefinition,
  ToolExecutionResult,
} from "../../../types/tool";
import {
  formatToolError,
  parseToolError,
} from "../tool-errors/ToolErrorFormatter";

export const SEARCH_SCOPE_TOOL_NAME = "select_search_scope";

export type SelectedSearchScope =
  | "scholarly_only"
  | "scholarly_then_web"
  | "web_allowed"
  | "no_external_search";

export type SearchToolPromptMode =
  | "unified"
  | "split"
  | "gated"
  | "scholarly_only"
  | "none";

export interface SearchScopeGateConfig {
  onScopeSelected: (scope: SelectedSearchScope) => void;
}

export function createSearchScopeToolDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: SEARCH_SCOPE_TOOL_NAME,
      description:
        "Choose the external-search permission and ordering scope for the current latest user turn before performing any external search. You must call this when the user explicitly asks you to search, browse, look up current/live information, or otherwise needs information outside the current PDF and Zotero library; do not claim that search is unavailable before selecting a scope. If the task can be answered from the current PDF or Zotero library, answer directly without calling it. Use scholarly_only when the user permits only Google Scholar, OpenAlex, scholarly databases, papers, or literature. Use scholarly_then_web when the user explicitly requires scholarly search first but permits ordinary or vendor-hosted web search only as a fallback after a scholarly attempt. Use web_allowed when ordinary or vendor-hosted web search may be used directly without a required scholarly-first step. Use no_external_search when the user explicitly prohibits all external search. The selection applies only to the current user turn.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: [
              "scholarly_only",
              "scholarly_then_web",
              "web_allowed",
              "no_external_search",
            ],
            description:
              "The external-search permission scope for this user turn.",
          },
          reason: {
            type: "string",
            description:
              "Briefly explain which part of the user's request determines this scope.",
          },
        },
        required: ["scope", "reason"],
      },
    },
  };
}

export function createPendingSearchScopeTools(
  tools: ToolDefinition[],
): ToolDefinition[] {
  return [
    ...tools.filter((tool) => !isExternalSearchToolName(tool.function.name)),
    createSearchScopeToolDefinition(),
  ];
}

export function filterSearchToolsForScope(params: {
  tools: ToolDefinition[];
  supportsHostedWebSearch: boolean;
  scope?: SelectedSearchScope;
}): ToolDefinition[] {
  const { tools, supportsHostedWebSearch, scope } = params;
  if (scope === "no_external_search") {
    return tools.filter(
      (tool) => !isExternalSearchToolName(tool.function.name),
    );
  }
  if (scope === "scholarly_only" || scope === "scholarly_then_web") {
    return tools.filter((tool) => tool.function.name !== "web_search");
  }
  if (!supportsHostedWebSearch) {
    return tools.filter(
      (tool) => tool.function.name !== "search_scholarly_sources",
    );
  }
  return tools;
}

export function getSearchToolPromptMode(
  tools: ToolDefinition[],
  gated: boolean = false,
): SearchToolPromptMode {
  if (gated) {
    return "gated";
  }
  const toolNames = new Set(tools.map((tool) => tool.function.name));
  if (toolNames.has("search_scholarly_sources")) {
    return toolNames.has("web_search") ? "split" : "scholarly_only";
  }
  return toolNames.has("web_search") ? "unified" : "none";
}

export function isExternalSearchToolName(toolName: string): boolean {
  return toolName === "web_search" || toolName === "search_scholarly_sources";
}

export function isSearchScopeControlledToolName(toolName: string): boolean {
  return (
    toolName === SEARCH_SCOPE_TOOL_NAME || isExternalSearchToolName(toolName)
  );
}

export function getSelectedSearchScopeRuntimeGuidance(
  scope: SelectedSearchScope,
  mode: SearchToolPromptMode,
): string {
  if (scope === "scholarly_then_web") {
    return [
      "The external-search scope is scholarly_then_web and is locked in its scholarly-first phase for this user turn. Do not call select_search_scope again.",
      "Call search_scholarly_sources before any hosted or ordinary web_search. web_search is intentionally hidden until a scholarly-search attempt completes.",
      "After that attempt, web_search may be exposed. Use it only if the scholarly attempt fails or returns no useful results and the user's requested fallback is still necessary.",
    ].join("\n");
  }
  if (scope === "web_allowed") {
    if (mode === "unified") {
      return [
        "The external-search scope is web_allowed and is locked for this user turn. Do not call select_search_scope again.",
        "The current model exposes the unified local web_search tool. Use its scholarly sources for papers and citations, and its general-web sources only when the user permits ordinary web evidence.",
      ].join("\n");
    }
    return [
      "The external-search scope is web_allowed and is locked for this user turn. Do not call select_search_scope again.",
      "For papers, authors, DOI, citations, or related work, use search_scholarly_sources before web_search.",
      "If scholarly search fails or returns no useful results and the user asked to continue with ordinary web search as fallback, call web_search before answering.",
    ].join("\n");
  }
  if (scope === "scholarly_only") {
    return [
      "The external-search scope is scholarly_only and is locked for this user turn. Do not call select_search_scope again.",
      "Use search_scholarly_sources for external search. Hosted or ordinary web_search is prohibited in this turn.",
      "If scholarly search returns no useful results, broaden the scholarly query or state the evidence gap without downgrading to general web search.",
    ].join("\n");
  }
  return [
    "The external-search scope is no_external_search and is locked for this user turn. Do not call select_search_scope again.",
    "Do not use external search tools. Continue with the current PDF and Zotero library evidence only.",
  ].join("\n");
}

export function findCompletedSearchScope(
  results: ToolExecutionResult[],
): SelectedSearchScope | undefined {
  let selectedScope: SelectedSearchScope | undefined;
  for (const result of results) {
    if (
      result.status === "completed" &&
      result.toolCall.function.name === SEARCH_SCOPE_TOOL_NAME
    ) {
      const scope = result.args?.scope;
      if (isSelectedSearchScope(scope)) {
        selectedScope = scope;
      }
      continue;
    }
    selectedScope = advanceSearchScopeAfterResults(selectedScope, [result]);
  }
  return selectedScope;
}

export function hasScholarlyThenWebSearchScope(
  results: ToolExecutionResult[],
): boolean {
  return results.some(
    (result) =>
      result.status === "completed" &&
      result.toolCall.function.name === SEARCH_SCOPE_TOOL_NAME &&
      result.args?.scope === "scholarly_then_web",
  );
}

export function advanceSearchScopeAfterResults(
  scope: SelectedSearchScope | undefined,
  results: ToolExecutionResult[],
): SelectedSearchScope | undefined {
  if (scope !== "scholarly_then_web") {
    return scope;
  }
  const scholarlyAttemptFinished = results.some((result) => {
    if (result.toolCall.function.name !== "search_scholarly_sources") {
      return false;
    }
    if (result.status === "completed") {
      return true;
    }
    if (result.status !== "failed") {
      return false;
    }
    const category = parseToolError(result.content)?.category;
    return (
      category === "not_found" ||
      category === "unavailable" ||
      category === "execution_failed" ||
      category === "budget_exhausted"
    );
  });
  return scholarlyAttemptFinished ? "web_allowed" : scope;
}

export function executeSearchScopeSelection(
  toolCall: ToolCall,
  currentScope?: SelectedSearchScope,
): { result: ToolExecutionResult; selectedScope?: SelectedSearchScope } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.function.arguments || "{}");
  } catch {
    return {
      result: createFailedSelectionResult(
        toolCall,
        "Arguments must be valid JSON.",
        "argument_parse",
      ),
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      result: createFailedSelectionResult(
        toolCall,
        "Arguments must be a JSON object.",
        "argument_validation",
      ),
    };
  }

  const args = parsed as Record<string, unknown>;
  const scope = args.scope;
  const reason = args.reason;
  if (!isSelectedSearchScope(scope) || typeof reason !== "string") {
    return {
      result: createFailedSelectionResult(
        toolCall,
        "scope must be scholarly_only, scholarly_then_web, web_allowed, or no_external_search, and reason must be a string.",
        "argument_validation",
        args,
      ),
    };
  }

  if (currentScope) {
    return {
      result: {
        toolCall,
        args,
        status: "denied",
        policyTrace: [
          {
            stage: "planner",
            policy: "permission_decision",
            outcome: "blocked",
            summary:
              "Blocked an attempt to change the external-search scope after it was selected for this turn.",
          },
        ],
        content: formatToolError({
          summary: "External-search scope is already locked for this turn.",
          category: "permission_denied",
          retryable: false,
          cause:
            currentScope === scope
              ? `The scope ${currentScope} was already selected.`
              : `The current scope is ${currentScope}; it cannot be changed to ${scope}.`,
          suggestedFix:
            "Continue using only the search tools currently available, or answer without external search.",
        }),
      },
    };
  }

  return {
    selectedScope: scope,
    result: {
      toolCall,
      args: { scope, reason },
      status: "completed",
      content: formatSelectedScopeResult(scope, reason),
    },
  };
}

export function createUnavailableSearchToolResult(
  toolCall: ToolCall,
): ToolExecutionResult {
  return {
    toolCall,
    status: "denied",
    policyTrace: [
      {
        stage: "planner",
        policy: "permission_decision",
        outcome: "blocked",
        summary:
          "Blocked a search-related tool that was not available in the current search-scope state.",
      },
    ],
    content: formatToolError({
      summary: `Tool ${toolCall.function.name} is not available in the current search scope.`,
      category: "permission_denied",
      retryable: true,
      cause:
        "The model requested a search-related tool that was not included in this model round.",
      suggestedFix:
        toolCall.function.name === SEARCH_SCOPE_TOOL_NAME
          ? "Continue with the already selected search scope."
          : `Call ${SEARCH_SCOPE_TOOL_NAME} first if it is available, then use only the search tools exposed in the following round.`,
    }),
  };
}

function isSelectedSearchScope(value: unknown): value is SelectedSearchScope {
  return (
    value === "scholarly_only" ||
    value === "scholarly_then_web" ||
    value === "web_allowed" ||
    value === "no_external_search"
  );
}

function createFailedSelectionResult(
  toolCall: ToolCall,
  cause: string,
  policy: "argument_parse" | "argument_validation",
  args?: Record<string, unknown>,
): ToolExecutionResult {
  return {
    toolCall,
    args,
    status: "failed",
    policyTrace: [
      {
        stage: "planner",
        policy,
        outcome: "blocked",
        summary: "Invalid external-search scope selection.",
      },
    ],
    content: formatToolError({
      summary: "Invalid external-search scope selection.",
      category: "invalid_arguments",
      retryable: true,
      cause,
      suggestedFix:
        "Retry select_search_scope with a valid scope and a short reason grounded in the latest user request.",
    }),
    error: cause,
  };
}

function formatSelectedScopeResult(
  scope: SelectedSearchScope,
  reason: string,
): string {
  const availability =
    scope === "scholarly_only"
      ? "Only local Google Scholar and OpenAlex search may be exposed. Ordinary or vendor-hosted web search is prohibited."
      : scope === "scholarly_then_web"
        ? "Local Google Scholar and OpenAlex search is exposed first. Ordinary or vendor-hosted web search remains hidden until a scholarly-search attempt completes, then may be used only as the requested fallback."
        : scope === "web_allowed"
          ? "Scholarly search and ordinary or vendor-hosted web search may be exposed. Prefer scholarly search for papers and citations. If the user requested ordinary web search as a fallback, continue with web_search after scholarly search returns no useful results instead of ending the task."
          : "No external search tool may be exposed. Use only the current PDF and Zotero library evidence.";
  return [
    `External-search scope selected for the current user turn: ${scope}.`,
    availability,
    `Reason: ${reason.trim() || "No reason provided."}`,
    "This selection expires when the next user turn begins.",
  ].join("\n");
}
