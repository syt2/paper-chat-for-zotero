/**
 * Library Executors - Zotero 库高级工具执行
 *
 * 包含：
 * - get_annotations: 获取 PDF 标注
 * - search_items: 搜索 Zotero 库
 * - get_collections / get_collection_items: 分类相关
 * - get_tags / search_by_tag: 标签相关
 * - get_recent: 获取最近条目
 * - search_notes: 跨条目搜索笔记
 * - create_note: 创建笔记
 * - append_to_note: 追加写入笔记
 * - batch_update_tags: 批量更新标签
 */

import type {
  AppendToNoteArgs,
  GetAnnotationsArgs,
  SearchItemsArgs,
  SearchFulltextArgs,
  RunSavedSearchArgs,
  UpdateItemMetadataArgs,
  LinkRelatedItemsArgs,
  GetCollectionsArgs,
  GetCollectionItemsArgs,
  GetTagsArgs,
  SearchByTagArgs,
  GetRecentArgs,
  SearchNotesArgs,
  CreateNoteArgs,
  BatchUpdateTagsArgs,
  AddItemArgs,
} from "../../../types/tool";
import { getErrorMessage, getItemTitleSmart } from "../../../utils/common";
import { markdownToNoteHtml } from "../../../utils/markdownToNoteHtml";

const PAPERCHAT_NOTES_TITLE = "PaperChat Notes";

/**
 * 根据 itemKey 获取 Zotero Item
 */
function getItemByKey(itemKey: string, libraryID?: number): Zotero.Item | null {
  libraryID ??= Zotero.Libraries.userLibraryID;
  const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
  return item || null;
}

// 使用 common.ts 中的 getItemTitleSmart 获取 item 标题

/**
 * 清理 HTML 标签，获取纯文本
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function noteContentToHtml(
  content: string,
  format: "plain" | "html" = "plain",
): string {
  if (format === "html") {
    return content;
  }
  return markdownToNoteHtml(content);
}

function resolveParentItemForNote(itemKey: string): Zotero.Item | string {
  let parentItem = getItemByKey(itemKey);

  if (parentItem && parentItem.isAttachment?.()) {
    const parentID = parentItem.parentItemID;
    if (parentID) {
      const realParent = Zotero.Items.get(parentID);
      if (realParent) {
        parentItem = realParent;
      }
    }
  }

  if (!parentItem || parentItem.isAttachment?.() || parentItem.isNote?.()) {
    return `Error: Item with key "${itemKey}" not found or is not a regular Zotero item.`;
  }

  return parentItem;
}

function addTagsToNote(note: Zotero.Item, tags?: string): void {
  if (!tags) {
    return;
  }
  const tagList = tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  for (const tag of tagList) {
    note.addTag(tag);
  }
}

function findDedicatedPaperChatNote(
  parentItem: Zotero.Item,
): Zotero.Item | null {
  const noteIDs = parentItem.getNotes?.() || [];
  for (const noteID of noteIDs) {
    const candidate = Zotero.Items.get(noteID);
    if (
      candidate?.isNote?.() &&
      candidate.getNoteTitle?.() === PAPERCHAT_NOTES_TITLE
    ) {
      return candidate;
    }
  }
  return null;
}

// ==================== get_annotations ====================

/**
 * 获取 PDF 阅读器中选中的标注 keys
 * 借鉴自 zotero-gpt
 */
async function getSelectedAnnotationKeys(): Promise<string[]> {
  try {
    const reader = await ztoolkit.Reader.getReader();
    if (!reader || !reader._iframeWindow) {
      return [];
    }
    const nodes = reader._iframeWindow.document.querySelectorAll(
      "[id^=annotation-].selected",
    );
    return Array.from(nodes)
      .filter((node): node is Element => node instanceof Element)
      .map((node) => node.id.split("-")[1]);
  } catch {
    return [];
  }
}

/**
 * 执行 get_annotations - 获取 PDF 标注
 */
