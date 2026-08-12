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
  SearchFulltextArgs,
  RunSavedSearchArgs,
  UpdateItemMetadataArgs,
  LinkRelatedItemsArgs,
  ScholarlySearchArgs,
  WebSearchArgs,
  GetCollectionsArgs,
  GetCollectionItemsArgs,
  GetTagsArgs,
  SearchByTagArgs,
  GetRecentArgs,
  SearchNotesArgs,
  AppendToNoteArgs,
  CreateNoteArgs,
  BatchUpdateTagsArgs,
  AddItemArgs,
  // 记忆工具类型
  SaveMemoryArgs,
} from "../../../types/tool";
import { getMemoryService } from "../memory/MemoryService";
import {
  executeScholarlySearch,
  executeWebSearch,
  isValidScholarlySearchArgs,
  isValidWebSearchArgs,
} from "../web-search";
import { preflightToolArguments } from "../tool-arguments/ToolArgumentPreflight";
import { parsePaperStructure, parsePages } from "./paperParser";
import {
  extractNativeOutline,
  type NativeOutlineExtraction,
} from "./nativeOutlineExtractor";
import type { AgentPromptContext } from "./promptGenerator";
import type { SearchToolPromptMode } from "../agent-runtime/SearchScopeGate";
import { generatePaperContextPrompt as generatePaperContextPromptFn } from "./promptGenerator";
import { createSearchToolDefinitions } from "./SearchToolDefinitions";
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
  executeSearchFulltext,
  executeListSavedSearches,
  executeRunSavedSearch,
  executeUpdateItemMetadata,
  executeLinkRelatedItems,
  executeGetCollections,
  executeGetCollectionItems,
  executeGetTags,
  executeSearchByTag,
  executeGetRecent,
  executeSearchNotes,
  executeCreateNote,
  executeAppendToNote,
  executeBatchUpdateTags,
  executeAddItem,
} from "./libraryExecutors";
import { getErrorMessage } from "../../../utils/common";
import {
  createPresentationToolDefinition,
  executePresentationCapability,
} from "../../presentation";
import { resolvePresentationSourceItemKey } from "../../presentation/PresentationSourceContext";
import type { ToolSchedulerExecutionContext } from "../tool-scheduler/ToolScheduler";

// 缓存条目类型
interface CacheEntry {
  structure: PaperStructureExtended;
  timestamp: number;
  attachmentItemID: number;
}

export class PdfToolManager {
  // 当前活动的 Item Key (单文档，向后兼容)
  private currentItemKey: string | null = null;

  // PDF 解析缓存（避免重复解析同一个 PDF）
  private paperCache: Map<string, CacheEntry> = new Map();
  private nativeOutlineRequests = new Map<
    number,
    Promise<NativeOutlineExtraction | null>
  >();
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
   * 根据 itemKey 获取 Zotero Item
   */
  private getItemByKey(itemKey: string): Zotero.Item | null {
    const libraryID = Zotero.Libraries.userLibraryID;
    const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
    return item || null;
  }

  /**
   * 解析 itemKey 对应的 PDF 附件 ID（item 本身是 PDF 附件或其第一个 PDF 附件）。
   * 用于文本提取失败但 reader 可能仍打开着该附件的场景（原生大纲提取）。
   */
  private findPdfAttachmentItemID(itemKey: string): number | null {
    const item = this.getItemByKey(itemKey);
    if (!item) return null;

    if (item.isAttachment && item.isAttachment()) {
      return item.isPDFAttachment && item.isPDFAttachment() ? item.id : null;
    }

    try {
      for (const attachmentID of item.getAttachments()) {
        const attachment = Zotero.Items.get(attachmentID);
        if (
          attachment &&
          attachment.isPDFAttachment &&
          attachment.isPDFAttachment()
        ) {
          return attachment.id;
        }
      }
    } catch (error) {
      ztoolkit.log(
        `[PdfToolManager] Error resolving PDF attachment for ${itemKey}:`,
        getErrorMessage(error),
      );
    }
    return null;
  }

