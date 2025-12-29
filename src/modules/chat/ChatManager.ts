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
import { getProviderManager } from "../providers";
import { getAuthManager } from "../auth";
import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";

export class ChatManager {
  private sessions: Map<number, ChatSession> = new Map();
  private activeItemId: number | null = null;
  private storageService: StorageService;
  private pdfExtractor: PdfExtractor;

  // UI回调
  private onMessageUpdate?: (itemId: number, messages: ChatMessage[]) => void;
  private onStreamingUpdate?: (itemId: number, content: string) => void;
  private onError?: (error: Error) => void;
  private onPdfAttached?: () => void; // 通知UI取消勾选PDF checkbox
  private onMessageComplete?: () => void; // 消息完成后通知（用于刷新余额等）

  constructor() {
    this.storageService = new StorageService();
    this.pdfExtractor = new PdfExtractor();
  }

  /**
   * Get the active AI provider
   */
  private getActiveProvider() {
    return getProviderManager().getActiveProvider();
  }

  /**
   * 检查错误是否为认证错误 (401/403 或令牌相关错误)
   */
  private isAuthError(error: Error): boolean {
    const message = error.message || "";
    return (
      // HTTP 状态码
      message.includes("API Error: 401") ||
      message.includes("API Error: 403") ||
      // 英文错误消息
      message.includes("Unauthorized") ||
      message.includes("Invalid API key") ||
      message.includes("authentication") ||
      message.includes("invalid_api_key") ||
      // 中文错误消息 (NewAPI)
      message.includes("无效的令牌") ||
      message.includes("未提供令牌") ||
      message.includes("令牌状态不可用") ||
      message.includes("令牌已过期") ||
      message.includes("令牌额度不足")
    );
  }