export async function executeGetAnnotations(
  args: GetAnnotationsArgs,
  currentItemKey: string | null,
  currentItemLibraryID?: number,
): Promise<string> {
  const targetItemKey = args.itemKey ?? currentItemKey;
  const annotationType = args.annotationType ?? "all";
  const selectedOnly = args.selectedOnly ?? false;
  const includePosition = args.includePosition ?? false;
  const limit = Math.min(args.limit ?? 50, 100);

  if (!targetItemKey) {
    return `Error: No item specified. Please provide an itemKey or ensure a paper is currently open.`;
  }

  let item = getItemByKey(
    targetItemKey,
    targetItemKey === currentItemKey ? currentItemLibraryID : undefined,
  );
  if (!item) {
    return `Error: Item with key "${targetItemKey}" not found.`;
  }

  // 如果是附件，获取其父 item
  if (item.isAttachment && item.isAttachment()) {
    const parentID = item.parentItemID;
    if (parentID) {
      const parentItem = Zotero.Items.get(parentID);
      if (parentItem) {
        item = parentItem;
      } else {
        return `Error: Cannot get annotations for attachment "${targetItemKey}" - parent item not found.`;
      }
    } else {
      return `Error: Cannot get annotations for standalone attachment "${targetItemKey}".`;
    }
  }

  // 获取选中的标注 keys（如果需要）
  let selectedKeys: string[] = [];
  if (selectedOnly) {
    selectedKeys = await getSelectedAnnotationKeys();
    if (selectedKeys.length === 0) {
      return `No annotations are currently selected in the PDF reader. Please select some annotations first.`;
    }
  }

  // 获取所有附件 (使用 try-catch 以防意外)
  let attachmentIDs: number[] = [];
  try {
    attachmentIDs = item.getAttachments ? item.getAttachments() : [];
  } catch (error) {
    return `Error: Cannot get attachments for item "${targetItemKey}": ${getErrorMessage(error)}`;
  }
  const annotations: Array<{
    key: string;
    type: string;
    text: string;
    comment: string;
    color: string;
    page: number;
    rect?: number[];
    dateModified: string;
  }> = [];

  for (const attachmentID of attachmentIDs) {
    const attachment = Zotero.Items.get(attachmentID);
    if (!attachment) continue;

    // 获取标注 items
    const annotationIDs = attachment.getAnnotations
      ? attachment.getAnnotations()
      : [];

    for (const annotation of annotationIDs) {
      if (!annotation) continue;

      const annKey = annotation.key;

      // 选中筛选
      if (selectedOnly && !selectedKeys.includes(annKey)) {
        continue;
      }

      const annType = annotation.annotationType || "unknown";

      // 类型筛选
      if (annotationType !== "all") {
        if (annotationType === "highlight" && annType !== "highlight") continue;
        if (annotationType === "note" && annType !== "note") continue;
        if (annotationType === "underline" && annType !== "underline") continue;
        if (annotationType === "image" && annType !== "image") continue;
      }

      const text = annotation.annotationText || "";
      const comment = annotation.annotationComment || "";
      const color = annotation.annotationColor || "";
      let page = 0;
      let rect: number[] | undefined;

      if (annotation.annotationPosition) {
        try {
          const position = JSON.parse(annotation.annotationPosition);
          page = (position?.pageIndex ?? -1) + 1;
          if (page < 1) page = 0;
          // 提取 rect 位置信息
          if (includePosition && position?.rects && position.rects.length > 0) {
            rect = position.rects[0]; // [left, bottom, right, top]
          }
        } catch {
          // 解析失败时保持默认值
        }
      }
      const dateModified = annotation.dateModified || "";

      annotations.push({
        key: annKey,
        type: annType,
        text,
        comment,
        color,
        page,
        rect,
        dateModified,
      });

      if (annotations.length >= limit) break;
    }

    if (annotations.length >= limit) break;
  }

  if (annotations.length === 0) {
    const filters: string[] = [];
    if (annotationType !== "all") filters.push(`type: ${annotationType}`);
    if (selectedOnly) filters.push("selected only");
    const filterStr = filters.length > 0 ? ` (${filters.join(", ")})` : "";
    return `No annotations found for item "${getItemTitleSmart(item)}"${filterStr}.`;
  }

  // 格式化输出
  const title = getItemTitleSmart(item);
  const filters: string[] = [];
  if (annotationType !== "all") filters.push(`type: ${annotationType}`);
  if (selectedOnly) filters.push("selected only");
  const filterStr = filters.length > 0 ? `, ${filters.join(", ")}` : "";
  const sourceReferences = {
    version: 1,
    pages: Array.from(
      new Set(
        annotations
          .map((annotation) => annotation.page)
          .filter((page) => Number.isSafeInteger(page) && page > 0),
      ),
    ),
    annotations: annotations.map((annotation) => ({
      key: annotation.key,
      ...(annotation.page > 0 ? { page: annotation.page } : {}),
    })),
  };
  const header = `Source item key: ${item.key}\nSource references: ${JSON.stringify(sourceReferences)}\nAnnotations for "${title}" (${annotations.length} found${filterStr}):\n\n`;

  const formattedAnnotations = annotations.map((ann, index) => {
    const metadata = [
      `${index + 1}. [${ann.type.toUpperCase()}]`,
      `Annotation key: ${ann.key}`,
    ];
    if (ann.page > 0) metadata.push(`Page ${ann.page}`);
    if (ann.color) metadata.push(`Color: ${ann.color}`);
    const parts = [`${metadata.join(" | ")}\n`];

    if (ann.text) {
      parts.push(`   Text: "${ann.text}"\n`);
    }
    if (ann.comment) {
      parts.push(`   Comment: ${ann.comment}\n`);
    }
    if (ann.rect) {
      parts.push(
        `   Position: [${ann.rect.map((n) => n.toFixed(1)).join(", ")}]\n`,
      );
    }

    return parts.join("");
  });

  return header + formattedAnnotations.join("\n");
}

// ==================== get_pdf_selection ====================

/**
 * 执行 get_pdf_selection - 获取 PDF 阅读器中选中的文本
 * 借鉴自 zotero-gpt
 */
export function executeGetPdfSelection(): string {
  try {
    // 获取主窗口
    const mainWindow = Zotero.getMainWindow() as
      | (Window & {
          Zotero_Tabs?: { selectedID: string };
        })
      | null;

    // 获取当前选中的 tab
    const selectedID = mainWindow?.Zotero_Tabs?.selectedID;
    if (!selectedID) {
      return "No PDF reader is currently open. Please open a PDF in Zotero first.";
    }

    const reader = Zotero.Reader?.getByTabID(selectedID);
    if (!reader) {
      return "No PDF reader is currently open. Please open a PDF in Zotero first.";
    }

    const selectedText = ztoolkit.Reader.getSelectedText(reader);

    if (!selectedText || selectedText.trim() === "") {
      return "No text is currently selected in the PDF reader. Please select some text first.";
    }

    return `Selected text from PDF:\n\n"${selectedText.trim()}"`;
  } catch (error) {
    ztoolkit.log("[get_pdf_selection] Error:", error);
    return "Error: Could not get PDF selection. Make sure a PDF is open in the reader.";
  }
}

