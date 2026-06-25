import { getPref } from "../../utils/prefs";
import { generateTimestampId, getErrorMessage } from "../../utils/common";

export type ReadingLoopState =
  | "idle"
  | "suggested"
  | "running"
  | "completed"
  | "attention";

export type ReadingSuggestionKind =
  | "explain_selection"
  | "save_selection_note"
  | "highlight_digest";

export interface ReadingSuggestion {
  id: string;
  kind: ReadingSuggestionKind;
  itemKey: string;
  title: string;
  reason: string;
  priority: number;
  status: ReadingLoopState;
  sourceEventIds: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  dismissedUntil?: number;
  payload?: Record<string, unknown>;
  result?: {
    title: string;
    detail?: string;
    noteKey?: string;
  };
  error?: string;
}

export interface ReadingLoopSnapshot {
  enabled: boolean;
  state: ReadingLoopState;
  activeSuggestion?: ReadingSuggestion;
}

export type ReadingLoopListener = (snapshot: ReadingLoopSnapshot) => void;

export interface ReadingLoopExecutionContext {
  suggestion: ReadingSuggestion;
  currentItem: Zotero.Item | null;
}

export interface ReadingLoopExecutionResult {
  title?: string;
  detail?: string;
  noteKey?: string;
}

export type ReadingLoopExecutor = (
  context: ReadingLoopExecutionContext,
) => Promise<ReadingLoopExecutionResult | void>;

const SELECTION_POLL_INTERVAL_MS = 800;
const SUGGESTION_BADGE_COOLDOWN_MS = 5 * 60 * 1000;
const DISMISS_SILENCE_MS = 30 * 60 * 1000;
const MAX_SELECTED_TEXT_LENGTH = 4000;
const HIGHLIGHT_SESSION_THRESHOLD = 3;
const HIGHLIGHT_TOTAL_THRESHOLD = 5;

const SUGGESTION_PRIORITY: Record<ReadingSuggestionKind, number> = {
  explain_selection: 70,
  save_selection_note: 60,
  highlight_digest: 50,
};

type DismissState = {
  count: number;
  until: number;
};

export class ReadingLoopService {
  private enabled = true;
  private currentItem: Zotero.Item | null = null;
  private currentPaperKey: string | null = null;
  private activeSuggestion: ReadingSuggestion | undefined;
  private listeners = new Set<ReadingLoopListener>();
  private executor: ReadingLoopExecutor | null = null;
  private selectionPollTimer: ReturnType<typeof setInterval> | null = null;
  private itemNotifierID: string | null = null;
  private lastSelectionText = "";
  private highlightSessionCounts = new Map<string, number>();
  private lastCreatedByKind = new Map<string, number>();
  private dismissStates = new Map<string, DismissState>();
  private initialized = false;

  init(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.refreshEnabledFromPrefs();
    this.startSelectionPolling();
    this.registerItemNotifier();
  }

  destroy(): void {
    if (this.selectionPollTimer) {
      clearInterval(this.selectionPollTimer);
      this.selectionPollTimer = null;
    }
    if (this.itemNotifierID) {
      Zotero.Notifier.unregisterObserver(this.itemNotifierID);
      this.itemNotifierID = null;
    }
    this.listeners.clear();
    this.executor = null;
    this.initialized = false;
  }

  refreshEnabledFromPrefs(): void {
    this.enabled = getPref("readingLoopEnabled") !== false;
    if (!this.enabled) {
      this.activeSuggestion = undefined;
      this.lastSelectionText = "";
    }
    this.notify();
  }

  setExecutor(executor: ReadingLoopExecutor | null): void {
    this.executor = executor;
  }

  subscribe(listener: ReadingLoopListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): ReadingLoopSnapshot {
    if (!this.enabled || !this.activeSuggestion) {
      return {
        enabled: this.enabled,
        state: "idle",
      };
    }
    return {
      enabled: this.enabled,
      state: this.activeSuggestion.status,
      activeSuggestion: { ...this.activeSuggestion },
    };
  }

  setCurrentItem(item: Zotero.Item | null): void {
    const paperKey = this.resolvePaperKey(item);
    if (paperKey === this.currentPaperKey) {
      this.currentItem = item;
      return;
    }

    this.currentItem = item;
    this.currentPaperKey = paperKey;
    this.lastSelectionText = "";

    if (
      this.activeSuggestion &&
      (!paperKey ||
        this.activeSuggestion.itemKey !== paperKey ||
        this.activeSuggestion.kind === "explain_selection")
    ) {
      this.activeSuggestion = undefined;
      this.notify();
    }
  }

