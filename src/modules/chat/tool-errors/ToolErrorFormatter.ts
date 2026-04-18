import type {
  ToolCall,
  ToolPermissionDecision,
} from "../../../types/tool";

export type ToolErrorCategory =
  | "invalid_arguments"
  | "confirmation_required"
  | "permission_denied"
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

  if (/set confirm\s*=\s*true/i.test(message)) {
    return {
      summary: `${toolName} requires explicit confirmation.`,
      category: "confirmation_required",
      retryable: true,
      cause: message,
      suggestedFix:
        "Retry with confirm set to the boolean value true, not a string.",
      saferAlternative:
        "Use targeted tools such as get_paper_section, get_pages, or search_paper_content first.",
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
    /disabled in settings/i.test(message) ||
    /AI write operations are disabled/i.test(message)
  ) {
    return {
      summary: `${toolName} is unavailable in the current settings.`,
      category: "unavailable",
      retryable: false,
      cause: message,
      suggestedFix:
        "Continue without this tool unless the user explicitly enables it.",
      saferAlternative:
        toolName === "web_search"
          ? "Use Zotero library tools instead of external web search."
          : "Use read-only tools that do not mutate Zotero state.",
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
    lines.push(`Suggested fix: ${options.suggestedFix}`);
  }
  if (options.saferAlternative) {
    lines.push(`Safer alternative: ${options.saferAlternative}`);
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
    if (line.startsWith("Suggested fix: ")) {
      result.suggestedFix = line.slice("Suggested fix: ".length).trim();
      continue;
    }
    if (line.startsWith("Safer alternative: ")) {
      result.saferAlternative = line
        .slice("Safer alternative: ".length)
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
