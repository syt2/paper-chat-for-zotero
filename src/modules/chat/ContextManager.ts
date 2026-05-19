/**
 * ContextManager - 上下文管理服务
 *
 * 职责:
 * 1. 稳定前缀 + 摘要压缩策略
 * 2. 异步摘要生成机制
 */

import type {
  ChatMessage,
  ChatSession,
  ContextSummary,
} from "../../types/chat";
import type { ModelInfo, ProviderConfig } from "../../types/provider";
import { getPref } from "../../utils/prefs";
import { getProviderManager } from "../providers";
import { getModelRoutingMeta } from "../preferences/ModelsFetcher";

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

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const MAX_SUMMARY_OUTPUT_RESERVE_TOKENS = 20000;
const DEFAULT_AUTO_COMPACT_CONTEXT_WINDOW_TOKENS = 100000;
export const CONTEXT_AUTO_COMPACT_WINDOW_TOKEN_STEPS = [
  40000, 50000, 60000, 80000, 100000, 120000, 150000, 180000, 200000, 300000,
  400000, 500000, 600000, 800000, 1000000,
] as const;

function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g);
  const cjkChars = cjkMatches?.length ?? 0;
  const otherChars = text.length - cjkChars;
  return Math.ceil(cjkChars / 1.5 + otherChars / 4);
}

function estimateMessageTokens(message: ChatMessage): number {
  let tokens = 8 + estimateTextTokens(message.content);
  if (message.reasoning) {
    tokens += estimateTextTokens(message.reasoning);
  }
  if (message.images?.length) {
    tokens += message.images.length * 256;
  }
  if (message.files?.length) {
    tokens += message.files.reduce(
      (sum, file) => sum + estimateTextTokens(file.content) + 16,
      0,
    );
  }
  if (message.tool_calls?.length) {
    tokens += estimateTextTokens(JSON.stringify(message.tool_calls));
  }
  return tokens;
}

function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce(
    (sum, message) => sum + estimateMessageTokens(message),
    0,
  );
}

function getProviderModelId(
  config: ProviderConfig,
  session?: Pick<ChatSession, "resolvedModelId">,
): string | undefined {
  if (session?.resolvedModelId) {
    return session.resolvedModelId;
  }
  if (config.type === "paperchat") {
    return config.resolvedModelOverride || config.defaultModel;
  }
  return config.defaultModel;
}

function getPaperChatRoutingModelInfo(
  config: ProviderConfig | undefined,
  modelId: string | undefined,
): Pick<ModelInfo, "contextWindow" | "maxOutput"> {
  if (!config || config.type !== "paperchat" || !modelId) {
    return {};
  }
  const meta = getModelRoutingMeta()[modelId];
  return {
    contextWindow: meta?.contextWindow,
    maxOutput: meta?.maxOutput,
  };
}

export function normalizeContextAutoCompactWindowTokens(
  value: unknown,
): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return DEFAULT_AUTO_COMPACT_CONTEXT_WINDOW_TOKENS;
  }
  const requested = Math.trunc(numeric);
  return CONTEXT_AUTO_COMPACT_WINDOW_TOKEN_STEPS.reduce(
    (nearest, candidate) => {
      const nearestDistance = Math.abs(nearest - requested);
      const candidateDistance = Math.abs(candidate - requested);
      return candidateDistance < nearestDistance ? candidate : nearest;
    },
    CONTEXT_AUTO_COMPACT_WINDOW_TOKEN_STEPS[0],
  );
}

