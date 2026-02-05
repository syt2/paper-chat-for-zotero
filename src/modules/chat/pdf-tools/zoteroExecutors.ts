/**
 * Zotero Executors - Zotero 库相关工具执行（不需要 PDF 内容）
 */

import type {
  ListAllItemsArgs,
  GetItemMetadataArgs,
  GetItemNotesArgs,
  GetNoteContentArgs,
} from "../../../types/tool";

/**
 * 根据 itemKey 获取 Zotero Item
 */
function getItemByKey(itemKey: string): Zotero.Item | null {
  const libraryID = Zotero.Libraries.userLibraryID;
  const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
  return item || null;
}

/**
 * 检查 item 是否有 PDF 附件
 * 如果 item 本身就是 PDF 附件，返回 true
 */
function hasPdfAttachment(item: Zotero.Item): boolean {
  // 如果 item 本身就是 PDF 附件
  if (item.isAttachment && item.isAttachment()) {
    return item.isPDFAttachment && item.isPDFAttachment();
  }

  // 只有非附件 item 才能调用 getAttachments()
  // 注意：getAttachments 方法在附件上调用会抛出错误
  try {
    const attachmentIDs = item.getAttachments();
    for (const attachmentID of attachmentIDs) {
      const attachment = Zotero.Items.get(attachmentID);
      if (
        attachment &&
        attachment.isPDFAttachment &&
        attachment.isPDFAttachment()
      ) {
        return true;
      }
    }
  } catch {
    // getAttachments() 在某些 item 类型上不可用
    return false;
  }
  return false;
}

/**
 * 执行 list_all_items - 列出所有 items（支持分页）
 */
export async function executeListAllItems(
  args: ListAllItemsArgs,
): Promise<string> {
  const { page = 1, pageSize = 20, hasPdf = false } = args;

  // 限制 pageSize
  const limitedPageSize = Math.min(Math.max(1, pageSize), 50);
  const offset = (Math.max(1, page) - 1) * limitedPageSize;

  const libraryID = Zotero.Libraries.userLibraryID;

  // 获取所有常规 items（排除附件、笔记等）
  const rawItems = await Zotero.Items.getAll(libraryID);
  const allItems = rawItems.filter((item: Zotero.Item) => {
    // 排除有parentItem的附件
    if (item.isAttachment() && item.parentItem) {
      return false;
    }
    // 排除笔记
    if (item.isNote()) {
      return false;
    }
    // 如果需要过滤只有 PDF 的
    if (hasPdf && !hasPdfAttachment(item)) {
      return false;
    }
    return true;
  });

  const totalItems = allItems.length;
  const totalPages = Math.ceil(totalItems / limitedPageSize);

  // 分页
  const pagedItems = allItems.slice(offset, offset + limitedPageSize);

  if (pagedItems.length === 0) {
    return `No items found. Page ${page} of ${totalPages} (total: ${totalItems} items)`;
  }

  // 格式化结果
  const itemList = pagedItems.map((item: Zotero.Item, index: number) => {
    const itemKey = item.key;
    const title = (item.getField("title") as string) || "[No title]";
    const year = item.getField("year") || "";
    const itemType = item.itemType;
    const withPdf = hasPdfAttachment(item) ? " [PDF]" : "";

    return `${offset + index + 1}. [${itemKey}] ${title} (${year}) - ${itemType}${withPdf}`;
  });

  const header = `Items (Page ${page}/${totalPages}, showing ${pagedItems.length} of ${totalItems} total${hasPdf ? ", filtered: PDF only" : ""}):\n`;

  return header + itemList.join("\n");
}

/**
 * 执行 get_item_metadata - 获取 item 元数据（不需要 PDF）
 */
