import type { ToolSourceReference, ToolCall } from "../../../types/tool";
import { normalizeSourceUrl } from "../note-source-provenance";

const ZOTERO_KEY_PATTERN = /^[A-Z0-9]{8}$/;
const PDF_ITEM_TOOLS = new Set([
  "get_paper_section",
  "search_paper_content",
  "get_paper_metadata",
  "get_pages",
  "get_page_count",
  "search_with_regex",
  "get_outline",
  "list_sections",
  "get_full_text",
]);
const PAGE_BEARING_TOOLS = new Set([
  "get_pages",
  "search_paper_content",
  "search_with_regex",
  "get_outline",
  "list_sections",
  "get_annotations",
]);
const ITEM_LIST_TOOLS = new Set([
  "list_all_items",
  "search_items",
  "get_collection_items",
  "search_by_tag",
  "get_recent",
]);

type ResolvedZoteroItem = Zotero.Item | null | undefined;

function normalizeZoteroKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const key = value.trim().toUpperCase();
  return ZOTERO_KEY_PATTERN.test(key) ? key : null;
}

function getUserLibraryID(): number | undefined {
  try {
    return typeof Zotero !== "undefined" &&
      typeof Zotero.Libraries?.userLibraryID === "number"
      ? Zotero.Libraries.userLibraryID
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `undefined` means the Zotero identity API is unavailable (for example in a
 * pure node unit test). `null` means Zotero was available and rejected the
 * identity. Production extraction therefore validates tool-formatted keys
 * against the library instead of trusting user-controlled titles/previews.
 */
function resolveZoteroItem(key: string): ResolvedZoteroItem {
  const libraryID = getUserLibraryID();
  try {
    if (
      libraryID === undefined ||
      typeof Zotero === "undefined" ||
      typeof Zotero.Items?.getByLibraryAndKey !== "function"
    ) {
      return undefined;
    }
    return Zotero.Items.getByLibraryAndKey(libraryID, key) || null;
  } catch {
    return null;
  }
}

function isNoteItem(item: ResolvedZoteroItem): boolean {
  return item !== undefined && item !== null && item.isNote?.() === true;
}

function isAnnotationItem(item: ResolvedZoteroItem): boolean {
  return item !== undefined && item !== null && item.isAnnotation?.() === true;
}

function isRegularSourceItem(item: ResolvedZoteroItem): boolean {
  return (
    item === undefined ||
    (item !== null && !isNoteItem(item) && !isAnnotationItem(item))
  );
}

function resolveCollectionLibraryID(key: string): number | null | undefined {
  const libraryID = getUserLibraryID();
  try {
    if (
      libraryID === undefined ||
      typeof Zotero === "undefined" ||
      typeof Zotero.Collections?.getByLibraryAndKey !== "function"
    ) {
      return undefined;
    }
    return Zotero.Collections.getByLibraryAndKey(libraryID, key)
      ? libraryID
      : null;
  } catch {
    return null;
  }
}

function referenceIdentity(reference: ToolSourceReference): string {
  switch (reference.type) {
    case "web":
      return `web:${reference.url}`;
    case "page":
      return `page:${reference.itemKey}:${reference.page}`;
    default:
      return `${reference.type}:${reference.key}`;
  }
}

function collectMatches(content: string, pattern: RegExp): string[] {
  const values: string[] = [];
  let match: RegExpExecArray | null;
  pattern.lastIndex = 0;
  while ((match = pattern.exec(content)) !== null) {
    if (match[1]) {
      values.push(match[1]);
    }
  }
  return values;
}

function extractFirstLineKey(content: string, label: string): string[] {
  const firstLineEnd = content.indexOf("\n");
  const firstLine = content
    .slice(0, firstLineEnd === -1 ? content.length : firstLineEnd)
    .replace(/\r$/, "");
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = firstLine.match(
    new RegExp(`^${escapedLabel}:[\\t ]*([A-Z0-9]{8})[\\t ]*$`, "i"),
  );
  return match?.[1] ? [match[1]] : [];
}

function extractItemListKeys(content: string): string[] {
  return collectMatches(
    content,
    /^[\t ]*\d+\.[\t ]+\[([A-Z0-9]{8})\](?=[\t ])/gim,
  );
}

function extractNoteListKeys(toolName: string, content: string): string[] {
  if (toolName === "get_item_notes") {
    return collectMatches(
      content,
      /^[\t ]*\[([A-Z0-9]{8})\][\t ]+\(Modified:/gim,
    );
  }
  if (toolName === "search_notes") {
    return collectMatches(
      content,
      /^[\t ]*\d+\.[\t ]+\[([A-Z0-9]{8})\](?=[\t (])/gim,
    );
  }
  return [];
}

function extractCollectionListKeys(content: string): string[] {
  return collectMatches(
    content,
    /^[\t ]*\[([A-Z0-9]{8})\][\t ]+[^\n]*\(\d+[\t ]+items?\)/gim,
  );
}

function extractWebResultUrls(content: string): string[] {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "Web source URLs:") {
    return [];
  }
  const urls: string[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "End web source URLs") {
      return urls;
    }
    const match = line.match(/^-\s+("(?:[^"\\]|\\.)*")$/);
    if (!match?.[1]) {
      return [];
    }
    try {
      const parsed = JSON.parse(match[1]);
      if (typeof parsed === "string") {
        urls.push(parsed);
      }
    } catch {
      return [];
    }
  }
  return [];
}

interface ExtractedAnnotation {
  key: string;
  page?: number;
}

interface ExtractedSourceReferences {
  pages: number[];
  annotations: ExtractedAnnotation[];
}

function extractSourceReferenceManifest(
  content: string,
): ExtractedSourceReferences {
  const lines = content.split("\n");
  const prefix = "Source references: ";
  if (!lines[1]?.startsWith(prefix)) {
    return { pages: [], annotations: [] };
  }

  try {
    const parsed = JSON.parse(lines[1].slice(prefix.length)) as {
      version?: unknown;
      pages?: unknown;
      annotations?: unknown;
    };
    if (parsed.version !== 1) {
      return { pages: [], annotations: [] };
    }
    const pages = Array.isArray(parsed.pages)
      ? parsed.pages.filter(
          (page): page is number =>
            typeof page === "number" && Number.isSafeInteger(page) && page > 0,
        )
      : [];
    const annotations: ExtractedAnnotation[] = [];
    if (Array.isArray(parsed.annotations)) {
      for (const value of parsed.annotations) {
        if (!value || typeof value !== "object") {
          continue;
        }
        const candidate = value as { key?: unknown; page?: unknown };
        const key = normalizeZoteroKey(candidate.key);
        if (!key) {
          continue;
        }
        const page = candidate.page;
        annotations.push({
          key,
          ...(typeof page === "number" && Number.isSafeInteger(page) && page > 0
            ? { page }
            : {}),
        });
      }
    }
    return { pages: Array.from(new Set(pages)), annotations };
  } catch {
    return { pages: [], annotations: [] };
  }
}

/**
 * Derive navigation identities from the scheduler's validated arguments and
 * the executor's raw response. Call this only for completed executions.
 */
export function deriveToolSourceReferences(
  toolCall: ToolCall,
  args: Record<string, unknown>,
  rawContent: string,
): ToolSourceReference[] {
  const toolName = toolCall.function.name;
  const references = new Map<string, ToolSourceReference>();

  const addReference = (reference: ToolSourceReference): void => {
    const identity = referenceIdentity(reference);
    const existing = references.get(identity);
    references.set(
      identity,
      existing ? { ...existing, ...reference } : reference,
    );
  };

  const addItem = (value: unknown): string | null => {
    const key = normalizeZoteroKey(value);
    if (!key) {
      return null;
    }
    const item = resolveZoteroItem(key);
    if (!isRegularSourceItem(item)) {
      return null;
    }
    addReference({
      type: "item",
      key,
      ...(typeof item?.libraryID === "number"
        ? { libraryID: item.libraryID }
        : {}),
    });
    return key;
  };

  const addNote = (value: unknown): string | null => {
    const key = normalizeZoteroKey(value);
    if (!key) {
      return null;
    }
    const item = resolveZoteroItem(key);
    if (item !== undefined && !isNoteItem(item)) {
      return null;
    }
    addReference({
      type: "note",
      key,
      ...(typeof item?.libraryID === "number"
        ? { libraryID: item.libraryID }
        : {}),
    });
    return key;
  };

  const addCollection = (value: unknown): string | null => {
    const key = normalizeZoteroKey(value);
    if (!key) {
      return null;
    }
    const libraryID = resolveCollectionLibraryID(key);
    if (libraryID === null) {
      return null;
    }
    addReference({
      type: "collection",
      key,
      ...(typeof libraryID === "number" ? { libraryID } : {}),
    });
    return key;
  };

  if (ITEM_LIST_TOOLS.has(toolName)) {
    for (const key of extractItemListKeys(rawContent)) {
      addItem(key);
    }
  }

  if (toolName === "get_item_metadata") {
    for (const key of extractFirstLineKey(rawContent, "Item Key")) {
      addItem(key);
    }
  }

  if (toolName === "add_item") {
    for (const key of collectMatches(
      rawContent,
      /^[\t ]*Item[\t ]+Key:[\t ]*([A-Z0-9]{8})[\t ]*$/gim,
    )) {
      addItem(key);
    }
    for (const key of collectMatches(
      rawContent,
      /^[\t ]*Added to collection:[\t ]*([A-Z0-9]{8})[\t ]*$/gim,
    )) {
      addCollection(key);
    }
  }

  if (toolName === "get_item_notes") {
    addItem(args.itemKey);
  }

  const sourceItemKeys =
    toolName === "get_annotations" || PDF_ITEM_TOOLS.has(toolName)
      ? extractFirstLineKey(rawContent, "Source item key")
      : [];
  for (const key of sourceItemKeys) {
    addItem(key);
  }

  if (toolName === "get_item_notes" || toolName === "search_notes") {
    for (const key of extractNoteListKeys(toolName, rawContent)) {
      addNote(key);
    }
  }

  if (toolName === "get_note_content") {
    addNote(args.noteKey);
    for (const key of collectMatches(
      rawContent,
      /^[\t ]*Parent Item:[^\n]*\(key:[\t ]*([A-Z0-9]{8})\)[\t ]*$/gim,
    )) {
      addItem(key);
    }
  }

  if (toolName === "create_note" || toolName === "append_to_note") {
    for (const key of collectMatches(
      rawContent,
      /^[\t ]*Note[\t ]+key:[\t ]*([A-Z0-9]{8})(?:[\t ]|$)/gim,
    )) {
      addNote(key);
    }
    for (const key of collectMatches(
      rawContent,
      /[\t ]under item[\t ]+"([A-Z0-9]{8})"/gi,
    )) {
      addItem(key);
    }
  }

  if (toolName === "get_collections") {
    addCollection(args.parentKey);
    for (const key of extractCollectionListKeys(rawContent)) {
      addCollection(key);
    }
  }

  if (toolName === "get_collection_items") {
    addCollection(args.collectionKey);
  }

  if (toolName === "web_search") {
    for (const rawUrl of extractWebResultUrls(rawContent)) {
      const url = normalizeSourceUrl(rawUrl);
      if (url) {
        addReference({ type: "web", url });
      }
    }
  }

  let pageItemKey: string | null = null;
  if (PAGE_BEARING_TOOLS.has(toolName)) {
    const uniqueSourceItemKeys = [
      ...new Set(sourceItemKeys.map(normalizeZoteroKey).filter(Boolean)),
    ];
    pageItemKey =
      uniqueSourceItemKeys.length === 1 ? uniqueSourceItemKeys[0]! : null;
    if (pageItemKey && !references.has(`item:${pageItemKey}`)) {
      pageItemKey = null;
    }
  }

  const sourceReferences = PAGE_BEARING_TOOLS.has(toolName)
    ? extractSourceReferenceManifest(rawContent)
    : { pages: [], annotations: [] };
  const annotations =
    toolName === "get_annotations" ? sourceReferences.annotations : [];
  if (toolName === "get_annotations") {
    for (const annotation of annotations) {
      const key = normalizeZoteroKey(annotation.key);
      if (!key) {
        continue;
      }
      const item = resolveZoteroItem(key);
      if (item !== undefined && !isAnnotationItem(item)) {
        continue;
      }
      addReference({
        type: "annotation",
        key,
        ...(typeof item?.libraryID === "number"
          ? { libraryID: item.libraryID }
          : {}),
        ...(pageItemKey ? { itemKey: pageItemKey } : {}),
        ...(annotation.page ? { page: annotation.page } : {}),
      });
    }
  }

  if (pageItemKey) {
    const itemReference = references.get(`item:${pageItemKey}`);
    const libraryID =
      itemReference?.type === "item" ? itemReference.libraryID : undefined;
    for (const page of sourceReferences.pages) {
      addReference({
        type: "page",
        itemKey: pageItemKey,
        page,
        ...(typeof libraryID === "number" ? { libraryID } : {}),
      });
    }
  }

  return [...references.values()];
}
