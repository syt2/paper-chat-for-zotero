/**
 * PdfToolManager - 论文内容管理 + 工具执行
 *
 * 职责:
 * 1. 管理当前活动的 Item
 * 2. 定义可用工具
 * 3. 协调工具调用执行
 *
 * 工具列表:
 * - get_paper_section: 获取指定章节内容
 * - search_paper_content: 关键词搜索
 * - get_paper_metadata: 获取元数据
 * - get_pages: 按页码范围获取内容
 * - get_page_count: 获取总页数
 * - search_with_regex: 正则搜索（支持上下文）
 * - get_outline: 获取文档大纲
 * - list_sections: 列出所有章节
 * - get_full_text: 获取完整原文（高 token 消耗）
 */

import type {
  ToolDefinition,
  ToolParameterProperty,
  ToolCall,
  PaperStructure,
  PaperStructureExtended,
  BaseToolArgs,
  GetPaperSectionArgs,
  SearchPaperContentArgs,
  GetPagesArgs,
  SearchWithRegexArgs,
  GetFullTextArgs,
  ListAllItemsArgs,
  GetItemMetadataArgs,
  GetItemNotesArgs,
  GetNoteContentArgs,
  // 新增类型
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
  // 多文档比较工具类型
  ComparePapersArgs,
  SearchAcrossPapersArgs,
} from "../../../types/tool";
import { parsePaperStructure, parsePages } from "./paperParser";
import { generatePaperContextPrompt as generatePaperContextPromptFn } from "./promptGenerator";
import {
  executeGetPaperSection,
  executeSearchPaperContent,
  executeGetPaperMetadata,
  executeGetPages,
  executeGetPageCount,
  executeSearchWithRegex,
  executeGetOutline,
  executeListSections,
  executeGetFullText,
} from "./toolExecutors";
import {
  executeListAllItems,
  executeGetItemMetadata,
  executeGetItemNotes,
  executeGetNoteContent,
} from "./zoteroExecutors";
import {
  executeGetAnnotations,
  executeGetPdfSelection,
  executeSearchItems,
  executeGetCollections,
  executeGetCollectionItems,
  executeGetTags,
  executeSearchByTag,
  executeGetRecent,
  executeSearchNotes,
  executeCreateNote,
  executeBatchUpdateTags,
} from "./libraryExecutors";
import { getPref } from "../../../utils/prefs";
import { getErrorMessage } from "../../../utils/common";

// 缓存条目类型
interface CacheEntry {
  structure: PaperStructureExtended;
  timestamp: number;
}

export class PdfToolManager {
  // 当前活动的 Item Key (单文档，向后兼容)
  private currentItemKey: string | null = null;
  // 当前活动的多个 Item Keys (多文档支持)
  private currentItemKeys: string[] = [];

  // PDF 解析缓存（避免重复解析同一个 PDF）
  private paperCache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存过期
  private readonly MAX_CACHE_SIZE = 10; // 最多缓存10个文档

  /**
   * 设置当前活动的 Item Key (单文档模式)
   */
  setCurrentItemKey(itemKey: string | null): void {
    this.currentItemKey = itemKey;
  }

  /**
   * 获取当前活动的 Item Key (单文档模式)
   */
  getCurrentItemKey(): string | null {
    return this.currentItemKey;
  }

  /**
   * 设置当前活动的多个 Item Keys (多文档模式)
   */
  setCurrentItemKeys(itemKeys: string[]): void {
    this.currentItemKeys = itemKeys;
  }

  /**
   * 获取当前活动的多个 Item Keys
   */
  getCurrentItemKeys(): string[] {
    return this.currentItemKeys;
  }

  /**
   * 批量提取多个论文的结构（用于多文档比较）
   */
  async extractAndParsePapers(
    itemKeys: string[],
  ): Promise<Map<string, PaperStructureExtended>> {
    const results = new Map<string, PaperStructureExtended>();
    for (const key of itemKeys) {
      const structure = await this.extractAndParsePaper(key);
      if (structure) {
        results.set(key, structure);
      }
    }
    return results;
  }

  /**
   * 根据 itemKey 获取 Zotero Item
   */
  private getItemByKey(itemKey: string): Zotero.Item | null {
    const libraryID = Zotero.Libraries.userLibraryID;
    const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
    return item || null;
  }

