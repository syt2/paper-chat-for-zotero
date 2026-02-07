/**
 * ChatManager - 聊天会话管理核心类
 *
 * 职责:
 * 1. 管理独立的聊天会话 (session 独立于 item)
 * 2. 处理消息发送和接收
 * 3. 跟踪当前活动的 item，在切换时插入 system-notice
 * 4. 动态调整工具列表和 system prompt
 */

import type {
  ChatMessage,
  ChatSession,
  SendMessageOptions,
  StreamCallbacks,
  StreamToolCallingCallbacks,
  SessionMeta,
} from "../../types/chat";
import type { ToolDefinition, ToolCall } from "../../types/tool";
import type { ToolCallingProvider, AIProvider } from "../../types/provider";
import { SessionStorageService } from "./SessionStorageService";
import { PdfExtractor } from "./PdfExtractor";
import { getContextManager } from "./ContextManager";
import { getPdfToolManager } from "./pdf-tools";
import { getProviderManager } from "../providers";
import { getAuthManager } from "../auth";
import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import { getErrorMessage, getItemTitleSmart, generateTimestampId } from "../../utils/common";
// V1 migration now handled by migrateToSQLite.ts at startup

/**
 * Type guard: check if provider supports tool calling
 * Works with any AIProvider (for fallback compatibility)
 */
function providerSupportsToolCalling(
  provider: AIProvider,
): provider is AIProvider & ToolCallingProvider {
  return (
    "chatCompletionWithTools" in provider &&
    typeof (provider as ToolCallingProvider).chatCompletionWithTools === "function"
  );
}

/**
 * Type guard: check if provider supports streaming tool calling
 */
function providerSupportsStreamingToolCalling(
  provider: AIProvider,
): provider is AIProvider & ToolCallingProvider & {
  streamChatCompletionWithTools: NonNullable<
    ToolCallingProvider["streamChatCompletionWithTools"]
  >;
} {
  return (
    providerSupportsToolCalling(provider) &&
    "streamChatCompletionWithTools" in provider &&
    typeof provider.streamChatCompletionWithTools === "function"
  );
}
// 使用 common.ts 中的 getItemTitleSmart 获取 item 标题

export class ChatManager {
  private sessionStorage: SessionStorageService;
  private pdfExtractor: PdfExtractor;
  private currentSession: ChatSession | null = null;
  private currentItemKey: string | null = null;
  private currentItemKeys: string[] = []; // 多文档支持
  private initialized: boolean = false;

  // Sessions that currently have an in-flight send/stream operation.
  // switchSession() reuses these objects instead of loading from DB,
  // so that isSessionActive() returns true and UI updates resume
  // when the user switches back to a session that is still streaming.
  private streamingSessions = new Map<string, ChatSession>();

  // UI回调
  private onMessageUpdate?: (messages: ChatMessage[]) => void;
  private onStreamingUpdate?: (content: string) => void;
  private onError?: (error: Error) => void;
  private onPdfAttached?: () => void;
  private onMessageComplete?: () => void;
  private onSelectedItemsChange?: (itemKeys: string[]) => void; // 多文档选择变化回调
  private onFallbackNotice?: (fromProvider: string, toProvider: string) => void; // 降级通知回调

  constructor() {
    this.sessionStorage = new SessionStorageService();
    this.pdfExtractor = new PdfExtractor();
  }

  /**
   * 初始化 ChatManager
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // 初始化存储服务 (migration handled at startup in hooks.ts)
    await this.sessionStorage.init();

    // 加载活动 session
    this.currentSession = await this.sessionStorage.getOrCreateActiveSession();

    this.initialized = true;
    ztoolkit.log("[ChatManager] Initialized");
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
      message.includes("API Error: 401") ||
      message.includes("API Error: 403") ||
      message.includes("Unauthorized") ||
      message.includes("Invalid API key") ||
      message.includes("authentication") ||
      message.includes("invalid_api_key") ||
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
   * Check if the given session is still the active/displayed session.
   * Used to guard UI callbacks so we don't update the UI for a session
   * the user has navigated away from.
   */
  private isSessionActive(session: ChatSession): boolean {
    return this.currentSession === session;
  }

  /**
   * 设置UI回调
   */
  setCallbacks(callbacks: {
    onMessageUpdate?: (messages: ChatMessage[]) => void;
    onStreamingUpdate?: (content: string) => void;
    onError?: (error: Error) => void;
    onPdfAttached?: () => void;
    onMessageComplete?: () => void;
    onSelectedItemsChange?: (itemKeys: string[]) => void;
    onFallbackNotice?: (fromProvider: string, toProvider: string) => void;
  }): void {
    this.onMessageUpdate = callbacks.onMessageUpdate;
    this.onStreamingUpdate = callbacks.onStreamingUpdate;
    this.onError = callbacks.onError;
    this.onPdfAttached = callbacks.onPdfAttached;
    this.onMessageComplete = callbacks.onMessageComplete;
    this.onSelectedItemsChange = callbacks.onSelectedItemsChange;
    this.onFallbackNotice = callbacks.onFallbackNotice;

    // 设置 ProviderManager 的降级回调
    const providerManager = getProviderManager();
    providerManager.setOnFallback((from, to, error) => {
      ztoolkit.log(`[ChatManager] Provider fallback: ${from} -> ${to}, error: ${error.message}`);
      // 在聊天消息中插入降级通知 (fire-and-forget)
      this.insertFallbackNotice(from, to).catch((err) => {
        ztoolkit.log("[ChatManager] Failed to persist fallback notice:", err);
      });
      // 通知 UI 层（如果需要额外处理）
      this.onFallbackNotice?.(from, to);
    });
  }