  /**
   * 根据 itemKey 提取 PDF 文本并解析结构（带缓存）
   */
  async extractAndParsePaper(
    itemKey: string,
    includeNativeOutline: boolean = false,
  ): Promise<PaperStructureExtended | null> {
    // 检查缓存
    const cached = this.paperCache.get(itemKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      ztoolkit.log(`[PdfToolManager] Cache hit for item: ${itemKey}`);
      if (includeNativeOutline) {
        await this.enrichWithNativeOutline(
          cached.structure,
          cached.attachmentItemID,
        );
      }
      return cached.structure;
    }

    const item = this.getItemByKey(itemKey);
    if (!item) {
      return null;
    }

    let structure: PaperStructureExtended | null = null;
    let attachmentItemID: number | null = null;

    // 如果 item 本身就是 PDF 附件，直接提取
    if (
      item.isAttachment &&
      item.isAttachment() &&
      item.isPDFAttachment &&
      item.isPDFAttachment()
    ) {
      try {
        const pdfText = await item.attachmentText;
        if (pdfText) {
          structure = this.parsePaperStructure(pdfText);
          attachmentItemID = item.id;
        }
      } catch (error) {
        ztoolkit.log(
          `[PdfToolManager] Error extracting PDF text for ${itemKey}:`,
          getErrorMessage(error),
        );
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
              attachmentItemID = attachment.id;
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
    if (structure && attachmentItemID !== null) {
      if (includeNativeOutline) {
        await this.enrichWithNativeOutline(structure, attachmentItemID);
      }
      this.addToCache(itemKey, attachmentItemID, structure);
    }

    return structure;
  }

  /**
   * 添加到缓存（带大小限制）
   */
  private async enrichWithNativeOutline(
    structure: PaperStructureExtended,
    attachmentItemID: number,
  ): Promise<void> {
    if (structure.nativeOutline?.length) return;

    let request = this.nativeOutlineRequests.get(attachmentItemID);
    if (!request) {
      request = extractNativeOutline(attachmentItemID);
      this.nativeOutlineRequests.set(attachmentItemID, request);
    }

    let extraction: NativeOutlineExtraction | null;
    try {
      extraction = await request;
    } finally {
      if (this.nativeOutlineRequests.get(attachmentItemID) === request) {
        this.nativeOutlineRequests.delete(attachmentItemID);
      }
    }
    if (!extraction) return;

    structure.nativeOutline = extraction.outline;
    structure.nativePageCount = extraction.pageCount;
    ztoolkit.log(
      `[PdfToolManager] Native outline extracted for attachment item: ${attachmentItemID} (${extraction.outline.length} top-level items)`,
    );
  }

  private addToCache(
    itemKey: string,
    attachmentItemID: number,
    structure: PaperStructureExtended,
  ): void {
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
      attachmentItemID,
    });
    ztoolkit.log(`[PdfToolManager] Cached structure for: ${itemKey}`);
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.paperCache.clear();
    this.nativeOutlineRequests.clear();
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

  private formatPdfContentResult(
    result: string,
    resolvedSourceItemKey: string | null,
  ): string {
    if (!resolvedSourceItemKey || /^\s*Error:/i.test(result)) {
      return result;
    }
    return `Source item key: ${resolvedSourceItemKey}\n${result}`;
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
      createPresentationToolDefinition(),
      {
        type: "function" as const,
        function: {
          name: "request_user_input",
          description:
            "Ask the user a blocking clarification or decision question and wait for their answer before continuing. Use this only when multiple materially different next steps are possible, required context is missing, or user confirmation is needed. Prefer concrete options over free-form questions. Do not use this for minor style choices or when a safe default is obvious. Use the same language as the user.",
          parameters: {
            type: "object" as const,
            properties: {
              reason: {
                type: "string" as const,
                description:
                  "Optional internal reason for asking. Keep it short and user-respectful.",
              },
              questions: {
                type: "array" as const,
                description:
                  "Structured questions to ask. Use at most 3 concise questions.",
                minItems: 1,
                maxItems: 3,
                items: {
                  type: "object",
                  description: "A single user-facing question.",
                  properties: {
                    id: {
                      type: "string",
                      description:
                        "Stable snake_case identifier used in the answer object.",
                    },
                    header: {
                      type: "string",
                      description:
                        "Short label for the request, usually 1-3 words.",
                    },
                    question: {
                      type: "string",
                      description:
                        "The concrete question shown to the user. Use the user's language.",
                    },
                    type: {
                      type: "string",
                      enum: [
                        "single_choice",
                        "multi_choice",
                        "text",
                        "secret",
                        "confirm",
                      ],
                      description:
                        "Question type. Prefer single_choice or confirm. Use text only when options cannot capture the answer. Use secret only when the user explicitly needs to provide a private key/token.",
                    },
                    options: {
                      type: "array",
                      description:
                        "Choice options. Use 2-4 concrete options and mark one recommended when possible.",
                      minItems: 2,
                      maxItems: 4,
                      items: {
                        type: "object",
                        description: "A selectable answer option.",
                        properties: {
                          label: {
                            type: "string",
                            description:
                              "Short option label. Add '(Recommended)' to the recommended option label when appropriate.",
                          },
                          description: {
                            type: "string",
                            description:
                              "One short sentence explaining the tradeoff.",
                          },
                          value: {
                            type: "string",
                            description:
                              "Stable machine-readable answer value.",
                          },
                          recommended: {
                            type: "boolean",
                            description:
                              "Whether this option is the recommended default.",
                          },
                        },
                        required: ["label", "description"],
                      },
                    },
                    allowOther: {
                      type: "boolean",
                      description:
                        "Whether the user may provide a custom Other answer.",
                    },
                    required: {
                      type: "boolean",
                      description:
                        "Whether an answer is required. Defaults to true.",
                    },
                    placeholder: {
                      type: "string",
                      description:
                        "Placeholder for text-style questions in the full form UI.",
                    },
                    defaultValue: {
                      type: "string",
                      description:
                        "Default value for text/auto-resolution. Never provide this for secret questions. For choice questions, prefer recommended=true on an option.",
                    },
                    minSelections: {
                      type: "number",
                      description: "Minimum selections for multi_choice.",
                    },
                    maxSelections: {
                      type: "number",
                      description: "Maximum selections for multi_choice.",
                    },
                    isSecret: {
                      type: "boolean",
                      description:
                        "Whether the answer contains a secret and must not be shown in chat history.",
                    },
                  },
                  required: ["id", "header", "question", "type"],
                },
              },
              autoResolutionMs: {
                type: "number" as const,
                description:
                  "Optional auto-resolution timeout in milliseconds. Must be 60000-240000 and requires a recommended option or defaultValue.",
              },
            },
            required: ["questions"],
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "read_artifact",
          description:
            "Read exact content from a large tool result saved earlier in the current session. Use this only when an artifact-backed tool result preview is insufficient and you need the full text or a later slice. You can only read artifacts from the current session by artifact id; never provide file paths.",
          parameters: {
            type: "object" as const,
            properties: {
              artifactId: {
                type: "string" as const,
                description:
                  "Artifact id returned by a previous tool result, for example artifact-1730000000-abc123.",
              },
              offset: {
                type: "number" as const,
                description:
                  "Optional zero-based character offset. Default: 0.",
              },
              maxCharacters: {
                type: "number" as const,
                description:
                  "Optional maximum characters to return. Default and max: 20000.",
              },
            },
            required: ["artifactId"],
          },
        },
      },
      ...createSearchToolDefinitions(),
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
          name: "search_fulltext",
          description:
            "Search the full text of all indexed PDFs in the Zotero library. Use this to find which papers mention a concept, method, or phrase anywhere in their body text - not just in titles or metadata. Returns the parent papers, which can then be read with get_full_text.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "The word or phrase to look for inside PDF full text. Required.",
              },
              itemType: {
                type: "string",
                description:
                  "Filter results by parent item type (e.g., journalArticle, book, conferencePaper). Optional.",
              },
              limit: {
                type: "number",
                description:
                  "Maximum number of papers to return (max 50). Default: 20",
              },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "list_saved_searches",
          description:
            "List the user's saved searches in Zotero. Use this when the user refers to their own saved search by name, or to discover how they organize their library.",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      },
      {
        type: "function",
        function: {
          name: "run_saved_search",
          description:
            "Execute one of the user's saved searches and return the matching items. Get the searchKey from list_saved_searches first.",
          parameters: {
            type: "object",
            properties: {
              searchKey: {
                type: "string",
                description:
                  "The saved search key from list_saved_searches. Required.",
              },
              limit: {
                type: "number",
                description:
                  "Maximum number of items to return (max 50). Default: 20",
              },
            },
            required: ["searchKey"],
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
          description: "Get all items in a specific collection by its key.",
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
                  "The note content. Required. Interpreted as plain text unless format is explicitly html.",
              },
              format: {
                type: "string",
                enum: ["plain", "html"],
                description:
                  "Content format. Defaults to plain, which escapes HTML. Use html only when content is trusted Zotero note HTML.",
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
          name: "append_to_note",
          description:
            "Append content to an existing Zotero note, or to the dedicated PaperChat Notes child note of the current/specified item. If that dedicated child note does not exist, create it and append the content. Use this when the user asks to write, save, or add findings to a note.",
          parameters: {
            type: "object",
            properties: {
              ...itemKeyProp,
              noteKey: {
                type: "string",
                description:
                  "Optional Zotero note key. If provided, append to this exact note.",
              },
              content: {
                type: "string",
                description:
                  "The content to append. Required. Interpreted as plain text unless format is explicitly html.",
              },
              format: {
                type: "string",
                enum: ["plain", "html"],
                description:
                  "Content format. Defaults to plain, which escapes HTML. Use html only when content is trusted Zotero note HTML.",
              },
              tags: {
                type: "string",
                description:
                  "Comma-separated tags to add only if a new note is created. Optional.",
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
            "Add or remove tags on multiple items. Prefer itemKeys to target exactly the papers you just analyzed; fall back to query only when you have no keys.",
          parameters: {
            type: "object",
            properties: {
              itemKeys: {
                type: "array",
                items: { type: "string" },
                description:
                  "Exact item keys to update. Preferred over query when you already know which papers to tag.",
              },
              query: {
                type: "string",
                description:
                  "Search query to find items to update. Used only when itemKeys is omitted.",
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
          },
        },
      },
      {
        type: "function",
        function: {
          name: "update_item_metadata",
          description:
            "Correct bibliographic fields on a Zotero item (for example a wrong year or a missing DOI). Only editable fields are accepted; creators and item type cannot be changed here.",
          parameters: {
            type: "object",
            properties: {
              itemKey: {
                type: "string",
                description: "The Zotero item key to update. Required.",
              },
              fields: {
                type: "object",
                description:
                  'Field name to new value, e.g. {"date": "2022", "DOI": "10.1000/xyz"}. Editable: title, abstractNote, date, DOI, url, publicationTitle, journalAbbreviation, volume, issue, pages, publisher, place, edition, ISBN, ISSN, language, extra.',
              },
            },
            required: ["itemKey", "fields"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "link_related_items",
          description:
            "Link Zotero items as related, in both directions. Use after identifying papers that cite, extend, or contradict each other.",
          parameters: {
            type: "object",
            properties: {
              itemKey: {
                type: "string",
                description: "The item to link from. Required.",
              },
              relatedItemKeys: {
                type: "array",
                items: { type: "string" },
                description: "Item keys to link to. Required.",
              },
            },
            required: ["itemKey", "relatedItemKeys"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "add_item",
          description:
            "Add a new item to the Zotero library by identifier (DOI, ISBN, PMID, arXiv ID). Uses Zotero's built-in metadata lookup.",
          parameters: {
            type: "object",
            properties: {
              identifier: {
                type: "string",
                description:
                  "The identifier to look up. Supports DOI (e.g. 10.1038/nature12373), ISBN, PMID, or arXiv ID.",
              },
              collection_key: {
                type: "string",
                description:
                  "Optional. The key of a collection to add the item to. Use get_collections to find available collections.",
              },
            },
            required: ["identifier"],
          },
        },
      },
    );

    // Memory tool (always available)
    const memoryTools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "save_memory",
          description:
            "Save a user preference, decision, or important fact to long-term memory. Use this when the user states a preference (e.g. 'I prefer concise answers'), makes a decision, or asks you to remember something. Memories are recalled automatically in future conversations.",
          parameters: {
            type: "object",
            properties: {
              text: {
                type: "string",
                description:
                  "The fact, preference, or decision to remember. Be concise (max 500 characters).",
              },
              category: {
                type: "string",
                description:
                  "Category: preference (user likes/dislikes), decision (choice made), entity (person/paper/tool), fact (general fact to remember), other. Default: other",
                enum: ["preference", "decision", "entity", "fact", "other"],
              },
              importance: {
                type: "number",
                description:
                  "How important this memory is, from 0.0 (low) to 1.0 (critical). Default: 0.7",
              },
            },
            required: ["text"],
          },
        },
      },
    ];

    // PDF 内容工具。Most of them can still work without an active reader tab
    // when the model provides an explicit itemKey.
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
            "Get the paper outline for navigation. When the matching PDF is open in Zotero and contains bookmarks, returns the native hierarchical bookmark outline with PDF viewer page numbers; otherwise falls back to heuristic text parsing. PDF viewer page numbers may not match get_pages when extracted text lacks page breaks. Do not treat missing headings as proof that the paper lacks those sections.",
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
            "List parsed sections with IDs accepted by get_paper_section, plus a navigation-only PDF bookmark outline when available. Do not use bookmark titles as section IDs. Text parsing may still merge or miss numbered or non-standard sections.",
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
            },
          },
        },
      },
    ];

    if (!hasCurrentItem) {
      return [...libraryTools, ...memoryTools, ...pdfTools];
    }

    return [...pdfTools, ...libraryTools, ...memoryTools];
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
    return typeof args === "object" && args !== null;
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

  private isSearchFulltextArgs(args: unknown): args is SearchFulltextArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as SearchFulltextArgs).query === "string"
    );
  }

  private isUpdateItemMetadataArgs(
    args: unknown,
  ): args is UpdateItemMetadataArgs {
    if (typeof args !== "object" || args === null) return false;
    const candidate = args as UpdateItemMetadataArgs;
    return (
      typeof candidate.itemKey === "string" &&
      typeof candidate.fields === "object" &&
      candidate.fields !== null &&
      !Array.isArray(candidate.fields)
    );
  }

  private isLinkRelatedItemsArgs(args: unknown): args is LinkRelatedItemsArgs {
    if (typeof args !== "object" || args === null) return false;
    const candidate = args as LinkRelatedItemsArgs;
    return (
      typeof candidate.itemKey === "string" &&
      Array.isArray(candidate.relatedItemKeys)
    );
  }

  private isRunSavedSearchArgs(args: unknown): args is RunSavedSearchArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as RunSavedSearchArgs).searchKey === "string"
    );
  }

  private isWebSearchArgs(args: unknown): args is WebSearchArgs {
    return isValidWebSearchArgs(args);
  }

  private isScholarlySearchArgs(args: unknown): args is ScholarlySearchArgs {
    return isValidScholarlySearchArgs(args);
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

  private isAppendToNoteArgs(args: unknown): args is AppendToNoteArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as AppendToNoteArgs).content === "string"
    );
  }

  private isBatchUpdateTagsArgs(args: unknown): args is BatchUpdateTagsArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as BatchUpdateTagsArgs).query === "string"
    );
  }

  private isAddItemArgs(args: unknown): args is AddItemArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as AddItemArgs).identifier === "string"
    );
  }

  private isSaveMemoryArgs(args: unknown): args is SaveMemoryArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as SaveMemoryArgs).text === "string"
    );
  }

  private async executeSaveMemory(args: SaveMemoryArgs): Promise<string> {
    const result = await getMemoryService().save(
      args.text,
      args.category ?? "other",
      args.importance ?? 0.7,
    );
    if (result.saved) {
      return `Memory saved: "${args.text.slice(0, 80)}"`;
    }
    return `Memory not saved (${result.reason ?? "unknown reason"}).`;
  }

  /**
   * 执行工具调用（异步，按需提取 PDF）
   *
   * Permission checks are the caller's responsibility — in practice this
   * runs only via ToolScheduler, which decides permission before dispatching.
   * The method takes pre-parsed args so the scheduler's JSON.parse result can
   * flow through without re-parsing.
   */
  async executeToolCall(
    toolCall: ToolCall,
    fallbackStructure?: PaperStructure | PaperStructureExtended,
    parsedArgs?: Record<string, unknown>,
    currentItemKeyOverride?: string | null,
    executionContext?: ToolSchedulerExecutionContext,
  ): Promise<string> {
    const { name, arguments: argsString } = toolCall.function;

    let args = parsedArgs;
    if (!args) {
      try {
        const parsed = JSON.parse(argsString);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          return `Error: Invalid arguments JSON: ${argsString}`;
        }
        args = parsed as Record<string, unknown>;
      } catch {
        return `Error: Invalid arguments JSON: ${argsString}`;
      }
    }
    args = preflightToolArguments(name, args);
    const effectiveCurrentItemKey =
      currentItemKeyOverride === undefined
        ? this.currentItemKey
        : currentItemKeyOverride;

    // === Zotero Library 工具（不需要 PDF）===
    switch (name) {
      case "web_search":
        if (!this.isWebSearchArgs(args)) {
          return "Error: Invalid arguments for web_search. Required: query (string)";
        }
        return executeWebSearch(args);
      case "search_scholarly_sources":
        if (!this.isScholarlySearchArgs(args)) {
          return "Error: Invalid arguments for search_scholarly_sources. Required: query (string)";
        }
        return executeScholarlySearch(args);
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
        return executeGetItemNotes(args, effectiveCurrentItemKey);
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
        return executeGetAnnotations(args, effectiveCurrentItemKey);

      case "get_pdf_selection":
        return executeGetPdfSelection();

      case "search_items":
        if (!this.isSearchItemsArgs(args)) {
          return "Error: Invalid arguments for search_items. Required: query (string)";
        }
        return executeSearchItems(args);

      case "search_fulltext":
        if (!this.isSearchFulltextArgs(args)) {
          return "Error: Invalid arguments for search_fulltext. Required: query (string)";
        }
        return executeSearchFulltext(args);

      case "list_saved_searches":
        return executeListSavedSearches();

      case "run_saved_search":
        if (!this.isRunSavedSearchArgs(args)) {
          return "Error: Invalid arguments for run_saved_search. Required: searchKey (string)";
        }
        return executeRunSavedSearch(args);

      case "update_item_metadata":
        if (!this.isUpdateItemMetadataArgs(args)) {
          return "Error: Invalid arguments for update_item_metadata. Required: itemKey (string), fields (object)";
        }
        return executeUpdateItemMetadata(args);

      case "link_related_items":
        if (!this.isLinkRelatedItemsArgs(args)) {
          return "Error: Invalid arguments for link_related_items. Required: itemKey (string), relatedItemKeys (string[])";
        }
        return executeLinkRelatedItems(args);

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
        if (!this.isCreateNoteArgs(args)) {
          return "Error: Invalid arguments for create_note. Required: content (string)";
        }
        return executeCreateNote(args, effectiveCurrentItemKey);
      }

      case "append_to_note": {
        if (!this.isAppendToNoteArgs(args)) {
          return "Error: Invalid arguments for append_to_note. Required: content (string)";
        }
        return executeAppendToNote(args, effectiveCurrentItemKey);
      }

      case "batch_update_tags": {
        if (!this.isBatchUpdateTagsArgs(args)) {
          return "Error: Invalid arguments for batch_update_tags. Required: query (string)";
        }
        return executeBatchUpdateTags(args);
      }

      case "add_item": {
        if (!this.isAddItemArgs(args)) {
          return "Error: Invalid arguments for add_item. Required: identifier (string)";
        }
        return executeAddItem(args);
      }

      case "save_memory": {
        if (!this.isSaveMemoryArgs(args)) {
          return "Error: Invalid arguments for save_memory. Required: text (string)";
        }
        return this.executeSaveMemory(args);
      }
      case "presentation": {
        const sourceItemKey = resolvePresentationSourceItemKey(
          args.sourceItemKey,
          effectiveCurrentItemKey,
        );
        const paper = sourceItemKey
          ? await this.extractAndParsePaper(sourceItemKey, true)
          : fallbackStructure
            ? this.ensureExtendedStructure(fallbackStructure)
            : null;
        return executePresentationCapability(
          sourceItemKey ? { ...args, sourceItemKey } : args,
          executionContext?.presentationVisualReviewer,
          executionContext?.presentationPlanner,
          paper || undefined,
        );
      }
    }

    // === PDF 内容工具（需要 PDF）===
    // 解析 itemKey：优先使用参数中的 itemKey，否则使用当前 itemKey
    const requestedItemKey = (args as BaseToolArgs).itemKey;
    const targetItemKey = requestedItemKey ?? effectiveCurrentItemKey;
    let resolvedSourceItemKey: string | null = null;

    // 获取 paperStructure（按需提取）
    let paperStructure: PaperStructureExtended | null = null;

    if (targetItemKey) {
      // 按 itemKey 提取 PDF
      paperStructure = await this.extractAndParsePaper(
        targetItemKey,
        name === "get_outline" || name === "list_sections",
      );
      if (paperStructure) {
        resolvedSourceItemKey = targetItemKey;
      }
    }

    // 如果按 itemKey 找不到，使用后备结构
    if (!paperStructure && fallbackStructure) {
      paperStructure = this.ensureExtendedStructure(fallbackStructure);
      // fallbackStructure represents the current reader paper. Never attribute
      // it to a different explicit itemKey that failed to resolve.
      if (
        effectiveCurrentItemKey &&
        (!requestedItemKey || requestedItemKey === effectiveCurrentItemKey)
      ) {
        resolvedSourceItemKey = effectiveCurrentItemKey;
        // 后备结构对应当前 reader 中的论文，reader 通常是打开的，
        // 因此这里同样尝试补充原生大纲。
        if (name === "get_outline" || name === "list_sections") {
          const attachmentItemID = this.findPdfAttachmentItemID(
            effectiveCurrentItemKey,
          );
          if (attachmentItemID !== null) {
            await this.enrichWithNativeOutline(
              paperStructure,
              attachmentItemID,
            );
          }
        }
      }
    }

    if (!paperStructure) {
      if (targetItemKey) {
        return `Error: Could not extract PDF content for item "${targetItemKey}". The item may not exist or may not have a PDF attachment.`;
      }
      return `Error: No paper content available. Please specify an itemKey or ensure the current item has a PDF attachment.`;
    }

    const formatResult = (result: string): string =>
      this.formatPdfContentResult(result, resolvedSourceItemKey);

    switch (name) {
      case "get_paper_section":
        if (!this.isGetPaperSectionArgs(args)) {
          return "Error: Invalid arguments for get_paper_section. Required: section (string)";
        }
        return formatResult(executeGetPaperSection(args, paperStructure));
      case "search_paper_content":
        if (!this.isSearchPaperContentArgs(args)) {
          return "Error: Invalid arguments for search_paper_content. Required: query (string)";
        }
        return formatResult(
          await executeSearchPaperContent(
            args,
            paperStructure,
            resolvedSourceItemKey ?? undefined,
          ),
        );
      case "get_paper_metadata":
        return formatResult(
          executeGetPaperMetadata(
            paperStructure,
            resolvedSourceItemKey ?? undefined,
          ),
        );
      case "get_pages":
        if (!this.isGetPagesArgs(args)) {
          return "Error: Invalid arguments for get_pages. Required: pages (string)";
        }
        return formatResult(executeGetPages(args, paperStructure));
      case "get_page_count":
        return formatResult(executeGetPageCount(paperStructure));
      case "search_with_regex":
        if (!this.isSearchWithRegexArgs(args)) {
          return "Error: Invalid arguments for search_with_regex. Required: pattern (string)";
        }
        return formatResult(executeSearchWithRegex(args, paperStructure));
      case "get_outline":
        return formatResult(executeGetOutline(paperStructure));
      case "list_sections":
        return formatResult(executeListSections(paperStructure));
      case "get_full_text":
        if (!this.isGetFullTextArgs(args)) {
          return "Error: Invalid arguments for get_full_text.";
        }
        return formatResult(executeGetFullText(paperStructure));
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
    memoryContext?: string,
    agentContext?: AgentPromptContext,
    searchToolMode: SearchToolPromptMode = "unified",
  ): string {
    return generatePaperContextPromptFn(
      currentPaperStructure,
      currentItemKey,
      currentTitle,
      hasCurrentItem,
      memoryContext,
      agentContext,
      searchToolMode,
    );
  }
}
