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
 * - batch_update_tags: 批量更新标签
 */

import type {
  GetAnnotationsArgs,
  SearchItemsArgs,
  GetCollectionsArgs,
  GetCollectionItemsArgs,
  GetTagsArgs,
  SearchByTagArgs,
  GetRecentArgs,
  SearchNotesArgs,
  CreateNoteArgs,
  BatchUpdateTagsArgs,
} from "../../../types/tool";
import { getString } from "../../../utils/locale";

/**
 * 根据 itemKey 获取 Zotero Item
 */
function getItemByKey(itemKey: string): Zotero.Item | null {
  const libraryID = Zotero.Libraries.userLibraryID;
  const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
  return item || null;
}

/**
 * 获取 item 的正确标题（处理附件情况）
 */
function getItemTitle(item: Zotero.Item): string {
  if (item.isAttachment && item.isAttachment()) {
    const parentID = item.parentItemID;
    if (parentID) {
      const parent = Zotero.Items.get(parentID);
      if (parent) {
        return (
          (parent.getField("title") as string) ||
          item.attachmentFilename ||
          getString("untitled")
        );
      }
    }
    return item.attachmentFilename || getString("untitled");
  }
  return (item.getField("title") as string) || getString("untitled");
}

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
): Promise<string> {
  const targetItemKey = args.itemKey ?? currentItemKey;
  const annotationType = args.annotationType ?? "all";
  const selectedOnly = args.selectedOnly ?? false;
  const includePosition = args.includePosition ?? false;
  const limit = Math.min(args.limit ?? 50, 100);

  if (!targetItemKey) {
    return `Error: No item specified. Please provide an itemKey or ensure a paper is currently open.`;
  }

  let item = getItemByKey(targetItemKey);
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
    return `Error: Cannot get attachments for item "${targetItemKey}": ${error instanceof Error ? error.message : String(error)}`;
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
    return `No annotations found for item "${getItemTitle(item)}"${filterStr}.`;
  }

  // 格式化输出
  const title = getItemTitle(item);
  const filters: string[] = [];
  if (annotationType !== "all") filters.push(`type: ${annotationType}`);
  if (selectedOnly) filters.push("selected only");
  const filterStr = filters.length > 0 ? `, ${filters.join(", ")}` : "";
  const header = `Annotations for "${title}" (${annotations.length} found${filterStr}):\n\n`;

  const formattedAnnotations = annotations.map((ann, index) => {
    const parts = [`${index + 1}. [${ann.type.toUpperCase()}]`];
    if (ann.page > 0) parts.push(`Page ${ann.page}`);
    if (ann.color) parts.push(`Color: ${ann.color}`);
    parts.push(`\n`);

    if (ann.text) {
      parts.push(`   Text: "${ann.text}"\n`);
    }
    if (ann.comment) {
      parts.push(`   Comment: ${ann.comment}\n`);
    }
    if (ann.rect) {
      parts.push(`   Position: [${ann.rect.map((n) => n.toFixed(1)).join(", ")}]\n`);
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
    const mainWindow = Zotero.getMainWindow() as (Window & {
      Zotero_Tabs?: { selectedID: string };
    }) | null;

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
  const results = items.map((item: Zotero.Item, index: number) => {
    const itemKey = item.key;
    const title = getItemTitle(item);
    const year = item.getField("year") || "";
    const creators = item.getCreators();
    const firstAuthor =
      creators && creators.length > 0
        ? creators[0].lastName || (creators[0] as { name?: string }).name || ""
        : "";
    const type = item.itemType;

    return `${index + 1}. [${itemKey}] ${title} (${firstAuthor}${firstAuthor && year ? ", " : ""}${year}) - ${type}`;
  });

  const header = `Search results for "${query}" (showing ${results.length} of ${itemIDs.length} matches):\n\n`;
  return header + results.join("\n");
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
    const title = getItemTitle(item);
    const year = item.getField("year") || "";
    const type = item.itemType;

    return `${index + 1}. [${itemKey}] ${title} (${year}) - ${type}`;
  });

  const header = `Items in collection "${collection.name}" (showing ${limitedItems.length} of ${items.length}):\n\n`;
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
    const title = getItemTitle(item);
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
    const title = getItemTitle(item);
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
        parentInfo = ` (from: ${getItemTitle(parentItem)})`;
      }
    }

    return `${index + 1}. [${noteKey}]${parentInfo}\n   "${preview}"`;
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
  const { content, tags } = args;

  if (!content || content.trim() === "") {
    return `Error: Note content is required.`;
  }

  const libraryID = Zotero.Libraries.userLibraryID;

  // 创建笔记 item
  const note = new Zotero.Item("note");
  note.libraryID = libraryID;

  // 设置笔记内容（包装为 HTML）
  const htmlContent = content.includes("<")
    ? content
    : `<p>${content.replace(/\n/g, "</p><p>")}</p>`;
  note.setNote(htmlContent);

  // 如果指定了父条目
  if (targetItemKey) {
    let parentItem = getItemByKey(targetItemKey);

    // 如果是附件，获取其父 item
    if (parentItem && parentItem.isAttachment && parentItem.isAttachment()) {
      const parentID = parentItem.parentItemID;
      if (parentID) {
        const realParent = Zotero.Items.get(parentID);
        if (realParent) {
          parentItem = realParent;
        }
      }
    }

    if (parentItem && !parentItem.isAttachment()) {
      note.parentID = parentItem.id;
    } else if (targetItemKey) {
      return `Error: Item with key "${targetItemKey}" not found or is an attachment without parent.`;
    }
  }

  // 保存笔记
  await note.saveTx();

  // 添加标签（如果指定）
  if (tags) {
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t);
    for (const tag of tagList) {
      note.addTag(tag);
    }
    await note.saveTx();
  }

  const parentInfo = targetItemKey ? ` under item "${targetItemKey}"` : "";
  return `Note created successfully!\nNote key: ${note.key}${parentInfo}${tags ? `\nTags: ${tags}` : ""}`;
}

// ==================== batch_update_tags ====================

/**
 * 执行 batch_update_tags - 批量更新标签
 */
export async function executeBatchUpdateTags(
  args: BatchUpdateTagsArgs,
): Promise<string> {
  const { query, addTags, removeTags, limit = 50 } = args;
  const limitedLimit = Math.min(Math.max(1, limit), 100);
  const libraryID = Zotero.Libraries.userLibraryID;

  if (!query || query.trim() === "") {
    return `Error: Search query is required to identify items to update.`;
  }

  if (!addTags && !removeTags) {
    return `Error: At least one of addTags or removeTags is required.`;
  }

  // 搜索条目
  const search = new Zotero.Search({ libraryID });
  search.addCondition("quicksearch-titleCreatorYear", "contains", query);
  search.addCondition("itemType", "isNot", "attachment");
  search.addCondition("itemType", "isNot", "note");

  const itemIDs = await search.search();

  if (!itemIDs || itemIDs.length === 0) {
    return `No items found matching query "${query}".`;
  }

  // 限制数量
  const targetIDs = itemIDs.slice(0, limitedLimit);
  const items = await Zotero.Items.getAsync(targetIDs);

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

  return `Batch tag update completed!\nItems affected: ${items.length}${itemIDs.length > limitedLimit ? ` (limited from ${itemIDs.length})` : ""}\n${parts.join("\n")}`;
}
