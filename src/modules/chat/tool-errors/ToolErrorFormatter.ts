import type {
  ToolCall,
  ToolPermissionDecision,
} from "../../../types/tool";

export type ToolErrorCategory =
  | "invalid_arguments"
  | "permission_denied"
  | "budget_exhausted"
  | "evidence_required"
  | "missing_context"
  | "not_found"
  | "unavailable"
  | "unknown_tool"
  | "execution_failed";

export interface ParsedToolError {
  summary: string;
  category?: ToolErrorCategory;
  retryable?: boolean;
  cause?: string;
  suggestedFix?: string;
  saferAlternative?: string;
}

interface FormatToolErrorOptions {
  summary: string;
  category: ToolErrorCategory;
  retryable: boolean;
  cause?: string;
  suggestedFix?: string;
  saferAlternative?: string;
}

const FIX_HINT_LABEL = "Fix hint: ";
const LEGACY_FIX_HINT_LABEL = "Suggested fix: ";
const ALTERNATIVE_LABEL = "Alternative: ";
const LEGACY_ALTERNATIVE_LABEL = "Safer alternative: ";

function stripErrorPrefix(message: string): string {
  return message.replace(/^Error:\s*/i, "").trim();
}

function isStructuredToolErrorContent(content: string): boolean {
  return /^Error:\s+/m.test(content) && /^Category:\s+/m.test(content);
}

function extractRequiredHint(message: string): string | null {
  const match = message.match(/Required:\s*(.+)$/i);
  return match?.[1]?.trim() || null;
}

function formatRetryable(retryable: boolean): string {
  return retryable ? "yes" : "no";
}

function inferToolError(
  toolName: string,
  rawMessage: string,
): FormatToolErrorOptions {
  const message = stripErrorPrefix(rawMessage);
  const requiredHint = extractRequiredHint(message);

  if (/^Invalid arguments JSON:/i.test(message)) {
    return {
      summary: `Invalid arguments for ${toolName}.`,
      category: "invalid_arguments",
      retryable: true,
      cause: message,
      suggestedFix:
        "Retry with a valid JSON object that matches the tool schema.",
      saferAlternative: "Send only the required fields first.",
    };
  }

  if (/^Invalid arguments for /i.test(message)) {
    return {
      summary: `Invalid arguments for ${toolName}.`,
      category: "invalid_arguments",
      retryable: true,
      cause: message,
      suggestedFix: requiredHint
        ? `Retry ${toolName} with ${requiredHint}.`
        : `Retry ${toolName} with the required fields and correct value types.`,
      saferAlternative: "Use a narrower tool call with fewer arguments.",
    };
  }

  if (
    /Permission denied/i.test(message) ||
    /requires approval/i.test(message) ||
    /no approval channel/i.test(message)
  ) {
    return {
      summary: `Permission denied for ${toolName}.`,
      category: "permission_denied",
      retryable: false,
      cause: message,
      suggestedFix:
        "Do not retry this tool in the current turn unless the user changes approval.",
      saferAlternative:
        "Continue with lower-risk read-only tools or explain the limitation.",
    };
  }

  if (
    /budget exhausted/i.test(message) ||
    /high-cost tool limit/i.test(message) ||
    /similar web_search query already used/i.test(message)
  ) {
    return {
      summary: `Tool budget exhausted for ${toolName}.`,
      category: "budget_exhausted",
      retryable: false,
      cause: message,
      suggestedFix:
        toolName === "get_full_text"
          ? "Use the full-text result already gathered in this turn, or wait for a new user turn before requesting full text again."
          : "Use the existing search results, narrow the question, or wait for a new user turn before searching again.",
      saferAlternative:
        toolName === "web_search"
          ? "Use Zotero library tools or synthesize from results already gathered in this turn."
          : "Use targeted section, page, metadata, notes, or annotation tools instead of full text.",
    };
  }

  if (
    /additional evidence required/i.test(message) ||
    /repeated full-text fetches need narrower evidence/i.test(message) ||
    /requires narrower paper evidence/i.test(message)
  ) {
    return {
      summary: `Additional evidence required for ${toolName}.`,
      category: "evidence_required",
      retryable: false,
      cause: message,
      suggestedFix:
        "Use a narrower paper tool for the same target first, then retry only if full text is still necessary.",
      saferAlternative:
        "Continue with section, page, outline, metadata, notes, or annotation tools instead of another full-text fetch.",
    };
  }

  if (
    /No item specified/i.test(message) ||
    /No paper content available/i.test(message) ||
    /Could not extract PDF content/i.test(message) ||
    /Make sure a PDF is open/i.test(message)
  ) {
    return {
      summary: `Required paper context is unavailable for ${toolName}.`,
      category: "missing_context",
      retryable: true,
      cause: message,
      suggestedFix:
        "Retry with a valid itemKey, or open the relevant PDF if the tool depends on the active reader.",
      saferAlternative:
        "Use metadata, notes, or library search tools that do not require full PDF text.",
    };
  }

  if (/not found/i.test(message)) {
    return {
      summary: `Requested resource for ${toolName} was not found.`,
      category: "not_found",
      retryable: true,
      cause: message,
      suggestedFix:
        "Retry with a valid Zotero key, collection key, note key, or identifier.",
      saferAlternative:
        "Discover valid targets first with list or search tools before retrying.",
    };
  }

  if (/^Unknown tool:/i.test(message)) {
    return {
      summary: `${toolName} is not an available tool.`,
      category: "unknown_tool",
      retryable: false,
      cause: message,
      suggestedFix: "Choose a tool from the advertised tool list.",
    };
  }

  return {
    summary: `Tool execution failed for ${toolName}.`,
    category: "execution_failed",
    retryable: true,
    cause: message,
    suggestedFix:
      "Adjust the arguments or switch to a narrower tool before retrying.",
    saferAlternative:
      "Continue with successful tool outputs if they already answer the question.",
  };
}

