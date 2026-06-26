import { getPref } from "../../utils/prefs";
import { generateTimestampId, getErrorMessage } from "../../utils/common";
import { ReadingLoopHistoryRegistry } from "./ReadingLoopHistoryRegistry";
import type {
  ReadingLoopExecutor,
  ReadingLoopListener,
  ReadingLoopSnapshot,
  ReadingSuggestion,
  ReadingSuggestionKind,
} from "./ReadingLoopTypes";

const SELECTION_POLL_INTERVAL_MS = 800;
const SUGGESTION_BADGE_COOLDOWN_MS = 5 * 60 * 1000;
const DISMISS_SILENCE_MS = 30 * 60 * 1000;
const MAX_SELECTED_TEXT_LENGTH = 4000;
const SELECTION_SUGGESTION_DELAY_MS = 2 * 1000;
const SELECTION_CLEAR_GRACE_MS = 15 * 1000;
const COMPLETED_SUGGESTION_VISIBLE_MS = 6 * 1000;
const HIGHLIGHT_SESSION_THRESHOLD = 3;
const HIGHLIGHT_TOTAL_THRESHOLD = 5;
const CLOSE_CHECKPOINT_MIN_ACTIVITY_MS = 2 * 60 * 1000;
const DWELL_CHECKPOINT_MS = 4 * 60 * 1000;
const PAGE_DWELL_MS = 90 * 1000;
const PROGRESS_BUCKET_STABLE_MS = 12 * 1000;
const FOLLOWUP_QUESTION_WINDOW_MS = 10 * 60 * 1000;
const FOLLOWUP_QUESTION_THRESHOLD = 3;

const SUGGESTION_PRIORITY: Record<ReadingSuggestionKind, number> = {
  explain_visual_context: 80,
  explain_formula: 80,
  trace_reference: 75,
  explain_selection: 70,
  followup_questions: 65,
  save_selection_note: 60,
  highlight_digest: 50,
  section_checkpoint: 45,
  reading_checkpoint: 40,
};

type DismissState = {
  count: number;
  until: number;
};

type PaperActivityState = {
  selectionCount: number;
  highlightCount: number;
  progressChangeCount: number;
  pageDwellCount: number;
  questionSignalCount: number;
  lastActiveAt: number;
};

type ReaderPageState = {
  pageIndex: number;
  pageCount: number;
  pageStartedAt: number;
  suggestedDwellKeys: Set<string>;
};

type PendingSelectionState = {
  itemKey: string;
  text: string;
  firstSeenAt: number;
};

type PendingProgressBucketState = {
  itemKey: string;
  bucket: number;
  firstSeenAt: number;
};