export function getContextAutoCompactTokenLimit(
  session?: Pick<ChatSession, "resolvedModelId">,
): number {
  const providerManager = getProviderManager();
  const provider = providerManager.getActiveProvider();
  const config = provider?.config;
  const modelId = config ? getProviderModelId(config, session) : undefined;
  const modelInfo =
    config && modelId ? providerManager.getModelInfo(config.id, modelId) : null;
  const routingModelInfo = getPaperChatRoutingModelInfo(config, modelId);
  const configuredContextWindow = normalizeContextAutoCompactWindowTokens(
    getPref("contextAutoCompactWindowTokens"),
  );
  const contextWindow =
    routingModelInfo.contextWindow && routingModelInfo.contextWindow > 0
      ? Math.min(configuredContextWindow, routingModelInfo.contextWindow)
      : configuredContextWindow;
  const maxOutput =
    config?.type !== "paperchat" &&
    typeof config?.maxTokens === "number" &&
    config.maxTokens > 0
      ? config.maxTokens
      : routingModelInfo.maxOutput ||
        modelInfo?.maxOutput ||
        DEFAULT_MAX_OUTPUT_TOKENS;
  const summaryReserve = Math.min(maxOutput, MAX_SUMMARY_OUTPUT_RESERVE_TOKENS);
  const buffer = getPref("contextAutoCompactBufferTokens") ?? 13000;
  return contextWindow - summaryReserve - buffer;
}

class ContextManager {
  // 追踪正在进行的摘要任务
  private summaryInProgress: Map<string, boolean> = new Map();

  /**
   * 过滤消息，返回用于 API 调用的消息列表
   * 策略: [system 消息] + [摘要(如有)] + [摘要之后的完整对话]
   *
   * 不再每轮滑动裁剪最近 N 轮。滑动窗口会让请求前缀每轮变化，
   * 破坏服务端 prompt cache。压缩只在摘要生成时发生一次。
   */
  filterMessages(session: ChatSession): FilteredMessagesResult {
    const enableSummary = getPref("contextEnableSummary") ?? false;

    const messages = session.messages;
    const result: ChatMessage[] = [];
    let summaryTriggered = false;

    // 1. 提取所有 system 消息 (不包括 system-notice)
    const systemMessages = messages.filter(
      (m) => m.role === "system" && !m.isSystemNotice && !m.apiOnly,
    );

    // 2. 提取对话消息 (user/assistant/tool) 和 system-notice，过滤掉 error 消息
    const conversationMessages = messages.filter(
      (m) =>
        m.role === "user" ||
        (m.role === "assistant" && m.streamingState !== "interrupted") ||
        m.role === "tool" ||
        (m.apiOnly && m.role !== "system") ||
        m.isSystemNotice,
    );

    // 3. 组装最终消息列表
    result.push(...systemMessages);

    // 4. 如果有摘要，插入摘要消息，并只保留摘要覆盖范围之后的完整消息。
    //    这个边界只在摘要更新时移动，避免每次请求都改变 prompt 前缀。
    let messagesAfterSummary = conversationMessages;
    if (session.contextSummary && session.contextSummary.content) {
      const summaryMessage: ChatMessage = {
        id: "context-summary",
        role: "system",
        content: `[Previous conversation summary]: ${session.contextSummary.content}`,
        timestamp: session.contextSummary.createdAt,
      };
      result.push(summaryMessage);

      const coveredIds = new Set(session.contextSummary.coveredMessageIds);
      let lastCoveredIndex = -1;
      for (let i = 0; i < conversationMessages.length; i++) {
        if (coveredIds.has(conversationMessages[i].id)) {
          lastCoveredIndex = i;
        }
      }
      if (
        lastCoveredIndex < 0 &&
        coveredIds.size === 0 &&
        session.contextSummary.messageCountAtCreation > 0
      ) {
        lastCoveredIndex =
          Math.min(
            conversationMessages.length,
            session.contextSummary.messageCountAtCreation,
          ) - 1;
      }
      if (lastCoveredIndex >= 0) {
        messagesAfterSummary = conversationMessages.slice(lastCoveredIndex + 1);
      }
    }

    result.push(...messagesAfterSummary);

    // 5. 检查是否需要触发摘要生成
    if (enableSummary) {
      const estimatedTokens = estimateMessagesTokens(result);
      const autoCompactTokenLimit = getContextAutoCompactTokenLimit(session);

      // Claude Code/Codex 风格: 根据模型上下文窗口的 token 预算触发压缩。
      // 消息数量不再作为滑动窗口裁剪或压缩触发条件，避免短消息聊天频繁改写前缀。
      if (estimatedTokens >= autoCompactTokenLimit) {
        summaryTriggered = true;
      }
    }

    return { messages: result, summaryTriggered };
  }