export function formatToolError(options: FormatToolErrorOptions): string {
  const lines = [
    `Error: ${options.summary}`,
    `Category: ${options.category}`,
    `Retryable: ${formatRetryable(options.retryable)}`,
  ];

  if (options.cause) {
    lines.push(`Cause: ${options.cause}`);
  }
  if (options.suggestedFix) {
    lines.push(`${FIX_HINT_LABEL}${options.suggestedFix}`);
  }
  if (options.saferAlternative) {
    lines.push(`${ALTERNATIVE_LABEL}${options.saferAlternative}`);
  }

  return lines.join("\n");
}

export function parseToolError(content: string): ParsedToolError | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const result: ParsedToolError = {
    summary: "",
  };

  for (const line of lines) {
    if (line.startsWith("Error: ")) {
      result.summary = line.slice("Error: ".length).trim();
      continue;
    }
    if (line.startsWith("Category: ")) {
      result.category = line.slice("Category: ".length).trim() as ToolErrorCategory;
      continue;
    }
    if (line.startsWith("Retryable: ")) {
      result.retryable =
        line.slice("Retryable: ".length).trim().toLowerCase() === "yes";
      continue;
    }
    if (line.startsWith("Cause: ")) {
      result.cause = line.slice("Cause: ".length).trim();
      continue;
    }
    if (
      line.startsWith(FIX_HINT_LABEL) ||
      line.startsWith(LEGACY_FIX_HINT_LABEL)
    ) {
      result.suggestedFix = line
        .slice(
          line.startsWith(FIX_HINT_LABEL)
            ? FIX_HINT_LABEL.length
            : LEGACY_FIX_HINT_LABEL.length,
        )
        .trim();
      continue;
    }
    if (
      line.startsWith(ALTERNATIVE_LABEL) ||
      line.startsWith(LEGACY_ALTERNATIVE_LABEL)
    ) {
      result.saferAlternative = line
        .slice(
          line.startsWith(ALTERNATIVE_LABEL)
            ? ALTERNATIVE_LABEL.length
            : LEGACY_ALTERNATIVE_LABEL.length,
        )
        .trim();
    }
  }

  if (result.summary) {
    return result;
  }

  if (/^Error:\s+/i.test(trimmed)) {
    return {
      summary: stripErrorPrefix(trimmed.split(/\r?\n/, 1)[0]),
      cause: stripErrorPrefix(trimmed),
    };
  }

  return null;
}

export function normalizeToolErrorContent(
  toolName: string,
  rawContent: string,
): { content: string; parsed: ParsedToolError } {
  if (isStructuredToolErrorContent(rawContent)) {
    const parsed = parseToolError(rawContent) || {
      summary: stripErrorPrefix(rawContent),
    };
    if (parsed.category && typeof parsed.retryable === "boolean") {
      return {
        content: formatToolError({
          summary: parsed.summary,
          category: parsed.category,
          retryable: parsed.retryable,
          cause: parsed.cause,
          suggestedFix: parsed.suggestedFix,
          saferAlternative: parsed.saferAlternative,
        }),
        parsed,
      };
    }
    return {
      content: rawContent,
      parsed,
    };
  }

  const formatted = inferToolError(toolName, rawContent);
  return {
    content: formatToolError(formatted),
    parsed: {
      summary: formatted.summary,
      category: formatted.category,
      retryable: formatted.retryable,
      cause: formatted.cause,
      suggestedFix: formatted.suggestedFix,
      saferAlternative: formatted.saferAlternative,
    },
  };
}

export function formatToolArgumentParseError(
  toolCall: ToolCall,
  cause: string,
): string {
  return formatToolError({
    summary: `Invalid arguments for ${toolCall.function.name}.`,
    category: "invalid_arguments",
    retryable: true,
    cause,
    suggestedFix:
      "Retry with a valid JSON object that matches the tool schema for this tool.",
    saferAlternative: "Send only the required fields first.",
  });
}

export function formatDeniedToolResult(
  decision: ToolPermissionDecision,
): string {
  return formatToolError({
    summary: `Permission denied for ${decision.descriptor.name}.`,
    category: "permission_denied",
    retryable: false,
    cause:
      decision.reason ||
      `Tool ${decision.descriptor.name} was blocked by the current permission policy.`,
    suggestedFix:
      "Do not retry this tool in the current turn unless the user changes approval.",
    saferAlternative:
      "Continue with lower-risk tools or explain what evidence is still missing.",
  });
}
