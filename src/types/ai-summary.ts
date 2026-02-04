/**
 * AISummary Types - AI摘要功能类型定义
 */

// AISummary 配置
export interface AISummaryConfig {
  enabled: boolean; // 是否启用 AISummary
  templateId: string; // 使用的模板 ID
  scheduleEnabled: boolean; // 是否启用定时执行
  scheduleIntervalHours: number; // 执行间隔（小时）
  noteLocation: "child" | "standalone"; // 笔记位置
  markProcessedTag: string; // 处理后添加的标签
  rateLimitRpm: number; // 每分钟请求数
  pauseBetweenMs: number; // 请求间隔毫秒
  maxItemsPerRun: number; // 每次运行最多处理的条目数
  filterHasPdf: boolean; // 是否只处理有 PDF 的条目
  excludeProcessedItems: boolean; // 是否排除已处理的条目
}

// AISummary 模板
export interface AISummaryTemplate {
  id: string;
  name: string;
  prompt: string;
  systemPrompt?: string;
  noteTitle: string; // 如 "AI Summary: {{title}}"
  tags: string[];
  maxTokens?: number; // 限制响应 token 数
}

// AISummary 运行进度
export interface AISummaryProgress {
  status: "idle" | "running" | "paused" | "completed" | "error";
  totalItems: number;
  processedItems: number;
  successfulItems: number;
  failedItems: number;
  currentItemKey?: string;
  currentItemTitle?: string;
  startTime?: number;
  lastProcessedTime?: number;
  errors: AISummaryError[];
}

// AISummary 错误
export interface AISummaryError {
  itemKey: string;
  itemTitle: string;
  error: string;
  timestamp: number;
  retryCount: number;
}

// AISummary 存储状态（用于恢复）
export interface AISummaryStoredState {
  progress: AISummaryProgress;
  pendingItemKeys: string[];
  completedItemKeys: string[];
  failedItemKeys: string[];
  lastScheduledRun?: number;
}

// AISummary 处理结果
export interface AISummaryProcessResult {
  success: boolean;
  itemKey: string;
  itemTitle: string;
  noteKey?: string;
  error?: string;
  tokensUsed?: number;
  processingTime?: number;
}

// 默认配置
export const DEFAULT_AISUMMARY_CONFIG: AISummaryConfig = {
  enabled: false,
  templateId: "summary-brief",
  scheduleEnabled: false,
  scheduleIntervalHours: 24, // 默认每 24 小时执行一次
  noteLocation: "child",
  markProcessedTag: "ai-processed",
  rateLimitRpm: 10,
  pauseBetweenMs: 2000,
  maxItemsPerRun: 10,
  filterHasPdf: true,
  excludeProcessedItems: true,
};
