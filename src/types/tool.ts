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
  | "get_item_metadata"
  // 新增工具
  | "get_annotations"
  | "get_pdf_selection"
  | "search_items"
  | "get_collections"
  | "get_collection_items"
  | "get_tags"
  | "search_by_tag"
  | "get_recent"
  | "search_notes"
  | "create_note"
  | "batch_update_tags"
  // 多文档比较工具
  | "compare_papers"
  | "search_across_papers";

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

// ========== 新增工具参数类型 ==========

// 获取 PDF 标注的参数
export interface GetAnnotationsArgs extends BaseToolArgs {
  annotationType?: "highlight" | "note" | "underline" | "image" | "all";
  selectedOnly?: boolean; // 仅获取 PDF 阅读器中选中的标注
  includePosition?: boolean; // 是否包含详细位置信息 (rect)
  limit?: number;
}

// 获取 PDF 选中文本的参数（无参数）
export type GetPdfSelectionArgs = Record<string, never>;

// 搜索 Zotero 库的参数
export interface SearchItemsArgs {
  query: string;
  field?: "title" | "creator" | "tag" | "everywhere"; // 搜索范围
  itemType?: string; // 条目类型筛选
  limit?: number;
}

// 获取分类列表的参数
export interface GetCollectionsArgs {
  parentKey?: string; // 获取子分类，不传则获取顶级分类
}

// 获取分类下条目的参数
export interface GetCollectionItemsArgs {
  collectionKey: string;
  limit?: number;
}

// 获取所有标签的参数
export interface GetTagsArgs {
  limit?: number;
}

// 按标签搜索的参数
export interface SearchByTagArgs {
  tags: string; // 逗号分隔的多个标签
  mode?: "and" | "or"; // 组合模式
  limit?: number;
}

// 获取最近条目的参数
export interface GetRecentArgs {
  limit?: number;
  days?: number; // 最近N天
}

// 跨条目搜索笔记的参数
export interface SearchNotesArgs {
  query: string;
  limit?: number;
}

// 创建笔记的参数
export interface CreateNoteArgs extends BaseToolArgs {
  content: string; // 笔记内容 (支持 HTML)
  tags?: string; // 逗号分隔的标签
}

// 批量更新标签的参数
export interface BatchUpdateTagsArgs {
  query: string; // 搜索条件，找到要更新的 items
  addTags?: string; // 要添加的标签（逗号分隔）
  removeTags?: string; // 要移除的标签（逗号分隔）
  limit?: number; // 最多影响的条目数
}

// ========== 多文档比较工具参数类型 ==========

// 比较多篇论文的参数
export interface ComparePapersArgs {
  itemKeys: string[]; // 要比较的论文 keys
  aspect?: "methodology" | "results" | "conclusions" | "all"; // 比较方面
  section?: string; // 比较特定章节
}

// 跨论文搜索的参数
export interface SearchAcrossPapersArgs {
  query: string; // 搜索查询
  itemKeys?: string[]; // 指定论文 keys，不传则搜索所有当前选中的论文
  max_results_per_paper?: number; // 每篇论文最多返回结果数
}
