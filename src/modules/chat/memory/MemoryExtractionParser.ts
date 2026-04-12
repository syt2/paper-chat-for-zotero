import type { MemoryCategory } from "./MemoryTypes";

const VALID_CATEGORIES: MemoryCategory[] = [
  "preference",
  "decision",
  "entity",
  "fact",
  "other",
];

export interface ExtractedMemoryEntry {
  text: string;
  category: MemoryCategory;
  importance: number;
}

export type MemoryExtractionParseResult =
  | {
      ok: true;
      entries: ExtractedMemoryEntry[];
    }
  | {
      ok: false;
      reason: "no_json_array" | "invalid_json_array" | "not_array";
    };

function normalizeMemoryEntry(entry: unknown): ExtractedMemoryEntry | null {
  if (typeof entry !== "object" || entry === null) return null;

  const text =
    typeof (entry as { text?: unknown }).text === "string"
      ? (entry as { text: string }).text.trim()
      : "";
  if (!text) return null;

  const rawCategory =
    typeof (entry as { category?: unknown }).category === "string"
      ? ((entry as { category: string }).category as MemoryCategory)
      : "other";
  const category = VALID_CATEGORIES.includes(rawCategory)
    ? rawCategory
    : "other";

  const rawImportance = (entry as { importance?: unknown }).importance;
  const importance =
    typeof rawImportance === "number"
      ? Math.max(0, Math.min(1, rawImportance))
      : 0.6;

  return {
    text,
    category,
    importance,
  };
}

function normalizeMemoryEntries(entries: unknown[]): ExtractedMemoryEntry[] {
  return entries
    .map(normalizeMemoryEntry)
    .filter((entry): entry is ExtractedMemoryEntry => entry !== null);
}

export function parseMemoryExtractionResponse(
  response: string,
): MemoryExtractionParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.trim());
  } catch {
    const match = response.match(/\[[\s\S]*?\]/);
    if (!match) {
      return { ok: false, reason: "no_json_array" };
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return { ok: false, reason: "invalid_json_array" };
    }
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "not_array" };
  }

  return {
    ok: true,
    entries: normalizeMemoryEntries(parsed),
  };
}
