/**
 * Tool Types - Function Calling 相关类型定义
 */

// 工具定义（OpenAI 格式）
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, ToolParameterProperty>;
      required?: string[];
    };
  };
}

export interface ToolParameterProperty {
  type: "string" | "number" | "boolean" | "array";
  description: string;
  enum?: string[];
  items?: { type: string };
}

// AI 返回的工具调用请求
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

// 工具调用结果
export interface ToolResult {
  tool_call_id: string;
  content: string;
}

// 论文结构化内容
export interface PaperStructure {
  metadata: PaperMetadata;
  sections: PaperSection[];
  fullText: string;
}

export interface PaperMetadata {
  title?: string;
  authors?: string[];
  abstract?: string;
  keywords?: string[];
  year?: number;
  doi?: string;
}

export interface PaperSection {
  name: string;
  normalizedName: string; // 标准化名称用于匹配
  content: string;
  startIndex: number;
  endIndex: number;
}

// 工具名称枚举
export type PaperToolName =
  | "get_paper_section"
  | "search_paper_content"
  | "get_paper_metadata"
  | "get_pages"
  | "get_page_count"
  | "search_with_regex"
  | "get_outline"
  | "list_sections"
  | "get_full_text"
  | "list_all_items"
  | "get_item_notes"
  | "get_note_content"
  | "get_item_metadata";

// 基础工具参数（所有工具都可以指定 itemKey）
export interface BaseToolArgs {
  itemKey?: string; // 可选，指定要查询的 Zotero Item Key，默认使用当前 Item
}

// 各工具的参数类型
export interface GetPaperSectionArgs extends BaseToolArgs {
  section: string;
}

export interface SearchPaperContentArgs extends BaseToolArgs {
  query: string;
  max_results?: number;
}

export type GetPaperMetadataArgs = BaseToolArgs;

export interface GetPagesArgs extends BaseToolArgs {
  pages: string; // 页码范围，如 "1-5,10,15-20"
}

export type GetPageCountArgs = BaseToolArgs;

export interface SearchWithRegexArgs extends BaseToolArgs {
  pattern: string;
  use_regex?: boolean;
  case_sensitive?: boolean;
  context_lines?: number; // 返回匹配前后多少行
  max_results?: number;
}

export type GetOutlineArgs = BaseToolArgs;

export type ListSectionsArgs = BaseToolArgs;

export interface GetFullTextArgs extends BaseToolArgs {
  confirm: boolean;
}

// 列出所有 items 的参数
export interface ListAllItemsArgs {
  page?: number; // 页码，从 1 开始，默认 1
  pageSize?: number; // 每页数量，默认 20
  hasPdf?: boolean; // 是否只返回有 PDF 附件的 items
}

// 获取 item 笔记列表的参数
export type GetItemNotesArgs = BaseToolArgs;

// 获取笔记内容的参数
export interface GetNoteContentArgs {
  noteKey: string; // 笔记的 key
}

// 获取 item 元数据的参数（不需要 PDF）
export interface GetItemMetadataArgs {
  itemKey: string; // 必须指定 itemKey
}

// 页面信息
export interface PageInfo {
  pageNumber: number;
  startIndex: number;
  endIndex: number;
  content: string;
}

// 扩展 PaperStructure 包含页面信息
export interface PaperStructureExtended extends PaperStructure {
  pages: PageInfo[];
  pageCount: number;
}