  /**
   * 设置当前活动的 Item Key (单文档模式，向后兼容)
   */
  setCurrentItemKey(itemKey: string | null): void {
    this.currentItemKey = itemKey;
    // 同步更新多文档列表
    this.currentItemKeys = itemKey ? [itemKey] : [];
    // 同步更新 PdfToolManager
    getPdfToolManager().setCurrentItemKey(itemKey);
    getPdfToolManager().setCurrentItemKeys(this.currentItemKeys);
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
    // 保持向后兼容：单文档 key 取第一个
    this.currentItemKey = itemKeys[0] || null;
    // 同步更新 PdfToolManager
    getPdfToolManager().setCurrentItemKeys(itemKeys);
    getPdfToolManager().setCurrentItemKey(this.currentItemKey);
    // 更新 session
    if (this.currentSession) {
      this.currentSession.lastActiveItemKeys = itemKeys;
      this.currentSession.lastActiveItemKey = this.currentItemKey;
    }
    // 通知 UI
    this.onSelectedItemsChange?.(itemKeys);
  }

  /**
   * 获取当前活动的多个 Item Keys
   */
  getCurrentItemKeys(): string[] {
    return this.currentItemKeys;
  }

  /**
   * 添加一个 Item 到当前选择
   */
  addItemToSelection(itemKey: string): void {
    if (!this.currentItemKeys.includes(itemKey)) {
      this.setCurrentItemKeys([...this.currentItemKeys, itemKey]);
    }
  }

  /**
   * 从当前选择移除一个 Item
   */
  removeItemFromSelection(itemKey: string): void {
    this.setCurrentItemKeys(this.currentItemKeys.filter(k => k !== itemKey));
  }

  /**
   * 清空所有选择的 Items
   */
  clearItemSelection(): void {
    this.setCurrentItemKeys([]);
  }

  /**
   * 获取当前活动会话
   */
  getActiveSession(): ChatSession | null {
    return this.currentSession;
  }

  /**
   * 创建新 session
   */
  async createNewSession(): Promise<ChatSession> {
    await this.init();
    this.currentSession = await this.sessionStorage.createSession();
    return this.currentSession;
  }

  /**
   * 切换到指定 session
   */
  async switchSession(sessionId: string): Promise<ChatSession | null> {
    await this.init();

    // If the target session is currently streaming, reuse its in-memory
    // object so that isSessionActive(sendingSession) returns true and
    // live streaming updates resume on the UI.
    const session = this.streamingSessions.get(sessionId)
      ?? await this.sessionStorage.loadSession(sessionId);

    if (session) {
      this.currentSession = session;
      await this.sessionStorage.setActiveSession(sessionId);
      // 恢复 lastActiveItemKey 和 lastActiveItemKeys
      this.currentItemKey = session.lastActiveItemKey;
      this.currentItemKeys = session.lastActiveItemKeys || (this.currentItemKey ? [this.currentItemKey] : []);
      getPdfToolManager().setCurrentItemKey(this.currentItemKey);
      getPdfToolManager().setCurrentItemKeys(this.currentItemKeys);
    }
    return session;
  }

  /**
   * 删除 session
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.init();
    await this.sessionStorage.deleteSession(sessionId);

    // 清理 ContextManager 中的相关状态
    getContextManager().onSessionDeleted(sessionId);
    this.streamingSessions.delete(sessionId);

    // 如果删除的是当前 session，切换到最近的或创建新的
    if (this.currentSession?.id === sessionId) {
      this.currentSession =
        await this.sessionStorage.getOrCreateActiveSession();
    }
  }

  /**
   * 获取所有 session 列表
   */
  async getAllSessions(): Promise<SessionMeta[]> {
    await this.init();
    return this.sessionStorage.listSessions();
  }

  /**
   * 显示错误消息到聊天界面
   */
  async showErrorMessage(content: string): Promise<void> {
    if (!this.currentSession) {
      await this.init();
    }

    const errorMessage: ChatMessage = {
      id: this.generateId(),
      role: "assistant",
      content,
      timestamp: Date.now(),
    };
    this.currentSession!.messages.push(errorMessage);
    await this.sessionStorage.insertMessage(this.currentSession!.id, errorMessage);
    this.onMessageUpdate?.(this.currentSession!.messages);
  }

  /**
   * 插入降级通知消息到聊天界面
   */
  private async insertFallbackNotice(fromProvider: string, toProvider: string): Promise<void> {
    if (!this.currentSession) return;

    const notice: ChatMessage = {
      id: this.generateId(),
      role: "system",
      content: `⚠️ ${fromProvider} unavailable, switching to ${toProvider}...`,
      timestamp: Date.now(),
      isSystemNotice: true,
    };

    this.currentSession.messages.push(notice);
    await this.sessionStorage.insertMessage(this.currentSession.id, notice);
    this.onMessageUpdate?.(this.currentSession.messages);
  }

