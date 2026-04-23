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

export type ToolPermissionMode = "auto_allow" | "ask" | "deny";

export type ToolPermissionScope = "once" | "session" | "always";

export type ToolPermissionRiskLevel =
  | "read"
  | "network"
  | "write"
  | "memory"
  | "high_cost";

export interface ToolPermissionDescriptor {
  name: string;
  riskLevel: ToolPermissionRiskLevel;
  mode: ToolPermissionMode;
  description: string;
}

export interface ToolPermissionRequest {
  toolCall: ToolCall;
  args: Record<string, unknown>;
  sessionId?: string;
  assistantMessageId?: string;
}

export interface ToolPermissionDecision {
  verdict: "allow" | "deny";
  mode: ToolPermissionMode;
  scope: ToolPermissionScope;
  descriptor: ToolPermissionDescriptor;
  reason?: string;
}

export interface ToolApprovalRequest {
  id: string;
  toolName: PaperToolName;
  descriptor: ToolPermissionDescriptor;
  request: ToolPermissionRequest;
  createdAt: number;
  assistantMessageId?: string;
}

export interface ToolApprovalResolution {
  verdict: "allow" | "deny";
  scope: ToolPermissionScope;
  reason?: string;
}

export interface ToolPermissionPolicyEntry {
  toolName: PaperToolName;
  verdict: "allow" | "deny";
  scope: ToolPermissionScope;
  sessionId?: string;
  updatedAt: number;
  reason?: string;
}

export type ToolExecutionStatus = "completed" | "failed" | "denied";

export type ToolExecutionClass =
  | "read"
  | "network"
  | "write"
  | "memory"
  | "high_cost";

export type ToolConcurrencyMode = "parallel_safe" | "serial";

export type ToolTargetScope = "paper" | "library" | "memory" | "external";

export interface ToolRuntimeMetadata {
  name: PaperToolName;
  executionClass: ToolExecutionClass;
  concurrency: ToolConcurrencyMode;
  targetScope: ToolTargetScope;
  mutatesState: boolean;
  requiresActivePaper?: boolean;
}

export interface ToolExecutionRequest {
  toolCall: ToolCall;
  args: Record<string, unknown>;
  sessionId?: string;
  assistantMessageId?: string;
}

export type ToolPolicyStage = "planner" | "scheduler" | "executor";

export type ToolPolicyName =
  | "retry_block"
  | "budget_block"
  | "permission_decision"
  | "argument_parse"
  | "argument_repair"
  | "argument_validation"
  | "fault_injection";

export type ToolPolicyOutcome = "allowed" | "blocked" | "rewritten";

export interface ToolPolicyTrace {
  stage: ToolPolicyStage;
  policy: ToolPolicyName;
  outcome: ToolPolicyOutcome;
  summary: string;
  detail?: string;
  data?: Record<string, unknown>;
}

export interface ToolExecutionResult {
  toolCall: ToolCall;
  args?: Record<string, unknown>;
  metadata?: ToolRuntimeMetadata;
  permissionDecision?: ToolPermissionDecision;
  policyTrace?: ToolPolicyTrace[];
  status: ToolExecutionStatus;
  content: string;
  error?: string;
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
  | "web_search"
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
  | "add_item"
  // Memory tool
  | "save_memory";

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

export type GetFullTextArgs = BaseToolArgs;

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

// Web 搜索参数
// WEB_SEARCH_SOURCES lists every id the validator accepts — including
// `semantic_scholar` / `semantic_scholar_web`, which are kept only as legacy
// aliases so old prefs or old tool-arg callers keep working. The tool schema
// exposed to the model uses MODEL_VISIBLE_WEB_SEARCH_SOURCES below so the
// model never actively picks the hidden aliases.
export const WEB_SEARCH_SOURCES = [
  "auto",
  "semantic_scholar",
  "semantic_scholar_web",
  "google_scholar",
  "openalex",
  "duckduckgo",
] as const;

export type WebSearchSource = (typeof WEB_SEARCH_SOURCES)[number];

export const MODEL_VISIBLE_WEB_SEARCH_SOURCES = [
  "auto",
  "google_scholar",
  "openalex",
  "duckduckgo",
] as const;

export const WEB_SEARCH_INTENTS = [
  "auto",
  "paper",
  "related",
  "discover",
  "biomedical",
  "web",
] as const;

export type WebSearchIntent = (typeof WEB_SEARCH_INTENTS)[number];

export interface WebSearchArgs {
  query: string;
  source?: WebSearchSource;
  intent?: WebSearchIntent;
  max_results?: number;
  domain_filter?: string[];
  include_content?: boolean;
  year_from?: number;
  year_to?: number;
  open_access_only?: boolean;
  seed_title?: string;
  seed_doi?: string;
  seed_paper_id?: string;
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

// 通过标识符添加条目的参数
export interface AddItemArgs {
  identifier: string; // DOI, ISBN, PMID, arXiv ID
  collection_key?: string; // 可选，指定添加到的分类
}

// 保存用户记忆的参数
export interface SaveMemoryArgs {
  text: string; // The fact, preference, or decision to remember
  category?: "preference" | "decision" | "entity" | "fact" | "other";
  importance?: number; // 0.0 – 1.0, defaults to 0.7
}
