/**
 * AISummaryService - AI 摘要服务
 *
 * 职责：
 * 1. 监听 item 添加事件，延迟触发 AI Summary
 * 2. 注册右键菜单
 * 3. 管理任务队列和历史记录
 */

import { getAISummaryManager } from "./AISummaryManager";

// 任务状态
export type TaskStatus = "pending" | "running" | "completed" | "failed";

// 单个任务
export interface AISummaryTask {
  id: string;
  itemKey: string;
  itemTitle: string;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  noteKey?: string;
}

// 任务队列状态
export interface TaskQueueState {
  tasks: AISummaryTask[];
  isProcessing: boolean;
}

class AISummaryService {
  private notifierID: string | null = null;
  private pendingTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private taskQueue: AISummaryTask[] = [];
  private taskHistory: AISummaryTask[] = [];
  private isProcessing: boolean = false;
  private isDestroyed: boolean = false; // 标记服务是否已销毁
  private maxHistorySize: number = 50;
  private delayMs: number = 30000; // 30 秒延迟

  // 回调
  private onTaskUpdate?: (tasks: AISummaryTask[], history: AISummaryTask[]) => void;
  private onOpenTaskWindow?: () => void;

  private initialized: boolean = false;

  /**
   * 初始化服务
   */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.isDestroyed = false; // 重置销毁标志（以防重新初始化）
    this.registerItemNotifier();
    this.registerContextMenu();
    ztoolkit.log("[AISummaryService] Initialized");
  }

  /**
   * 销毁服务
   */
  destroy(): void {
    if (!this.initialized) return;
    this.initialized = false;
    this.isDestroyed = true;
    this.unregisterItemNotifier();
    this.clearAllPendingTimers();
    // 清空回调，防止销毁后仍被调用
    this.onTaskUpdate = undefined;
    this.onOpenTaskWindow = undefined;
    ztoolkit.log("[AISummaryService] Destroyed");
  }

  /**
   * 设置任务更新回调
   */
  setOnTaskUpdate(callback: (tasks: AISummaryTask[], history: AISummaryTask[]) => void): void {
    this.onTaskUpdate = callback;
  }

  /**
   * 获取当前任务更新回调
   */
  getOnTaskUpdate(): ((tasks: AISummaryTask[], history: AISummaryTask[]) => void) | undefined {
    return this.onTaskUpdate;
  }

  /**
   * 设置打开任务窗口的回调
   */
  setOnOpenTaskWindow(callback: () => void): void {
    this.onOpenTaskWindow = callback;
  }

  /**
   * 获取当前任务队列
   */
  getTaskQueue(): AISummaryTask[] {
    return [...this.taskQueue];
  }

  /**
   * 获取任务历史
   */
  getTaskHistory(): AISummaryTask[] {
    return [...this.taskHistory];
  }

  /**
   * 注册 item 添加通知器
   */
  private registerItemNotifier(): void {
    if (this.notifierID) return;

    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: async (
          event: string,
          type: string,
          ids: (string | number)[],
          _extraData: Record<string, unknown>,
        ) => {
          if (event === "add" && type === "item") {
            await this.handleItemsAdded(ids as number[]);
          }
        },
      },
      ["item"],
      "paperchat-aisummary-item-observer",
      100,
    );

    ztoolkit.log("[AISummaryService] Item notifier registered:", this.notifierID);
  }

  /**
   * 取消注册 item 通知器
   */
  private unregisterItemNotifier(): void {
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = null;
      ztoolkit.log("[AISummaryService] Item notifier unregistered");
    }
  }

  /**
   * 处理新增 items
   */
  private async handleItemsAdded(ids: number[]): Promise<void> {
    // 如果服务已销毁，直接返回
    if (this.isDestroyed) return;

    for (const id of ids) {
      const item = Zotero.Items.get(id);
      if (!item) continue;

      // 跳过笔记
      if (item.isNote?.()) continue;

      // 如果是 PDF 附件，获取其顶层父条目
      if (item.isPDFAttachment?.()) {
        const topLevelItem = this.getTopLevelParent(item);
        if (topLevelItem && !topLevelItem.isNote?.() && !topLevelItem.isAttachment?.()) {
          this.scheduleItemProcessing(topLevelItem);
        }
        continue;
      }

      // 如果是普通条目（非附件、非笔记）
      if (!item.isAttachment?.()) {
        this.scheduleItemProcessing(item);
      }
    }
  }

  /**
   * 获取顶层父条目
   */
  private getTopLevelParent(item: Zotero.Item): Zotero.Item | null {
    let current = item;
    while (current.parentID) {
      const parent = Zotero.Items.get(current.parentID);
      if (!parent) return current;
      current = parent;
    }
    return current;
  }

  /**
   * 安排条目处理（延迟 30 秒）
   */
  private scheduleItemProcessing(item: Zotero.Item): void {
    // 如果服务已销毁，直接返回
    if (this.isDestroyed) return;

    const itemKey = item.key;
    const libraryID = item.libraryID;

    // 如果已经有定时器，取消重新安排
    if (this.pendingTimers.has(itemKey)) {
      clearTimeout(this.pendingTimers.get(itemKey)!);
    }

    const title = (item.getField?.("title") as string) || "Untitled";
    ztoolkit.log(`[AISummaryService] Scheduling AI Summary for "${title}" in ${this.delayMs / 1000}s`);

    // 只保存 itemKey 和 libraryID，在回调时重新获取 item
    const timer = setTimeout(() => {
      this.pendingTimers.delete(itemKey);
      // 重新获取 item，确保使用最新状态
      const freshItem = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
      if (freshItem) {
        this.addToQueue(freshItem);
      } else {
        ztoolkit.log(`[AISummaryService] Item "${itemKey}" no longer exists, skipping`);
      }
    }, this.delayMs);

    this.pendingTimers.set(itemKey, timer);
  }

  /**
   * 添加到处理队列
   */
  private addToQueue(item: Zotero.Item): void {
    // 如果服务已销毁，直接返回
    if (this.isDestroyed) return;

    const itemKey = item.key;
    const title = (item.getField?.("title") as string) || "Untitled";

    // 检查是否已在队列中
    if (this.taskQueue.some((t) => t.itemKey === itemKey)) {
      ztoolkit.log(`[AISummaryService] Item "${title}" already in queue`);
      return;
    }

    // 检查是否已处理过（有 ai-processed 标签）
    const manager = getAISummaryManager();
    const config = manager.getConfig();
    const tags = item.getTags?.() || [];
    if (tags.some((t: { tag: string }) => t.tag === config.markProcessedTag)) {
      ztoolkit.log(`[AISummaryService] Item "${title}" already processed`);
      return;
    }

    // 检查是否有 PDF
    if (config.filterHasPdf && !this.hasPdfAttachment(item)) {
      ztoolkit.log(`[AISummaryService] Item "${title}" has no PDF, skipping`);
      return;
    }

    const task: AISummaryTask = {
      id: `task-${Date.now()}-${itemKey}`,
      itemKey,
      itemTitle: title,
      status: "pending",
      createdAt: Date.now(),
    };

    this.taskQueue.push(task);
    this.notifyUpdate();

    ztoolkit.log(`[AISummaryService] Added "${title}" to queue`);

    // 开始处理队列
    this.processQueue();
  }

  /**
   * 手动添加条目到队列（右键菜单使用）
   */
  addItemToQueue(item: Zotero.Item): void {
    this.addToQueue(item);
  }

  /**
   * 处理队列
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.isDestroyed) return;

    const pendingTask = this.taskQueue.find((t) => t.status === "pending");
    if (!pendingTask) return;

    this.isProcessing = true;
    pendingTask.status = "running";
    pendingTask.startedAt = Date.now();
    this.notifyUpdate();

    try {
      const manager = getAISummaryManager();
      const result = await manager.processSingleItem(pendingTask.itemKey);

      if (result.success) {
        pendingTask.status = "completed";
        pendingTask.noteKey = result.noteKey;
      } else {
        pendingTask.status = "failed";
        pendingTask.error = result.error;
      }
    } catch (error) {
      pendingTask.status = "failed";
      pendingTask.error = error instanceof Error ? error.message : String(error);
    }

    pendingTask.completedAt = Date.now();

    // 移动到历史记录
    this.moveToHistory(pendingTask);

    this.isProcessing = false;
    this.notifyUpdate();

    // 继续处理下一个（使用 setTimeout 避免栈溢出）
    // 检查 isDestroyed 避免在销毁后继续处理
    if (!this.isDestroyed) {
      setTimeout(() => this.processQueue(), 0);
    }
  }

  /**
   * 移动任务到历史记录
   */
  private moveToHistory(task: AISummaryTask): void {
    const index = this.taskQueue.findIndex((t) => t.id === task.id);
    if (index !== -1) {
      this.taskQueue.splice(index, 1);
    }

    this.taskHistory.unshift(task);

    // 限制历史记录大小
    if (this.taskHistory.length > this.maxHistorySize) {
      this.taskHistory = this.taskHistory.slice(0, this.maxHistorySize);
    }
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
   * 清除所有待处理的定时器
   */
  private clearAllPendingTimers(): void {
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
  }

  /**
   * 通知更新
   */
  private notifyUpdate(): void {
    this.onTaskUpdate?.(this.taskQueue, this.taskHistory);
  }

  /**
   * 注册右键菜单
   */
  private registerContextMenu(): void {
    // 生成 AI 摘要菜单项（条目列表右键菜单）
    ztoolkit.Menu.register("item", {
      tag: "menuitem",
      id: "paperchat-aisummary-menuitem",
      label: "Generate AI Summary",
      icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.svg`,
      commandListener: (_event) => {
        const pane = Zotero.getActiveZoteroPane();
        const selectedItems = pane?.getSelectedItems() as Zotero.Item[] | undefined;
        if (selectedItems && selectedItems.length > 0) {
          const processedKeys = new Set<string>();
          for (const item of selectedItems) {
            // 跳过笔记
            if (item.isNote?.()) continue;

            // 如果是 PDF 附件，获取其父条目
            if (item.isPDFAttachment?.()) {
              const parentID = item.parentItemID;
              if (parentID) {
                const parent = Zotero.Items.get(parentID);
                if (parent && !parent.isNote?.() && !processedKeys.has(parent.key)) {
                  processedKeys.add(parent.key);
                  this.addItemToQueue(parent);
                }
              }
              continue;
            }

            // 跳过非 PDF 附件
            if (item.isAttachment?.()) continue;

            // 普通条目
            if (!processedKeys.has(item.key)) {
              processedKeys.add(item.key);
              this.addItemToQueue(item);
            }
          }
          // 打开任务窗口
          this.onOpenTaskWindow?.();
        }
      },
      getVisibility: (_elem, _ev) => {
        const pane = Zotero.getActiveZoteroPane();
        const selectedItems = pane?.getSelectedItems() as Zotero.Item[] | undefined;
        if (!selectedItems || selectedItems.length === 0) return false;
        // 至少有一个：非附件非笔记的条目，或者是有父条目的 PDF 附件
        return selectedItems.some((item: Zotero.Item) => {
          // 跳过笔记
          if (item.isNote?.()) return false;
          // PDF 附件：检查是否有父条目
          if (item.isPDFAttachment?.()) {
            return !!item.parentItemID;
          }
          // 非 PDF 附件：跳过
          if (item.isAttachment?.()) return false;
          // 普通条目：显示
          return true;
        });
      },
    });

    // 工具菜单 - 查看任务列表
    ztoolkit.Menu.register("menuTools", {
      tag: "menuitem",
      id: "paperchat-aisummary-tasks-menuitem",
      label: "AI Summary Tasks",
      icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.svg`,
      commandListener: () => {
        this.onOpenTaskWindow?.();
      },
    });

    // PDF 阅读器右键菜单
    this.registerReaderContextMenu();

    ztoolkit.log("[AISummaryService] Context menu registered");
  }

  /**
   * 注册 PDF 阅读器右键菜单
   */
  private registerReaderContextMenu(): void {
    // 检查 Zotero.Reader API 是否可用
    if (!Zotero.Reader?.registerEventListener) {
      ztoolkit.log("[AISummaryService] Zotero.Reader.registerEventListener not available");
      return;
    }

    // PDF 阅读器视图右键菜单（选中文本或空白处右键）
    Zotero.Reader.registerEventListener(
      "createViewContextMenu",
      (event: {
        append: (options: { label: string; onCommand: () => void }) => void;
        reader: { itemID?: number };
      }) => {
        const { append, reader } = event;

        // 获取当前 PDF 对应的父条目
        const parentItem = this.getParentItemFromReader(reader);
        if (!parentItem) return;

        append({
          label: "Generate AI Summary",
          onCommand: () => {
            this.addItemToQueue(parentItem);
            this.onOpenTaskWindow?.();
          },
        });
      },
      addon.data.config.addonRef,
    );

    // PDF 阅读器标注右键菜单（标注上右键）
    Zotero.Reader.registerEventListener(
      "createAnnotationContextMenu",
      (event: {
        append: (options: { label: string; onCommand: () => void }) => void;
        reader: { itemID?: number };
      }) => {
        const { append, reader } = event;

        // 获取当前 PDF 对应的父条目
        const parentItem = this.getParentItemFromReader(reader);
        if (!parentItem) return;

        append({
          label: "Generate AI Summary",
          onCommand: () => {
            this.addItemToQueue(parentItem);
            this.onOpenTaskWindow?.();
          },
        });
      },
      addon.data.config.addonRef,
    );

    ztoolkit.log("[AISummaryService] Reader context menu registered");
  }

  /**
   * 从 Reader 获取父条目（论文条目）
   */
  private getParentItemFromReader(reader: { itemID?: number }): Zotero.Item | null {
    if (!reader.itemID) return null;

    const item = Zotero.Items.get(reader.itemID);
    if (!item) return null;

    // 如果是 PDF 附件，获取其父条目
    if (item.isAttachment?.()) {
      const parentID = item.parentItemID;
      if (parentID) {
        const parent = Zotero.Items.get(parentID);
        if (parent && !parent.isNote?.()) {
          return parent;
        }
      }
      return null;
    }

    // 非附件且非笔记
    if (!item.isNote?.()) {
      return item;
    }

    return null;
  }
}

// 单例
let aiSummaryService: AISummaryService | null = null;

export function getAISummaryService(): AISummaryService {
  if (!aiSummaryService) {
    aiSummaryService = new AISummaryService();
  }
  return aiSummaryService;
}

export function initAISummaryService(): void {
  getAISummaryService().init();
}

export function destroyAISummaryService(): void {
  if (aiSummaryService) {
    aiSummaryService.destroy();
    aiSummaryService = null;
  }
}