  /**
   * 插入 item 切换的 system-notice 消息
   */
  private async insertItemSwitchNotice(
    newItemKey: string,
    newItemTitle: string,
    session?: ChatSession,
  ): Promise<void> {
    const target = session ?? this.currentSession;
    if (!target) return;

    const notice: ChatMessage = {
      id: this.generateId(),
      role: "system",
      content: `--- Switched to paper: "${newItemTitle}" ---`,
      timestamp: Date.now(),
      isSystemNotice: true,
    };

    target.messages.push(notice);
    await this.sessionStorage.insertMessage(target.id, notice);
    target.lastActiveItemKey = newItemKey;
  }

  /**
   * 发送消息
   * @param content 消息内容
   * @param options 选项
   */
  async sendMessage(
    content: string,
    options: SendMessageOptions & { item?: Zotero.Item | null } = {},
  ): Promise<void> {
    await this.init();

    const item = options.item;
    const hasCurrentItem = item !== null && item !== undefined && item.id !== 0;
    const itemKey = hasCurrentItem ? item!.key : null;
    const itemTitle = hasCurrentItem ? getItemTitleSmart(item!) : null;

    ztoolkit.log(
      "[ChatManager] sendMessage called, hasCurrentItem:",
      hasCurrentItem,
      "itemKey:",
      itemKey,
    );

    // 确保有 session
    if (!this.currentSession) {
      this.currentSession =
        await this.sessionStorage.getOrCreateActiveSession();
    }

    // Capture a stable reference to the session we're sending in.
    // This ensures DB writes and in-memory mutations target the correct
    // session even if the user switches sessions mid-stream.
    const sendingSession = this.currentSession;

    // 检查是否需要插入 item 切换通知
    if (itemKey !== sendingSession.lastActiveItemKey) {
      if (hasCurrentItem) {
        // 切换到新 item
        await this.insertItemSwitchNotice(itemKey!, itemTitle!, sendingSession);
      } else if (sendingSession.lastActiveItemKey !== null) {
        // 从有 item 切换到无 item
        const notice: ChatMessage = {
          id: this.generateId(),
          role: "system",
          content: `--- No paper selected ---`,
          timestamp: Date.now(),
          isSystemNotice: true,
        };
        sendingSession.messages.push(notice);
        await this.sessionStorage.insertMessage(sendingSession.id, notice);
        sendingSession.lastActiveItemKey = null;
      }
      // 更新当前 itemKey
      this.currentItemKey = itemKey;
      getPdfToolManager().setCurrentItemKey(itemKey);
    }

    // 获取活动的 AI 提供商
    const provider = this.getActiveProvider();
    ztoolkit.log(
      "[ChatManager] provider:",
      provider?.getName(),
      "isReady:",
      provider?.isReady(),
    );

    if (!provider || !provider.isReady()) {
      ztoolkit.log("[ChatManager] Provider not ready, showing error in chat");
      const errorMessage: ChatMessage = {
        id: this.generateId(),
        role: "assistant",
        content: getString(
          "chat-error-no-provider" as Parameters<typeof getString>[0],
        ),
        timestamp: Date.now(),
      };
      sendingSession.messages.push(errorMessage);
      await this.sessionStorage.insertMessage(sendingSession.id, errorMessage);
      if (this.isSessionActive(sendingSession)) {
        this.onMessageUpdate?.(sendingSession.messages);
      }
      return;
    }

    // 构建最终消息内容
    let finalContent = content;

    // 处理选中文本
    if (options.selectedText) {
      const prefix = hasCurrentItem
        ? "[Selected text from PDF]"
        : "[Selected text]";
      finalContent = `${prefix}:\n"${options.selectedText}"\n\n[Question]:\n${content}`;
    }

    // PDF 附件相关
    let pdfAttachment:
      | { data: string; mimeType: string; name: string }
      | undefined;
    let pdfWasAttached = false;

    ztoolkit.log("[Tool Calling] provider type:", provider?.constructor?.name);
    ztoolkit.log(
      "[Tool Calling] providerSupportsToolCalling:",
      providerSupportsToolCalling(provider),
    );

    // 如果 provider 支持 tool calling，启用 tool calling 模式
    // 即使没有 PDF，也可以使用 library 工具（搜索、笔记等）
    const useToolCalling = providerSupportsToolCalling(provider);

    if (useToolCalling) {
      // 如果有当前 item，尝试提取 PDF（用于 PDF 相关工具）
      if (hasCurrentItem && item) {
        const hasPdf = await this.pdfExtractor.hasPdfAttachment(item);
        ztoolkit.log("[PDF Auto-detect] Item has PDF:", hasPdf);

        if (hasPdf) {
          const pdfText = await this.pdfExtractor.extractPdfText(item);
          if (pdfText) {
            pdfWasAttached = true;
            ztoolkit.log("[PDF Auto-detect] PDF extracted for tool calling");
          } else {
            ztoolkit.log("[PDF Auto-detect] PDF text extraction failed");
            // 尝试原始 PDF 上传
            if (
              provider.supportsPdfUpload() &&
              getPref("uploadRawPdfOnFailure")
            ) {
              const pdfBase64 = await this.pdfExtractor.getPdfBase64(item);
              if (pdfBase64) {
                pdfAttachment = pdfBase64;
                pdfWasAttached = true;
                ztoolkit.log(
                  "[PDF Auto-detect] Using raw PDF upload as fallback",
                );
              }
            }
          }
        }
      }
    } else if (hasCurrentItem && item) {
      // Provider 不支持 tool calling，使用传统模式
      const hasPdf = await this.pdfExtractor.hasPdfAttachment(item);
      if (hasPdf) {
        const pdfText = await this.pdfExtractor.extractPdfText(item);
        if (pdfText) {
          pdfWasAttached = true;
          finalContent = `[PDF Content]:\n${pdfText.substring(0, 50000)}\n\n[Question]:\n${content}`;
          ztoolkit.log("[PDF Legacy] Embedded PDF content in message");
        }
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

    // 创建用户消息
    const userMessage: ChatMessage = {
      id: this.generateId(),
      role: "user",
      content: finalContent,
      images: options.images,
      files: options.files,
      timestamp: Date.now(),
      pdfContext: pdfWasAttached,
      selectedText: options.selectedText,
    };

    sendingSession.messages.push(userMessage);
    await this.sessionStorage.insertMessage(sendingSession.id, userMessage);
    sendingSession.updatedAt = Date.now();
    if (this.isSessionActive(sendingSession)) {
      this.onMessageUpdate?.(sendingSession.messages);
    }

    // 创建 AI 消息占位
    const assistantMessage: ChatMessage = {
      id: this.generateId(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };

    sendingSession.messages.push(assistantMessage);
    await this.sessionStorage.insertMessage(sendingSession.id, assistantMessage);
    if (this.isSessionActive(sendingSession)) {
      this.onMessageUpdate?.(sendingSession.messages);
    }

    // 获取上下文管理器并过滤消息
    const contextManager = getContextManager();
    const { messages: filteredMessages, summaryTriggered } =
      contextManager.filterMessages(sendingSession);

    // 从过滤后的消息中排除最后一条 (assistant 占位)
    const messagesForApi = filteredMessages.filter(
      (m) => m.id !== assistantMessage.id,
    );

    ztoolkit.log(
      "[API Request] Original message count:",
      sendingSession.messages.length,
    );
    ztoolkit.log(
      "[API Request] Filtered message count:",
      messagesForApi.length,
    );
    ztoolkit.log("[API Request] Use tool calling:", useToolCalling);

    // Register the session as actively streaming so that switchSession()
    // can reuse this in-memory object and resume UI updates.
    this.streamingSessions.set(sendingSession.id, sendingSession);
    try {
      // 如果启用 tool calling
      if (useToolCalling && providerSupportsToolCalling(provider)) {
        ztoolkit.log("[Tool Calling] Using tool calling mode");
        await this.sendMessageWithToolCalling(
          provider,
          messagesForApi,
          assistantMessage,
          pdfWasAttached,
          summaryTriggered,
          hasCurrentItem,
          item!,
          sendingSession,
        );
        return;
      }

      // 传统模式：流式调用（带自动降级）
      const providerManager = getProviderManager();

      try {
        await providerManager.executeWithFallback(async (currentProvider) => {
          // 重置 assistant 消息内容（降级时需要清空之前的部分内容）
          assistantMessage.content = "";

          return new Promise<void>((resolve, reject) => {
            const callbacks: StreamCallbacks = {
              onChunk: (chunk: string) => {
                assistantMessage.content += chunk;
                if (this.isSessionActive(sendingSession)) {
                  this.onStreamingUpdate?.(assistantMessage.content);
                }
              },
              onComplete: async (fullContent: string) => {
                assistantMessage.content = fullContent;
                assistantMessage.timestamp = Date.now();
                sendingSession.updatedAt = Date.now();

                await this.sessionStorage.updateMessageContent(sendingSession.id, assistantMessage.id, fullContent);
                await this.sessionStorage.updateSessionMeta(sendingSession);
                if (this.isSessionActive(sendingSession)) {
                  this.onMessageUpdate?.(sendingSession.messages);

                  if (pdfWasAttached) {
                    this.onPdfAttached?.();
                  }
                  this.onMessageComplete?.();
                }

                // 异步触发摘要生成（不阻塞主流程）
                if (summaryTriggered) {
                  contextManager
                    .generateSummaryAsync(sendingSession, async () => {
                      await this.sessionStorage.updateSessionMeta(sendingSession);
                    })
                    .catch((err) => {
                      ztoolkit.log("[ChatManager] Summary generation failed:", err);
                    });
                }

                resolve();
              },
              onError: async (error: Error) => {
                ztoolkit.log("[API Error]", error.message);

                // 对于 PaperChat 的认证错误，尝试刷新 token
                if (this.isAuthError(error) && currentProvider.getName() === "PaperChat") {
                  try {
                    const authManager = getAuthManager();
                    await authManager.ensurePluginToken(true);
                    ztoolkit.log("[API Retry] Token refreshed, but will use fallback mechanism");
                  } catch (refreshError) {
                    ztoolkit.log("[API Retry] Failed to refresh token:", refreshError);
                  }
                }

                // 拒绝 Promise，让 executeWithFallback 处理降级
                reject(error);
              },
            };

            currentProvider.streamChatCompletion(messagesForApi, callbacks, pdfAttachment);
          });
        });
      } catch (error) {
        // 所有 provider 都失败了
        ztoolkit.log("[ChatManager] All providers failed:", error);

        // 移除 assistant 占位消息（使用 id 精确定位，避免误删 fallback notice）
        const assistantIndex = sendingSession.messages.findIndex(
          (m) => m.id === assistantMessage.id
        );
        if (assistantIndex !== -1) {
          sendingSession.messages.splice(assistantIndex, 1);
          await this.sessionStorage.deleteMessage(sendingSession.id, assistantMessage.id);
        }

        const errorMessage: ChatMessage = {
          id: this.generateId(),
          role: "error",
          content: getErrorMessage(error),
          timestamp: Date.now(),
        };
        sendingSession.messages.push(errorMessage);
        await this.sessionStorage.insertMessage(sendingSession.id, errorMessage);

        if (this.isSessionActive(sendingSession)) {
          this.onError?.(error instanceof Error ? error : new Error(String(error)));
          this.onMessageUpdate?.(sendingSession.messages);
        }
      }
    } finally {
      this.streamingSessions.delete(sendingSession.id);
    }
  }

  /**
   * 使用 Tool Calling 发送消息
   * 优先使用流式模式，fallback 到非流式
   * 支持 provider 降级：在第一次调用时选择可用的 provider
   */
  private async sendMessageWithToolCalling(
    _provider: ToolCallingProvider, // 原始 provider，可能被降级替换
    messagesForApi: ChatMessage[],
    assistantMessage: ChatMessage,
    pdfWasAttached: boolean,
    summaryTriggered: boolean,
    hasCurrentItem: boolean,
    item: Zotero.Item,
    sendingSession: ChatSession,
  ): Promise<void> {
    const pdfToolManager = getPdfToolManager();
    const providerManager = getProviderManager();

    // 获取动态工具列表
    const tools = pdfToolManager.getToolDefinitions(hasCurrentItem);

    // 实时提取论文结构
    const paperStructure = hasCurrentItem
      ? await pdfToolManager.extractAndParsePaper(item.key)
      : undefined;

    // 添加论文上下文系统提示
    const paperContextPrompt = pdfToolManager.generatePaperContextPrompt(
      paperStructure || undefined,
      hasCurrentItem ? item.key : undefined,
      hasCurrentItem ? getItemTitleSmart(item) : undefined,
      hasCurrentItem,
    );

    const messagesWithContext: ChatMessage[] = [
      {
        id: "paper-context",
        role: "system",
        content: paperContextPrompt,
        timestamp: Date.now(),
      },
      ...messagesForApi,
    ];

    // 使用 executeWithFallback 找到第一个可用的支持 tool calling 的 provider
    // 注意：一旦开始 tool calling 循环，就不再降级（状态难以恢复）
    try {
      await providerManager.executeWithFallback(async (currentProvider) => {
        // 检查 provider 是否支持 tool calling
        if (!providerSupportsToolCalling(currentProvider)) {
          throw new Error(`Provider ${currentProvider.getName()} does not support tool calling`);
        }

        const toolProvider = currentProvider as AIProvider & ToolCallingProvider;

        // 重置 assistant 消息内容（降级时需要清空之前的部分内容）
        assistantMessage.content = "";

        // 检查是否支持流式 tool calling
        if (providerSupportsStreamingToolCalling(currentProvider)) {
          ztoolkit.log(`[Tool Calling] Using streaming mode with ${currentProvider.getName()}`);
          await this.sendMessageWithStreamingToolCalling(
            currentProvider as AIProvider & ToolCallingProvider & {
              streamChatCompletionWithTools: NonNullable<ToolCallingProvider["streamChatCompletionWithTools"]>;
            },
            messagesWithContext,
            assistantMessage,
            pdfWasAttached,
            summaryTriggered,
            tools,
            paperStructure,
            sendingSession,
          );
        } else {
          ztoolkit.log(`[Tool Calling] Using non-streaming mode with ${currentProvider.getName()}`);
          await this.sendMessageWithNonStreamingToolCalling(
            toolProvider,
            messagesWithContext,
            assistantMessage,
            pdfWasAttached,
            summaryTriggered,
            tools,
            paperStructure,
            sendingSession,
          );
        }
      });
    } catch (error) {
      // 所有 provider 都失败了
      ztoolkit.log("[Tool Calling] All providers failed:", error);

      // 移除 assistant 占位消息（使用 id 精确定位，避免误删 fallback notice）
      const assistantIndex = sendingSession.messages.findIndex(
        (m) => m.id === assistantMessage.id
      );
      if (assistantIndex !== -1) {
        sendingSession.messages.splice(assistantIndex, 1);
        await this.sessionStorage.deleteMessage(sendingSession.id, assistantMessage.id);
      }

      const errorMessage: ChatMessage = {
        id: this.generateId(),
        role: "error",
        content: getErrorMessage(error),
        timestamp: Date.now(),
      };
      sendingSession.messages.push(errorMessage);
      await this.sessionStorage.insertMessage(sendingSession.id, errorMessage);

      if (this.isSessionActive(sendingSession)) {
        this.onError?.(error instanceof Error ? error : new Error(String(error)));
        this.onMessageUpdate?.(sendingSession.messages);
      }
    }
  }

  /**
   * 转义 XML 特殊字符，防止 XSS/XML 注入
   */
  private escapeXml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  /**
   * 格式化工具调用卡片（用于 UI 显示）
   */
  private formatToolCallCard(
    toolName: string,
    args: string,
    status: "calling" | "completed" | "error",
    resultPreview?: string,
  ): string {
    const statusIcon =
      status === "calling" ? "⏳" : status === "completed" ? "✓" : "✗";
    const statusText =
      status === "calling"
        ? getString("tool-status-calling")
        : status === "completed"
          ? getString("tool-status-done")
          : getString("tool-status-error");

    // 解析参数用于显示
    let argsDisplay = "";
    try {
      const parsed = JSON.parse(args);
      argsDisplay = Object.entries(parsed)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ");
      if (argsDisplay.length > 60) {
        argsDisplay = argsDisplay.substring(0, 57) + "...";
      }
    } catch {
      argsDisplay = args.length > 60 ? args.substring(0, 57) + "..." : args;
    }

    // 转义所有用户输入，防止 XSS/XML 注入
    const escapedToolName = this.escapeXml(toolName);
    const escapedArgs = this.escapeXml(argsDisplay);
    const escapedResult = resultPreview
      ? this.escapeXml(
          resultPreview.length > 100
            ? resultPreview.substring(0, 97) + "..."
            : resultPreview,
        )
      : "";

    // 使用特殊标记格式，便于 MessageRenderer 识别和渲染
    let card = `\n<tool-call status="${status}">\n`;
    card += `<tool-name>${statusIcon} ${escapedToolName}</tool-name>\n`;
    if (escapedArgs) {
      card += `<tool-args>${escapedArgs}</tool-args>\n`;
    }
    card += `<tool-status>${statusText}</tool-status>\n`;
    if (escapedResult && status === "completed") {
      card += `<tool-result>${escapedResult}</tool-result>\n`;
    }
    card += `</tool-call>\n`;

    return card;
  }

  /**
   * 流式 Tool Calling - 边输出边调用工具
   * 实现类似 Claude Code 的效果：实时显示文本和工具调用状态
   */
  private async sendMessageWithStreamingToolCalling(
    provider: ToolCallingProvider & {
      streamChatCompletionWithTools: NonNullable<
        ToolCallingProvider["streamChatCompletionWithTools"]
      >;
    },
    currentMessages: ChatMessage[],
    assistantMessage: ChatMessage,
    pdfWasAttached: boolean,
    summaryTriggered: boolean,
    tools: ToolDefinition[],
    paperStructure: Awaited<
      ReturnType<typeof getPdfToolManager.prototype.extractAndParsePaper>
    >,
    sendingSession: ChatSession,
  ): Promise<void> {
    const pdfToolManager = getPdfToolManager();
    const contextManager = getContextManager();
    const maxIterations = 10;
    let iteration = 0;

    // 累积的显示内容（跨多轮保持）
    let accumulatedDisplay = "";

    try {
      while (iteration < maxIterations) {
        iteration++;
        ztoolkit.log(
          `[Streaming Tool Calling] Iteration ${iteration}, messages: ${currentMessages.length}`,
        );

        // 本轮的工具调用信息
        const pendingToolCalls = new Map<
          number,
          { id: string; name: string; arguments: string }
        >();

        // 本轮开始前的显示内容长度
        const displayBeforeThisRound = accumulatedDisplay;

        const result = await new Promise<{
          content: string;
          toolCalls?: ToolCall[];
          stopReason: string;
        }>((resolve, reject) => {
          let roundContent = "";
          let stopReason = "end_turn";

          const callbacks: StreamToolCallingCallbacks = {
            onTextDelta: (text) => {
              roundContent += text;
              // 实时更新：显示累积内容 + 本轮文本
              assistantMessage.content = displayBeforeThisRound + roundContent;
              if (this.isSessionActive(sendingSession)) {
                this.onStreamingUpdate?.(assistantMessage.content);
              }
            },
            onToolCallStart: ({ index, id, name }) => {
              pendingToolCalls.set(index, { id, name, arguments: "" });
              ztoolkit.log(
                `[Streaming Tool Calling] Tool call started: ${name} (${id})`,
              );
              // 注意：这里不显示卡片，因为参数还在流式接收中
              // 等到工具实际执行时再显示完整的 "calling" 卡片，避免 UI 闪烁
            },
            onToolCallDelta: (index, argumentsDelta) => {
              const tc = pendingToolCalls.get(index);
              if (tc) {
                tc.arguments += argumentsDelta;
              }
            },
            onComplete: (result) => {
              stopReason = result.stopReason;
              // Build tool calls from accumulated data
              const toolCalls: ToolCall[] = [];
              for (const [, tc] of pendingToolCalls) {
                toolCalls.push({
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.name,
                    arguments: tc.arguments,
                  },
                });
              }
              resolve({
                content: roundContent,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                stopReason,
              });
            },
            onError: (error) => {
              reject(error);
            },
          };

          // 调用流式方法，捕获可能的同步异常
          provider
            .streamChatCompletionWithTools(currentMessages, tools, callbacks)
            .catch(reject);
        });

        ztoolkit.log(
          "[Streaming Tool Calling] Response:",
          result.content ? result.content.substring(0, 100) : "(no content)",
          "toolCalls:",
          result.toolCalls?.length || 0,
          "stopReason:",
          result.stopReason,
        );

        // 如果有工具调用，执行并继续
        if (result.toolCalls && result.toolCalls.length > 0) {
          // 添加带 tool_calls 的 assistant 消息到上下文
          const assistantToolMessage: ChatMessage = {
            id: this.generateId(),
            role: "assistant",
            content: result.content || "",
            tool_calls: result.toolCalls,
            timestamp: Date.now(),
          };
          currentMessages.push(assistantToolMessage);

          // 累积本轮的文本内容
          if (result.content) {
            accumulatedDisplay += result.content;
          }

          // 执行所有工具，并实时更新显示
          for (const toolCall of result.toolCalls) {
            const toolName = toolCall.function.name;
            const toolArgs = toolCall.function.arguments;

            ztoolkit.log(`[Streaming Tool Calling] Executing: ${toolName}`);

            // 显示"正在调用"状态
            const callingDisplay =
              accumulatedDisplay +
              this.formatToolCallCard(toolName, toolArgs, "calling");
            assistantMessage.content = callingDisplay;
            if (this.isSessionActive(sendingSession)) {
              this.onStreamingUpdate?.(callingDisplay);
            }

            // 执行工具（包装 try-catch 防止意外异常中断聊天）
            let toolResult: string;
            try {
              toolResult = await pdfToolManager.executeToolCall(
                toolCall,
                paperStructure || undefined,
              );
            } catch (error) {
              toolResult = `Error: Tool execution failed: ${getErrorMessage(error)}`;
              ztoolkit.log(`[Streaming Tool Calling] Tool ${toolName} threw error:`, error);
            }

            ztoolkit.log(
              `[Streaming Tool Calling] Result (truncated): ${toolResult.substring(0, 200)}...`,
            );

            // 添加工具结果到上下文
            const toolResultMessage: ChatMessage = {
              id: this.generateId(),
              role: "tool",
              content: toolResult,
              tool_call_id: toolCall.id,
              timestamp: Date.now(),
            };
            currentMessages.push(toolResultMessage);

            // 更新显示：工具执行完成
            accumulatedDisplay += this.formatToolCallCard(
              toolName,
              toolArgs,
              "completed",
              toolResult,
            );
            assistantMessage.content = accumulatedDisplay;
            if (this.isSessionActive(sendingSession)) {
              this.onStreamingUpdate?.(accumulatedDisplay);
            }
          }

          // 继续下一轮
          continue;
        }

        // 没有 tool calls，最终回答
        // 累积本轮内容作为最终显示
        accumulatedDisplay += result.content || "";
        assistantMessage.content = accumulatedDisplay;
        assistantMessage.timestamp = Date.now();
        sendingSession.updatedAt = Date.now();

        await this.sessionStorage.updateMessageContent(sendingSession.id, assistantMessage.id, accumulatedDisplay);
        await this.sessionStorage.updateSessionMeta(sendingSession);
        if (this.isSessionActive(sendingSession)) {
          this.onMessageUpdate?.(sendingSession.messages);

          if (pdfWasAttached) {
            this.onPdfAttached?.();
          }
          this.onMessageComplete?.();
        }

        if (summaryTriggered) {
          contextManager
            .generateSummaryAsync(sendingSession, async () => {
              await this.sessionStorage.updateSessionMeta(sendingSession);
            })
            .catch((err) => {
              ztoolkit.log("[ChatManager] Summary generation failed:", err);
            });
        }

        return;
      }

      // 达到最大迭代次数
      ztoolkit.log("[Streaming Tool Calling] Max iterations reached");
      accumulatedDisplay +=
        "\n\nI apologize, but I was unable to complete the request within the allowed number of iterations.";
      assistantMessage.content = accumulatedDisplay;
      assistantMessage.timestamp = Date.now();
      sendingSession.updatedAt = Date.now();
      await this.sessionStorage.updateMessageContent(sendingSession.id, assistantMessage.id, accumulatedDisplay);
      await this.sessionStorage.updateSessionMeta(sendingSession);
      if (this.isSessionActive(sendingSession)) {
        this.onMessageUpdate?.(sendingSession.messages);
        this.onMessageComplete?.();
      }
    } catch (error) {
      ztoolkit.log("[Streaming Tool Calling] Error:", error);
      // 重新抛出错误，让外层的 executeWithFallback 处理降级
      throw error;
    }
  }

  /**
   * 非流式 Tool Calling - 等待完整响应后再继续
   * 使用与流式相同的累积显示逻辑
   */
  private async sendMessageWithNonStreamingToolCalling(
    provider: ToolCallingProvider,
    currentMessages: ChatMessage[],
    assistantMessage: ChatMessage,
    pdfWasAttached: boolean,
    summaryTriggered: boolean,
    tools: ToolDefinition[],
    paperStructure: Awaited<
      ReturnType<typeof getPdfToolManager.prototype.extractAndParsePaper>
    >,
    sendingSession: ChatSession,
  ): Promise<void> {
    const pdfToolManager = getPdfToolManager();
    const contextManager = getContextManager();
    const maxIterations = 10;
    let iteration = 0;

    // 累积的显示内容（跨多轮保持）
    let accumulatedDisplay = "";

    try {
      while (iteration < maxIterations) {
        iteration++;
        ztoolkit.log(
          `[Tool Calling] Iteration ${iteration}, messages: ${currentMessages.length}`,
        );

        const result = await provider.chatCompletionWithTools(
          currentMessages,
          tools,
        );

        ztoolkit.log(
          "[Tool Calling] Response:",
          result.content ? result.content.substring(0, 100) : "(no content)",
          "toolCalls:",
          result.toolCalls?.length || 0,
        );

        if (result.toolCalls && result.toolCalls.length > 0) {
          const assistantToolMessage: ChatMessage = {
            id: this.generateId(),
            role: "assistant",
            content: result.content || "",
            tool_calls: result.toolCalls,
            timestamp: Date.now(),
          };
          currentMessages.push(assistantToolMessage);

          // 累积本轮的文本内容
          if (result.content) {
            accumulatedDisplay += result.content;
          }

          // 执行所有工具，并实时更新显示
          for (const toolCall of result.toolCalls) {
            const toolName = toolCall.function.name;
            const toolArgs = toolCall.function.arguments;

            ztoolkit.log(`[Tool Calling] Executing tool: ${toolName}`, toolArgs);

            // 显示"正在调用"状态
            const callingDisplay =
              accumulatedDisplay +
              this.formatToolCallCard(toolName, toolArgs, "calling");
            assistantMessage.content = callingDisplay;
            if (this.isSessionActive(sendingSession)) {
              this.onStreamingUpdate?.(callingDisplay);
            }

            // 执行工具（包装 try-catch 防止意外异常中断聊天）
            let toolResult: string;
            try {
              toolResult = await pdfToolManager.executeToolCall(
                toolCall,
                paperStructure || undefined,
              );
            } catch (error) {
              toolResult = `Error: Tool execution failed: ${getErrorMessage(error)}`;
              ztoolkit.log(`[Tool Calling] Tool ${toolName} threw error:`, error);
            }

            ztoolkit.log(
              `[Tool Calling] Tool result (truncated): ${toolResult.substring(0, 200)}...`,
            );

            // 添加工具结果到上下文
            const toolResultMessage: ChatMessage = {
              id: this.generateId(),
              role: "tool",
              content: toolResult,
              tool_call_id: toolCall.id,
              timestamp: Date.now(),
            };
            currentMessages.push(toolResultMessage);

            // 更新显示：工具执行完成
            accumulatedDisplay += this.formatToolCallCard(
              toolName,
              toolArgs,
              "completed",
              toolResult,
            );
            assistantMessage.content = accumulatedDisplay;
            if (this.isSessionActive(sendingSession)) {
              this.onStreamingUpdate?.(accumulatedDisplay);
            }
          }

          continue;
        }

        // 没有 tool calls，最终回答
        accumulatedDisplay += result.content || "";
        assistantMessage.content = accumulatedDisplay;
        assistantMessage.timestamp = Date.now();
        sendingSession.updatedAt = Date.now();

        await this.sessionStorage.updateMessageContent(sendingSession.id, assistantMessage.id, accumulatedDisplay);
        await this.sessionStorage.updateSessionMeta(sendingSession);
        if (this.isSessionActive(sendingSession)) {
          this.onMessageUpdate?.(sendingSession.messages);

          if (pdfWasAttached) {
            this.onPdfAttached?.();
          }
          this.onMessageComplete?.();
        }

        if (summaryTriggered) {
          contextManager
            .generateSummaryAsync(sendingSession, async () => {
              await this.sessionStorage.updateSessionMeta(sendingSession);
            })
            .catch((err) => {
              ztoolkit.log("[ChatManager] Summary generation failed:", err);
            });
        }

        return;
      }

      // 达到最大迭代次数
      ztoolkit.log("[Tool Calling] Max iterations reached");
      accumulatedDisplay +=
        "\n\nI apologize, but I was unable to complete the request within the allowed number of iterations.";
      assistantMessage.content = accumulatedDisplay;
      assistantMessage.timestamp = Date.now();
      sendingSession.updatedAt = Date.now();
      await this.sessionStorage.updateMessageContent(sendingSession.id, assistantMessage.id, accumulatedDisplay);
      await this.sessionStorage.updateSessionMeta(sendingSession);
      if (this.isSessionActive(sendingSession)) {
        this.onMessageUpdate?.(sendingSession.messages);
        this.onMessageComplete?.();
      }
    } catch (error) {
      ztoolkit.log("[Tool Calling] Error:", error);
      // 重新抛出错误，让外层的 executeWithFallback 处理降级
      throw error;
    }
  }

  /**
   * 清空当前会话
   */
  async clearCurrentSession(): Promise<void> {
    if (!this.currentSession) return;

    this.currentSession.messages = [];
    this.currentSession.contextSummary = undefined;
    this.currentSession.contextState = undefined;
    this.currentSession.lastActiveItemKey = null;
    this.currentSession.lastActiveItemKeys = [];
    this.currentSession.updatedAt = Date.now();

    await this.sessionStorage.deleteAllMessages(this.currentSession.id);
    await this.sessionStorage.updateSessionMeta(this.currentSession);
    this.onMessageUpdate?.(this.currentSession.messages);

    ztoolkit.log("Current session cleared");
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
    return generateTimestampId();
  }

  /**
   * 销毁
   */
  async destroy(): Promise<void> {
    if (this.currentSession) {
      await this.sessionStorage.updateSessionMeta(this.currentSession);
    }
    this.currentSession = null;
    this.currentItemKey = null;
    this.currentItemKeys = [];
    this.streamingSessions.clear();
    this.initialized = false;
  }
}