/**
 * One-line summary of a Zotero item for list-style tool results.
 * Shared by search_items, search_fulltext, and run_saved_search so their
 * output stays consistent and downstream itemKey parsing has one shape.
 */
function formatItemSummaryLine(item: Zotero.Item, index: number): string {
  const title = getItemTitleSmart(item);
  const year = item.getField("year") || "";
  const creators = item.getCreators();
  const firstAuthor =
    creators && creators.length > 0
      ? creators[0].lastName || (creators[0] as { name?: string }).name || ""
      : "";
  return `${index + 1}. [${item.key}] ${title} (${firstAuthor}${
    firstAuthor && year ? ", " : ""
  }${year}) - ${item.itemType}`;
}

// ==================== search_items ====================

/**
 * 执行 search_items - 搜索 Zotero 库
 */
export async function executeSearchItems(
  args: SearchItemsArgs,
): Promise<string> {
  const { query, field = "everywhere", itemType, limit = 20 } = args;
  const limitedLimit = Math.min(Math.max(1, limit), 50);

  if (!query || query.trim() === "") {
    return `Error: Search query is required.`;
  }

  const libraryID = Zotero.Libraries.userLibraryID;

  // 创建搜索
  const search = new Zotero.Search({ libraryID });

  // 根据字段添加搜索条件
  switch (field) {
    case "title":
      search.addCondition("title", "contains", query);
      break;
    case "creator":
      search.addCondition("creator", "contains", query);
      break;
    case "tag":
      search.addCondition("tag", "is", query);
      break;
    case "everywhere":
    default:
      search.addCondition("quicksearch-titleCreatorYear", "contains", query);
      break;
  }

  // 添加条目类型筛选
  if (itemType) {
    search.addCondition("itemType", "is", itemType);
  }

  // 执行搜索
  const itemIDs = await search.search();

  if (!itemIDs || itemIDs.length === 0) {
    return `No items found for query "${query}"${field !== "everywhere" ? ` in field "${field}"` : ""}${itemType ? ` with type "${itemType}"` : ""}.`;
  }

  // 获取 items 并限制数量
  const items = await Zotero.Items.getAsync(itemIDs.slice(0, limitedLimit));

  // 格式化结果
  const results = items.map(formatItemSummaryLine);

  const header = `Search results for "${query}" (showing ${results.length} of ${itemIDs.length} matches):\n\n`;
  return header + results.join("\n");
}

// ==================== search_fulltext ====================

/**
 * 执行 search_fulltext - 全库 PDF 全文检索
 */
export async function executeSearchFulltext(
  args: SearchFulltextArgs,
): Promise<string> {
  const { query, itemType, limit = 20 } = args;
  const limitedLimit = Math.min(Math.max(1, limit), 50);

  if (!query || query.trim() === "") {
    return `Error: Search query is required.`;
  }

  const libraryID = Zotero.Libraries.userLibraryID;
  const search = new Zotero.Search({ libraryID });
  search.addCondition("fulltextContent", "contains", query);

  const itemIDs = await search.search();

  if (!itemIDs || itemIDs.length === 0) {
    return `No papers found whose full text mentions "${query}". Note: only indexed attachments are searchable; the paper may still mention it if its PDF is not indexed.`;
  }

  // fulltextContent matches attachment items; surface their top-level parents.
  const matched = await Zotero.Items.getAsync(itemIDs);
  const parentsById = new Map<number, Zotero.Item>();
  for (const item of matched) {
    let parent: Zotero.Item | null = item;
    if (item.isAttachment?.() && item.parentItemID) {
      parent = Zotero.Items.get(item.parentItemID) || null;
    }
    if (!parent || parent.isAttachment?.() || parent.isNote?.()) {
      continue;
    }
    if (itemType && parent.itemType !== itemType) {
      continue;
    }
    if (!parentsById.has(parent.id)) {
      parentsById.set(parent.id, parent);
    }
  }

  if (parentsById.size === 0) {
    return `No papers found whose full text mentions "${query}"${itemType ? ` with type "${itemType}"` : ""}.`;
  }

  const parents = [...parentsById.values()];
  const results = parents.slice(0, limitedLimit).map(formatItemSummaryLine);

  const header = `Papers whose full text mentions "${query}" (showing ${results.length} of ${parents.length} matches):\n\n`;
  const hint = `\n\nUse get_full_text or get_annotations with an itemKey above to read the matching paper.`;
  return header + results.join("\n") + hint;
}

// ==================== saved searches ====================

/**
 * 执行 list_saved_searches - 列出用户的保存搜索
 */
export async function executeListSavedSearches(): Promise<string> {
  const libraryID = Zotero.Libraries.userLibraryID;
  const ids = await Zotero.Searches.getAllIDs(libraryID);
  if (!ids?.length) {
    return "No saved searches found in the Zotero library.";
  }

  const lines: string[] = [];
  for (const id of ids) {
    const search = Zotero.Searches.get(id);
    if (!search?.key) {
      continue;
    }
    lines.push(`${lines.length + 1}. [${search.key}] ${search.name}`);
  }

  if (!lines.length) {
    return "No saved searches found in the Zotero library.";
  }

  return (
    `Saved searches (${lines.length}):\n\n` +
    lines.join("\n") +
    `\n\nUse run_saved_search with a searchKey above to execute one.`
  );
}