  handleTextSelected(text: string): void {
    if (!this.enabled || !this.currentPaperKey) {
      return;
    }

    const normalized = this.normalizeSelection(text);
    if (normalized.length < 3) {
      this.handleSelectionCleared();
      return;
    }
    if (normalized === this.lastSelectionText) {
      return;
    }

    this.lastSelectionText = normalized;
    const kind: ReadingSuggestionKind =
      normalized.length > 800 ? "save_selection_note" : "explain_selection";
    const title =
      kind === "save_selection_note"
        ? "保存选中文本到笔记"
        : "解释当前选中文本";

    this.createSuggestion({
      kind,
      itemKey: this.currentPaperKey,
      title,
      reason: "来自当前 PDF 选中文本",
      payload: {
        selectedText: normalized.slice(0, MAX_SELECTED_TEXT_LENGTH),
        selectedTextLength: normalized.length,
      },
      expiresAt: Date.now() + 2 * 60 * 1000,
    });
  }

  handleSelectionCleared(): void {
    this.lastSelectionText = "";
    if (
      this.activeSuggestion?.kind === "explain_selection" ||
      this.activeSuggestion?.kind === "save_selection_note"
    ) {
      this.activeSuggestion = undefined;
      this.notify();
    }
  }

  handleAnnotationCreated(annotation?: Zotero.Item | null): void {
    if (!this.enabled || !annotation) {
      return;
    }

    const annotationType = String(annotation.annotationType || "");
    if (
      !annotationType ||
      !["highlight", "underline"].includes(annotationType)
    ) {
      return;
    }

    const paperKey = this.resolvePaperKeyFromAnnotation(annotation);
    if (!paperKey || paperKey !== this.currentPaperKey) {
      return;
    }

    const nextCount = (this.highlightSessionCounts.get(paperKey) || 0) + 1;
    this.highlightSessionCounts.set(paperKey, nextCount);

    const totalCount = this.getHighlightCountForPaper(paperKey);
    if (
      nextCount < HIGHLIGHT_SESSION_THRESHOLD &&
      totalCount < HIGHLIGHT_TOTAL_THRESHOLD
    ) {
      return;
    }

    this.createSuggestion({
      kind: "highlight_digest",
      itemKey: paperKey,
      title: `整理 ${Math.max(nextCount, totalCount)} 条高亮为阅读笔记`,
      reason: "来自当前论文的高亮",
      payload: {
        sessionHighlightCount: nextCount,
        totalHighlightCount: totalCount,
      },
    });
  }

  dismissSuggestion(id: string): void {
    if (!this.activeSuggestion || this.activeSuggestion.id !== id) {
      return;
    }
    const key = this.getKindItemKey(
      this.activeSuggestion.itemKey,
      this.activeSuggestion.kind,
    );
    const existing = this.dismissStates.get(key);
    this.dismissStates.set(key, {
      count: (existing?.count || 0) + 1,
      until: Date.now() + DISMISS_SILENCE_MS,
    });
    this.activeSuggestion = undefined;
    this.notify();
  }

  async acceptSuggestion(id: string): Promise<void> {
    const suggestion = this.activeSuggestion;
    if (
      !suggestion ||
      suggestion.id !== id ||
      suggestion.status === "running"
    ) {
      return;
    }

    const executor = this.executor;
    if (!executor) {
      this.markAttention(suggestion, "Reading Loop executor is not ready.");
      return;
    }

    this.activeSuggestion = {
      ...suggestion,
      status: "running",
      title: this.getRunningTitle(suggestion),
      updatedAt: Date.now(),
    };
    this.notify();

    try {
      const result = await executor({
        suggestion,
        currentItem: this.currentItem,
      });
      if (!this.isCurrentRunningSuggestion(suggestion)) {
        return;
      }
      this.activeSuggestion = {
        ...suggestion,
        status: "completed",
        title: result?.title || this.getCompletedTitle(suggestion),
        updatedAt: Date.now(),
        result: result
          ? {
              title: result.title || this.getCompletedTitle(suggestion),
              detail: result.detail,
              noteKey: result.noteKey,
            }
          : {
              title: this.getCompletedTitle(suggestion),
            },
      };
      this.notify();
    } catch (error) {
      this.markAttention(suggestion, getErrorMessage(error), {
        requireRunning: true,
      });
    }
  }