export function executeGetItemMetadata(args: GetItemMetadataArgs): string {
  const { itemKey } = args;

  const item = getItemByKey(itemKey);
  if (!item) {
    return `Error: Item with key "${itemKey}" not found.`;
  }

  const parts: string[] = [];

  // 基本信息
  parts.push(`Item Key: ${item.key}`);
  parts.push(`Item Type: ${item.itemType}`);

  const title = item.getField("title");
  if (title) {
    parts.push(`Title: ${title}`);
  }

  // 作者
  const creators = item.getCreators();
  if (creators && creators.length > 0) {
    const authorNames = creators.map(
      (c: { name?: string; firstName?: string; lastName?: string }) => {
        if (c.name) return c.name;
        return `${c.firstName || ""} ${c.lastName || ""}`.trim();
      },
    );
    parts.push(`Authors: ${authorNames.join(", ")}`);
  }

  // 年份
  const year = item.getField("year");
  if (year) {
    parts.push(`Year: ${year}`);
  }

  // DOI
  const doi = item.getField("DOI");
  if (doi) {
    parts.push(`DOI: ${doi}`);
  }

  // URL
  const url = item.getField("url");
  if (url) {
    parts.push(`URL: ${url}`);
  }

  // 期刊/会议
  const publication = item.getField("publicationTitle");
  if (publication) {
    parts.push(`Publication: ${publication}`);
  }

  const conferenceName = item.getField("conferenceName");
  if (conferenceName) {
    parts.push(`Conference: ${conferenceName}`);
  }

  // 摘要
  const abstractText = item.getField("abstractNote");
  if (abstractText) {
    const truncated =
      abstractText.length > 1500
        ? abstractText.substring(0, 1500) + "..."
        : abstractText;
    parts.push(`\nAbstract:\n${truncated}`);
  }

  // 标签
  const tags = item.getTags();
  if (tags && tags.length > 0) {
    const tagNames = tags.map((t: { tag: string }) => t.tag);
    parts.push(`\nTags: ${tagNames.join(", ")}`);
  }

  // 附件信息（只对非附件 item 有效）
  if (item.getAttachments && !item.isAttachment()) {
    const attachmentIDs = item.getAttachments();
    if (attachmentIDs.length > 0) {
      const attachmentInfo: string[] = [];
      for (const attachmentID of attachmentIDs) {
        const attachment = Zotero.Items.get(attachmentID);
        if (attachment) {
          const attachmentTitle =
            attachment.getField("title") || "[Untitled attachment]";
          const isPdf =
            attachment.isPDFAttachment && attachment.isPDFAttachment();
          attachmentInfo.push(
            `  - ${attachmentTitle}${isPdf ? " [PDF]" : ""} (key: ${attachment.key})`,
          );
        }
      }
      parts.push(`\nAttachments:\n${attachmentInfo.join("\n")}`);
    }
  }

  // 笔记数量（只对非附件 item 有效）
  if (item.getNotes && !item.isAttachment()) {
    const noteIDs = item.getNotes();
    if (noteIDs.length > 0) {
      parts.push(`\nNotes: ${noteIDs.length} note(s) available`);
    }
  }

  return parts.join("\n");
}

/**
 * 执行 get_item_notes - 获取 item 的笔记列表
 */
export function executeGetItemNotes(
  args: GetItemNotesArgs,
  currentItemKey: string | null,
): string {
  const targetItemKey = args.itemKey ?? currentItemKey;

  if (!targetItemKey) {
    return `Error: No item specified. Please provide an itemKey.`;
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
        return `Error: Cannot get notes for attachment "${targetItemKey}" - parent item not found.`;
      }
    } else {
      return `Error: Cannot get notes for standalone attachment "${targetItemKey}". Attachments don't have notes directly.`;
    }
  }

  // 获取笔记 (使用 try-catch 以防其他意外情况)
  let noteIDs: number[];
  try {
    noteIDs = item.getNotes();
  } catch (error) {
    return `Error: Cannot get notes for item "${targetItemKey}": ${error instanceof Error ? error.message : String(error)}`;
  }
  if (noteIDs.length === 0) {
    return `No notes found for item "${targetItemKey}".`;
  }

  const noteList: string[] = [];

  for (const noteID of noteIDs) {
    const noteItem = Zotero.Items.get(noteID);
    if (noteItem && noteItem.isNote()) {
      const noteKey = noteItem.key;
      const noteContent = noteItem.getNote() || "";

      // 去除 HTML 标签获取纯文本预览
      const plainText = noteContent
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const preview =
        plainText.length > 200
          ? plainText.substring(0, 200) + "..."
          : plainText;

      const dateModified = noteItem.dateModified || "";

      noteList.push(
        `[${noteKey}] (Modified: ${dateModified})\n   Preview: ${preview}`,
      );
    }
  }

  const title = item.getField("title") || targetItemKey;

  return `Notes for "${title}" (${noteList.length} notes):\n\n${noteList.join("\n\n")}`;
}

/**
 * 执行 get_note_content - 获取笔记内容
 */
export function executeGetNoteContent(args: GetNoteContentArgs): string {
  const { noteKey } = args;

  const noteItem = getItemByKey(noteKey);
  if (!noteItem) {
    return `Error: Note with key "${noteKey}" not found.`;
  }

  if (!noteItem.isNote()) {
    return `Error: Item "${noteKey}" is not a note.`;
  }

  const noteContent = noteItem.getNote();
  if (!noteContent) {
    return `Note "${noteKey}" is empty.`;
  }

  // 获取父 item 信息
  const parentID = noteItem.parentID;
  let parentInfo = "";
  if (parentID) {
    const parentItem = Zotero.Items.get(parentID);
    if (parentItem) {
      const parentTitle = parentItem.getField("title") || parentItem.key;
      parentInfo = `\nParent Item: ${parentTitle} (key: ${parentItem.key})`;
    }
  }

  // 去除 HTML 标签（笔记存储为 HTML）
  const plainText = noteContent
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const dateModified = noteItem.dateModified || "Unknown";

  return `Note: ${noteKey}${parentInfo}\nLast Modified: ${dateModified}\n\n---\n\n${plainText}`;
}