  /**
   * 根据 itemKey 提取 PDF 文本并解析结构（带缓存）
   */
  async extractAndParsePaper(
    itemKey: string,
  ): Promise<PaperStructureExtended | null> {
    // 检查缓存
    const cached = this.paperCache.get(itemKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      ztoolkit.log(`[PdfToolManager] Cache hit for item: ${itemKey}`);
      return cached.structure;
    }

    const item = this.getItemByKey(itemKey);
    if (!item) {
      return null;
    }

    let structure: PaperStructureExtended | null = null;

    // 如果 item 本身就是 PDF 附件，直接提取
    if (
      item.isAttachment &&
      item.isAttachment() &&
      item.isPDFAttachment &&
      item.isPDFAttachment()
    ) {
      const pdfText = await item.attachmentText;
      if (pdfText) {
        structure = this.parsePaperStructure(pdfText);
      }
    } else if (item.isAttachment && item.isAttachment()) {
      // 非 PDF 附件，无法提取
      ztoolkit.log(
        `[PdfToolManager] Item ${itemKey} is a non-PDF attachment, cannot extract structure`,
      );
    } else {
      // 普通条目，获取其 PDF 附件
      // 注意：getAttachments() 只能在非附件 item 上调用
      try {
        const attachmentIDs = item.getAttachments();
        for (const attachmentID of attachmentIDs) {
          const attachment = Zotero.Items.get(attachmentID);
          if (
            attachment &&
            attachment.isPDFAttachment &&
            attachment.isPDFAttachment()
          ) {
            // 提取 PDF 文本
            const pdfText = await attachment.attachmentText;
            if (pdfText) {
              structure = this.parsePaperStructure(pdfText);
              break;
            }
          }
        }
      } catch (error) {
        ztoolkit.log(
          `[PdfToolManager] Error getting attachments for ${itemKey}:`,
          getErrorMessage(error),
        );
      }
    }

    // 缓存结果
    if (structure) {
      this.addToCache(itemKey, structure);
    }

    return structure;
  }

