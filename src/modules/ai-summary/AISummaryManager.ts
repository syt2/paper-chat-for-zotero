/**
 * AISummaryManager - AI摘要核心管理器
 *
 * 职责：
 * 1. 管理 AISummary 配置和状态
 * 2. 协调批处理流程
 */

import type {
  AISummaryConfig,
  AISummaryProgress,
  AISummaryStoredState,
} from "../../types/ai-summary";
import { DEFAULT_AISUMMARY_CONFIG } from "../../types/ai-summary";
import { AISummaryProcessor } from "./AISummaryProcessor";
import { AISummaryStorage } from "./AISummaryStorage";
import { getTemplateById } from "./defaultTemplates";
import { getString } from "../../utils/locale";
import { getItemTitle } from "../../utils/common";

export class AISummaryManager {
  private config: AISummaryConfig = { ...DEFAULT_AISUMMARY_CONFIG };
  private progress: AISummaryProgress = {
    status: "idle",
    totalItems: 0,
    processedItems: 0,
    successfulItems: 0,
    failedItems: 0,
    errors: [],
  };

  private processor: AISummaryProcessor;
  private storage: AISummaryStorage;
  private abortController: AbortController | null = null;
  private initialized: boolean = false;

  // 回调
  private onProgressUpdate?: (progress: AISummaryProgress) => void;
  private onItemComplete?: (itemKey: string, success: boolean) => void;
  private onRunComplete?: () => void;

  constructor() {
    this.processor = new AISummaryProcessor();
    this.storage = new AISummaryStorage();
  }

  /**
   * 初始化
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    await this.storage.init();

    // 加载配置
    this.config = await this.storage.loadConfig();

    // 恢复进度（如果有中断的任务）
    const storedState = await this.storage.loadProgress();
    if (storedState && storedState.progress.status === "running") {
      // 标记为暂停（之前被中断）
      storedState.progress.status = "paused";
      await this.storage.saveProgress(storedState);
      this.progress = storedState.progress;
      ztoolkit.log("[AISummary] Found interrupted progress, marked as paused");
    }

    this.initialized = true;
    ztoolkit.log("[AISummary] Manager initialized");
  }

  /**
   * 设置回调
   */
  setCallbacks(callbacks: {
    onProgressUpdate?: (progress: AISummaryProgress) => void;
    onItemComplete?: (itemKey: string, success: boolean) => void;
    onRunComplete?: () => void;
  }): void {
    this.onProgressUpdate = callbacks.onProgressUpdate;
    this.onItemComplete = callbacks.onItemComplete;
    this.onRunComplete = callbacks.onRunComplete;
  }

  /**
   * 设置进度更新回调（简化版本）
   */
  setOnProgressUpdate(callback: (progress: AISummaryProgress) => void): void {
    this.onProgressUpdate = callback;
  }

  /**
   * 获取当前配置
   */
  getConfig(): AISummaryConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  async updateConfig(newConfig: Partial<AISummaryConfig>): Promise<void> {
    this.config = { ...this.config, ...newConfig };
    await this.storage.saveConfig(this.config);
    ztoolkit.log("[AISummary] Config updated");
  }

  /**
   * 获取当前进度
   */
  getProgress(): AISummaryProgress {
    return { ...this.progress };
  }

  /**
   * 处理单个条目（供 AISummaryService 调用）
   */
  async processSingleItem(itemKey: string): Promise<{
    success: boolean;
    noteKey?: string;
    error?: string;
  }> {
    const libraryID = Zotero.Libraries.userLibraryID;
    const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);

    if (!item) {
      return { success: false, error: "Item not found" };
    }

    const template = getTemplateById(this.config.templateId);
    if (!template) {
      return { success: false, error: `Template not found: ${this.config.templateId}` };
    }

    const result = await this.processor.processItem(item, template, this.config);

