import type { ChatMessage } from "../../../types/chat";
import type { ToolExecutionResult } from "../../../types/tool";
import type { ToolErrorCategory, ParsedToolError } from "../tool-errors/ToolErrorFormatter";
import { parseToolError } from "../tool-errors/ToolErrorFormatter";

export interface ToolRecoveryDirective {
  toolName: string;
  status: ToolExecutionResult["status"];
  category: ToolErrorCategory | "unspecified";
  summary: string;
  immediateAction: string;
  planningInstruction: string;
  alternative?: string;
  recommendedTools: string[];
}

export function getRecoveryDirective(
  result: ToolExecutionResult,
): ToolRecoveryDirective {
  const parsed = parseToolError(result.content);
  const category = deriveRecoveryCategory(result, parsed);
  const toolName = result.toolCall.function.name;
  const summary =
    parsed?.summary ||
    result.permissionDecision?.reason ||
    result.error ||
    "Tool call did not complete successfully.";

  const fallbackAlternative =
    parsed?.saferAlternative || getDefaultAlternative(category, toolName);

  const base = getDirectiveTemplate(category, toolName, parsed);

  return {
    toolName,
    status: result.status,
    category,
    summary,
    immediateAction: base.immediateAction,
    planningInstruction: base.planningInstruction,
    alternative: fallbackAlternative,
    recommendedTools: getRecommendedTools(category, toolName),
  };
}

export function summarizeRecoveryDirectives(
  results: ToolExecutionResult[],
  limit: number = 3,
): string[] {
  return results
    .filter((result) => result.status === "failed" || result.status === "denied")
    .slice(-limit)
    .map((result) => {
      const directive = getRecoveryDirective(result);
      const suggestedTools =
        directive.recommendedTools.length > 0
          ? ` | tools=${directive.recommendedTools.join(", ")}`
          : "";
      return `- [${directive.status}] ${directive.toolName} | category=${directive.category} | next=${directive.immediateAction}${suggestedTools}`;
    });
}

export function formatRecoveryNotice(results: ToolExecutionResult[]): string | null {
  const affectedResults = results.filter(
    (result) => result.status === "failed" || result.status === "denied",
  );
  if (affectedResults.length === 0) {
    return null;
  }

  const directives = affectedResults.map((result) => getRecoveryDirective(result));
  const groupedInstructions = dedupeStrings(
    directives.map((directive) => directive.planningInstruction),
  );

  const lines = [
    "Tool recovery notice:",
    "The following tool calls did not complete successfully in this turn.",
    ...directives.map((directive) => formatDirectiveLine(directive)),
    "Replanning rules:",
    ...groupedInstructions.map((instruction) => `- ${instruction}`),
    "Use successful tool outputs from this turn as ground truth, and state any remaining evidence gaps explicitly.",
  ];

  return lines.join("\n");
}

export function createRecoveryGuidanceSystemMessage(
  results: ToolExecutionResult[],
  generateId: () => string,
  timestamp: number = Date.now(),
): ChatMessage | null {
  const notice = formatRecoveryNotice(results);
  if (!notice) {
    return null;
  }

  return {
    id: generateId(),
    role: "system",
    content: notice,
    timestamp,
  };
}

export function deriveRecoveryCategory(
  result: ToolExecutionResult,
  parsed?: ParsedToolError | null,
): ToolErrorCategory | "unspecified" {
  if (
    result.status === "denied" ||
    result.permissionDecision?.verdict === "deny"
  ) {
    return "permission_denied";
  }

  if (parsed?.category === "budget_exhausted") {
    return "budget_exhausted";
  }

  return parsed?.category || "unspecified";
}

function formatDirectiveLine(directive: ToolRecoveryDirective): string {
  const parts = [
    `- [${directive.status}] ${directive.toolName}`,
    `(category: ${directive.category})`,
    directive.summary,
    `Next: ${directive.immediateAction}`,
  ];
  if (directive.alternative) {
    parts.push(`Alternative: ${directive.alternative}`);
  }
  if (directive.recommendedTools.length > 0) {
    parts.push(`Suggested tools: ${directive.recommendedTools.join(", ")}`);
  }
  return parts.join(" ");
}