  viewResult(id: string): void {
    if (!this.activeSuggestion || this.activeSuggestion.id !== id) {
      return;
    }
    if (this.activeSuggestion.result?.noteKey) {
      this.openNoteByKey(this.activeSuggestion.result.noteKey);
    }
    this.activeSuggestion = undefined;
    this.notify();
  }

  private createSuggestion(input: {
    kind: ReadingSuggestionKind;
    itemKey: string;
    title: string;
    reason: string;
    payload?: Record<string, unknown>;
    expiresAt?: number;
  }): void {
    if (!this.enabled || this.isSilenced(input.itemKey, input.kind)) {
      return;
    }

    const now = Date.now();
    const kindKey = this.getKindItemKey(input.itemKey, input.kind);

    if (
      this.activeSuggestion &&
      this.activeSuggestion.itemKey === input.itemKey &&
      this.activeSuggestion.kind === input.kind &&
      this.activeSuggestion.status === "suggested"
    ) {
      this.activeSuggestion = {
        ...this.activeSuggestion,
        title: input.title,
        reason: input.reason,
        payload: input.payload,
        expiresAt: input.expiresAt,
        updatedAt: now,
      };
      this.notify();
      return;
    }

    if (input.kind === "highlight_digest") {
      const lastCreatedAt = this.lastCreatedByKind.get(kindKey) || 0;
      if (now - lastCreatedAt < SUGGESTION_BADGE_COOLDOWN_MS) {
        return;
      }
    }

    if (
      this.activeSuggestion &&
      this.activeSuggestion.status !== "suggested" &&
      this.activeSuggestion.status !== "idle"
    ) {
      return;
    }

    const candidate: ReadingSuggestion = {
      id: generateTimestampId(),
      kind: input.kind,
      itemKey: input.itemKey,
      title: input.title,
      reason: input.reason,
      priority: SUGGESTION_PRIORITY[input.kind],
      status: "suggested",
      sourceEventIds: [generateTimestampId()],
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
      payload: input.payload,
    };

    if (
      this.activeSuggestion &&
      this.activeSuggestion.priority > candidate.priority
    ) {
      return;
    }

    this.activeSuggestion = candidate;
    this.lastCreatedByKind.set(kindKey, now);
    this.notify();
  }

  private markAttention(
    suggestion: ReadingSuggestion,
    error: string,
    options: { requireRunning?: boolean } = {},
  ): void {
    if (
      !this.enabled ||
      this.currentPaperKey !== suggestion.itemKey ||
      !this.activeSuggestion ||
      this.activeSuggestion.id !== suggestion.id ||
      this.activeSuggestion.itemKey !== suggestion.itemKey ||
      (options.requireRunning && this.activeSuggestion.status !== "running")
    ) {
      return;
    }
    this.activeSuggestion = {
      ...suggestion,
      status: "attention",
      title: "建议执行失败",
      error,
      updatedAt: Date.now(),
    };
    this.notify();
  }

