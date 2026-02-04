/**
 * AISummaryTaskWindow - AI 摘要任务列表窗口
 */

import { getAISummaryService, type AISummaryTask } from "./AISummaryService";

let taskWindow: Window | null = null;

/**
 * 打开任务窗口
 */
export function openTaskWindow(): void {
  if (taskWindow && !taskWindow.closed) {
    taskWindow.focus();
    return;
  }

  const mainWindow = Zotero.getMainWindow();
  if (!mainWindow) return;

  const win = mainWindow.openDialog(
    "about:blank",
    "paperchat-aisummary-tasks",
    "chrome,centerscreen,resizable=yes,width=500,height=600",
  );

  if (!win) return;

  taskWindow = win;
  win.addEventListener("load", () => {
    buildTaskWindowContent(win);
    setupTaskUpdates(win);
  });
}

/**
 * 关闭任务窗口
 */
export function closeTaskWindow(): void {
  if (taskWindow && !taskWindow.closed) {
    taskWindow.close();
  }
  taskWindow = null;
}

/**
 * 构建窗口内容
 */
function buildTaskWindowContent(win: Window): void {
  const doc = win.document;

  // 设置标题
  doc.title = "AI Summary Tasks";

  // 清空并重建文档
  while (doc.documentElement.firstChild) {
    doc.documentElement.removeChild(doc.documentElement.firstChild);
  }

  // 创建 head
  const head = doc.createElement("head");
  const style = doc.createElement("style");
  style.textContent = getStyles();
  head.appendChild(style);
  doc.documentElement.appendChild(head);

  // 创建 body
  const body = doc.createElement("body");
  doc.documentElement.appendChild(body);

  // 构建内容结构
  const container = doc.createElement("div");
  container.className = "container";

  const title = doc.createElement("h2");
  title.className = "title";
  title.textContent = "AI Summary Tasks";
  container.appendChild(title);

  // 当前队列区域
  const queueSection = doc.createElement("div");
  queueSection.className = "section";

  const queueTitle = doc.createElement("h3");
  queueTitle.className = "section-title";
  queueTitle.textContent = "Current Queue";
  queueSection.appendChild(queueTitle);

  const queueList = doc.createElement("div");
  queueList.id = "task-queue";
  queueList.className = "task-list";
  queueSection.appendChild(queueList);

  container.appendChild(queueSection);

  // 历史记录区域
  const historySection = doc.createElement("div");
  historySection.className = "section";

  const historyTitle = doc.createElement("h3");
  historyTitle.className = "section-title";
  historyTitle.textContent = "History";
  historySection.appendChild(historyTitle);

  const historyList = doc.createElement("div");
  historyList.id = "task-history";
  historyList.className = "task-list";
  historySection.appendChild(historyList);

  container.appendChild(historySection);

  body.appendChild(container);

  // 初始渲染
  renderTasks(doc);
}

/**
 * 设置任务更新监听
 */
function setupTaskUpdates(win: Window): void {
  const service = getAISummaryService();

  const updateCallback = (_tasks: AISummaryTask[], _history: AISummaryTask[]) => {
    if (win.closed) return;
    renderTasks(win.document);
  };

  service.setOnTaskUpdate(updateCallback);

  // 窗口关闭时清理回调
  win.addEventListener("unload", () => {
    // 清理全局窗口引用
    if (taskWindow === win) {
      taskWindow = null;
    }
    // 只有当前回调还是我们设置的才清理
    // 使用 try-catch 以防服务已被销毁
    try {
      if (service.getOnTaskUpdate() === updateCallback) {
        service.setOnTaskUpdate(() => {});
      }
    } catch {
      // 服务可能已被销毁，忽略错误
    }
  });
}

/**
 * 渲染任务列表
 */
function renderTasks(doc: Document): void {
  const service = getAISummaryService();
  const queue = service.getTaskQueue();
  const history = service.getTaskHistory();

  // 渲染当前队列
  const queueContainer = doc.getElementById("task-queue");
  if (queueContainer) {
    // 清空容器
    while (queueContainer.firstChild) {
      queueContainer.removeChild(queueContainer.firstChild);
    }

    if (queue.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No tasks in queue";
      queueContainer.appendChild(empty);
    } else {
      queue.forEach((task) => {
        queueContainer.appendChild(createTaskItemElement(doc, task));
      });
    }
  }

  // 渲染历史记录
  const historyContainer = doc.getElementById("task-history");
  if (historyContainer) {
    // 清空容器
    while (historyContainer.firstChild) {
      historyContainer.removeChild(historyContainer.firstChild);
    }

    if (history.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No history";
      historyContainer.appendChild(empty);
    } else {
      history.forEach((task) => {
        historyContainer.appendChild(createTaskItemElement(doc, task));
      });
    }
  }
}

/**
 * 创建任务项元素
 */
function createTaskItemElement(doc: Document, task: AISummaryTask): HTMLElement {
  const item = doc.createElement("div");
  item.className = `task-item status-${task.status}`;

  const info = doc.createElement("div");
  info.className = "task-info";

  const titleEl = doc.createElement("div");
  titleEl.className = "task-title";
  titleEl.textContent = task.itemTitle;
  info.appendChild(titleEl);

  const meta = doc.createElement("div");
  meta.className = "task-meta";

  const statusSpan = doc.createElement("span");
  statusSpan.className = "task-status";
  statusSpan.textContent = getStatusText(task.status);
  meta.appendChild(statusSpan);

  const timeSpan = doc.createElement("span");
  timeSpan.className = "task-time";
  timeSpan.textContent = formatTime(task.completedAt || task.startedAt || task.createdAt);
  meta.appendChild(timeSpan);

  info.appendChild(meta);

  if (task.error) {
    const errorEl = doc.createElement("div");
    errorEl.className = "task-error";
    errorEl.textContent = task.error;
    info.appendChild(errorEl);
  }

  item.appendChild(info);
  return item;
}

/**
 * 获取状态文本
 */
function getStatusText(status: string): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "running":
      return "Processing...";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

/**
 * 格式化时间
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString();
}

/**
 * 获取样式
 */
function getStyles(): string {
  return `
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      background: #f5f5f5;
      color: #333;
    }

    .container {
      padding: 16px;
      max-width: 100%;
    }

    .title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 16px;
      color: #1a1a1a;
    }

    .section {
      margin-bottom: 20px;
    }

    .section-title {
      font-size: 14px;
      font-weight: 500;
      color: #666;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid #ddd;
    }

    .task-list {
      background: #fff;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }

    .empty-state {
      padding: 24px;
      text-align: center;
      color: #999;
    }

    .task-item {
      padding: 12px 16px;
      border-bottom: 1px solid #eee;
    }

    .task-item:last-child {
      border-bottom: none;
    }

    .task-title {
      font-weight: 500;
      margin-bottom: 4px;
      word-break: break-word;
    }

    .task-meta {
      display: flex;
      gap: 12px;
      font-size: 12px;
      color: #666;
    }

    .task-status {
      font-weight: 500;
    }

    .status-pending .task-status {
      color: #666;
    }

    .status-running .task-status {
      color: #0066cc;
    }

    .status-completed .task-status {
      color: #28a745;
    }

    .status-failed .task-status {
      color: #dc3545;
    }

    .task-error {
      margin-top: 4px;
      font-size: 12px;
      color: #dc3545;
      background: #fff5f5;
      padding: 4px 8px;
      border-radius: 4px;
    }

    .status-running {
      background: #f0f7ff;
    }
  `;
}
