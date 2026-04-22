const COMMON_ALIASES: Record<string, string> = {
  item_key: "itemKey",
  itemkey: "itemKey",
  note_key: "noteKey",
  notekey: "noteKey",
};

const TOOL_SPECIFIC_ALIASES: Record<string, Record<string, string>> = {
  web_search: {
    maxResults: "max_results",
    includeContent: "include_content",
    domainFilter: "domain_filter",
    domains: "domain_filter",
    provider: "source",
    searchIntent: "intent",
    yearFrom: "year_from",
    yearTo: "year_to",
    openAccessOnly: "open_access_only",
    seedTitle: "seed_title",
    seedDoi: "seed_doi",
    seedPaperId: "seed_paper_id",
  },
  list_all_items: {
    page_size: "pageSize",
    has_pdf: "hasPdf",
  },
  get_annotations: {
    annotation_type: "annotationType",
    selected_only: "selectedOnly",
    include_position: "includePosition",
  },
  get_collections: {
    parent_key: "parentKey",
  },
  get_collection_items: {
    collection_key: "collectionKey",
  },
  get_paper_section: {
    section_name: "section",
    sectionName: "section",
    name: "section",
  },
  get_pages: {
    page_range: "pages",
    pageRange: "pages",
  },
  search_with_regex: {
    regex: "pattern",
  },
  add_item: {
    collectionKey: "collection_key",
  },
};

const BOOLEAN_KEYS = new Set([
  "hasPdf",
  "selectedOnly",
  "includePosition",
  "include_content",
  "open_access_only",
]);

const NUMBER_KEYS = new Set([
  "page",
  "pageSize",
  "limit",
  "days",
  "max_results",
  "importance",
  "year_from",
  "year_to",
]);

const STRING_ARRAY_KEYS = new Set(["domain_filter"]);
const CSV_STRING_KEYS = new Set(["tags", "addTags", "removeTags"]);

export function preflightToolArguments(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = renameAliases(toolName, args);
  applyToolSpecificRepairs(toolName, normalized);

  for (const key of BOOLEAN_KEYS) {
    coerceBooleanArg(normalized, key);
  }
  for (const key of NUMBER_KEYS) {
    coerceNumberArg(normalized, key);
  }
  for (const key of STRING_ARRAY_KEYS) {
    coerceStringArrayArg(normalized, key);
  }
  for (const key of CSV_STRING_KEYS) {
    coerceCsvStringArg(normalized, key);
  }

  return normalized;
}

function renameAliases(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...args };
  const aliasMap = {
    ...COMMON_ALIASES,
    ...(TOOL_SPECIFIC_ALIASES[toolName] || {}),
  };

  for (const [alias, canonical] of Object.entries(aliasMap)) {
    if (!(alias in normalized)) {
      continue;
    }
    if (!(canonical in normalized)) {
      normalized[canonical] = normalized[alias];
    }
    if (alias !== canonical) {
      delete normalized[alias];
    }
  }

  return normalized;
}

function applyToolSpecificRepairs(
  toolName: string,
  args: Record<string, unknown>,
): void {
  switch (toolName) {
    case "create_note":
      moveIfMissing(args, "content", ["text", "body", "note"]);
      break;
    case "save_memory":
      moveIfMissing(args, "text", ["content", "memory"]);
      break;
    case "add_item":
      moveIfMissing(args, "identifier", [
        "doi",
        "isbn",
        "pmid",
        "arxiv",
        "arxivId",
      ]);
      break;
  }
}

function moveIfMissing(
  args: Record<string, unknown>,
  targetKey: string,
  candidates: string[],
): void {
  if (typeof args[targetKey] === "string" && args[targetKey]) {
    return;
  }

  for (const candidate of candidates) {
    const value = args[candidate];
    if (typeof value === "string" && value.trim()) {
      args[targetKey] = value;
      delete args[candidate];
      return;
    }
  }
}

function coerceBooleanArg(args: Record<string, unknown>, key: string): void {
  const value = args[key];
  if (typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (value === 1) {
      args[key] = true;
    } else if (value === 0) {
      args[key] = false;
    }
    return;
  }
  if (typeof value !== "string") {
    return;
  }

  const normalizedValue = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalizedValue)) {
    args[key] = true;
    return;
  }
  if (["false", "0", "no"].includes(normalizedValue)) {
    args[key] = false;
  }
}

function coerceNumberArg(args: Record<string, unknown>, key: string): void {
  const value = args[key];
  if (typeof value === "number") {
    return;
  }
  if (typeof value !== "string") {
    return;
  }

  const trimmed = value.trim();
  if (!trimmed || !/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return;
  }

  const parsed = Number(trimmed);
  if (Number.isFinite(parsed)) {
    args[key] = parsed;
  }
}

function coerceStringArrayArg(
  args: Record<string, unknown>,
  key: string,
): void {
  const normalized = normalizeStringArray(args[key]);
  if (!normalized) {
    return;
  }
  args[key] = normalized;
}

function normalizeStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) =>
        typeof entry === "string" || typeof entry === "number"
          ? String(entry).trim()
          : "",
      )
      .filter(Boolean);
    return normalized.length > 0 ? normalized : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      return normalizeStringArray(parsed);
    } catch {
      // Fall through to plain string splitting.
    }
  }

  return trimmed
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function coerceCsvStringArg(args: Record<string, unknown>, key: string): void {
  const value = args[key];
  if (!Array.isArray(value)) {
    return;
  }

  const normalized = value
    .map((entry) =>
      typeof entry === "string" || typeof entry === "number"
        ? String(entry).trim()
        : "",
    )
    .filter(Boolean);
  if (normalized.length > 0) {
    args[key] = normalized.join(", ");
  }
}