/**
 * 执行 run_saved_search - 按 key 执行保存搜索
 *
 * 只调用 search.search()，不解析或回写 condition 结构：Zotero 10 重写了
 * 保存搜索的内部表示（嵌套条件组、resultLevel 标记条件），任何对条件形状
 * 的假设都会在升级后失效。
 */
export async function executeRunSavedSearch(
  args: RunSavedSearchArgs,
): Promise<string> {
  const { searchKey, limit = 20 } = args;
  const limitedLimit = Math.min(Math.max(1, limit), 50);

  if (!searchKey || searchKey.trim() === "") {
    return "Error: searchKey is required. Use list_saved_searches to discover keys.";
  }

  const libraryID = Zotero.Libraries.userLibraryID;
  const search = Zotero.Searches.getByLibraryAndKey(
    libraryID,
    searchKey.trim(),
  );
  if (!search) {
    return `Error: No saved search found with key "${searchKey}". Use list_saved_searches to see available searches.`;
  }

  const ids = await search.search();
  if (!ids?.length) {
    return `Saved search "${search.name}" returned no items.`;
  }

  const items = await Zotero.Items.getAsync(ids.slice(0, limitedLimit));
  const results = items
    .filter((item: Zotero.Item) => !item.isNote?.())
    .map(formatItemSummaryLine);

  if (!results.length) {
    return `Saved search "${search.name}" returned no regular items.`;
  }

  return (
    `Saved search "${search.name}" (showing ${results.length} of ${ids.length} matches):\n\n` +
    results.join("\n")
  );
}

// ==================== get_collections ====================

/**
 * 执行 get_collections - 获取分类列表
 */
export async function executeGetCollections(
  args: GetCollectionsArgs,
): Promise<string> {
  const { parentKey } = args;
  const libraryID = Zotero.Libraries.userLibraryID;

  let collections: Zotero.Collection[];

  if (parentKey) {
    // 获取子分类
    const parentCollection = Zotero.Collections.getByLibraryAndKey(
      libraryID,
      parentKey,
    );
    if (!parentCollection) {
      return `Error: Collection with key "${parentKey}" not found.`;
    }
    collections = parentCollection.getChildCollections();
  } else {
    // 获取顶级分类
    collections = Zotero.Collections.getByLibrary(libraryID).filter(
      (c: Zotero.Collection) => !c.parentID,
    );
  }

  if (!collections || collections.length === 0) {
    return parentKey
      ? `No sub-collections found for collection "${parentKey}".`
      : `No collections found in the library.`;
  }

  // 格式化输出
  const formatCollection = (
    collection: Zotero.Collection,
    indent: string = "",
  ): string => {
    const key = collection.key;
    const name = collection.name;
    const itemCount = collection.getChildItems().length;
    const childCount = collection.getChildCollections().length;

    let info = `${indent}[${key}] ${name} (${itemCount} items)`;
    if (childCount > 0) {
      info += ` - ${childCount} sub-collection(s)`;
    }
    info += `\n${indent}   Collection key: ${key}`;
    return info;
  };

  const header = parentKey
    ? `Sub-collections of "${parentKey}":\n\n`
    : `Top-level collections:\n\n`;

  const result = collections.map((c) => formatCollection(c)).join("\n");
  return header + result;
}

// ==================== get_collection_items ====================

/**
 * 执行 get_collection_items - 获取分类下的条目
 */
export async function executeGetCollectionItems(
  args: GetCollectionItemsArgs,
): Promise<string> {
  const { collectionKey, limit = 30 } = args;
  const limitedLimit = Math.min(Math.max(1, limit), 100);
  const libraryID = Zotero.Libraries.userLibraryID;

  const collection = Zotero.Collections.getByLibraryAndKey(
    libraryID,
    collectionKey,
  );
  if (!collection) {
    return `Error: Collection with key "${collectionKey}" not found.`;
  }

  const items = collection.getChildItems();

  if (!items || items.length === 0) {
    return `No items found in collection "${collection.name}".`;
  }

  // 限制数量
  const limitedItems = items.slice(0, limitedLimit);

  // 格式化结果
  const results = limitedItems.map((item: Zotero.Item, index: number) => {
    const itemKey = item.key;
    const title = getItemTitleSmart(item);
    const year = item.getField("year") || "";
    const type = item.itemType;

    return `${index + 1}. [${itemKey}] ${title} (${year}) - ${type}`;
  });

  const header = `Items in collection "${collection.name}" (showing ${limitedItems.length} of ${items.length}):\nSource collection key: ${collection.key}\n\n`;
  return header + results.join("\n");
}

// ==================== get_tags ====================

/**
 * 执行 get_tags - 获取所有标签
 */
export async function executeGetTags(args: GetTagsArgs): Promise<string> {
  const { limit = 100 } = args;
  const limitedLimit = Math.min(Math.max(1, limit), 500);
  const libraryID = Zotero.Libraries.userLibraryID;

  // 获取所有标签
  const tags = await Zotero.Tags.getAll(libraryID);

  if (!tags || tags.length === 0) {
    return `No tags found in the library.`;
  }

  // 排序并限制数量
  const sortedTags = tags
    .map((t: { tag: string }) => t.tag)
    .sort((a: string, b: string) => a.localeCompare(b))
    .slice(0, limitedLimit);

  const header = `Tags in library (showing ${sortedTags.length} of ${tags.length}):\n\n`;
  return header + sortedTags.join(", ");
}

