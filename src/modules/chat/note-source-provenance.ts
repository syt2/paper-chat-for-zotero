import type { ToolExecutionResult } from "../../types/tool";

const NOTE_KEY_PATTERN = /^[A-Z0-9]{8}$/;
const NOTE_RESULT_PATTERN =
  /^Note (?:created|appended) successfully!\s*\nNote key:\s*([A-Z0-9]{8})(?:\s|$)/;
const TRUSTED_NOTE_TOOLS = new Set(["create_note", "append_to_note"]);

function getAttribute(attrs: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = attrs.match(
    new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"),
  );
  return match?.[1] || match?.[2] || undefined;
}

export function collectTrustedGeneratedNoteKeys(
  results: ToolExecutionResult[],
): Set<string> {
  const keys = new Set<string>();
  for (const result of results) {
    if (
      result.status !== "completed" ||
      !TRUSTED_NOTE_TOOLS.has(result.toolCall.function.name)
    ) {
      continue;
    }
    const key = result.content.match(NOTE_RESULT_PATTERN)?.[1];
    if (key && NOTE_KEY_PATTERN.test(key)) {
      keys.add(key);
    }
  }
  return keys;
}

export function sanitizeNoteSourceGroupKeys(
  content: string,
  trustedNoteKeys: ReadonlySet<string>,
): string {
  const openingTagPattern = /<source-group\b/gi;
  let sanitized = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = openingTagPattern.exec(content)) !== null) {
    sanitized += content.slice(cursor, match.index);
    const tagEnd = findOpeningTagEnd(content, openingTagPattern.lastIndex);
    if (tagEnd === null) {
      return sanitized + content.slice(match.index);
    }
    if (tagEnd < 0) {
      const nextTagStart = -tagEnd - 1;
      sanitized += content.slice(match.index, nextTagStart);
      cursor = nextTagStart;
      openingTagPattern.lastIndex = nextTagStart;
      continue;
    }

    const attrs = content.slice(openingTagPattern.lastIndex, tagEnd);
    const type = getAttribute(attrs, "type")?.trim().toLowerCase();
    const rawKey = getAttribute(attrs, "key")?.trim().toUpperCase();
    const attrsWithoutKey = attrs.replace(
      /\s+key\s*=\s*(?:"[^"]*"|'[^']*')/gi,
      "",
    );
    const trustedKey =
      type === "note" &&
      rawKey &&
      NOTE_KEY_PATTERN.test(rawKey) &&
      trustedNoteKeys.has(rawKey)
        ? rawKey
        : null;
    sanitized += `<source-group${attrsWithoutKey}${trustedKey ? ` key="${trustedKey}"` : ""}>`;
    cursor = tagEnd + 1;
    openingTagPattern.lastIndex = cursor;
  }

  return sanitized + content.slice(cursor);
}

function findOpeningTagEnd(content: string, start: number): number | null {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") {
      return index;
    }
    if (char === "<") {
      return -(index + 1);
    }
  }
  return null;
}