  /**
   * 添加到缓存（带大小限制）
   */
  private addToCache(itemKey: string, structure: PaperStructureExtended): void {
    // 如果缓存已满，删除最旧的条目
    if (this.paperCache.size >= this.MAX_CACHE_SIZE) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, entry] of this.paperCache) {
        if (entry.timestamp < oldestTime) {
          oldestTime = entry.timestamp;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.paperCache.delete(oldestKey);
        ztoolkit.log(`[PdfToolManager] Cache evicted: ${oldestKey}`);
      }
    }

    this.paperCache.set(itemKey, {
      structure,
      timestamp: Date.now(),
    });
    ztoolkit.log(`[PdfToolManager] Cached structure for: ${itemKey}`);
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.paperCache.clear();
    ztoolkit.log("[PdfToolManager] Cache cleared");
  }

  /**
   * 从缓存中移除指定条目
   */
  invalidateCache(itemKey: string): void {
    this.paperCache.delete(itemKey);
  }

  /**
   * 解析论文结构（公开方法，委托给 paperParser）
   */
  parsePaperStructure(pdfText: string): PaperStructureExtended {
    return parsePaperStructure(pdfText);
  }

  /**
   * itemKey 参数定义（所有工具共用）
   */
  private getItemKeyProperty(): Record<string, ToolParameterProperty> {
    return {
      itemKey: {
        type: "string",
        description:
          "Optional. The Zotero item key of the paper to query (e.g., 'ABC12345'). If not specified, uses the current active paper. Use this to query a specific paper when comparing multiple papers.",
      },
    };
  }

  /**
   * 获取可用工具定义
   * @param hasCurrentItem 是否有当前选中的 item，用于动态调整工具列表
   */
  getToolDefinitions(hasCurrentItem: boolean = true): ToolDefinition[] {
    const itemKeyProp = this.getItemKeyProperty();

    // Library 工具 (始终可用，不需要 PDF)
    const libraryTools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "list_all_items",
          description:
            "List all items in the Zotero library with pagination. Returns item keys, titles, and whether they have PDF attachments. Use this to discover available papers for cross-paper analysis.",
          parameters: {
            type: "object",
            properties: {
              page: {
                type: "number",
                description: "Page number (1-indexed). Default: 1",
              },
              pageSize: {
                type: "number",
                description: "Number of items per page (max 50). Default: 20",
              },
              hasPdf: {
                type: "boolean",
                description:
                  "If true, only return items with PDF attachments. Default: false (return all items)",
              },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_item_metadata",
          description:
            "Get metadata of a Zotero item by its key. Works for any item type (with or without PDF). Returns title, authors, year, DOI, abstract, tags, and other bibliographic information.",
          parameters: {
            type: "object",
            properties: {
              itemKey: {
                type: "string",
                description:
                  "The Zotero item key (e.g., 'ABC12345'). Required.",
              },
            },
            required: ["itemKey"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_item_notes",
          description:
            "Get all notes (annotations and user notes) associated with a Zotero item. Returns a list of note keys with previews.",
          parameters: {
            type: "object",
            properties: {
              ...itemKeyProp,
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_note_content",
          description:
            "Get the full content of a specific note by its key. Use get_item_notes first to discover available note keys.",
          parameters: {
            type: "object",
            properties: {
              noteKey: {
                type: "string",
                description: "The Zotero note key. Required.",
              },
            },
            required: ["noteKey"],
          },
        },
      },
      // ========== 新增高级库工具 ==========
      {
        type: "function",
        function: {
          name: "get_annotations",
          description:
            "Get PDF annotations (highlights, notes, underlines, images) from a paper. Returns annotation text, comments, colors, and page numbers. Can filter by type or get only currently selected annotations.",
          parameters: {
            type: "object",
            properties: {
              ...itemKeyProp,
              annotationType: {
                type: "string",
                description:
                  "Filter by annotation type. Options: highlight, note, underline, image, all. Default: all",
                enum: ["highlight", "note", "underline", "image", "all"],
              },
              selectedOnly: {
                type: "boolean",
                description:
                  "If true, only return annotations that are currently selected in the PDF reader. Default: false",
              },
              includePosition: {
                type: "boolean",
                description:
                  "If true, include detailed position information (rect coordinates) for each annotation. Default: false",
              },
              limit: {
                type: "number",
                description:
                  "Maximum number of annotations to return (max 100). Default: 50",
              },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_pdf_selection",
          description:
            "Get the text currently selected by the user in the PDF reader. Use this when the user asks about specific text they have highlighted or selected, or to check if the user has selected any text.",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      },
      {
        type: "function",
        function: {
          name: "search_items",
          description:
            "Search for items in Zotero library by keyword. Searches across titles, authors, and other metadata.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The search keyword or phrase. Required.",
              },
              field: {
                type: "string",
                description:
                  "Search scope: title (titles only), creator (authors only), tag (exact tag match), everywhere (all fields). Default: everywhere",
                enum: ["title", "creator", "tag", "everywhere"],
              },
              itemType: {
                type: "string",
                description:
                  "Filter by item type (e.g., journalArticle, book, conferencePaper). Optional.",
              },
              limit: {
                type: "number",
                description:
                  "Maximum number of results to return (max 50). Default: 20",
              },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_collections",
          description:
            "List collections (folders) in the Zotero library. Shows collection hierarchy with item counts.",
          parameters: {
            type: "object",
            properties: {
              parentKey: {
                type: "string",
                description:
                  "Get sub-collections of a specific collection. If omitted, returns top-level collections.",
              },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_collection_items",
          description:
            "Get all items in a specific collection by its key.",
          parameters: {
            type: "object",
            properties: {
              collectionKey: {
                type: "string",
                description: "The collection key. Required.",
              },
              limit: {
                type: "number",
                description:
                  "Maximum number of items to return (max 100). Default: 30",
              },
            },
            required: ["collectionKey"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_tags",
          description:
            "Get all tags used in the Zotero library, sorted alphabetically.",
          parameters: {
            type: "object",
            properties: {
              limit: {
                type: "number",
                description:
                  "Maximum number of tags to return (max 500). Default: 100",
              },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "search_by_tag",
          description:
            "Find items with specific tag(s). Supports multiple tags with AND/OR logic.",
          parameters: {
            type: "object",
            properties: {
              tags: {
                type: "string",
                description:
                  "Comma-separated list of tags to search for. Required.",
              },
              mode: {
                type: "string",
                description:
                  "How to combine multiple tags: 'and' (all tags required) or 'or' (any tag matches). Default: or",
                enum: ["and", "or"],
              },
              limit: {
                type: "number",
                description:
                  "Maximum number of results to return (max 100). Default: 30",
              },
            },
            required: ["tags"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_recent",
          description:
            "Get recently added items in the Zotero library, sorted by date added (newest first).",
          parameters: {
            type: "object",
            properties: {
              limit: {
                type: "number",
                description:
                  "Maximum number of items to return (max 100). Default: 20",
              },
              days: {
                type: "number",
                description:
                  "Only return items added in the last N days. Optional.",
              },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "search_notes",
          description:
            "Search for notes across all items in the library by content.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The search text to find in notes. Required.",
              },
              limit: {
                type: "number",
                description:
                  "Maximum number of notes to return (max 50). Default: 20",
              },
            },
            required: ["query"],
          },
        },
      },
    ];

    // 写入工具（根据设置动态添加）
    const enableAIWrite = getPref("enableAIWriteOperations") as boolean;
    if (enableAIWrite) {
      libraryTools.push(
        {
          type: "function",
          function: {
            name: "create_note",
            description:
              "Create a new note in Zotero, optionally attached to a specific item. The note will be saved to the user's library.",
            parameters: {
              type: "object",
              properties: {
                ...itemKeyProp,
                content: {
                  type: "string",
                  description:
                    "The note content. Can be plain text or HTML. Required.",
                },
                tags: {
                  type: "string",
                  description: "Comma-separated list of tags to add. Optional.",
                },
              },
              required: ["content"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "batch_update_tags",
            description:
              "Add or remove tags from multiple items matching a search query. Useful for organizing your library.",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description:
                    "Search query to find items to update. Required.",
                },
                addTags: {
                  type: "string",
                  description:
                    "Comma-separated list of tags to add to matching items.",
                },
                removeTags: {
                  type: "string",
                  description:
                    "Comma-separated list of tags to remove from matching items.",
                },
                limit: {
                  type: "number",
                  description:
                    "Maximum number of items to affect (max 100). Default: 50",
                },
              },
              required: ["query"],
            },
          },
        },
      );
    }

    // 如果没有当前 item，只返回 library 工具
    if (!hasCurrentItem) {
      return libraryTools;
    }

    // PDF 内容工具 (需要有当前 item)
    const pdfTools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "get_paper_section",
          description:
            "Get the content of a specific section from a paper. NOTE: Section detection works best for English papers with standard headings (Introduction, Methodology, Results, etc.). For non-English papers or if section not found, use search_paper_content instead with relevant keywords.",
          parameters: {
            type: "object",
            properties: {
              ...itemKeyProp,
              section: {
                type: "string",
                description:
                  "The section name to retrieve. Common sections: abstract, introduction, related_work, methodology, experiments, results, discussion, conclusion, references",
                enum: [
                  "abstract",
                  "introduction",
                  "related_work",
                  "methodology",
                  "experiments",
                  "results",
                  "discussion",
                  "conclusion",
                  "references",
                ],
              },
            },
            required: ["section"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "search_paper_content",
          description:
            "Search for specific content in a paper using semantic search. This is the most versatile search tool - it works well with ALL languages (English, Chinese, etc.) and can find conceptually related content even without exact keyword matches. Prefer this tool for non-English papers or when looking for concepts rather than exact terms.",
          parameters: {
            type: "object",
            properties: {
              ...itemKeyProp,
              query: {
                type: "string",
                description: "The search query (keywords or phrase to find)",
              },
              max_results: {
                type: "number",
                description:
                  "Maximum number of matching paragraphs to return (default: 5)",
              },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_paper_metadata",
          description:
            "Get a paper's metadata including title, authors, abstract, and keywords. Use this to get an overview of the paper.",
          parameters: {
            type: "object",
            properties: {
              ...itemKeyProp,
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_pages",
          description:
            "Get text content of specific pages by page range from a paper. Use this when you need to read specific pages of the paper.",
          parameters: {
            type: "object",
            properties: {
              ...itemKeyProp,
              pages: {
                type: "string",
                description:
                  'Page range specification. Examples: "1" (single page), "1-5" (range), "1,3,5" (multiple pages), "1-3,7,10-12" (mixed)',
              },
            },
            required: ["pages"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_page_count",
          description:
            "Get the total number of pages in a paper. Use this to understand the paper's length.",
          parameters: {
            type: "object",
            properties: {
              ...itemKeyProp,
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "search_with_regex",
          description:
            "Advanced search with regex support and context in a paper. Use this for complex pattern matching or when you need surrounding context for matches.",
          parameters: {
            type: "object",
            properties: {
              ...itemKeyProp,
              pattern: {
                type: "string",
                description:
                  "Search pattern. Can be plain text or regex pattern if use_regex is true",
              },
              use_regex: {
                type: "boolean",
                description:
                  "Whether to treat pattern as regex (default: false)",
              },
              case_sensitive: {
                type: "boolean",
                description:
                  "Whether search is case sensitive (default: false)",
              },
              context_lines: {
                type: "number",
                description:
                  "Number of lines to include before and after each match (default: 2)",
              },
              max_results: {
                type: "number",
                description:
                  "Maximum number of results to return (default: 10)",
              },
            },
            required: ["pattern"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_outline",
          description:
            "Get a paper's outline/table of contents showing the document structure with section headings. NOTE: Outline detection works best for English papers with standard academic headings. For non-English papers, the outline may be incomplete or missing - use search_paper_content to find specific content instead.",
          parameters: {
            type: "object",
            properties: {
              ...itemKeyProp,
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "list_sections",
          description:
            "List all detected sections in a paper with their character counts. NOTE: Section detection works best for English papers with standard academic headings. For non-English papers, sections may not be detected properly - use search_paper_content with relevant keywords as a more reliable alternative.",
          parameters: {
            type: "object",
            properties: {
              ...itemKeyProp,
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_full_text",
          description:
            "Get the complete raw text content of the entire paper. WARNING: This tool returns the ENTIRE paper content and consumes a very large number of tokens. Only use this as a LAST RESORT when other tools (get_paper_section, get_pages, search_paper_content) cannot provide the information you need. Prefer using targeted tools first.",
          parameters: {
            type: "object",
            properties: {
              ...itemKeyProp,
              confirm: {
                type: "boolean",
                description:
                  "Must be set to true to confirm you understand this will consume many tokens. Set to true only if absolutely necessary.",
              },
            },
            required: ["confirm"],
          },
        },
      },
    ];

    // 多文档比较工具（仅在选择了多个文档时可用）
    const comparisonTools: ToolDefinition[] = [];
    if (this.currentItemKeys.length > 1) {
      comparisonTools.push(
        {
          type: "function",
          function: {
            name: "compare_papers",
            description:
              "Compare specific aspects across multiple papers. Use this when you need to compare methodology, results, or conclusions between papers.",
            parameters: {
              type: "object",
              properties: {
                itemKeys: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Array of paper item keys to compare. If not provided, compares all currently selected papers.",
                },
                aspect: {
                  type: "string",
                  description:
                    "The aspect to compare: methodology (research methods), results (findings), conclusions, or all. Default: all",
                  enum: ["methodology", "results", "conclusions", "all"],
                },
                section: {
                  type: "string",
                  description:
                    "Optionally compare a specific section by name (e.g., 'introduction', 'experiments').",
                },
              },
            },
          },
        },
        {
          type: "function",
          function: {
            name: "search_across_papers",
            description:
              "Search for content across all selected papers simultaneously using semantic search. Works well with ALL languages and can find conceptually related content. Returns matches from each paper.",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "The search query to find across papers.",
                },
                itemKeys: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Optional: specific paper keys to search. If not provided, searches all currently selected papers.",
                },
                max_results_per_paper: {
                  type: "number",
                  description:
                    "Maximum results per paper (default: 3, max: 10).",
                },
              },
              required: ["query"],
            },
          },
        },
      );
    }

    // 返回 PDF 工具 + Library 工具 + 比较工具
    return [...pdfTools, ...libraryTools, ...comparisonTools];
  }

  // === 类型守卫函数 ===

  private isListAllItemsArgs(args: unknown): args is ListAllItemsArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      (typeof (args as ListAllItemsArgs).page === "undefined" ||
        typeof (args as ListAllItemsArgs).page === "number") &&
      (typeof (args as ListAllItemsArgs).pageSize === "undefined" ||
        typeof (args as ListAllItemsArgs).pageSize === "number")
    );
  }

  private isGetItemMetadataArgs(args: unknown): args is GetItemMetadataArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as GetItemMetadataArgs).itemKey === "string"
    );
  }

  private isGetItemNotesArgs(args: unknown): args is GetItemNotesArgs {
    return typeof args === "object" && args !== null;
  }

  private isGetNoteContentArgs(args: unknown): args is GetNoteContentArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as GetNoteContentArgs).noteKey === "string"
    );
  }

  private isGetPaperSectionArgs(args: unknown): args is GetPaperSectionArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as GetPaperSectionArgs).section === "string"
    );
  }

  private isSearchPaperContentArgs(
    args: unknown,
  ): args is SearchPaperContentArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as SearchPaperContentArgs).query === "string"
    );
  }

  private isGetPagesArgs(args: unknown): args is GetPagesArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as GetPagesArgs).pages === "string"
    );
  }

  private isSearchWithRegexArgs(args: unknown): args is SearchWithRegexArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as SearchWithRegexArgs).pattern === "string"
    );
  }

  private isGetFullTextArgs(args: unknown): args is GetFullTextArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as GetFullTextArgs).confirm === "boolean"
    );
  }

  // === 新增工具的类型守卫 ===

  private isGetAnnotationsArgs(args: unknown): args is GetAnnotationsArgs {
    return typeof args === "object" && args !== null;
  }

  private isSearchItemsArgs(args: unknown): args is SearchItemsArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as SearchItemsArgs).query === "string"
    );
  }

  private isGetCollectionsArgs(args: unknown): args is GetCollectionsArgs {
    return typeof args === "object" && args !== null;
  }

  private isGetCollectionItemsArgs(
    args: unknown,
  ): args is GetCollectionItemsArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as GetCollectionItemsArgs).collectionKey === "string"
    );
  }

  private isGetTagsArgs(args: unknown): args is GetTagsArgs {
    return typeof args === "object" && args !== null;
  }

  private isSearchByTagArgs(args: unknown): args is SearchByTagArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as SearchByTagArgs).tags === "string"
    );
  }

  private isGetRecentArgs(args: unknown): args is GetRecentArgs {
    return typeof args === "object" && args !== null;
  }

  private isSearchNotesArgs(args: unknown): args is SearchNotesArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as SearchNotesArgs).query === "string"
    );
  }

  private isCreateNoteArgs(args: unknown): args is CreateNoteArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as CreateNoteArgs).content === "string"
    );
  }

  private isBatchUpdateTagsArgs(args: unknown): args is BatchUpdateTagsArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as BatchUpdateTagsArgs).query === "string"
    );
  }

  // === 多文档比较工具的类型守卫 ===

  private isComparePapersArgs(args: unknown): args is ComparePapersArgs {
    return typeof args === "object" && args !== null;
  }

  private isSearchAcrossPapersArgs(
    args: unknown,
  ): args is SearchAcrossPapersArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as SearchAcrossPapersArgs).query === "string"
    );
  }

  /**
   * 执行工具调用（异步，按需提取 PDF）
   * @param toolCall AI 请求的工具调用
   * @param fallbackStructure 后备的 paperStructure（当前 item 的，如果无法按 itemKey 找到）
   */
  async executeToolCall(
    toolCall: ToolCall,
    fallbackStructure?: PaperStructure | PaperStructureExtended,
  ): Promise<string> {
    const { name, arguments: argsString } = toolCall.function;

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsString);
    } catch {
      return `Error: Invalid arguments JSON: ${argsString}`;
    }

    // === Zotero Library 工具（不需要 PDF）===
    switch (name) {
      case "list_all_items":
        if (!this.isListAllItemsArgs(args)) {
          return "Error: Invalid arguments for list_all_items";
        }
        return executeListAllItems(args);
      case "get_item_metadata":
        if (!this.isGetItemMetadataArgs(args)) {
          return "Error: Invalid arguments for get_item_metadata. Required: itemKey (string)";
        }
        return executeGetItemMetadata(args);
      case "get_item_notes":
        if (!this.isGetItemNotesArgs(args)) {
          return "Error: Invalid arguments for get_item_notes";
        }
        return executeGetItemNotes(args, this.currentItemKey);
      case "get_note_content":
        if (!this.isGetNoteContentArgs(args)) {
          return "Error: Invalid arguments for get_note_content. Required: noteKey (string)";
        }
        return executeGetNoteContent(args);

      // === 新增高级库工具 ===
      case "get_annotations":
        if (!this.isGetAnnotationsArgs(args)) {
          return "Error: Invalid arguments for get_annotations";
        }
        return executeGetAnnotations(args, this.currentItemKey);

      case "get_pdf_selection":
        return executeGetPdfSelection();

      case "search_items":
        if (!this.isSearchItemsArgs(args)) {
          return "Error: Invalid arguments for search_items. Required: query (string)";
        }
        return executeSearchItems(args);

      case "get_collections":
        if (!this.isGetCollectionsArgs(args)) {
          return "Error: Invalid arguments for get_collections";
        }
        return executeGetCollections(args);

      case "get_collection_items":
        if (!this.isGetCollectionItemsArgs(args)) {
          return "Error: Invalid arguments for get_collection_items. Required: collectionKey (string)";
        }
        return executeGetCollectionItems(args);

      case "get_tags":
        if (!this.isGetTagsArgs(args)) {
          return "Error: Invalid arguments for get_tags";
        }
        return executeGetTags(args);

      case "search_by_tag":
        if (!this.isSearchByTagArgs(args)) {
          return "Error: Invalid arguments for search_by_tag. Required: tags (string)";
        }
        return executeSearchByTag(args);

      case "get_recent":
        if (!this.isGetRecentArgs(args)) {
          return "Error: Invalid arguments for get_recent";
        }
        return executeGetRecent(args);

      case "search_notes":
        if (!this.isSearchNotesArgs(args)) {
          return "Error: Invalid arguments for search_notes. Required: query (string)";
        }
        return executeSearchNotes(args);

      case "create_note": {
        // 检查写入权限
        const canWrite1 = getPref("enableAIWriteOperations") as boolean;
        if (!canWrite1) {
          return "Error: AI write operations are disabled. The user needs to enable 'Allow AI to create notes and modify tags' in settings.";
        }
        if (!this.isCreateNoteArgs(args)) {
          return "Error: Invalid arguments for create_note. Required: content (string)";
        }
        return executeCreateNote(args, this.currentItemKey);
      }

      case "batch_update_tags": {
        // 检查写入权限
        const canWrite2 = getPref("enableAIWriteOperations") as boolean;
        if (!canWrite2) {
          return "Error: AI write operations are disabled. The user needs to enable 'Allow AI to create notes and modify tags' in settings.";
        }
        if (!this.isBatchUpdateTagsArgs(args)) {
          return "Error: Invalid arguments for batch_update_tags. Required: query (string)";
        }
        return executeBatchUpdateTags(args);
      }

      // === 多文档比较工具 ===
      case "compare_papers": {
        if (!this.isComparePapersArgs(args)) {
          return "Error: Invalid arguments for compare_papers";
        }
        return this.executeComparePapers(args);
      }

      case "search_across_papers": {
        if (!this.isSearchAcrossPapersArgs(args)) {
          return "Error: Invalid arguments for search_across_papers. Required: query (string)";
        }
        return this.executeSearchAcrossPapers(args);
      }
    }

    // === PDF 内容工具（需要 PDF）===
    // 解析 itemKey：优先使用参数中的 itemKey，否则使用当前 itemKey
    const requestedItemKey = (args as BaseToolArgs).itemKey;
    const targetItemKey = requestedItemKey ?? this.currentItemKey;

    // 获取 paperStructure（按需提取）
    let paperStructure: PaperStructureExtended | null = null;

    if (targetItemKey) {
      // 按 itemKey 提取 PDF
      paperStructure = await this.extractAndParsePaper(targetItemKey);
    }

    // 如果按 itemKey 找不到，使用后备结构
    if (!paperStructure && fallbackStructure) {
      paperStructure = this.ensureExtendedStructure(fallbackStructure);
    }

    if (!paperStructure) {
      if (targetItemKey) {
        return `Error: Could not extract PDF content for item "${targetItemKey}". The item may not exist or may not have a PDF attachment.`;
      }
      return `Error: No paper content available. Please specify an itemKey or ensure the current item has a PDF attachment.`;
    }

    switch (name) {
      case "get_paper_section":
        if (!this.isGetPaperSectionArgs(args)) {
          return "Error: Invalid arguments for get_paper_section. Required: section (string)";
        }
        return executeGetPaperSection(args, paperStructure);
      case "search_paper_content":
        if (!this.isSearchPaperContentArgs(args)) {
          return "Error: Invalid arguments for search_paper_content. Required: query (string)";
        }
        return executeSearchPaperContent(args, paperStructure, targetItemKey ?? undefined);
      case "get_paper_metadata":
        return executeGetPaperMetadata(paperStructure);
      case "get_pages":
        if (!this.isGetPagesArgs(args)) {
          return "Error: Invalid arguments for get_pages. Required: pages (string)";
        }
        return executeGetPages(args, paperStructure);
      case "get_page_count":
        return executeGetPageCount(paperStructure);
      case "search_with_regex":
        if (!this.isSearchWithRegexArgs(args)) {
          return "Error: Invalid arguments for search_with_regex. Required: pattern (string)";
        }
        return executeSearchWithRegex(args, paperStructure);
      case "get_outline":
        return executeGetOutline(paperStructure);
      case "list_sections":
        return executeListSections(paperStructure);
      case "get_full_text":
        if (!this.isGetFullTextArgs(args)) {
          return "Error: Invalid arguments for get_full_text. Required: confirm (boolean)";
        }
        return executeGetFullText(args, paperStructure);
      default:
        return `Error: Unknown tool: ${name}`;
    }
  }

  /**
   * 确保结构包含页面信息
   */
  private ensureExtendedStructure(
    structure: PaperStructure | PaperStructureExtended,
  ): PaperStructureExtended {
    if ("pages" in structure && "pageCount" in structure) {
      return structure as PaperStructureExtended;
    }

    // 补充页面信息
    const pages = parsePages(structure.fullText);
    return {
      ...structure,
      pages,
      pageCount: pages.length,
    };
  }

  /**
   * 生成系统提示（委托给 promptGenerator）
   * @param currentPaperStructure 当前论文的结构（可选）
   * @param currentItemKey 当前 item 的 key（可选）
   * @param currentTitle 当前论文标题（可选）
   * @param hasCurrentItem 是否有当前选中的 item
   */
  generatePaperContextPrompt(
    currentPaperStructure?: PaperStructureExtended,
    currentItemKey?: string,
    currentTitle?: string,
    hasCurrentItem: boolean = true,
  ): string {
    return generatePaperContextPromptFn(
      currentPaperStructure,
      currentItemKey,
      currentTitle,
      hasCurrentItem,
    );
  }

  // === 多文档比较工具的执行方法 ===

  /**
   * 执行 compare_papers 工具
   * 比较多篇论文的特定方面
   */
  private async executeComparePapers(args: ComparePapersArgs): Promise<string> {
    // 确定要比较的论文 keys
    const itemKeys = args.itemKeys?.length ? args.itemKeys : this.currentItemKeys;

    if (itemKeys.length < 2) {
      return "Error: compare_papers requires at least 2 papers. Please select multiple papers or provide itemKeys array.";
    }

    // 提取所有论文的结构
    const papersMap = await this.extractAndParsePapers(itemKeys);

    if (papersMap.size < 2) {
      return `Error: Could only extract ${papersMap.size} paper(s). Need at least 2 for comparison.`;
    }

    const aspect = args.aspect || "all";
    const results: string[] = [];

    results.push(`=== Comparing ${papersMap.size} Papers ===\n`);

    // 获取每篇论文的标题
    for (const [key, structure] of papersMap) {
      const title = structure.metadata.title || key;
      results.push(`- [${key}] "${title}"`);
    }
    results.push("");

    // 根据 aspect 提取对应内容
    const sectionsToCompare: string[] = [];
    if (aspect === "methodology" || aspect === "all") {
      sectionsToCompare.push("methodology", "methods", "approach");
    }
    if (aspect === "results" || aspect === "all") {
      sectionsToCompare.push("results", "experiments", "evaluation");
    }
    if (aspect === "conclusions" || aspect === "all") {
      sectionsToCompare.push("conclusion", "conclusions", "discussion");
    }
    if (args.section) {
      sectionsToCompare.push(args.section.toLowerCase());
    }

    // 对每篇论文提取相关章节
    for (const [key, structure] of papersMap) {
      const title = structure.metadata.title || key;
      results.push(`\n--- Paper [${key}]: ${title} ---\n`);

      let foundContent = false;
      for (const sectionName of sectionsToCompare) {
        const section = structure.sections.find(
          (s) =>
            s.normalizedName === sectionName ||
            s.name.toLowerCase().includes(sectionName),
        );
        if (section) {
          foundContent = true;
          results.push(`**${section.name}:**`);
          // 截断到合理长度
          const content =
            section.content.length > 2000
              ? section.content.substring(0, 2000) + "... [truncated]"
              : section.content;
          results.push(content);
          results.push("");
        }
      }

      if (!foundContent) {
        // 如果没有找到具体章节，返回摘要
        if (structure.metadata.abstract) {
          results.push("**Abstract:**");
          results.push(structure.metadata.abstract);
        } else {
          results.push("(No matching sections found for this paper)");
        }
      }
    }

    return results.join("\n");
  }

  /**
   * 执行 search_across_papers 工具
   * 在多篇论文中搜索内容（支持语义搜索）
   */
  private async executeSearchAcrossPapers(
    args: SearchAcrossPapersArgs,
  ): Promise<string> {
    const query = args.query;
    const itemKeys = args.itemKeys?.length ? args.itemKeys : this.currentItemKeys;
    const maxResultsPerPaper = Math.min(args.max_results_per_paper || 3, 10);

    if (itemKeys.length === 0) {
      return "Error: No papers selected. Please select papers or provide itemKeys array.";
    }

    // 提取所有论文的结构
    const papersMap = await this.extractAndParsePapers(itemKeys);

    if (papersMap.size === 0) {
      return "Error: Could not extract any paper content.";
    }

    const results: string[] = [];
    results.push(`=== Search Results for "${query}" across ${papersMap.size} papers ===\n`);

    // 尝试使用语义搜索
    const { getRAGService } = await import("../../embedding");
    const ragService = getRAGService();
    const useSemanticSearch = await ragService.isAvailable();

    if (useSemanticSearch) {
      // 确保所有论文都已索引
      for (const [key, structure] of papersMap) {
        if (!await ragService.isIndexed(key)) {
          ztoolkit.log(`[searchAcrossPapers] Indexing paper: ${key}`);
          await ragService.indexPaper(key, structure.fullText);
        }
      }

      // 执行跨论文语义搜索
      const semanticResults = await ragService.searchAcrossPapers(
        query,
        Array.from(papersMap.keys()),
        { topK: maxResultsPerPaper * papersMap.size },
      );

      if (semanticResults.length > 0) {
        // 按论文分组结果
        const resultsByPaper = new Map<string, typeof semanticResults>();
        for (const result of semanticResults) {
          const paperResults = resultsByPaper.get(result.itemKey) || [];
          if (paperResults.length < maxResultsPerPaper) {
            paperResults.push(result);
            resultsByPaper.set(result.itemKey, paperResults);
          }
        }

        for (const [key, structure] of papersMap) {
          const title = structure.metadata.title || key;
          results.push(`\n--- Paper [${key}]: ${title} ---\n`);

          const paperResults = resultsByPaper.get(key);
          if (paperResults && paperResults.length > 0) {
            results.push(`Found ${paperResults.length} semantically relevant match(es):\n`);
            paperResults.forEach((match, i) => {
              const truncated =
                match.text.length > 500 ? match.text.substring(0, 500) + "..." : match.text;
              const pageInfo = match.page ? ` (Page ${match.page})` : "";
              results.push(`${i + 1}. [Score: ${(match.score * 100).toFixed(1)}%${pageInfo}] ${truncated}\n`);
            });
          } else {
            results.push("No semantic matches found in this paper.\n");
          }
        }

        return results.join("\n");
      }
    }

    // 降级到关键词搜索
    const queryLower = query.toLowerCase();

    for (const [key, structure] of papersMap) {
      const title = structure.metadata.title || key;
      results.push(`\n--- Paper [${key}]: ${title} ---\n`);

      // 搜索全文
      const fullText = structure.fullText;
      const paragraphs = fullText.split(/\n\s*\n/);
      const matches: string[] = [];

      for (const para of paragraphs) {
        if (para.toLowerCase().includes(queryLower) && para.trim().length > 20) {
          // 高亮匹配
          const highlighted = para.trim();
          matches.push(highlighted);
          if (matches.length >= maxResultsPerPaper) break;
        }
      }

      if (matches.length > 0) {
        results.push(`Found ${matches.length} match(es):\n`);
        matches.forEach((match, i) => {
          const truncated =
            match.length > 500 ? match.substring(0, 500) + "..." : match;
          results.push(`${i + 1}. ${truncated}\n`);
        });
      } else {
        results.push("No matches found in this paper.\n");
      }
    }

    return results.join("\n");
  }
}