// ==================== search_by_tag ====================

/**
 * 执行 search_by_tag - 按标签搜索
 */
export async function executeSearchByTag(
  args: SearchByTagArgs,
): Promise<string> {
  const { tags, mode = "or", limit = 30 } = args;
  const limitedLimit = Math.min(Math.max(1, limit), 100);
  const libraryID = Zotero.Libraries.userLibraryID;

  // 解析标签列表
  const tagList = tags
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t);

  if (tagList.length === 0) {
    return `Error: At least one tag is required.`;
  }

  // 创建搜索
  const search = new Zotero.Search({ libraryID });

  if (mode === "and") {
    // AND 模式：所有标签都必须存在
    for (const tag of tagList) {
      search.addCondition("tag", "is", tag);
    }
  } else {
    // OR 模式：任一标签存在即可
    // Zotero 默认就是 OR 行为对于多个相同字段的条件
    // 但我们需要用 joinMode
    search.addCondition("joinMode", "any", "");
    for (const tag of tagList) {
      search.addCondition("tag", "is", tag);
    }
  }

  // 执行搜索
  const itemIDs = await search.search();

  if (!itemIDs || itemIDs.length === 0) {
    return `No items found with tag(s): ${tagList.join(", ")} (mode: ${mode.toUpperCase()})`;
  }

  // 获取 items
  const items = await Zotero.Items.getAsync(itemIDs.slice(0, limitedLimit));

  // 格式化结果
  const results = items.map((item: Zotero.Item, index: number) => {
    const itemKey = item.key;
    const title = getItemTitleSmart(item);
    const year = item.getField("year") || "";
    const itemTags = item
      .getTags()
      .map((t: { tag: string }) => t.tag)
      .join(", ");

    return `${index + 1}. [${itemKey}] ${title} (${year})\n   Tags: ${itemTags}`;
  });

  const header = `Items with tag(s) "${tagList.join(", ")}" (${mode.toUpperCase()} mode, showing ${results.length} of ${itemIDs.length}):\n\n`;
  return header + results.join("\n\n");
}

// ==================== get_recent ====================

/**
 * 执行 get_recent - 获取最近添加的条目
 */
export async function executeGetRecent(args: GetRecentArgs): Promise<string> {
  const { limit = 20, days } = args;
  const limitedLimit = Math.min(Math.max(1, limit), 100);
  const libraryID = Zotero.Libraries.userLibraryID;

  // 创建搜索
  const search = new Zotero.Search({ libraryID });

  // 添加日期条件（如果指定）
  if (days && days > 0) {
    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - days);
    const dateStr = daysAgo.toISOString().split("T")[0];
    search.addCondition("dateAdded", "isAfter", dateStr);
  }

  // 排除附件和笔记
  search.addCondition("itemType", "isNot", "attachment");
  search.addCondition("itemType", "isNot", "note");

  // 执行搜索
  const itemIDs = await search.search();

  if (!itemIDs || itemIDs.length === 0) {
    return days
      ? `No items added in the last ${days} day(s).`
      : `No items found in the library.`;
  }

  // 获取 items
  const items = await Zotero.Items.getAsync(itemIDs);

  // 按添加日期排序（最新的在前）
  const sortedItems = items
    .sort((a: Zotero.Item, b: Zotero.Item) => {
      const dateA = new Date(a.dateAdded || 0).getTime();
      const dateB = new Date(b.dateAdded || 0).getTime();
      return dateB - dateA;
    })
    .slice(0, limitedLimit);

  // 格式化结果
  const results = sortedItems.map((item: Zotero.Item, index: number) => {
    const itemKey = item.key;
    const title = getItemTitleSmart(item);
    const year = item.getField("year") || "";
    const type = item.itemType;
    const dateAdded = item.dateAdded
      ? new Date(item.dateAdded).toLocaleDateString()
      : "";

    return `${index + 1}. [${itemKey}] ${title} (${year}) - ${type}\n   Added: ${dateAdded}`;
  });

  const header = `Recently added items${days ? ` (last ${days} days)` : ""} (showing ${sortedItems.length}):\n\n`;
  return header + results.join("\n\n");
}

// ==================== search_notes ====================

/**
 * 执行 search_notes - 跨条目搜索笔记
 */
