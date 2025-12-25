/**
 * ChatManager - 聊天会话管理核心类
 *
 * 职责:
 * 1. 管理多个聊天会话 (每个Zotero Item对应一个会话)
 * 2. 处理消息发送和接收
 * 3. 协调PDF上下文和文件附件
 * 4. 触发UI更新
 */

import type {
  ChatMessage,
  ChatSession,
  SendMessageOptions,
  StreamCallbacks,
} from "../../types/chat";
import { StorageService } from "./StorageService";
import { PdfExtractor } from "./PdfExtractor";
import { MessageRenderer } from "./MessageRenderer";
import { getProviderManager } from "../providers";
import { getString } from "../../utils/locale";

export class ChatManager {
  private sessions: Map<number, ChatSession> = new Map();
  private activeItemId: number | null = null;
  private storageService: StorageService;
  private pdfExtractor: PdfExtractor;
  private messageRenderer: MessageRenderer;

  // UI回调
  private onMessageUpdate?: (itemId: number, messages: ChatMessage[]) => void;
  private onStreamingUpdate?: (itemId: number, content: string) => void;
  private onError?: (error: Error) => void;
  private onPdfAttached?: () => void; // 通知UI取消勾选PDF checkbox
  private onMessageComplete?: () => void; // 消息完成后通知（用于刷新余额等）

  constructor() {
    this.storageService = new StorageService();
    this.pdfExtractor = new PdfExtractor();
    this.messageRenderer = new MessageRenderer();
  }

  /**
   * Get the active AI provider
   */
  private getActiveProvider() {
    return getProviderManager().getActiveProvider();
  }

  /**
   * 设置UI回调
   */
  setCallbacks(callbacks: {
    onMessageUpdate?: (itemId: number, messages: ChatMessage[]) => void;
    onStreamingUpdate?: (itemId: number, content: string) => void;
    onError?: (error: Error) => void;
    onPdfAttached?: () => void;
    onMessageComplete?: () => void;
  }): void {
    this.onMessageUpdate = callbacks.onMessageUpdate;
    this.onStreamingUpdate = callbacks.onStreamingUpdate;
    this.onError = callbacks.onError;
    this.onPdfAttached = callbacks.onPdfAttached;
    this.onMessageComplete = callbacks.onMessageComplete;
  }

