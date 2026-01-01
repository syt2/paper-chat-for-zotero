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

// 聊天消息
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "error";
  content: string;
  images?: ImageAttachment[];
  files?: FileAttachment[];
  timestamp: number;
  pdfContext?: boolean; // 是否包含PDF上下文
  selectedText?: string; // 选中的PDF文本
}

// 聊天会话
export interface ChatSession {
  id: string;
  itemId: number; // 关联的Zotero Item ID
  messages: ChatMessage[];
  pdfAttached: boolean;
  pdfContent?: string;
  createdAt: number;
  updatedAt: number;
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
  role: "user" | "assistant" | "system";
  content: string | OpenAIMessageContent[];
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
  onComplete: (fullContent: string) => void;
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

// 存储的会话元数据
export interface StoredSessionMeta {
  itemId: number;
  itemName: string;
  messageCount: number;
  lastMessagePreview: string;
  lastUpdated: number;
}