export async function executeSearchNotes(
  args: SearchNotesArgs,
): Promise<string> {
  const { query, limit = 20 } = args;
  const limitedLimit = Math.min(Math.max(1, limit), 50);
  const libraryID = Zotero.Libraries.userLibraryID;

  if (!query || query.trim() === "") {
    return `Error: Search query is required.`;
  }

  // 搜索笔记
  const search = new Zotero.Search({ libraryID });
  search.addCondition("itemType", "is", "note");
  search.addCondition("note", "contains", query);

  const noteIDs = await search.search();

  if (!noteIDs || noteIDs.length === 0) {
    return `No notes found containing "${query}".`;
  }

  // 获取笔记
  const notes = await Zotero.Items.getAsync(noteIDs.slice(0, limitedLimit));

  // 格式化结果
  const results = notes.map((note: Zotero.Item, index: number) => {
    const noteKey = note.key;
    const noteContent = note.getNote ? note.getNote() : "";
    const plainText = stripHtml(noteContent);

    // 找到匹配位置并提取上下文
    const lowerText = plainText.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const matchIndex = lowerText.indexOf(lowerQuery);

    let preview = "";
    if (matchIndex >= 0) {
      const start = Math.max(0, matchIndex - 50);
      const end = Math.min(plainText.length, matchIndex + query.length + 100);
      preview =
        (start > 0 ? "..." : "") +
        plainText.substring(start, end) +
        (end < plainText.length ? "..." : "");
    } else {
      preview =
        plainText.substring(0, 150) + (plainText.length > 150 ? "..." : "");
    }

    // 获取父条目信息
    let parentInfo = "";
    const parentID = note.parentID;
    if (parentID) {
      const parentItem = Zotero.Items.get(parentID);
      if (parentItem) {
        parentInfo = ` (from: ${getItemTitleSmart(parentItem)})`;
      }
    }

    return `${index + 1}. [${noteKey}]${parentInfo}\n   Note key: ${noteKey}\n   "${preview}"`;
  });

  const header = `Notes containing "${query}" (showing ${results.length} of ${noteIDs.length}):\n\n`;
  return header + results.join("\n\n");
}

// ==================== create_note ====================

/**
 * 执行 create_note - 创建笔记
 */
export async function executeCreateNote(
  args: CreateNoteArgs,
  currentItemKey: string | null,
): Promise<string> {
  const targetItemKey = args.itemKey ?? currentItemKey;
  const { content, format = "plain", tags } = args;

  if (!content || content.trim() === "") {
    return `Error: Note content is required.`;
  }

  const libraryID = Zotero.Libraries.userLibraryID;

  // 创建笔记 item
  const note = new Zotero.Item("note");
  note.libraryID = libraryID;

  // 设置笔记内容（包装为 HTML）
  note.setNote(noteContentToHtml(content, format));

  // 如果指定了父条目
  if (targetItemKey) {
    const parentItem = resolveParentItemForNote(targetItemKey);
    if (typeof parentItem === "string") {
      return parentItem;
    }
    note.parentID = parentItem.id;
  }

  // Reuse Zotero's transaction helper so create_note does not collide with
  // other addon writes that may already hold a DB transaction.
  await Zotero.DB.executeTransaction(async () => {
    await note.save();

    if (tags) {
      addTagsToNote(note, tags);
      await note.save();
    }
  });

  const parentInfo = targetItemKey ? ` under item "${targetItemKey}"` : "";
  return `Note created successfully!\nNote key: ${note.key}${parentInfo}${tags ? `\nTags: ${tags}` : ""}`;
}

// ==================== append_to_note ====================

/**
 * 执行 append_to_note - 追加内容到已有笔记，或当前条目的子笔记
 */
export async function executeAppendToNote(
  args: AppendToNoteArgs,
  currentItemKey: string | null,
): Promise<string> {
  const { content, format = "plain", noteKey, tags } = args;
  const targetItemKey = args.itemKey ?? currentItemKey;

  if (!content || content.trim() === "") {
    return `Error: Note content is required.`;
  }

  let note: Zotero.Item | null = null;
  let created = false;
  let parentInfo = "";

  if (noteKey) {
    const noteItem = getItemByKey(noteKey);
    if (!noteItem || !noteItem.isNote?.()) {
      return `Error: Note with key "${noteKey}" not found.`;
    }
    note = noteItem;
    parentInfo = ` existing note "${noteKey}"`;
  } else {
    if (!targetItemKey) {
      return `Error: append_to_note requires noteKey or itemKey/current item context.`;
    }

    const parentItem = resolveParentItemForNote(targetItemKey);
    if (typeof parentItem === "string") {
      return parentItem;
    }

    note = findDedicatedPaperChatNote(parentItem);

    if (!note) {
      note = new Zotero.Item("note");
      note.libraryID = parentItem.libraryID;
      note.parentID = parentItem.id;
      note.setNote(`<h1>${escapeHtml(PAPERCHAT_NOTES_TITLE)}</h1>`);
      created = true;
    }
    parentInfo = ` under item "${targetItemKey}"`;
  }

  const currentHtml = note.getNote?.() || "";
  const appendHtml = noteContentToHtml(content, format);
  const separator = currentHtml.trim() ? "\n<hr/>\n" : "";
  note.setNote(`${currentHtml}${separator}${appendHtml}`);

  await Zotero.DB.executeTransaction(async () => {
    await note!.save();
    if (created && tags) {
      addTagsToNote(note!, tags);
      await note!.save();
    }
  });

  return `Note appended successfully!\nNote key: ${note.key}${parentInfo}\nCreated new note: ${created ? "yes" : "no"}${created && tags ? `\nTags: ${tags}` : ""}`;
}

// ==================== batch_update_tags ====================

/**
 * 执行 batch_update_tags - 批量更新标签
 */