  /**
   * 获取或创建会话
   */
  async getSession(item: Zotero.Item): Promise<ChatSession> {
    const itemId = item.id;

    // 先检查内存缓存
    if (this.sessions.has(itemId)) {
      return this.sessions.get(itemId)!;
    }

    // 尝试从存储加载
    const storedSession = await this.storageService.loadSession(itemId);
    if (storedSession) {
      this.sessions.set(itemId, storedSession);
      return storedSession;
    }

    // 创建新会话
    const newSession: ChatSession = {
      id: this.generateId(),
      itemId,
      messages: [],
      pdfAttached: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.sessions.set(itemId, newSession);
    return newSession;
  }

  /**
   * 设置当前活动的Item
   */
  setActiveItem(itemId: number): void {
    this.activeItemId = itemId;
  }

  /**
   * 获取当前活动会话
   */
  getActiveSession(): ChatSession | null {
    if (this.activeItemId && this.sessions.has(this.activeItemId)) {
      return this.sessions.get(this.activeItemId)!;
    }
    return null;
  }

  /**
   * 发送消息
   */
  async sendMessage(
    item: Zotero.Item,
    content: string,
    options: SendMessageOptions = {},
  ): Promise<void> {
    ztoolkit.log("[ChatManager] sendMessage called, itemId:", item.id);
    const session = await this.getSession(item);
    const itemId = item.id;

    // 获取活动的AI提供商
    const provider = this.getActiveProvider();
    ztoolkit.log("[ChatManager] provider:", provider?.getName(), "isReady:", provider?.isReady());
    if (!provider || !provider.isReady()) {
      ztoolkit.log("[ChatManager] Provider not ready, showing error in chat");
      // Show error message in chat
      const errorMessage: ChatMessage = {
        id: this.generateId(),
        role: "assistant",
        content: getString("chat-error-no-provider" as any),
        timestamp: Date.now(),
      };
      session.messages.push(errorMessage);
      this.onMessageUpdate?.(itemId, session.messages);
      return;
    }

    // 构建最终消息内容
    let finalContent = content;

    // Debug: log options
    ztoolkit.log("[ChatManager] sendMessage options:", {
      attachPdf: options.attachPdf,
      hasImages: options.images?.length || 0,
      hasFiles: options.files?.length || 0,
      hasSelectedText: !!options.selectedText,
    });
    ztoolkit.log("[ChatManager] session.pdfAttached:", session.pdfAttached);

    // 处理选中文本
    if (options.selectedText) {
      finalContent = `[Selected text from PDF]:\n"${options.selectedText}"\n\n[Question]:\n${content}`;
    }

    // Track PDF attachment for providers that support PDF upload
    let pdfAttachment: { data: string; mimeType: string; name: string } | undefined;
    let pdfWasAttached = false; // 标记本次消息是否附加了PDF

    // 处理PDF附加 - 每次勾选checkbox都尝试附加
    if (options.attachPdf) {
      const pdfInfo = await this.pdfExtractor.getPdfInfo(item);
      ztoolkit.log("[PDF Attach] Checkbox checked, attempting to attach PDF");
      ztoolkit.log("[PDF Attach] PDF info:", pdfInfo ? `name=${pdfInfo.name}, size=${pdfInfo.size} bytes` : "No PDF found");

      // First, try text extraction
      const pdfText = await this.pdfExtractor.extractPdfText(item);
      if (pdfText) {
        session.pdfContent = pdfText;
        session.pdfAttached = true;
        pdfWasAttached = true;
        ztoolkit.log("[PDF Attach] PDF text extracted successfully, text length:", pdfText.length);

        // 将PDF内容作为系统上下文添加到消息
        finalContent = `[PDF Content]:\n${pdfText.substring(0, 50000)}\n\n[Question]:\n${content}`;
        ztoolkit.log("[PDF Attach] PDF content added to message, truncated to 50000 chars");
      } else {
        // Text extraction failed, try PDF file upload if provider supports it
        ztoolkit.log("[PDF Attach] Text extraction failed, checking if provider supports PDF upload");

        if (provider.supportsPdfUpload()) {
          ztoolkit.log("[PDF Attach] Provider supports PDF upload, getting PDF file");
          const pdfBase64 = await this.pdfExtractor.getPdfBase64(item);
          if (pdfBase64) {
            pdfAttachment = pdfBase64;
            session.pdfAttached = true;
            pdfWasAttached = true;
            ztoolkit.log("[PDF Attach] PDF file ready for upload:", pdfBase64.name, "size:", pdfBase64.data.length, "chars (base64)");
          } else {
            ztoolkit.log("[PDF Attach] Failed to get PDF file for upload");
          }
        } else {
          ztoolkit.log("[PDF Attach] Provider does not support PDF upload, skipping");
        }
      }
    }

    // 处理文件附件
    if (options.files && options.files.length > 0) {
      ztoolkit.log("[File Attach] Processing", options.files.length, "file(s)");
      for (const f of options.files) {
        ztoolkit.log("[File Attach] File:", f.name, "type:", f.type, "content length:", f.content.length);
      }
      const filesContent = options.files
        .map((f) => `[File: ${f.name}]\n${f.content}`)
        .join("\n\n");
      finalContent = `${filesContent}\n\n[Question]:\n${content}`;
    }

    // 处理图片附件
    if (options.images && options.images.length > 0) {
      ztoolkit.log("[Image Attach] Processing", options.images.length, "image(s)");
      for (const img of options.images) {
        ztoolkit.log("[Image Attach] Image:", img.name || "unnamed", "type:", img.mimeType, "data length:", img.data.length);
      }
    }

    // 创建用户消息
    const userMessage: ChatMessage = {
      id: this.generateId(),
      role: "user",
      content: finalContent,
      images: options.images,
      files: options.files,
      timestamp: Date.now(),
      pdfContext: options.attachPdf,
      selectedText: options.selectedText,
    };

    // 添加到会话
    session.messages.push(userMessage);
    session.updatedAt = Date.now();

    // 通知UI更新
    this.onMessageUpdate?.(itemId, session.messages);

    // 创建AI消息占位
    const assistantMessage: ChatMessage = {
      id: this.generateId(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };

    session.messages.push(assistantMessage);
    this.onMessageUpdate?.(itemId, session.messages);

    // 调用API
    const callbacks: StreamCallbacks = {
      onChunk: (chunk: string) => {
        assistantMessage.content += chunk;
        this.onStreamingUpdate?.(itemId, assistantMessage.content);
      },
      onComplete: async (fullContent: string) => {
        assistantMessage.content = fullContent;
        assistantMessage.timestamp = Date.now();
        session.updatedAt = Date.now();

        // 保存到存储
        await this.storageService.saveSession(session);

        // 通知UI更新
        this.onMessageUpdate?.(itemId, session.messages);

        // 如果本次消息附加了PDF，通知UI取消勾选checkbox
        if (pdfWasAttached) {
          this.onPdfAttached?.();
        }

        // 通知消息完成（用于刷新余额等）
        this.onMessageComplete?.();
      },
      onError: (error: Error) => {
        ztoolkit.log("[API Error]", error.message);
        // 移除空的AI消息，替换为错误消息
        session.messages.pop();

        // 添加错误消息到会话（使用特殊的 role="error"）
        const errorMessage: ChatMessage = {
          id: this.generateId(),
          role: "error" as ChatMessage["role"],
          content: error.message,
          timestamp: Date.now(),
        };
        session.messages.push(errorMessage);

        this.onError?.(error);
        this.onMessageUpdate?.(itemId, session.messages);
      },
    };

    // Log API request info
    ztoolkit.log("[API Request] Sending to provider:", provider.getName());
    ztoolkit.log("[API Request] Message count:", session.messages.length - 1);
    ztoolkit.log("[API Request] Has images:", options.images && options.images.length > 0 ? options.images.length : 0);
    ztoolkit.log("[API Request] Has PDF context:", options.attachPdf ? "yes" : "no");
    ztoolkit.log("[API Request] Has PDF file attachment:", pdfAttachment ? "yes" : "no");
    ztoolkit.log("[API Request] Final content length:", finalContent.length);

    await provider.streamChatCompletion(session.messages.slice(0, -1), callbacks, pdfAttachment);
  }

  /**
   * 发送消息 (全局模式，无需关联Item)
   */
  async sendMessageGlobal(
    content: string,
    options: Omit<SendMessageOptions, "attachPdf"> = {},
  ): Promise<void> {
    // 使用特殊的 itemId = 0 作为全局聊天
    const globalItemId = 0;

    // 获取或创建全局会话
    let session = this.sessions.get(globalItemId);
    if (!session) {
      session = {
        id: this.generateId(),
        itemId: globalItemId,
        messages: [],
        pdfAttached: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.sessions.set(globalItemId, session);
    }

    // 获取活动的AI提供商
    const provider = this.getActiveProvider();
    if (!provider || !provider.isReady()) {
      // Show error message in chat
      const errorMessage: ChatMessage = {
        id: this.generateId(),
        role: "assistant",
        content: getString("chat-error-no-provider" as any),
        timestamp: Date.now(),
      };
      session.messages.push(errorMessage);
      this.onMessageUpdate?.(globalItemId, session.messages);
      return;
    }

    // 构建最终消息内容
    let finalContent = content;

    // 处理选中文本
    if (options.selectedText) {
      finalContent = `[Selected text]:\n"${options.selectedText}"\n\n[Question]:\n${content}`;
    }

    // 处理文件附件
    if (options.files && options.files.length > 0) {
      ztoolkit.log("[File Attach Global] Processing", options.files.length, "file(s)");
      for (const f of options.files) {
        ztoolkit.log("[File Attach Global] File:", f.name, "type:", f.type, "content length:", f.content.length);
      }
      const filesContent = options.files
        .map((f) => `[File: ${f.name}]\n${f.content}`)
        .join("\n\n");
      finalContent = `${filesContent}\n\n[Question]:\n${content}`;
    }

    // 处理图片附件
    if (options.images && options.images.length > 0) {
      ztoolkit.log("[Image Attach Global] Processing", options.images.length, "image(s)");
      for (const img of options.images) {
        ztoolkit.log("[Image Attach Global] Image:", img.name || "unnamed", "type:", img.mimeType, "data length:", img.data.length);
      }
    }

    // 创建用户消息
    const userMessage: ChatMessage = {
      id: this.generateId(),
      role: "user",
      content: finalContent,
      images: options.images,
      files: options.files,
      timestamp: Date.now(),
      selectedText: options.selectedText,
    };

    // 添加到会话
    session.messages.push(userMessage);
    session.updatedAt = Date.now();

    // 通知UI更新
    this.onMessageUpdate?.(globalItemId, session.messages);

    // 创建AI消息占位
    const assistantMessage: ChatMessage = {
      id: this.generateId(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };

    session.messages.push(assistantMessage);
    this.onMessageUpdate?.(globalItemId, session.messages);

    // 调用API
    const callbacks: StreamCallbacks = {
      onChunk: (chunk: string) => {
        assistantMessage.content += chunk;
        this.onStreamingUpdate?.(globalItemId, assistantMessage.content);
      },
      onComplete: async (fullContent: string) => {
        assistantMessage.content = fullContent;
        assistantMessage.timestamp = Date.now();
        session!.updatedAt = Date.now();

        // 保存到存储
        await this.storageService.saveSession(session!);

        // 通知UI更新
        this.onMessageUpdate?.(globalItemId, session!.messages);

        // 通知消息完成（用于刷新余额等）
        this.onMessageComplete?.();
      },
      onError: (error: Error) => {
        // 移除空的AI消息
        session!.messages.pop();
        this.onError?.(error);
        this.onMessageUpdate?.(globalItemId, session!.messages);
      },
    };

    // Log API request info
    ztoolkit.log("[API Request Global] Sending to provider:", provider.getName());
    ztoolkit.log("[API Request Global] Message count:", session.messages.length - 1);
    ztoolkit.log("[API Request Global] Has images:", options.images && options.images.length > 0 ? options.images.length : 0);
    ztoolkit.log("[API Request Global] Has files:", options.files && options.files.length > 0 ? options.files.length : 0);
    ztoolkit.log("[API Request Global] Final content length:", finalContent.length);

    await provider.streamChatCompletion(session.messages.slice(0, -1), callbacks);
  }

  /**
   * 清空会话
   */
  async clearSession(itemId: number): Promise<void> {
    const session = this.sessions.get(itemId);
    if (session) {
      session.messages = [];
      session.pdfAttached = false;
      session.pdfContent = undefined;
      session.updatedAt = Date.now();

      await this.storageService.deleteSession(itemId);
      this.onMessageUpdate?.(itemId, session.messages);
    }
  }

  /**
   * 检查是否有PDF附件
   */
  async hasPdfAttachment(item: Zotero.Item): Promise<boolean> {
    return this.pdfExtractor.hasPdfAttachment(item);
  }

  /**
   * 获取选中的PDF文本
   */
  getSelectedText(): string | null {
    return this.pdfExtractor.getSelectedTextFromReader();
  }

  /**
   * 获取消息渲染器
   */
  getMessageRenderer(): MessageRenderer {
    return this.messageRenderer;
  }

  /**
   * 获取PDF提取器
   */
  getPdfExtractor(): PdfExtractor {
    return this.pdfExtractor;
  }

  /**
   * 生成唯一ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * 获取所有会话列表（带item信息）
   * 直接使用StorageService缓存的索引，性能更好
   */
  async getAllSessions(): Promise<Array<{
    itemId: number;
    itemName: string;
    messageCount: number;
    lastMessage: string;
    lastUpdated: number;
  }>> {
    const storedSessions = await this.storageService.listSessions();

    // 索引已经包含所有需要的信息，直接映射返回
    return storedSessions.map((meta) => ({
      itemId: meta.itemId,
      itemName: meta.itemName,
      messageCount: meta.messageCount,
      lastMessage: meta.lastMessagePreview,
      lastUpdated: meta.lastUpdated,
    }));
  }

  /**
   * 加载指定item的会话到当前
   */
  async loadSessionForItem(itemId: number): Promise<ChatSession | null> {
    const session = await this.storageService.loadSession(itemId);
    if (session) {
      this.sessions.set(itemId, session);
      this.activeItemId = itemId;
      return session;
    }
    return null;
  }

  /**
   * 销毁
   */
  async destroy(): Promise<void> {
    // 保存所有会话
    for (const session of this.sessions.values()) {
      await this.storageService.saveSession(session);
    }
    this.sessions.clear();
  }
}
