/**
 * Chat Types - 聊天相关类型定义
 */

// 图片附件
export interface ImageAttachment {
  type: "base64" | "url";
  data: string; // base64数据或URL
  mimeType: string;
  name?: string;
}

// 文件附件
export interface FileAttachment {
  name: string;
  content: string; // 文件文本内容
  type: string;
}

import type { ToolCall } from "./tool";

// 聊天消息
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "error" | "tool";
  content: string;
  images?: ImageAttachment[];
  files?: FileAttachment[];
  timestamp: number;
  pdfContext?: boolean; // 是否包含PDF上下文
  selectedText?: string; // 选中的PDF文本
  // Tool calling 相关
  tool_calls?: ToolCall[]; // AI 请求调用的工具
  tool_call_id?: string; // tool 角色消息的工具调用ID
  // 系统通知标记 (用于显示 item 切换提示等)
  isSystemNotice?: boolean;
}

// 上下文摘要
export interface ContextSummary {
  id: string;
  content: string;
  coveredMessageIds: string[];
  createdAt: number;
  messageCountAtCreation: number;
}

// 上下文状态
export interface ContextState {
  summaryInProgress: boolean;
  lastSummaryMessageCount: number;
}

// Session 索引 (用于快速加载 session 列表)
export interface SessionIndex {
  sessions: SessionMeta[];
  activeSessionId: string | null;
}

// Session 元数据 (存储在索引中)
export interface SessionMeta {
  id: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  lastMessagePreview: string;
  lastMessageTime: number;
}

// 聊天会话 (独立于 item，支持跨 item 对话)
export interface ChatSession {
  id: string; // timestamp-uuid 格式
  createdAt: number;
  updatedAt: number;
  lastActiveItemKey: string | null; // 上次活动的 item key
  messages: ChatMessage[];
  // 上下文管理相关
  contextSummary?: ContextSummary;
  contextState?: ContextState;
}

// API配置
export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  providerId?: string; // Reference to provider config
  providerType?: string; // Type of provider for format selection
}

// OpenAI API消息格式
export interface OpenAIMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | OpenAIMessageContent[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

// OpenAI消息内容 (Vision API and File API)
export type OpenAIMessageContent =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "low" | "high" | "auto" };
    }
  | {
      type: "document";
      source: { type: "base64"; media_type: string; data: string };
    };

// 流式响应回调
export interface StreamCallbacks {
  onChunk: (chunk: string) => void;
  onComplete: (fullContent: string, toolCalls?: ToolCall[]) => void;
  onError: (error: Error) => void;
}

// 流式 Tool Calling 完成结果
export interface StreamToolCallingResult {
  content: string;
  toolCalls?: ToolCall[];
  stopReason: "tool_calls" | "end_turn" | "max_tokens" | "stop";
}

// 流式 Tool Calling 回调
export interface StreamToolCallingCallbacks {
  /** 文本片段 */
  onTextDelta: (text: string) => void;

  /** Tool call 开始 */
  onToolCallStart: (toolCall: {
    index: number;
    id: string;
    name: string;
  }) => void;

  /** Tool call 参数增量 */
  onToolCallDelta: (index: number, argumentsDelta: string) => void;

  /** 所有内容完成 */
  onComplete: (result: StreamToolCallingResult) => void;

  /** 错误 */
  onError: (error: Error) => void;
}

// 发送消息选项
export interface SendMessageOptions {
  attachPdf?: boolean;
  images?: ImageAttachment[];
  files?: FileAttachment[];
  selectedText?: string;
}

// 聊天管理器事件
export type ChatEventType =
  | "message:sent"
  | "message:received"
  | "message:streaming"
  | "session:created"
  | "session:loaded"
  | "session:saved"
  | "error";

export interface ChatEvent {
  type: ChatEventType;
  data?: unknown;
}

// 存储的会话元数据 (兼容旧格式，用于迁移)
export interface StoredSessionMeta {
  itemId: number;
  itemName: string;
  messageCount: number;
  lastMessagePreview: string;
  lastUpdated: number;
}

// 旧版 ChatSession 格式 (用于迁移)
export interface LegacyChatSession {
  id: string;
  itemId: number;
  messages: ChatMessage[];
  pdfAttached: boolean;
  pdfContent?: string;
  createdAt: number;
  updatedAt: number;
  contextSummary?: ContextSummary;
  contextState?: ContextState;
  paperStructure?: unknown;
}