  /**
   * 检查当前 provider 是否为 PaperChat (支持 token 刷新)
   */
  private isPaperChatProvider(): boolean {
    const provider = this.getActiveProvider();
    return provider?.getName() === "PaperChat";
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
    return this.getOrCreateSession(item.id);
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
   * 显示错误消息到聊天界面
   */
  async showErrorMessage(content: string): Promise<void> {
    const itemId = this.activeItemId ?? 0;
    const session = await this.getOrCreateSession(itemId);
    const errorMessage: ChatMessage = {
      id: this.generateId(),
      role: "assistant",
      content,
      timestamp: Date.now(),
    };
    session.messages.push(errorMessage);
    this.onMessageUpdate?.(itemId, session.messages);
  }

  /**
   * 发送消息（统一方法，支持全局聊天和绑定 Item 的聊天）
   * @param content 消息内容
   * @param options 选项，包含可选的 item（为 null 或 item.id === 0 时为全局聊天）
   */
  async sendMessage(
    content: string,
    options: SendMessageOptions & { item?: Zotero.Item | null } = {},
  ): Promise<void> {
    const item = options.item;
    const itemId = item?.id ?? 0;
    const isGlobalChat = !item || item.id === 0;

    ztoolkit.log("[ChatManager] sendMessage called, itemId:", itemId, "isGlobal:", isGlobalChat);

    // 获取或创建会话
    const session = await this.getOrCreateSession(itemId);

    // 获取活动的 AI 提供商
    const provider = this.getActiveProvider();
    ztoolkit.log("[ChatManager] provider:", provider?.getName(), "isReady:", provider?.isReady());

    if (!provider || !provider.isReady()) {
      ztoolkit.log("[ChatManager] Provider not ready, showing error in chat");
      const errorMessage: ChatMessage = {
        id: this.generateId(),
        role: "assistant",
        content: getString("chat-error-no-provider" as Parameters<typeof getString>[0]),
        timestamp: Date.now(),
      };
      session.messages.push(errorMessage);
      this.onMessageUpdate?.(itemId, session.messages);
      return;
    }

    // Debug: log options
    ztoolkit.log("[ChatManager] sendMessage options:", {
      attachPdf: options.attachPdf,
      hasImages: options.images?.length || 0,
      hasFiles: options.files?.length || 0,
      hasSelectedText: !!options.selectedText,
    });

    // 构建最终消息内容
    let finalContent = content;

    // 处理选中文本
    if (options.selectedText) {
      const prefix = isGlobalChat ? "[Selected text]" : "[Selected text from PDF]";
      finalContent = `${prefix}:\n"${options.selectedText}"\n\n[Question]:\n${content}`;
    }

    // PDF 附件相关（仅非全局模式）
    let pdfAttachment: { data: string; mimeType: string; name: string } | undefined;
    let pdfWasAttached = false;

    if (!isGlobalChat && options.attachPdf && item) {
      const pdfInfo = await this.pdfExtractor.getPdfInfo(item);
      ztoolkit.log("[PDF Attach] Checkbox checked, attempting to attach PDF");
      ztoolkit.log("[PDF Attach] PDF info:", pdfInfo ? `name=${pdfInfo.name}, size=${pdfInfo.size} bytes` : "No PDF found");

      // 优先尝试文本提取
      const pdfText = await this.pdfExtractor.extractPdfText(item);
      if (pdfText) {
        session.pdfContent = pdfText;
        session.pdfAttached = true;
        pdfWasAttached = true;
        ztoolkit.log("[PDF Attach] PDF text extracted successfully, text length:", pdfText.length);
        finalContent = `[PDF Content]:\n${pdfText.substring(0, 50000)}\n\n[Question]:\n${content}`;
      } else if (provider.supportsPdfUpload() && getPref("uploadRawPdfOnFailure")) {
        // 文本提取失败，且用户允许上传原始 PDF，尝试 PDF 文件上传
        ztoolkit.log("[PDF Attach] Text extraction failed, trying PDF file upload");
        const pdfBase64 = await this.pdfExtractor.getPdfBase64(item);
        if (pdfBase64) {
          pdfAttachment = pdfBase64;
          session.pdfAttached = true;
          pdfWasAttached = true;
          ztoolkit.log("[PDF Attach] PDF file ready for upload:", pdfBase64.name);
        }
      } else if (!pdfText) {
        ztoolkit.log("[PDF Attach] Text extraction failed and raw PDF upload is disabled");
      }
    }

    // 处理文件附件
    if (options.files && options.files.length > 0) {
      ztoolkit.log("[File Attach] Processing", options.files.length, "file(s)");
      const filesContent = options.files
        .map((f) => `[File: ${f.name}]\n${f.content}`)
        .join("\n\n");
      finalContent = `${filesContent}\n\n[Question]:\n${content}`;
    }

    // 处理图片附件
    if (options.images && options.images.length > 0) {
      ztoolkit.log("[Image Attach] Processing", options.images.length, "image(s)");
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

    session.messages.push(userMessage);
    session.updatedAt = Date.now();
    this.onMessageUpdate?.(itemId, session.messages);

    // 创建 AI 消息占位
    const assistantMessage: ChatMessage = {
      id: this.generateId(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };

    session.messages.push(assistantMessage);
    this.onMessageUpdate?.(itemId, session.messages);

    // Log API request info
    ztoolkit.log("[API Request] Sending to provider:", provider.getName());
    ztoolkit.log("[API Request] Message count:", session.messages.length - 1);
    ztoolkit.log("[API Request] Has images:", options.images?.length || 0);
    ztoolkit.log("[API Request] Has PDF attachment:", pdfAttachment ? "yes" : "no");

    // 调用 API with retry on auth error
    let hasRetried = false;

    const attemptRequest = async (): Promise<void> => {
      return new Promise((resolve) => {
        const callbacks: StreamCallbacks = {
          onChunk: (chunk: string) => {
            assistantMessage.content += chunk;
            this.onStreamingUpdate?.(itemId, assistantMessage.content);
          },
          onComplete: async (fullContent: string) => {
            assistantMessage.content = fullContent;
            assistantMessage.timestamp = Date.now();
            session.updatedAt = Date.now();

            await this.storageService.saveSession(session);
            this.onMessageUpdate?.(itemId, session.messages);

            if (pdfWasAttached) {
              this.onPdfAttached?.();
            }
            this.onMessageComplete?.();
            resolve();
          },
          onError: async (error: Error) => {
            ztoolkit.log("[API Error]", error.message);

            // 检查是否为认证错误，且可以重试
            if (!hasRetried && this.isAuthError(error) && this.isPaperChatProvider()) {
              ztoolkit.log("[API Error] Auth error detected, attempting to refresh API key...");
              hasRetried = true;

              try {
                // 刷新 API key
                const authManager = getAuthManager();
                await authManager.ensurePluginToken(true); // forceRefresh

                // 重置 assistant message 内容
                assistantMessage.content = "";
                ztoolkit.log("[API Retry] API key refreshed, retrying request...");

                // 重新获取 provider (它会使用新的 API key)
                const newProvider = this.getActiveProvider();
                if (newProvider && newProvider.isReady()) {
                  // 递归重试
                  await attemptRequest();
                  resolve();
                  return;
                }
              } catch (retryError) {
                ztoolkit.log("[API Retry] Failed to refresh API key:", retryError);
              }
            }

            // 显示错误消息
            session.messages.pop();

            const errorMessage: ChatMessage = {
              id: this.generateId(),
              role: "error",
              content: error.message,
              timestamp: Date.now(),
            };
            session.messages.push(errorMessage);

            this.onError?.(error);
            this.onMessageUpdate?.(itemId, session.messages);
            resolve();
          },
        };

        provider.streamChatCompletion(session.messages.slice(0, -1), callbacks, pdfAttachment);
      });
    };

    await attemptRequest();
  }

  /**
   * 获取或创建会话（支持全局聊天 itemId=0）
   */
  private async getOrCreateSession(itemId: number): Promise<ChatSession> {
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
   * 清空会话（同时删除本地存储）
   */
  async clearSession(itemId: number): Promise<void> {
    // 清空内存中的会话（如果存在）
    const session = this.sessions.get(itemId);
    if (session) {
      session.messages = [];
      session.pdfAttached = false;
      session.pdfContent = undefined;
      session.updatedAt = Date.now();
      this.onMessageUpdate?.(itemId, session.messages);
    }

    // 无论内存中是否存在，都尝试删除本地存储
    await this.storageService.deleteSession(itemId);
    ztoolkit.log("Session cleared and deleted from storage:", itemId);
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