type HighlightStats = {
  count: number;
  lastAnnotationMarker: string;
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
  private pendingSelection: PendingSelectionState | null = null;
  private highlightSessionCounts = new Map<string, number>();
  private lastCreatedByKind = new Map<string, number>();
  private dismissStates = new Map<string, DismissState>();
  private currentItemStartedAt = 0;
  private currentReaderSessionId: string | null = null;
  private readerSessionCounter = 0;
  private lastReaderProgressBucket = new Map<string, number>();
  private pendingProgressBucket: PendingProgressBucketState | null = null;
  private readerPageStates = new Map<string, ReaderPageState>();
  private paperActivityStates = new Map<string, PaperActivityState>();
  private recentQuestionSignals = new Map<string, number[]>();
  private historyRegistry = new ReadingLoopHistoryRegistry();
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
    this.currentItem = null;
    this.currentPaperKey = null;
    this.activeSuggestion = undefined;
    this.lastSelectionText = "";
    this.pendingSelection = null;
    this.currentReaderSessionId = null;
    this.highlightSessionCounts.clear();
    this.lastCreatedByKind.clear();
    this.dismissStates.clear();
    this.lastReaderProgressBucket.clear();
    this.pendingProgressBucket = null;
    this.readerPageStates.clear();
    this.paperActivityStates.clear();
    this.recentQuestionSignals.clear();
    this.historyRegistry.resetMemory();
    this.initialized = false;
  }

  refreshEnabledFromPrefs(): void {
    this.enabled = getPref("readingLoopEnabled") !== false;
    if (!this.enabled) {
      this.activeSuggestion = undefined;
      this.lastSelectionText = "";
      this.pendingSelection = null;
      this.pendingProgressBucket = null;
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
    this.beginReaderSession(paperKey);
    this.lastSelectionText = "";
    this.pendingSelection = null;

    if (
      this.activeSuggestion &&
      ((paperKey && this.activeSuggestion.itemKey !== paperKey) ||
        this.isSelectionSuggestion(this.activeSuggestion.kind))
    ) {
      this.activeSuggestion = undefined;
      this.notify();
    }

    if (paperKey) {
      this.maybeSuggestExistingHighlightDigest(paperKey);
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

    const now = Date.now();
    const pending = this.pendingSelection;
    if (
      !pending ||
      pending.text !== normalized ||
      pending.itemKey !== this.currentPaperKey
    ) {
      this.pendingSelection = {
        itemKey: this.currentPaperKey,
        text: normalized,
        firstSeenAt: now,
      };
      this.clearPendingSelectionSuggestion(normalized);
      return;
    }
    if (now - pending.firstSeenAt < SELECTION_SUGGESTION_DELAY_MS) {
      return;
    }

    this.pendingSelection = null;
    this.lastSelectionText = normalized;
    const classified = this.classifySelection(normalized);
    this.recordPaperActivity(this.currentPaperKey, "selectionCount");

    this.createSuggestion({
      kind: classified.kind,
      itemKey: this.currentPaperKey,
      title: classified.title,
      reason: classified.reason,
      triggerSignature: `selection:${normalized.length}:${this.hashText(
        normalized,
      )}`,
      payload: {
        selectedText: normalized.slice(0, MAX_SELECTED_TEXT_LENGTH),
        selectedTextLength: normalized.length,
      },
      expiresAt: Date.now() + 2 * 60 * 1000,
    });
  }

  handleSelectionCleared(): void {
    this.pendingSelection = null;
    this.lastSelectionText = "";
    if (!this.activeSuggestion) {
      return;
    }

    if (this.isSelectionSuggestion(this.activeSuggestion.kind)) {
      const now = Date.now();
      const expiresAt = Math.min(
        this.activeSuggestion.expiresAt || now + SELECTION_CLEAR_GRACE_MS,
        now + SELECTION_CLEAR_GRACE_MS,
      );
      this.activeSuggestion = {
        ...this.activeSuggestion,
        expiresAt,
        updatedAt: now,
      };
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
    this.recordPaperActivity(paperKey, "highlightCount");

    const highlightStats = this.getHighlightStatsForPaper(paperKey);
    const totalCount = highlightStats.count;
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
      triggerSignature: this.getHighlightTriggerSignature(highlightStats),
      payload: {
        sessionHighlightCount: nextCount,
        totalHighlightCount: totalCount,
      },
    });
  }

  handleChatMessageSent(text: string, item?: Zotero.Item | null): void {
    if (!this.enabled) {
      return;
    }
    const paperKey = this.resolvePaperKey(item || this.currentItem);
    if (!paperKey || paperKey !== this.currentPaperKey) {
      return;
    }
    if (!this.looksLikeQuestionOrConfusion(text)) {
      return;
    }

    const now = Date.now();
    const recent = (this.recentQuestionSignals.get(paperKey) || []).filter(
      (timestamp) => now - timestamp <= FOLLOWUP_QUESTION_WINDOW_MS,
    );
    recent.push(now);
    this.recentQuestionSignals.set(paperKey, recent);
    this.recordPaperActivity(paperKey, "questionSignalCount");

    if (recent.length < FOLLOWUP_QUESTION_THRESHOLD) {
      return;
    }

    this.createSuggestion({
      kind: "followup_questions",
      itemKey: paperKey,
      title: "整理刚才的问题为阅读路线",
      reason: "来自连续提问",
      triggerSignature: `followup:${recent[0]}:${recent[recent.length - 1]}:${
        recent.length
      }`,
      payload: {
        recentQuestionCount: recent.length,
      },
    });
    this.recentQuestionSignals.set(paperKey, []);
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
    this.historyRegistry.recordStatus(suggestion, "accepted");
    this.notify();

    try {
      const result = await executor({
        suggestion,
        currentItem: this.currentItem,
      });
      if (!this.isCurrentRunningSuggestion(suggestion)) {
        return;
      }
      const completedAt = Date.now();
      const completedSuggestion: ReadingSuggestion = {
        ...suggestion,
        status: "completed",
        title: result?.title || this.getCompletedTitle(suggestion),
        updatedAt: completedAt,
        expiresAt: completedAt + COMPLETED_SUGGESTION_VISIBLE_MS,
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
      this.activeSuggestion = completedSuggestion;
      this.historyRegistry.recordStatus(completedSuggestion, "completed");
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
    triggerSignature?: string;
    payload?: Record<string, unknown>;
    expiresAt?: number;
  }): boolean {
    if (!this.enabled || this.isSilenced(input.itemKey, input.kind)) {
      return false;
    }

    const now = Date.now();
    const kindKey = this.getKindItemKey(input.itemKey, input.kind);
    const triggerSignature = input.triggerSignature;

    if (
      triggerSignature &&
      this.historyRegistry.isSuppressed(
        input.itemKey,
        input.kind,
        triggerSignature,
      )
    ) {
      return false;
    }

    if (
      this.activeSuggestion &&
      this.activeSuggestion.itemKey === input.itemKey &&
      this.activeSuggestion.kind === input.kind &&
      this.activeSuggestion.status === "suggested"
    ) {
      if (this.isCreationCoolingDown(input.kind, kindKey, now)) {
        return false;
      }
      this.activeSuggestion = {
        ...this.activeSuggestion,
        title: input.title,
        reason: input.reason,
        payload: input.payload,
        triggerSignature,
        expiresAt: input.expiresAt,
        updatedAt: now,
      };
      this.lastCreatedByKind.set(kindKey, now);
      this.historyRegistry.recordStatus(this.activeSuggestion, "suggested");
      this.notify();
      return true;
    }

    if (this.isCreationCoolingDown(input.kind, kindKey, now)) {
      return false;
    }

    if (
      this.activeSuggestion &&
      this.activeSuggestion.status !== "suggested" &&
      this.activeSuggestion.status !== "idle"
    ) {
      return false;
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
      triggerSignature,
      payload: input.payload,
    };

    if (
      this.activeSuggestion &&
      this.activeSuggestion.priority > candidate.priority
    ) {
      return false;
    }

    this.activeSuggestion = candidate;
    this.lastCreatedByKind.set(kindKey, now);
    this.historyRegistry.recordStatus(candidate, "suggested");
    this.notify();
    return true;
  }

  private markAttention(
    suggestion: ReadingSuggestion,
    error: string,
    options: { requireRunning?: boolean } = {},
  ): void {
    if (
      !this.enabled ||
      (this.currentPaperKey !== null &&
        this.currentPaperKey !== suggestion.itemKey) ||
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
      (this.currentPaperKey === null ||
        this.currentPaperKey === suggestion.itemKey) &&
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

    this.expireStaleSuggestion();

    const activeItem = this.getActiveReaderItem();
    const activePaperKey = this.resolvePaperKey(activeItem);
    if (
      this.currentPaperKey &&
      (!activePaperKey || activePaperKey !== this.currentPaperKey)
    ) {
      this.handleReaderClosed(this.currentPaperKey);
    }
    this.setCurrentItem(activeItem);
    if (!activePaperKey) {
      return;
    }
    this.handleReaderProgressSignals();

    const selectedText = await this.readActivePdfSelection();
    if (selectedText) {
      this.handleTextSelected(selectedText);
    } else if (this.lastSelectionText) {
      this.handleSelectionCleared();
    } else if (this.pendingSelection) {
      this.handleSelectionCleared();
    }
  }

  private expireStaleSuggestion(): void {
    if (
      this.activeSuggestion?.expiresAt &&
      this.activeSuggestion.expiresAt <= Date.now()
    ) {
      this.activeSuggestion = undefined;
      this.notify();
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
      const reader = this.getActiveReader();
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
      const reader =
        (await ztoolkit.Reader.getReader().catch(() => null)) ||
        this.getActiveReader();
      const toolkitSelectedText = reader
        ? ztoolkit.Reader.getSelectedText(reader)
        : "";
      const iframeWindow = reader?._iframeWindow;
      const pdfViewerDocument =
        iframeWindow?.PDFViewerApplication?.pdfViewer?.container?.ownerDocument;
      const mainWindow = Zotero.getMainWindow();
      const selectedText =
        toolkitSelectedText ||
        iframeWindow?.getSelection?.()?.toString() ||
        iframeWindow?.document?.getSelection?.()?.toString() ||
        pdfViewerDocument?.getSelection?.()?.toString() ||
        mainWindow?.getSelection?.()?.toString() ||
        mainWindow?.document?.getSelection?.()?.toString() ||
        "";
      return this.normalizeSelection(selectedText);
    } catch {
      return "";
    }
  }

  private normalizeSelection(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  private classifySelection(text: string): {
    kind: ReadingSuggestionKind;
    title: string;
    reason: string;
  } {
    if (text.length > 800) {
      return {
        kind: "save_selection_note",
        title: "保存选中文本到笔记",
        reason: "来自较长 PDF 选中文本",
      };
    }

    if (this.looksLikeVisualReference(text)) {
      return {
        kind: "explain_visual_context",
        title: "解释这处图表线索",
        reason: "来自当前 PDF 选中的图表/图片线索",
      };
    }

    if (this.looksLikeFormula(text)) {
      return {
        kind: "explain_formula",
        title: "解释当前公式",
        reason: "来自当前 PDF 选中的公式或符号",
      };
    }

    if (this.looksLikeCitation(text)) {
      return {
        kind: "trace_reference",
        title: "追踪这处引用线索",
        reason: "来自当前 PDF 选中的引用或参考文献",
      };
    }

    return {
      kind: "explain_selection",
      title: "解释当前选中文本",
      reason: "来自当前 PDF 选中文本",
    };
  }

  private looksLikeVisualReference(text: string): boolean {
    return /\b(fig(?:ure)?|table|scheme|algorithm|image|panel)\s*\.?\s*\d+[a-z]?\b/i.test(
      text,
    );
  }

  private looksLikeFormula(text: string): boolean {
    return (
      /\b(eq(?:uation)?|formula)\s*\.?\s*\(?\d+[a-z]?\)?\b/i.test(text) ||
      /[=≈≃≤≥∑∫√∞±×÷∂∇α-ωΑ-Ω]/u.test(text)
    );
  }

  private looksLikeCitation(text: string): boolean {
    return (
      /\[(?:\d{1,3}|[A-Z][A-Za-z-]+(?:\s+et\s+al\.)?)(?:\s*[,;]\s*(?:\d{1,3}|[A-Z][A-Za-z-]+(?:\s+et\s+al\.)?))*\]/.test(
        text,
      ) ||
      /\b[A-Z][A-Za-z-]+(?:\s+et\s+al\.)?,\s*(?:19|20)\d{2}\b/.test(text) ||
      /\((?:[A-Z][A-Za-z-]+(?:\s+et\s+al\.)?,\s*)?(?:19|20)\d{2}[a-z]?\)/.test(
        text,
      )
    );
  }

  private looksLikeQuestionOrConfusion(text: string): boolean {
    return (
      /[?？]/.test(text) ||
      /(不懂|没懂|困惑|为什么|怎么|如何|区别|含义|意思|解释|看不明白|confus|unclear|why|how|what does|difference|meaning)/i.test(
        text,
      )
    );
  }

  private maybeSuggestExistingHighlightDigest(paperKey: string): void {
    const highlightStats = this.getHighlightStatsForPaper(paperKey);
    const totalCount = highlightStats.count;
    if (totalCount < HIGHLIGHT_TOTAL_THRESHOLD) {
      return;
    }

    this.createSuggestion({
      kind: "highlight_digest",
      itemKey: paperKey,
      title: `整理已有 ${totalCount} 条高亮为阅读笔记`,
      reason: "来自当前论文已有高亮",
      triggerSignature: this.getHighlightTriggerSignature(highlightStats),
      payload: {
        sessionHighlightCount: this.highlightSessionCounts.get(paperKey) || 0,
        totalHighlightCount: totalCount,
      },
    });
  }

  private handleReaderProgressSignals(): void {
    if (!this.enabled || !this.currentPaperKey || !this.currentItemStartedAt) {
      return;
    }

    const now = Date.now();
    const progress = this.readActiveReaderProgress();
    if (progress && progress.pageCount > 0) {
      this.handlePageDwellSignal(progress);
      this.handleProgressBucketSignal(progress, now);
    }

    if (now - this.currentItemStartedAt >= DWELL_CHECKPOINT_MS) {
      if (progress && !this.isCurrentProgressPositionStable(progress, now)) {
        return;
      }
      this.createSuggestion({
        kind: "reading_checkpoint",
        itemKey: this.currentPaperKey,
        title: "生成当前阅读 checkpoint",
        reason: "来自当前论文的持续阅读",
        triggerSignature: `dwell:${this.getProgressTriggerSignature(progress)}`,
        payload: {
          dwellMs: now - this.currentItemStartedAt,
        },
      });
    }
  }

  private handleProgressBucketSignal(
    progress: {
      pageIndex: number;
      pageCount: number;
    },
    now: number,
  ): void {
    if (!this.currentPaperKey) {
      return;
    }
    const ratio = (progress.pageIndex + 1) / progress.pageCount;
    const bucket = Math.floor(ratio * 4);
    const lastBucket = this.lastReaderProgressBucket.get(this.currentPaperKey);
    if (typeof lastBucket === "undefined") {
      this.lastReaderProgressBucket.set(this.currentPaperKey, bucket);
      return;
    }
    if (bucket === lastBucket) {
      this.pendingProgressBucket = null;
      return;
    }
    if (bucket <= 0) {
      this.lastReaderProgressBucket.set(this.currentPaperKey, bucket);
      this.pendingProgressBucket = null;
      return;
    }

    const pending = this.pendingProgressBucket;
    if (
      !pending ||
      pending.itemKey !== this.currentPaperKey ||
      pending.bucket !== bucket
    ) {
      this.pendingProgressBucket = {
        itemKey: this.currentPaperKey,
        bucket,
        firstSeenAt: now,
      };
      return;
    }
    if (now - pending.firstSeenAt < PROGRESS_BUCKET_STABLE_MS) {
      return;
    }

    this.pendingProgressBucket = null;
    this.lastReaderProgressBucket.set(this.currentPaperKey, bucket);
    this.recordPaperActivity(this.currentPaperKey, "progressChangeCount");
    this.createSuggestion({
      kind: bucket >= 3 ? "reading_checkpoint" : "section_checkpoint",
      itemKey: this.currentPaperKey,
      title: bucket >= 3 ? "收束这篇论文的阅读进展" : "总结当前阅读段落",
      reason: `来自阅读进度约 ${Math.min(100, Math.round(ratio * 100))}%`,
      triggerSignature: `progress-bucket:${bucket}`,
      payload: {
        pageIndex: progress.pageIndex,
        pageCount: progress.pageCount,
        progressRatio: ratio,
      },
    });
  }

  private isCurrentProgressPositionStable(
    progress: {
      pageIndex: number;
      pageCount: number;
    },
    now: number,
  ): boolean {
    if (
      this.pendingProgressBucket &&
      this.pendingProgressBucket.itemKey === this.currentPaperKey
    ) {
      return false;
    }
    const pageState = this.currentPaperKey
      ? this.readerPageStates.get(this.currentPaperKey)
      : undefined;
    if (!pageState || pageState.pageIndex !== progress.pageIndex) {
      return false;
    }
    return now - pageState.pageStartedAt >= PROGRESS_BUCKET_STABLE_MS;
  }

  private handlePageDwellSignal(progress: {
    pageIndex: number;
    pageCount: number;
  }): void {
    if (!this.currentPaperKey) {
      return;
    }

    const now = Date.now();
    const existing = this.readerPageStates.get(this.currentPaperKey);
    if (!existing || existing.pageIndex !== progress.pageIndex) {
      this.readerPageStates.set(this.currentPaperKey, {
        pageIndex: progress.pageIndex,
        pageCount: progress.pageCount,
        pageStartedAt: now,
        suggestedDwellKeys: existing?.suggestedDwellKeys || new Set<string>(),
      });
      return;
    }

    if (now - existing.pageStartedAt < PAGE_DWELL_MS) {
      return;
    }

    const dwellKey = `${progress.pageIndex}:${Math.floor(
      existing.pageStartedAt / PAGE_DWELL_MS,
    )}`;
    if (existing.suggestedDwellKeys.has(dwellKey)) {
      return;
    }
    existing.suggestedDwellKeys.add(dwellKey);
    this.recordPaperActivity(this.currentPaperKey, "pageDwellCount");

    const activity = this.paperActivityStates.get(this.currentPaperKey);
    const shouldSuggest =
      (activity?.selectionCount || 0) > 0 ||
      (activity?.highlightCount || 0) > 0 ||
      (activity?.pageDwellCount || 0) >= 2;
    if (!shouldSuggest) {
      return;
    }

    this.createSuggestion({
      kind: "section_checkpoint",
      itemKey: this.currentPaperKey,
      title: "总结当前页面重点",
      reason: `来自第 ${progress.pageIndex + 1} 页的停留`,
      triggerSignature: `page-dwell:${progress.pageIndex}`,
      payload: {
        pageIndex: progress.pageIndex,
        pageCount: progress.pageCount,
        pageDwellMs: now - existing.pageStartedAt,
      },
    });
  }

  private handleReaderClosed(paperKey: string): void {
    if (!this.enabled || !this.currentItemStartedAt) {
      return;
    }

    const now = Date.now();
    const activity = this.paperActivityStates.get(paperKey);
    const activeDurationMs = now - this.currentItemStartedAt;
    const hasMeaningfulActivity =
      activeDurationMs >= CLOSE_CHECKPOINT_MIN_ACTIVITY_MS ||
      (activity?.selectionCount || 0) > 0 ||
      (activity?.highlightCount || 0) > 0 ||
      (activity?.progressChangeCount || 0) > 0 ||
      (activity?.pageDwellCount || 0) > 0 ||
      (activity?.questionSignalCount || 0) > 0;
    if (!hasMeaningfulActivity) {
      return;
    }

    const clearedStaleSelection =
      this.activeSuggestion?.itemKey === paperKey &&
      this.isSelectionSuggestion(this.activeSuggestion.kind);
    if (clearedStaleSelection) {
      this.activeSuggestion = undefined;
    }

    this.createSuggestion({
      kind: "reading_checkpoint",
      itemKey: paperKey,
      title: "生成刚才的阅读 checkpoint",
      reason: "来自刚结束的论文阅读",
      triggerSignature: `reader-close:${this.currentReaderSessionId || now}`,
      payload: {
        activeDurationMs,
        closedAt: now,
        activity,
      },
    });
    if (clearedStaleSelection && !this.activeSuggestion) {
      this.notify();
    }
  }

  private readActiveReaderProgress(): {
    pageIndex: number;
    pageCount: number;
  } | null {
    try {
      const reader = this.getActiveReader();
      const iframeWindow = (reader as any)?._iframeWindow as
        | (Window & {
            PDFViewerApplication?: {
              page?: number;
              pagesCount?: number;
              pdfViewer?: {
                currentPageNumber?: number;
                pagesCount?: number;
              };
            };
          })
        | undefined;
      const pdfApp = iframeWindow?.PDFViewerApplication;
      const pageNumber =
        pdfApp?.pdfViewer?.currentPageNumber || pdfApp?.page || 0;
      const pageCount =
        pdfApp?.pdfViewer?.pagesCount || pdfApp?.pagesCount || 0;
      if (pageNumber < 1 || pageCount < 1) {
        return null;
      }
      return {
        pageIndex: pageNumber - 1,
        pageCount,
      };
    } catch {
      return null;
    }
  }

  private getActiveReader(): any | null {
    try {
      const mainWindow = Zotero.getMainWindow() as Window & {
        Zotero_Tabs?: { selectedID: string };
      };
      const selectedID = mainWindow.Zotero_Tabs?.selectedID;
      return selectedID ? Zotero.Reader?.getByTabID(selectedID) || null : null;
    } catch {
      return null;
    }
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

  private getHighlightStatsForPaper(paperKey: string): HighlightStats {
    const libraryID = Zotero.Libraries.userLibraryID;
    const item = Zotero.Items.getByLibraryAndKey(libraryID, paperKey);
    if (!item) {
      return {
        count: 0,
        lastAnnotationMarker: "",
      };
    }
    let count = 0;
    let lastAnnotationMarker = "";
    const attachmentIDs = item.getAttachments?.() || [];
    for (const attachmentID of attachmentIDs) {
      const attachment = Zotero.Items.get(attachmentID);
      const annotations = attachment?.getAnnotations?.() || [];
      for (const annotation of annotations) {
        const type = String(annotation?.annotationType || "");
        if (type === "highlight" || type === "underline") {
          count++;
          const marker = this.getAnnotationHistoryMarker(annotation);
          if (marker > lastAnnotationMarker) {
            lastAnnotationMarker = marker;
          }
        }
      }
    }
    return {
      count,
      lastAnnotationMarker,
    };
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

  private shouldApplyCreationCooldown(kind: ReadingSuggestionKind): boolean {
    return !this.isSelectionSuggestion(kind);
  }

  private isSelectionSuggestion(kind: ReadingSuggestionKind): boolean {
    return [
      "explain_selection",
      "save_selection_note",
      "explain_visual_context",
      "explain_formula",
      "trace_reference",
    ].includes(kind);
  }

  private isCreationCoolingDown(
    kind: ReadingSuggestionKind,
    kindKey: string,
    now: number,
  ): boolean {
    if (!this.shouldApplyCreationCooldown(kind)) {
      return false;
    }
    const lastCreatedAt = this.lastCreatedByKind.get(kindKey);
    if (typeof lastCreatedAt !== "number") {
      return false;
    }
    return now - lastCreatedAt < SUGGESTION_BADGE_COOLDOWN_MS;
  }

  private getRunningTitle(suggestion: ReadingSuggestion): string {
    switch (suggestion.kind) {
      case "highlight_digest":
        return "正在整理高亮...";
      case "section_checkpoint":
      case "reading_checkpoint":
        return "正在整理阅读进展...";
      case "followup_questions":
        return "正在整理提问线索...";
      case "explain_visual_context":
        return "正在解释图表线索...";
      case "explain_formula":
        return "正在解释公式...";
      case "trace_reference":
        return "正在追踪引用线索...";
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
      case "save_selection_note":
      case "explain_selection":
      case "section_checkpoint":
      case "reading_checkpoint":
      case "followup_questions":
      case "explain_visual_context":
      case "explain_formula":
      case "trace_reference":
      default:
        return "已发送到 PaperChat";
    }
  }

  private clearPendingSelectionSuggestion(nextText: string): void {
    if (
      this.activeSuggestion?.status === "suggested" &&
      this.isSelectionSuggestion(this.activeSuggestion.kind) &&
      this.activeSuggestion.payload?.selectedText !== nextText
    ) {
      this.activeSuggestion = undefined;
      this.lastSelectionText = "";
      this.notify();
    }
  }

  private recordPaperActivity(
    paperKey: string,
    field: keyof Omit<PaperActivityState, "lastActiveAt">,
  ): void {
    const existing =
      this.paperActivityStates.get(paperKey) ||
      this.createEmptyPaperActivityState();
    existing[field] += 1;
    existing.lastActiveAt = Date.now();
    this.paperActivityStates.set(paperKey, existing);
  }

  private beginReaderSession(paperKey: string | null): void {
    this.currentItemStartedAt = paperKey ? Date.now() : 0;
    this.currentReaderSessionId = paperKey
      ? `${paperKey}:${this.currentItemStartedAt}:${++this.readerSessionCounter}`
      : null;
    this.pendingProgressBucket = null;
    if (!paperKey) {
      return;
    }
    this.paperActivityStates.set(
      paperKey,
      this.createEmptyPaperActivityState(),
    );
    this.readerPageStates.delete(paperKey);
    this.lastReaderProgressBucket.delete(paperKey);
  }

  private createEmptyPaperActivityState(): PaperActivityState {
    return {
      selectionCount: 0,
      highlightCount: 0,
      progressChangeCount: 0,
      pageDwellCount: 0,
      questionSignalCount: 0,
      lastActiveAt: Date.now(),
    };
  }

  private getHighlightTriggerSignature(stats: HighlightStats): string {
    return `highlights:${stats.count}:${stats.lastAnnotationMarker || "none"}`;
  }

  private getProgressTriggerSignature(
    progress: { pageIndex: number; pageCount: number } | null,
  ): string {
    if (!progress || progress.pageCount <= 0) {
      return "paper";
    }
    const ratio = (progress.pageIndex + 1) / progress.pageCount;
    const bucket = Math.floor(ratio * 4);
    return `page:${progress.pageIndex}:bucket:${bucket}`;
  }

  private getAnnotationHistoryMarker(annotation: unknown): string {
    const candidate = annotation as {
      key?: unknown;
      id?: unknown;
      dateModified?: unknown;
      dateAdded?: unknown;
      getField?: (field: string) => unknown;
    };
    const rawDate =
      candidate.dateModified ||
      candidate.dateAdded ||
      candidate.getField?.("dateModified") ||
      candidate.getField?.("dateAdded") ||
      "";
    const parsedDate = Date.parse(String(rawDate));
    const datePart = Number.isFinite(parsedDate)
      ? String(parsedDate).padStart(13, "0")
      : String(rawDate);
    return `${datePart}:${String(candidate.key || candidate.id || "")}`;
  }

  private hashText(text: string): string {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
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