  private isCurrentRunningSuggestion(suggestion: ReadingSuggestion): boolean {
    return (
      this.enabled &&
      this.currentPaperKey === suggestion.itemKey &&
      this.activeSuggestion?.id === suggestion.id &&
      this.activeSuggestion?.itemKey === suggestion.itemKey &&
      this.activeSuggestion?.status === "running"
    );
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private startSelectionPolling(): void {
    if (this.selectionPollTimer) {
      return;
    }
    this.selectionPollTimer = setInterval(() => {
      this.pollReaderState().catch((error) => {
        ztoolkit.log("[ReadingLoop] Poll failed:", error);
      });
    }, SELECTION_POLL_INTERVAL_MS);
  }

  private async pollReaderState(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const activeItem = this.getActiveReaderItem();
    this.setCurrentItem(activeItem);

    const selectedText = await this.readActivePdfSelection();
    if (selectedText) {
      this.handleTextSelected(selectedText);
    } else if (this.lastSelectionText) {
      this.handleSelectionCleared();
    }
  }

  private registerItemNotifier(): void {
    if (this.itemNotifierID) {
      return;
    }
    this.itemNotifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event: string, type: string, ids: (string | number)[]) => {
          if (!this.enabled || event !== "add" || type !== "item") {
            return;
          }
          for (const id of ids) {
            const item = Zotero.Items.get(Number(id));
            if (item) {
              this.handleAnnotationCreated(item as Zotero.Item);
            }
          }
        },
      },
      ["item"],
      "paperchat-reading-loop-item-observer",
      100,
    );
  }

  private getActiveReaderItem(): Zotero.Item | null {
    try {
      const mainWindow = Zotero.getMainWindow() as Window & {
        Zotero_Tabs?: { selectedID: string };
      };
      const selectedID = mainWindow.Zotero_Tabs?.selectedID;
      if (!selectedID) {
        return null;
      }
      const reader = Zotero.Reader?.getByTabID(selectedID);
      const itemID = reader?.itemID;
      if (!itemID) {
        return null;
      }
      return (Zotero.Items.get(itemID) as Zotero.Item | false) || null;
    } catch {
      return null;
    }
  }

  private async readActivePdfSelection(): Promise<string> {
    try {
      const reader = await ztoolkit.Reader.getReader();
      const iframeWindow = reader?._iframeWindow;
      const selectedText =
        iframeWindow?.getSelection?.()?.toString() ||
        iframeWindow?.document?.getSelection?.()?.toString() ||
        "";
      return this.normalizeSelection(selectedText);
    } catch {
      return "";
    }
  }

  private normalizeSelection(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  private resolvePaperKey(item: Zotero.Item | null | undefined): string | null {
    if (!item?.key) {
      return null;
    }
    if (item.isAttachment?.() && item.parentItemID) {
      const parent = Zotero.Items.get(item.parentItemID);
      return parent?.key || item.key;
    }
    if (item.isNote?.() && item.parentItemID) {
      const parent = Zotero.Items.get(item.parentItemID);
      return parent?.key || item.key;
    }
    return item.key;
  }

  private resolvePaperKeyFromAnnotation(
    annotation: Zotero.Item,
  ): string | null {
    const attachmentID = annotation.parentItemID;
    if (!attachmentID) {
      return this.resolvePaperKey(annotation);
    }
    const attachment = Zotero.Items.get(attachmentID);
    if (!attachment) {
      return null;
    }
    return this.resolvePaperKey(attachment as Zotero.Item);
  }

  private getHighlightCountForPaper(paperKey: string): number {
    const libraryID = Zotero.Libraries.userLibraryID;
    const item = Zotero.Items.getByLibraryAndKey(libraryID, paperKey);
    if (!item) {
      return 0;
    }
    let count = 0;
    const attachmentIDs = item.getAttachments?.() || [];
    for (const attachmentID of attachmentIDs) {
      const attachment = Zotero.Items.get(attachmentID);
      const annotations = attachment?.getAnnotations?.() || [];
      for (const annotation of annotations) {
        const type = String(annotation?.annotationType || "");
        if (type === "highlight" || type === "underline") {
          count++;
        }
      }
    }
    return count;
  }

  private isSilenced(itemKey: string, kind: ReadingSuggestionKind): boolean {
    const state = this.dismissStates.get(this.getKindItemKey(itemKey, kind));
    if (!state) {
      return false;
    }
    if (state.count >= 2) {
      return true;
    }
    return Date.now() < state.until;
  }

  private getKindItemKey(itemKey: string, kind: ReadingSuggestionKind): string {
    return `${itemKey}:${kind}`;
  }

  private getRunningTitle(suggestion: ReadingSuggestion): string {
    switch (suggestion.kind) {
      case "highlight_digest":
        return "正在整理高亮...";
      case "save_selection_note":
        return "正在保存选中文本...";
      case "explain_selection":
      default:
        return "正在解释选中文本...";
    }
  }

  private getCompletedTitle(suggestion: ReadingSuggestion): string {
    switch (suggestion.kind) {
      case "highlight_digest":
        return "已发送到 PaperChat";
      case "save_selection_note":
        return "已发送到 PaperChat";
      case "explain_selection":
      default:
        return "已发送到 PaperChat";
    }
  }

  private openNoteByKey(noteKey: string): void {
    try {
      const note = Zotero.Items.getByLibraryAndKey(
        Zotero.Libraries.userLibraryID,
        noteKey,
      );
      if (note) {
        Zotero.getActiveZoteroPane()?.selectItem(note.id);
      }
    } catch (error) {
      ztoolkit.log("[ReadingLoop] Failed to open note:", error);
    }
  }
}

let readingLoopService: ReadingLoopService | null = null;

export function getReadingLoopService(): ReadingLoopService {
  if (!readingLoopService) {
    readingLoopService = new ReadingLoopService();
  }
  return readingLoopService;
}

export function initReadingLoopService(): void {
  getReadingLoopService().init();
}

export function destroyReadingLoopService(): void {
  readingLoopService?.destroy();
  readingLoopService = null;
}