    return {
      success: result.success,
      noteKey: result.noteKey,
      error: result.error,
    };
  }

  /**
   * 启动批处理
   */
  async startBatch(itemKeys?: string[]): Promise<void> {
    if (this.progress.status === "running") {
      ztoolkit.log("[AISummary] Already running, skipping");
      return;
    }

    ztoolkit.log("[AISummary] Starting batch processing");

    // 准备要处理的条目
    const keys = itemKeys || (await this.discoverItemsToProcess());

    if (keys.length === 0) {
      ztoolkit.log("[AISummary] No items to process");
      return;
    }

    // 初始化进度
    this.progress = {
      status: "running",
      totalItems: keys.length,
      processedItems: 0,
      successfulItems: 0,
      failedItems: 0,
      startTime: Date.now(),
      errors: [],
    };

    // 创建 abort controller
    this.abortController = new AbortController();

    // 保存初始状态
    await this.saveCurrentState(keys, [], []);

    // 通知进度更新
    this.onProgressUpdate?.(this.progress);

    // 开始处理
    await this.processQueue(keys);
  }

  /**
   * 暂停批处理
   */
  pauseBatch(): void {
    if (this.progress.status !== "running") return;

    ztoolkit.log("[AISummary] Pausing batch");
    this.progress.status = "paused";
    this.abortController?.abort();
    this.onProgressUpdate?.(this.progress);
  }

  /**
   * 恢复批处理
   */
  async resumeBatch(): Promise<void> {
    if (this.progress.status !== "paused") return;

    const storedState = await this.storage.loadProgress();
    if (!storedState || storedState.pendingItemKeys.length === 0) {
      ztoolkit.log("[AISummary] No pending items to resume");
      return;
    }

    ztoolkit.log("[AISummary] Resuming batch with", storedState.pendingItemKeys.length, "items");

    this.progress.status = "running";
    this.abortController = new AbortController();
    this.onProgressUpdate?.(this.progress);

    await this.processQueue(
      storedState.pendingItemKeys,
      storedState.completedItemKeys,
      storedState.failedItemKeys,
    );
  }

  /**
   * 取消批处理
   */
  async cancelBatch(): Promise<void> {
    ztoolkit.log("[AISummary] Cancelling batch");

    this.abortController?.abort();
    this.progress.status = "idle";
    await this.storage.clearProgress();
    this.onProgressUpdate?.(this.progress);
  }

  /**
   * 发现要处理的条目
   */
  private async discoverItemsToProcess(): Promise<string[]> {
    const libraryID = Zotero.Libraries.userLibraryID;
    const rawItems = await Zotero.Items.getAll(libraryID);

    const itemKeys: string[] = [];
    const processedTag = this.config.markProcessedTag;

    for (const item of rawItems) {
      // 跳过附件和笔记
      if (item.isAttachment?.() || item.isNote?.()) continue;

      // 如果需要排除已处理的条目
      if (this.config.excludeProcessedItems && processedTag) {
        const tags = item.getTags?.() || [];
        if (tags.some((t: { tag: string }) => t.tag === processedTag)) {
          continue;
        }
      }

      // 如果只处理有 PDF 的条目
      if (this.config.filterHasPdf) {
        if (!this.hasPdfAttachment(item)) continue;
      }

      itemKeys.push(item.key);

      // 限制每次运行的条目数
      if (itemKeys.length >= this.config.maxItemsPerRun) break;
    }

    ztoolkit.log("[AISummary] Discovered", itemKeys.length, "items to process");
    return itemKeys;
  }

  /**
   * 检查是否有 PDF 附件
   */
  private hasPdfAttachment(item: Zotero.Item): boolean {
    if (item.isPDFAttachment?.()) return true;
    const attachmentIDs = item.getAttachments?.() || [];
    for (const id of attachmentIDs) {
      const attachment = Zotero.Items.get(id);
      if (attachment?.isPDFAttachment?.()) return true;
    }
    return false;
  }

  /**
   * 处理队列
   */
  private async processQueue(
    pendingKeys: string[],
    completedKeys: string[] = [],
    failedKeys: string[] = [],
  ): Promise<void> {
    const template = getTemplateById(this.config.templateId);
    if (!template) {
      ztoolkit.log("[AISummary] Template not found:", this.config.templateId);
      this.progress.status = "error";
      this.progress.errors.push({
        itemKey: "",
        itemTitle: "Configuration",
        error: `Template not found: ${this.config.templateId}`,
        timestamp: Date.now(),
        retryCount: 0,
      });
      this.onProgressUpdate?.(this.progress);
      return;
    }

    const libraryID = Zotero.Libraries.userLibraryID;
    const remaining = [...pendingKeys];
    const completed = [...completedKeys];
    const failed = [...failedKeys];

    while (remaining.length > 0) {
      // 检查是否已取消/暂停
      if (this.abortController?.signal.aborted) {
        ztoolkit.log("[AISummary] Processing aborted");
        break;
      }

      const itemKey = remaining.shift()!;
      const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);

      if (!item) {
        ztoolkit.log("[AISummary] Item not found:", itemKey);
        failed.push(itemKey);
        continue;
      }

      // 更新进度
      this.progress.currentItemKey = itemKey;
      this.progress.currentItemTitle = getItemTitle(item);
      this.onProgressUpdate?.(this.progress);

      // 处理条目
      const result = await this.processor.processItem(
        item,
        template,
        this.config,
        this.abortController?.signal,
      );

      // 更新进度
      this.progress.processedItems++;
      if (result.success) {
        this.progress.successfulItems++;
        completed.push(itemKey);
      } else {
        this.progress.failedItems++;
        failed.push(itemKey);
        this.progress.errors.push({
          itemKey,
          itemTitle: result.itemTitle,
          error: result.error || "Unknown error",
          timestamp: Date.now(),
          retryCount: 0,
        });
      }

      this.progress.lastProcessedTime = Date.now();

      // 保存状态
      await this.saveCurrentState(remaining, completed, failed);

      // 通知回调
      this.onProgressUpdate?.(this.progress);
      this.onItemComplete?.(itemKey, result.success);

      // 速率限制暂停
      if (remaining.length > 0) {
        await this.delay(this.config.pauseBetweenMs);
      }
    }

    // 完成
    if (this.progress.status === "running") {
      this.progress.status = "completed";
      this.progress.currentItemKey = undefined;
      this.progress.currentItemTitle = undefined;
      await this.storage.clearProgress();
    }

    this.onProgressUpdate?.(this.progress);
    this.onRunComplete?.();

    ztoolkit.log(
      "[AISummary] Batch complete. Success:",
      this.progress.successfulItems,
      "Failed:",
      this.progress.failedItems,
    );
  }

  /**
   * 保存当前状态
   */
  private async saveCurrentState(
    pending: string[],
    completed: string[],
    failed: string[],
  ): Promise<void> {
    const state: AISummaryStoredState = {
      progress: this.progress,
      pendingItemKeys: pending,
      completedItemKeys: completed,
      failedItemKeys: failed,
    };
    await this.storage.saveProgress(state);
  }

  /**
   * 延迟
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 销毁
   */
  destroy(): void {
    this.abortController?.abort();
    ztoolkit.log("[AISummary] Manager destroyed");
  }
}

// 单例实例
let aiSummaryManager: AISummaryManager | null = null;

/**
 * 获取 AISummaryManager 单例
 */
export function getAISummaryManager(): AISummaryManager {
  if (!aiSummaryManager) {
    aiSummaryManager = new AISummaryManager();
  }
  return aiSummaryManager;
}

/**
 * 初始化 AISummary
 */
export async function initAISummary(): Promise<void> {
  const manager = getAISummaryManager();
  await manager.init();
}