export async function executeBatchUpdateTags(
  args: BatchUpdateTagsArgs,
): Promise<string> {
  const { query, itemKeys, addTags, removeTags, limit = 50 } = args;
  const limitedLimit = Math.min(Math.max(1, limit), 100);
  const libraryID = Zotero.Libraries.userLibraryID;

  if (!query?.trim() && !itemKeys?.length) {
    return `Error: Provide itemKeys (preferred) or a query to identify items to update.`;
  }

  if (!addTags && !removeTags) {
    return `Error: At least one of addTags or removeTags is required.`;
  }

  // itemKeys 优先：模型刚分析过的论文可以被精确定位，无需靠文本查询碰运气。
  let items: Zotero.Item[];
  let totalMatched: number;
  if (itemKeys?.length) {
    const resolved: Zotero.Item[] = [];
    const missing: string[] = [];
    for (const key of itemKeys) {
      const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
      if (item && !item.isAttachment?.() && !item.isNote?.()) {
        resolved.push(item);
      } else {
        missing.push(key);
      }
    }
    if (!resolved.length) {
      return `Error: None of the provided itemKeys resolved to a regular item: ${missing.join(", ")}`;
    }
    totalMatched = resolved.length;
    items = resolved.slice(0, limitedLimit);
  } else {
    const search = new Zotero.Search({ libraryID });
    search.addCondition("quicksearch-titleCreatorYear", "contains", query!);
    search.addCondition("itemType", "isNot", "attachment");
    search.addCondition("itemType", "isNot", "note");

    const itemIDs = await search.search();
    if (!itemIDs || itemIDs.length === 0) {
      return `No items found matching query "${query}".`;
    }
    totalMatched = itemIDs.length;
    items = await Zotero.Items.getAsync(itemIDs.slice(0, limitedLimit));
  }

  // 解析标签列表
  const tagsToAdd = addTags
    ? addTags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t)
    : [];
  const tagsToRemove = removeTags
    ? removeTags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t)
    : [];

  let addedCount = 0;
  let removedCount = 0;

  // 批量更新
  await Zotero.DB.executeTransaction(async () => {
    for (const item of items) {
      // 添加标签
      for (const tag of tagsToAdd) {
        if (!item.hasTag(tag)) {
          item.addTag(tag);
          addedCount++;
        }
      }

      // 移除标签
      for (const tag of tagsToRemove) {
        if (item.hasTag(tag)) {
          item.removeTag(tag);
          removedCount++;
        }
      }

      await item.save();
    }
  });

  const parts = [];
  if (tagsToAdd.length > 0) {
    parts.push(`Added tags [${tagsToAdd.join(", ")}]: ${addedCount} additions`);
  }
  if (tagsToRemove.length > 0) {
    parts.push(
      `Removed tags [${tagsToRemove.join(", ")}]: ${removedCount} removals`,
    );
  }

  return `Batch tag update completed!\nItems affected: ${items.length}${totalMatched > limitedLimit ? ` (limited from ${totalMatched})` : ""}\n${parts.join("\n")}`;
}

// ==================== update_item_metadata ====================

/**
 * 可安全写入的字段白名单。
 *
 * 刻意排除 creators（结构化数据，需要专门的 API）和 itemType（会改变条目
 * 的整个字段形状）——它们需要独立工具而不是通用 setField。
 */
const EDITABLE_METADATA_FIELDS = new Set([
  "title",
  "abstractNote",
  "date",
  "DOI",
  "url",
  "publicationTitle",
  "journalAbbreviation",
  "volume",
  "issue",
  "pages",
  "publisher",
  "place",
  "edition",
  "ISBN",
  "ISSN",
  "language",
  "extra",
]);

/**
 * 执行 update_item_metadata - 修正条目的书目字段
 */
export async function executeUpdateItemMetadata(
  args: UpdateItemMetadataArgs,
): Promise<string> {
  const { itemKey, fields } = args;

  if (!itemKey?.trim()) {
    return "Error: itemKey is required.";
  }
  if (!fields || Object.keys(fields).length === 0) {
    return "Error: fields is required and must contain at least one field.";
  }

  const item = getItemByKey(itemKey.trim());
  if (!item || item.isAttachment?.() || item.isNote?.()) {
    return `Error: Item with key "${itemKey}" not found or is not a regular Zotero item.`;
  }

  const rejected = Object.keys(fields).filter(
    (field) => !EDITABLE_METADATA_FIELDS.has(field),
  );
  if (rejected.length) {
    return (
      `Error: These fields are not editable: ${rejected.join(", ")}.\n` +
      `Editable fields: ${[...EDITABLE_METADATA_FIELDS].join(", ")}.`
    );
  }

  const changes: string[] = [];
  for (const [field, nextValue] of Object.entries(fields)) {
    let previous: string;
    try {
      previous = String(item.getField(field) || "");
    } catch {
      return `Error: Field "${field}" does not apply to item type "${item.itemType}".`;
    }
    const next = String(nextValue ?? "");
    if (previous === next) {
      continue;
    }
    try {
      item.setField(field, next);
    } catch (error) {
      return `Error: Could not set "${field}" on item type "${item.itemType}": ${getErrorMessage(error)}`;
    }
    changes.push(`- ${field}: "${previous}" -> "${next}"`);
  }

  if (!changes.length) {
    return `No changes: every provided field already had the requested value on [${item.key}].`;
  }

  await item.saveTx();

  return `Updated metadata on [${item.key}] ${getItemTitleSmart(item)}:\n${changes.join("\n")}`;
}

// ==================== link_related_items ====================

/**
 * 执行 link_related_items - 在条目之间建立 Zotero 关联
 */