  /**
   * 在主请求发出前同步压缩上下文。相比请求完成后异步摘要，这更接近
   * Codex/Claude Code 的 pre-turn compaction，能避免已经接近窗口时仍发送超长请求。
   */
  async compactBeforeSendIfNeeded(
    session: ChatSession,
    onComplete?: () => Promise<void>,
  ): Promise<boolean> {
    const { summaryTriggered } = this.filterMessages(session);
    if (!summaryTriggered) {
      return false;
    }

    return this.generateSummaryAsync(session, onComplete);
  }

  /**
   * 异步生成摘要 (不阻塞用户操作)
   */
  async generateSummaryAsync(
    session: ChatSession,
    onComplete?: () => Promise<void>,
  ): Promise<boolean> {
    const sessionId = session.id;
    let summaryGenerated = false;

    // 防止重复生成
    if (this.summaryInProgress.get(sessionId)) {
      ztoolkit.log("[ContextManager] Summary already in progress for session");
      return false;
    }

    // 检查是否正在进行中 (通过 session state)
    if (session.contextState?.summaryInProgress) {
      ztoolkit.log(
        "[ContextManager] Summary already in progress (from session state)",
      );
      return false;
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
        return false;
      }

      // 构建要摘要的消息 (只包含 user/assistant，排除 system/error)
      const conversationMessages = session.messages.filter(
        (m) =>
          !m.apiOnly &&
          (m.role === "user" ||
            (m.role === "assistant" && m.streamingState !== "interrupted")),
      );

      // 压缩时保留最近的消息；平时 filterMessages 不再滑动裁剪。
      const maxRecentPairs = getPref("contextMaxRecentPairs") ?? 10;
      const recentCount = maxRecentPairs * 2;

      const alreadyCoveredIds = new Set(
        session.contextSummary?.coveredMessageIds || [],
      );
      const unsummarizedMessages = conversationMessages.filter(
        (message) => !alreadyCoveredIds.has(message.id),
      );

      // 如果未摘要部分不足以切分，跳过
      if (unsummarizedMessages.length <= recentCount) {
        ztoolkit.log(
          "[ContextManager] Not enough messages to summarize, skipping",
        );
        return false;
      }

      const messagesToSummarize = unsummarizedMessages.slice(0, -recentCount);

      if (messagesToSummarize.length < 4) {
        ztoolkit.log(
          "[ContextManager] Not enough messages to summarize, skipping",
        );
        return false;
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
        return false;
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
          content: session.contextSummary?.content
            ? `Previous summary:\n${session.contextSummary.content}\n\nPlease update the summary with this additional conversation:\n\n${conversationText}`
            : `Please summarize this conversation:\n\n${conversationText}`,
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
          coveredMessageIds: [
            ...alreadyCoveredIds,
            ...actualSummarizedMessages.map((m) => m.id),
          ],
          createdAt: Date.now(),
          messageCountAtCreation: conversationMessages.length,
          estimatedTokensAtCreation:
            estimateMessagesTokens(conversationMessages),
        };

        session.contextSummary = summary;
        session.contextState!.lastSummaryMessageCount =
          conversationMessages.length;
        session.contextState!.lastSummaryTokenEstimate =
          estimateMessagesTokens(conversationMessages);
        session.contextState!.lastCompactionAt = summary.createdAt;

        ztoolkit.log(
          "[ContextManager] Summary generated successfully:",
          summaryContent.substring(0, 100) + "...",
        );
        summaryGenerated = true;
      }
      return summaryGenerated;
    } catch (error) {
      ztoolkit.log("[ContextManager] Failed to generate summary:", error);
      return false;
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
      session.contextState.lastSummaryTokenEstimate = undefined;
      session.contextState.lastCompactionAt = undefined;
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
