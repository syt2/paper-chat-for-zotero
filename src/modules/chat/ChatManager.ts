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
  SessionMeta,
} from "../../types/chat";
import type { ToolDefinition, ToolCall } from "../../types/tool";
import { SessionStorageService } from "./SessionStorageService";
import { PdfExtractor } from "./PdfExtractor";
import { getContextManager } from "./ContextManager";
import { getPdfToolManager } from "./pdf-tools";
import { getProviderManager } from "../providers";
import { getAuthManager } from "../auth";
import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import { checkAndMigrate } from "./migration/migrateV1Sessions";

// Type guard for providers that support tool calling
interface ToolCallingProvider {
  chatCompletionWithTools(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
  ): Promise<{ content: string; toolCalls?: ToolCall[] }>;
}

function supportsToolCalling(
  provider: unknown,
): provider is ToolCallingProvider {
  return (
    provider !== null &&
    typeof provider === "object" &&
    "chatCompletionWithTools" in provider &&
    typeof (provider as ToolCallingProvider).chatCompletionWithTools ===
      "function"
  );
}

/**
 * 获取 item 的正确标题（处理附件情况）
 * 如果 item 是附件，返回父条目的标题
 */
function getItemTitle(item: Zotero.Item): string {
  // 如果是附件，尝试获取父条目的标题
  if (item.isAttachment && item.isAttachment()) {
    const parentID = item.parentItemID;
    if (parentID) {
      const parent = Zotero.Items.get(parentID);
      if (parent) {
        return (
          (parent.getField("title") as string) ||
          item.attachmentFilename ||
          "Untitled"
        );
      }
    }
    // 没有父条目，返回文件名
    return item.attachmentFilename || "Untitled";
  }
  // 普通条目，直接返回标题
  return (item.getField("title") as string) || "Untitled";
}

export class ChatManager {
  private sessionStorage: SessionStorageService;
  private pdfExtractor: PdfExtractor;
  private currentSession: ChatSession | null = null;
  private currentItemKey: string | null = null;
  private initialized: boolean = false;

  // UI回调
  private onMessageUpdate?: (messages: ChatMessage[]) => void;
  private onStreamingUpdate?: (content: string) => void;
  private onError?: (error: Error) => void;
  private onPdfAttached?: () => void;
  private onMessageComplete?: () => void;

  constructor() {
    this.sessionStorage = new SessionStorageService();
    this.pdfExtractor = new PdfExtractor();
  }