export async function executeLinkRelatedItems(
  args: LinkRelatedItemsArgs,
): Promise<string> {
  const { itemKey, relatedItemKeys } = args;

  if (!itemKey?.trim()) {
    return "Error: itemKey is required.";
  }
  if (!relatedItemKeys?.length) {
    return "Error: relatedItemKeys is required and must contain at least one key.";
  }

  const item = getItemByKey(itemKey.trim());
  if (!item || item.isAttachment?.() || item.isNote?.()) {
    return `Error: Item with key "${itemKey}" not found or is not a regular Zotero item.`;
  }

  const linked: string[] = [];
  const skipped: string[] = [];
  const touched: Zotero.Item[] = [];

  for (const rawKey of relatedItemKeys) {
    const key = rawKey.trim();
    if (!key || key === item.key) {
      skipped.push(rawKey);
      continue;
    }
    const related = getItemByKey(key);
    if (!related || related.isAttachment?.() || related.isNote?.()) {
      skipped.push(rawKey);
      continue;
    }
    // Zotero relations are bidirectional only if both sides are set.
    const forward = item.addRelatedItem(related);
    const backward = related.addRelatedItem(item);
    if (forward || backward) {
      linked.push(key);
      if (backward) touched.push(related);
    } else {
      skipped.push(key);
    }
  }

  if (!linked.length) {
    return `No relations added. Unresolved or already-linked keys: ${skipped.join(", ")}`;
  }

  await Zotero.DB.executeTransaction(async () => {
    await item.save();
    for (const related of touched) {
      await related.save();
    }
  });

  const skippedNote = skipped.length
    ? `\nSkipped (unresolved, self, or already linked): ${skipped.join(", ")}`
    : "";
  return `Linked [${item.key}] to ${linked.length} related item(s): ${linked.join(", ")}${skippedNote}`;
}

// ==================== add_item ====================

/**
 * 执行 add_item - 通过标识符（DOI/ISBN/PMID/arXiv ID）添加条目到 Zotero 库
 */
export async function executeAddItem(args: AddItemArgs): Promise<string> {
  const { identifier, collection_key } = args;

  if (!identifier || identifier.trim() === "") {
    return "Error: identifier is required.";
  }

  // 解析标识符
  const identifiers = Zotero.Utilities.extractIdentifiers(identifier);
  if (!identifiers || identifiers.length === 0) {
    return `Error: Could not recognize a valid identifier from "${identifier}". Supported formats: DOI (e.g. 10.1038/nature12373), ISBN, PMID, arXiv ID.`;
  }

  const parsedIdentifier = identifiers[0];

  const libraryID = Zotero.Libraries.userLibraryID;

  // 确定 collections
  let collections: number[] = [];
  if (collection_key) {
    const collection = Zotero.Collections.getByLibraryAndKey(
      libraryID,
      collection_key,
    );
    if (!collection) {
      return `Error: Collection with key "${collection_key}" not found.`;
    }
    collections = [collection.id];
  }

  try {
    // 创建 Translate.Search 实例
    const translate = new (Zotero.Translate as any).Search();
    translate.setIdentifier(parsedIdentifier);

    // 获取翻译器
    const translators = await translate.getTranslators();
    if (!translators || translators.length === 0) {
      return `Error: No translators found for identifier "${identifier}". The identifier may be invalid or the lookup service is unavailable.`;
    }

    translate.setTranslator(translators);

    // 执行翻译（创建条目）
    const items: Zotero.Item[] = await translate.translate({
      libraryID,
      collections,
    });

    if (!items || items.length === 0) {
      return `Error: Could not retrieve metadata for identifier "${identifier}". The identifier may be invalid or the item could not be found.`;
    }

    // 顺带尝试抓取开放获取 PDF，这样"把这篇加进来然后读一下"能一步到位。
    // 失败不影响条目本身已成功添加。
    const pdfAttached = new Set<string>();
    try {
      await Zotero.Attachments.addAvailableFiles(items);
      for (const item of items) {
        const hasPdf = (item.getAttachments?.() || []).some((id) =>
          Zotero.Items.get(id)?.isPDFAttachment?.(),
        );
        if (hasPdf) pdfAttached.add(item.key);
      }
    } catch (error) {
      ztoolkit.log("[add_item] PDF fetch skipped:", getErrorMessage(error));
    }

    // 格式化成功信息
    const results = items.map((item: Zotero.Item) => {
      const title = getItemTitleSmart(item);
      const creators = item.getCreators();
      const authors = creators
        .map((c: { firstName?: string; lastName?: string; name?: string }) =>
          c.lastName
            ? `${c.lastName}${c.firstName ? ", " + c.firstName : ""}`
            : c.name || "",
        )
        .filter(Boolean);
      const year = item.getField("year") || "";
      const type = item.itemType;

      const parts = [`Title: ${title}`];
      if (authors.length > 0) {
        parts.push(
          `Authors: ${authors.length > 3 ? authors.slice(0, 3).join("; ") + " et al." : authors.join("; ")}`,
        );
      }
      if (year) parts.push(`Year: ${year}`);
      parts.push(`Type: ${type}`);
      parts.push(`Item Key: ${item.key}`);
      parts.push(
        pdfAttached.has(item.key)
          ? `PDF: attached (readable with get_full_text)`
          : `PDF: not available`,
      );
      if (collection_key) {
        parts.push(`Added to collection: ${collection_key}`);
      }
      return parts.join("\n");
    });

    return `Successfully added ${items.length} item(s) to the Zotero library:\n\n${results.join("\n\n")}`;
  } catch (error) {
    const msg = getErrorMessage(error);
    ztoolkit.log("[add_item] Error:", msg);
    return `Error: Failed to add item for identifier "${identifier}". ${msg}`;
  }
}