function getDirectiveTemplate(
  category: ToolErrorCategory | "unspecified",
  toolName: string,
  parsed?: ParsedToolError | null,
): {
  immediateAction: string;
  planningInstruction: string;
} {
  switch (category) {
    case "invalid_arguments":
      return {
        immediateAction:
          parsed?.suggestedFix ||
          `Retry ${toolName} with only the required fields and correct value types.`,
        planningInstruction:
          "For invalid arguments, inspect the tool schema, simplify the payload, and retry only with corrected arguments.",
      };
    case "permission_denied":
      return {
        immediateAction:
          "Do not retry this tool in the current turn. Switch to lower-risk tools or explain the limitation.",
        planningInstruction:
          "For denied tools, do not repeat the call unless the user changes approval. Replan around read-only or already-allowed tools.",
      };
    case "budget_exhausted":
      return {
        immediateAction:
          toolName === "get_full_text"
            ? "Do not call get_full_text again in this turn. Use narrower paper tools or the evidence already collected."
            : "Do not spend more web-search budget in this turn. Use the results already gathered or pivot to local tools.",
        planningInstruction:
          "For budget-exhausted tools, treat the runtime limit as final for this turn. Replan with narrower or cheaper tools instead of retrying.",
      };
    case "missing_context":
      return {
        immediateAction:
          parsed?.suggestedFix ||
          "Acquire the required paper context first by supplying itemKey, opening the relevant PDF, or switching to reader-independent tools.",
        planningInstruction:
          "For missing context, first fetch or establish the missing target context before retrying. Prefer metadata, notes, or search tools if they can answer the request without full PDF access.",
      };
    case "not_found":
      return {
        immediateAction:
          "Discover valid Zotero keys or identifiers first, then retry with the resolved target.",
        planningInstruction:
          "For not-found errors, use discovery tools such as list/search tools to resolve a valid target before retrying.",
      };
    case "unavailable":
      return {
        immediateAction:
          "Treat this tool as unavailable for the current settings. Continue without it unless the user explicitly enables it.",
        planningInstruction:
          "For unavailable tools, stop retrying in this turn and pivot to tools that are currently enabled.",
      };
    case "unknown_tool":
      return {
        immediateAction:
          "Choose a tool from the advertised tool list instead of retrying the unknown name.",
        planningInstruction:
          "For unknown tools, select one of the actually available tools and restate the plan using those capabilities.",
      };
    case "execution_failed":
    case "unspecified":
    default:
      return {
        immediateAction:
          parsed?.suggestedFix ||
          "If you retry, materially change the arguments or choose a narrower tool.",
        planningInstruction:
          "For generic execution failures, avoid repeating the same call unchanged. Retry only with a materially different request or continue with other evidence.",
      };
  }
}

function getDefaultAlternative(
  category: ToolErrorCategory | "unspecified",
  toolName: string,
): string | undefined {
  switch (category) {
    case "permission_denied":
      return "Continue with lower-risk read-only tools.";
    case "budget_exhausted":
      return toolName === "web_search"
        ? "Use Zotero library tools or the current-turn web results instead of another search."
        : "Use narrower paper tools or synthesize from the evidence already gathered.";
    case "missing_context":
      return "Use metadata, notes, annotations, or library search first.";
    case "not_found":
      return "Resolve the target with list/search tools before acting on it.";
    case "unavailable":
      return toolName === "web_search"
        ? "Use Zotero library tools instead of external web search."
        : "Use another enabled read-only tool.";
    case "invalid_arguments":
      return "Start from a minimal valid payload.";
    case "unknown_tool":
      return "Use one of the tools listed in the current prompt.";
    case "execution_failed":
    case "unspecified":
    default:
      return "Continue with successful tool outputs if they already answer the question.";
  }
}

function getRecommendedTools(
  category: ToolErrorCategory | "unspecified",
  toolName: string,
): string[] {
  switch (category) {
    case "missing_context":
      return dedupeStrings([
        ...getReaderIndependentFallbacks(toolName),
        "get_item_metadata",
        "get_item_notes",
        "search_items",
        "list_all_items",
      ]);
    case "not_found":
      return dedupeStrings([
        "search_items",
        "list_all_items",
        "get_collections",
        "get_collection_items",
        "search_notes",
      ]);
    case "permission_denied":
      return dedupeStrings([
        ...getReadOnlyNeighborTools(toolName),
        "get_item_metadata",
        "get_item_notes",
      ]);
    case "budget_exhausted":
      return toolName === "web_search"
        ? ["search_items", "search_notes", "list_all_items"]
        : dedupeStrings([
            ...getReaderIndependentFallbacks(toolName),
            "get_paper_section",
            "search_paper_content",
            "get_pages",
            "get_item_metadata",
            "get_item_notes",
          ]);
    case "unavailable":
      return toolName === "web_search"
        ? ["search_items", "search_notes", "list_all_items"]
        : dedupeStrings([...getReadOnlyNeighborTools(toolName), "list_all_items"]);
    case "unknown_tool":
      return ["search_items", "get_item_metadata", "list_all_items"];
    case "execution_failed":
    case "unspecified":
      return getReadOnlyNeighborTools(toolName);
    case "invalid_arguments":
    default:
      return [];
  }
}

function getReaderIndependentFallbacks(toolName: string): string[] {
  switch (toolName) {
    case "get_full_text":
    case "get_paper_section":
    case "search_paper_content":
    case "get_pages":
    case "get_outline":
    case "list_sections":
    case "search_with_regex":
    case "get_page_count":
      return ["get_item_metadata", "get_item_notes", "get_annotations"];
    case "get_pdf_selection":
      return ["get_item_metadata", "get_item_notes", "get_annotations"];
    default:
      return [];
  }
}

function getReadOnlyNeighborTools(toolName: string): string[] {
  switch (toolName) {
    case "create_note":
      return ["get_item_metadata", "get_item_notes", "get_note_content"];
    case "batch_update_tags":
      return ["get_tags", "search_by_tag", "search_items"];
    case "add_item":
      return ["search_items", "list_all_items", "get_collections"];
    case "save_memory":
      return ["get_item_metadata", "get_item_notes", "search_notes"];
    case "web_search":
      return ["search_items", "search_notes", "list_all_items"];
    default:
      return [];
  }
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}