  /**
   * 初始化 ChatManager
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // 执行迁移检查
    await checkAndMigrate();

    // 初始化存储服务
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
   * 设置UI回调
   */
  setCallbacks(callbacks: {
    onMessageUpdate?: (messages: ChatMessage[]) => void;
    onStreamingUpdate?: (content: string) => void;
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
   * 设置当前活动的 Item Key
   */
  setCurrentItemKey(itemKey: string | null): void {
    this.currentItemKey = itemKey;
    // 同步更新 PdfToolManager
    getPdfToolManager().setCurrentItemKey(itemKey);
  }

  /**
   * 获取当前活动的 Item Key
   */
  getCurrentItemKey(): string | null {
    return this.currentItemKey;
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
    const session = await this.sessionStorage.loadSession(sessionId);
    if (session) {
      this.currentSession = session;
      await this.sessionStorage.setActiveSession(sessionId);
      // 恢复 lastActiveItemKey
      this.currentItemKey = session.lastActiveItemKey;
      getPdfToolManager().setCurrentItemKey(this.currentItemKey);
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
    this.onMessageUpdate?.(this.currentSession!.messages);
  }

  /**
   * 插入 item 切换的 system-notice 消息
   */
  private insertItemSwitchNotice(
    newItemKey: string,
    newItemTitle: string,
  ): void {
    if (!this.currentSession) return;

    const notice: ChatMessage = {
      id: this.generateId(),
      role: "system",
      content: `--- Switched to paper: "${newItemTitle}" ---`,
      timestamp: Date.now(),
      isSystemNotice: true,
    };

    this.currentSession.messages.push(notice);
    this.currentSession.lastActiveItemKey = newItemKey;
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
    const itemTitle = hasCurrentItem ? getItemTitle(item!) : null;

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

    // 检查是否需要插入 item 切换通知
    if (itemKey !== this.currentSession.lastActiveItemKey) {
      if (hasCurrentItem) {
        // 切换到新 item
        this.insertItemSwitchNotice(itemKey!, itemTitle!);
      } else if (this.currentSession.lastActiveItemKey !== null) {
        // 从有 item 切换到无 item
        const notice: ChatMessage = {
          id: this.generateId(),
          role: "system",
          content: `--- No paper selected ---`,
          timestamp: Date.now(),
          isSystemNotice: true,
        };
        this.currentSession.messages.push(notice);
        this.currentSession.lastActiveItemKey = null;
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
      this.currentSession.messages.push(errorMessage);
      this.onMessageUpdate?.(this.currentSession.messages);
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
    let useToolCalling = false;

    ztoolkit.log("[Tool Calling] provider type:", provider?.constructor?.name);
    ztoolkit.log(
      "[Tool Calling] supportsToolCalling:",
      supportsToolCalling(provider),
    );

    // 自动检测并解析 PDF（有 item 且 provider 支持 tool calling）
    if (hasCurrentItem && item && supportsToolCalling(provider)) {
      const hasPdf = await this.pdfExtractor.hasPdfAttachment(item);
      ztoolkit.log("[PDF Auto-detect] Item has PDF:", hasPdf);

      if (hasPdf) {
        // 实时提取 PDF（不再存储）
        const pdfText = await this.pdfExtractor.extractPdfText(item);
        if (pdfText) {
          pdfWasAttached = true;
          useToolCalling = true;
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
    } else if (hasCurrentItem && item && !supportsToolCalling(provider)) {
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

    this.currentSession.messages.push(userMessage);
    this.currentSession.updatedAt = Date.now();
    this.onMessageUpdate?.(this.currentSession.messages);

    // 创建 AI 消息占位
    const assistantMessage: ChatMessage = {
      id: this.generateId(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };

    this.currentSession.messages.push(assistantMessage);
    this.onMessageUpdate?.(this.currentSession.messages);

    // 获取上下文管理器并过滤消息
    const contextManager = getContextManager();
    const { messages: filteredMessages, summaryTriggered } =
      contextManager.filterMessages(this.currentSession);

    // 从过滤后的消息中排除最后一条 (assistant 占位)
    const messagesForApi = filteredMessages.filter(
      (m) => m.id !== assistantMessage.id,
    );

    ztoolkit.log(
      "[API Request] Original message count:",
      this.currentSession.messages.length,
    );
    ztoolkit.log(
      "[API Request] Filtered message count:",
      messagesForApi.length,
    );
    ztoolkit.log("[API Request] Use tool calling:", useToolCalling);

    // 如果启用 tool calling
    if (useToolCalling && supportsToolCalling(provider)) {
      ztoolkit.log("[Tool Calling] Using tool calling mode");
      await this.sendMessageWithToolCalling(
        provider,
        messagesForApi,
        assistantMessage,
        pdfWasAttached,
        summaryTriggered,
        hasCurrentItem,
        item!,
      );
      return;
    }

    // 传统模式：流式调用
    let hasRetried = false;

    const attemptRequest = async (): Promise<void> => {
      return new Promise((resolve) => {
        const callbacks: StreamCallbacks = {
          onChunk: (chunk: string) => {
            assistantMessage.content += chunk;
            this.onStreamingUpdate?.(assistantMessage.content);
          },
          onComplete: async (fullContent: string) => {
            assistantMessage.content = fullContent;
            assistantMessage.timestamp = Date.now();
            this.currentSession!.updatedAt = Date.now();

            await this.sessionStorage.saveSession(this.currentSession!);
            this.onMessageUpdate?.(this.currentSession!.messages);

            if (pdfWasAttached) {
              this.onPdfAttached?.();
            }
            this.onMessageComplete?.();

            // 异步触发摘要生成（不阻塞主流程）
            if (summaryTriggered) {
              contextManager
                .generateSummaryAsync(this.currentSession!, async () => {
                  await this.sessionStorage.saveSession(this.currentSession!);
                })
                .catch((err) => {
                  ztoolkit.log("[ChatManager] Summary generation failed:", err);
                });
            }

            resolve();
          },
          onError: async (error: Error) => {
            ztoolkit.log("[API Error]", error.message);

            if (
              !hasRetried &&
              this.isAuthError(error) &&
              this.isPaperChatProvider()
            ) {
              ztoolkit.log("[API Error] Auth error, attempting refresh...");
              hasRetried = true;

              try {
                const authManager = getAuthManager();
                await authManager.ensurePluginToken(true);
                assistantMessage.content = "";
                ztoolkit.log("[API Retry] API key refreshed, retrying...");

                const newProvider = this.getActiveProvider();
                if (newProvider && newProvider.isReady()) {
                  await attemptRequest();
                  resolve();
                  return;
                }
              } catch (retryError) {
                ztoolkit.log("[API Retry] Failed to refresh:", retryError);
              }
            }

            // 显示错误消息
            this.currentSession!.messages.pop();

            const errorMessage: ChatMessage = {
              id: this.generateId(),
              role: "error",
              content: error.message,
              timestamp: Date.now(),
            };
            this.currentSession!.messages.push(errorMessage);

            this.onError?.(error);
            this.onMessageUpdate?.(this.currentSession!.messages);
            resolve();
          },
        };

        provider.streamChatCompletion(messagesForApi, callbacks, pdfAttachment);
      });
    };

    await attemptRequest();
  }

  /**
   * 使用 Tool Calling 发送消息
   */
  private async sendMessageWithToolCalling(
    provider: ToolCallingProvider,
    messagesForApi: ChatMessage[],
    assistantMessage: ChatMessage,
    pdfWasAttached: boolean,
    summaryTriggered: boolean,
    hasCurrentItem: boolean,
    item: Zotero.Item,
  ): Promise<void> {
    const pdfToolManager = getPdfToolManager();
    const contextManager = getContextManager();

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
      hasCurrentItem ? getItemTitle(item) : undefined,
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

    const currentMessages = messagesWithContext;
    const maxIterations = 10;
    let iteration = 0;

    try {
      while (iteration < maxIterations) {
        iteration++;
        ztoolkit.log(
          `[Tool Calling] Iteration ${iteration}, messages: ${currentMessages.length}`,
        );

        if (iteration > 1) {
          assistantMessage.content += "\n\n[Retrieving information...]\n\n";
          this.onStreamingUpdate?.(assistantMessage.content);
        }

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

          for (const toolCall of result.toolCalls) {
            ztoolkit.log(
              `[Tool Calling] Executing tool: ${toolCall.function.name}`,
              toolCall.function.arguments,
            );

            const toolResult = await pdfToolManager.executeToolCall(
              toolCall,
              paperStructure || undefined,
            );

            ztoolkit.log(
              `[Tool Calling] Tool result (truncated): ${toolResult.substring(0, 200)}...`,
            );

            const toolResultMessage: ChatMessage = {
              id: this.generateId(),
              role: "tool",
              content: toolResult,
              tool_call_id: toolCall.id,
              timestamp: Date.now(),
            };
            currentMessages.push(toolResultMessage);
          }

          continue;
        }

        // 没有 tool calls，最终回答
        assistantMessage.content = result.content || "";
        assistantMessage.timestamp = Date.now();
        this.currentSession!.updatedAt = Date.now();

        await this.sessionStorage.saveSession(this.currentSession!);
        this.onMessageUpdate?.(this.currentSession!.messages);

        if (pdfWasAttached) {
          this.onPdfAttached?.();
        }
        this.onMessageComplete?.();

        if (summaryTriggered) {
          contextManager
            .generateSummaryAsync(this.currentSession!, async () => {
              await this.sessionStorage.saveSession(this.currentSession!);
            })
            .catch((err) => {
              ztoolkit.log("[ChatManager] Summary generation failed:", err);
            });
        }

        return;
      }

      // 达到最大迭代次数
      ztoolkit.log("[Tool Calling] Max iterations reached");
      assistantMessage.content =
        "I apologize, but I was unable to complete the request within the allowed number of iterations.";
      assistantMessage.timestamp = Date.now();
      this.currentSession!.updatedAt = Date.now();
      await this.sessionStorage.saveSession(this.currentSession!);
      this.onMessageUpdate?.(this.currentSession!.messages);
    } catch (error) {
      ztoolkit.log("[Tool Calling] Error:", error);

      this.currentSession!.messages.pop();

      const errorMessage: ChatMessage = {
        id: this.generateId(),
        role: "error",
        content: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
      this.currentSession!.messages.push(errorMessage);

      this.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.onMessageUpdate?.(this.currentSession!.messages);
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
    this.currentSession.updatedAt = Date.now();

    await this.sessionStorage.saveSession(this.currentSession);
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
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * 销毁
   */
  async destroy(): Promise<void> {
    if (this.currentSession) {
      await this.sessionStorage.saveSession(this.currentSession);
    }
    this.currentSession = null;
    this.currentItemKey = null;
    this.initialized = false;
  }
}
