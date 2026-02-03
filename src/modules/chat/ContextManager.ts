/**
 * ContextManager - 上下文管理服务
 *
 * 职责:
 * 1. 滑动窗口 + 保留首轮对话策略
 * 2. 异步摘要生成机制
 */

import type {
  ChatMessage,
  ChatSession,
  ContextSummary,
} from "../../types/chat";
import { getPref } from "../../utils/prefs";
import { getProviderManager } from "../providers";

// 过滤后的消息结果
export interface FilteredMessagesResult {
  messages: ChatMessage[];
  summaryTriggered: boolean;
}

// 摘要生成系统提示
const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer. Summarize the following conversation concisely, capturing the key points, questions asked, and answers provided. Focus on:
1. The main topics discussed
2. Important facts or information shared
3. Any decisions or conclusions reached
Keep the summary under 500 words.`;

class ContextManager {
  // 追踪正在进行的摘要任务
  private summaryInProgress: Map<string, boolean> = new Map();

  /**
   * 过滤消息，返回用于 API 调用的消息列表
   * 策略: [system 消息] + [摘要(如有)] + [最近 N 轮对话(包含 system-notice)]
   */
  filterMessages(session: ChatSession): FilteredMessagesResult {
    const maxRecentPairs = getPref("contextMaxRecentPairs") ?? 10;
    const enableSummary = getPref("contextEnableSummary") ?? false;
    const summaryThreshold = getPref("contextSummaryThreshold") ?? 20;

    const messages = session.messages;
    const result: ChatMessage[] = [];
    let summaryTriggered = false;

    // 1. 提取所有 system 消息 (不包括 system-notice)
    const systemMessages = messages.filter(
      (m) => m.role === "system" && !m.isSystemNotice,
    );

    // 2. 提取对话消息 (user/assistant/tool) 和 system-notice，过滤掉 error 消息
    const conversationMessages = messages.filter(
      (m) =>
        m.role === "user" ||
        m.role === "assistant" ||
        m.role === "tool" ||
        m.isSystemNotice,
    );

    // 3. 计算需要保留的最近消息
    // 每轮对话 = 1 user + 1 assistant = 2 条消息 (tool 消息跟随 assistant)
    const recentMessageCount = maxRecentPairs * 2;

    // 取最近 N 轮 (包含 system-notice)
    const recentMessages = conversationMessages.slice(-recentMessageCount);

    // 4. 组装最终消息列表
    result.push(...systemMessages);

    // 5. 如果有摘要，插入摘要消息
    if (session.contextSummary && session.contextSummary.content) {
      const summaryMessage: ChatMessage = {
        id: "context-summary",
        role: "system",
        content: `[Previous conversation summary]: ${session.contextSummary.content}`,
        timestamp: session.contextSummary.createdAt,
      };
      result.push(summaryMessage);
    }

    result.push(...recentMessages);

    // 6. 检查是否需要触发摘要生成
    if (enableSummary) {
      const totalConversation = conversationMessages.length;
      const lastSummaryCount =
        session.contextState?.lastSummaryMessageCount ?? 0;

      // 当消息数超过阈值，且距离上次摘要又增加了足够消息
      if (
        totalConversation >= summaryThreshold &&
        totalConversation - lastSummaryCount >= summaryThreshold / 2
      ) {
        summaryTriggered = true;
      }
    }

    return { messages: result, summaryTriggered };
  }

  /**
   * 异步生成摘要 (不阻塞用户操作)
   */
  async generateSummaryAsync(
    session: ChatSession,
    onComplete?: () => Promise<void>,
  ): Promise<void> {
    const sessionId = session.id;

    // 防止重复生成
    if (this.summaryInProgress.get(sessionId)) {
      ztoolkit.log("[ContextManager] Summary already in progress for session");
      return;
    }

    // 检查是否正在进行中 (通过 session state)
    if (session.contextState?.summaryInProgress) {
      ztoolkit.log(
        "[ContextManager] Summary already in progress (from session state)",
      );
      return;
    }

    this.summaryInProgress.set(sessionId, true);

    // 更新 session state
    if (!session.contextState) {
      session.contextState = {
        summaryInProgress: true,
        lastSummaryMessageCount: 0,
      };
    } else {
      session.contextState.summaryInProgress = true;
    }

    try {
      ztoolkit.log("[ContextManager] Starting summary generation...");

      const provider = getProviderManager().getActiveProvider();
      if (!provider || !provider.isReady()) {
        ztoolkit.log("[ContextManager] Provider not ready, skipping summary");
        return;
      }

      // 构建要摘要的消息 (只包含 user/assistant，排除 system/error)
      const conversationMessages = session.messages.filter(
        (m) => m.role === "user" || m.role === "assistant",
      );

      // 排除最近的消息 (这些会被完整保留)
      const maxRecentPairs = getPref("contextMaxRecentPairs") ?? 10;
      const recentCount = maxRecentPairs * 2;

      // 如果消息数不足以切分，跳过
      if (conversationMessages.length <= recentCount) {
        ztoolkit.log(
          "[ContextManager] Not enough messages to summarize, skipping",
        );
        return;
      }

      const messagesToSummarize = conversationMessages.slice(0, -recentCount);

      if (messagesToSummarize.length < 4) {
        ztoolkit.log(
          "[ContextManager] Not enough messages to summarize, skipping",
        );
        return;
      }

      // 构建摘要请求，限制总长度避免超出 token 限制
      const MAX_SUMMARY_INPUT_LENGTH = 30000;
      let conversationText = "";
      const actualSummarizedMessages: ChatMessage[] = [];

      for (const m of messagesToSummarize) {
        const msgText = `${m.role.toUpperCase()}: ${m.content}\n\n`;
        if (
          conversationText.length + msgText.length >
          MAX_SUMMARY_INPUT_LENGTH
        ) {
          ztoolkit.log(
            "[ContextManager] Conversation truncated for summary due to length limit",
          );
          break;
        }
        conversationText += msgText;
        actualSummarizedMessages.push(m);
      }

      // 如果没有有效内容，跳过摘要
      if (!conversationText.trim() || actualSummarizedMessages.length < 2) {
        ztoolkit.log("[ContextManager] No valid content for summary, skipping");
        return;
      }

      const summaryMessages: ChatMessage[] = [
        {
          id: "summary-system",
          role: "system",
          content: SUMMARY_SYSTEM_PROMPT,
          timestamp: Date.now(),
        },
        {
          id: "summary-user",
          role: "user",
          content: `Please summarize this conversation:\n\n${conversationText}`,
          timestamp: Date.now(),
        },
      ];

      // 调用 API 生成摘要
      const summaryContent = await provider.chatCompletion(summaryMessages);

      if (summaryContent) {
        // 创建摘要对象
        const summary: ContextSummary = {
          id: `summary-${Date.now()}`,
          content: summaryContent,
          coveredMessageIds: actualSummarizedMessages.map((m) => m.id),
          createdAt: Date.now(),
          messageCountAtCreation: conversationMessages.length,
        };

        session.contextSummary = summary;
        session.contextState!.lastSummaryMessageCount =
          conversationMessages.length;

        ztoolkit.log(
          "[ContextManager] Summary generated successfully:",
          summaryContent.substring(0, 100) + "...",
        );
      }
    } catch (error) {
      ztoolkit.log("[ContextManager] Failed to generate summary:", error);
    } finally {
      this.summaryInProgress.delete(sessionId);
      if (session.contextState) {
        session.contextState.summaryInProgress = false;
      }

      // 回调保存 session
      if (onComplete) {
        await onComplete();
      }
    }
  }

  /**
   * 清除会话的摘要缓存
   */
  clearSummary(session: ChatSession): void {
    session.contextSummary = undefined;
    if (session.contextState) {
      session.contextState.lastSummaryMessageCount = 0;
    }
  }

  /**
   * 当会话被删除时清理相关状态
   */
  onSessionDeleted(sessionId: string): void {
    this.summaryInProgress.delete(sessionId);
  }

  /**
   * 清理所有状态
   */
  destroy(): void {
    this.summaryInProgress.clear();
  }
}

// 单例
let contextManager: ContextManager | null = null;
let isContextManagerDestroyed = false;

export function getContextManager(): ContextManager {
  if (isContextManagerDestroyed) {
    ztoolkit.log(
      "[ContextManager] Warning: Accessing destroyed ContextManager, recreating...",
    );
    isContextManagerDestroyed = false;
  }
  if (!contextManager) {
    contextManager = new ContextManager();
  }
  return contextManager;
}

export function destroyContextManager(): void {
  if (contextManager) {
    contextManager.destroy();
    contextManager = null;
  }
  isContextManagerDestroyed = true;
}
