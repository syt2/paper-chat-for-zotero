import { getPref, setPref } from "../../utils/prefs";
import type {
  ReadingSuggestion,
  ReadingSuggestionKind,
} from "./ReadingLoopTypes";

type ReadingLoopHistoryStatus = "suggested" | "accepted" | "completed";

type ReadingLoopHistoryRecord = {
  itemKey: string;
  kind: ReadingSuggestionKind;
  triggerSignature: string;
  status: ReadingLoopHistoryStatus;
  firstSuggestedAt: number;
  lastUpdatedAt: number;
  acceptedAt?: number;
  completedAt?: number;
  suggestionId?: string;
};

type ReadingLoopHistoryStore = {
  version: 1;
  records: ReadingLoopHistoryRecord[];
};

const MAX_HISTORY_RECORDS = 800;

export class ReadingLoopHistoryRegistry {
  private loaded = false;
  private records = new Map<string, ReadingLoopHistoryRecord>();

  isSuppressed(
    itemKey: string,
    kind: ReadingSuggestionKind,
    triggerSignature: string,
  ): boolean {
    this.ensureLoaded();
    return this.records.has(this.getRecordKey(itemKey, kind, triggerSignature));
  }

  recordStatus(
    suggestion: ReadingSuggestion,
    status: ReadingLoopHistoryStatus,
  ): void {
    const triggerSignature = suggestion.triggerSignature;
    if (!triggerSignature) {
      return;
    }
    this.ensureLoaded();
    const now = Date.now();
    const key = this.getRecordKey(
      suggestion.itemKey,
      suggestion.kind,
      triggerSignature,
    );
    const existing = this.records.get(key);
    const record: ReadingLoopHistoryRecord = {
      itemKey: suggestion.itemKey,
      kind: suggestion.kind,
      triggerSignature,
      status,
      firstSuggestedAt:
        existing?.firstSuggestedAt || suggestion.createdAt || now,
      lastUpdatedAt: now,
      acceptedAt: existing?.acceptedAt,
      completedAt: existing?.completedAt,
      suggestionId: suggestion.id,
    };
    if (status === "accepted") {
      record.acceptedAt = now;
    }
    if (status === "completed") {
      record.acceptedAt = record.acceptedAt || existing?.acceptedAt || now;
      record.completedAt = now;
    }
    this.records.set(key, record);
    this.persist();
  }

  resetMemory(): void {
    this.loaded = false;
    this.records.clear();
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    const raw = this.readPref();
    if (!raw) {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ReadingLoopHistoryStore>;
      if (!Array.isArray(parsed.records)) {
        return;
      }
      for (const rawRecord of parsed.records) {
        const record = this.normalizeRecord(rawRecord);
        if (!record) {
          continue;
        }
        this.records.set(
          this.getRecordKey(
            record.itemKey,
            record.kind,
            record.triggerSignature,
          ),
          record,
        );
      }
    } catch {
      this.records.clear();
    }
  }

  private normalizeRecord(rawRecord: unknown): ReadingLoopHistoryRecord | null {
    const record = rawRecord as Partial<ReadingLoopHistoryRecord>;
    if (
      typeof record.itemKey !== "string" ||
      !record.itemKey ||
      !this.isReadingSuggestionKind(record.kind) ||
      typeof record.triggerSignature !== "string" ||
      !record.triggerSignature
    ) {
      return null;
    }
    const status = this.isHistoryStatus(record.status)
      ? record.status
      : "suggested";
    const firstSuggestedAt =
      typeof record.firstSuggestedAt === "number"
        ? record.firstSuggestedAt
        : Date.now();
    const lastUpdatedAt =
      typeof record.lastUpdatedAt === "number"
        ? record.lastUpdatedAt
        : firstSuggestedAt;
    return {
      itemKey: record.itemKey,
      kind: record.kind,
      triggerSignature: record.triggerSignature,
      status,
      firstSuggestedAt,
      lastUpdatedAt,
      acceptedAt:
        typeof record.acceptedAt === "number" ? record.acceptedAt : undefined,
      completedAt:
        typeof record.completedAt === "number" ? record.completedAt : undefined,
      suggestionId:
        typeof record.suggestionId === "string"
          ? record.suggestionId
          : undefined,
    };
  }

  private persist(): void {
    const records = [...this.records.values()]
      .sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt)
      .slice(0, MAX_HISTORY_RECORDS);
    this.records = new Map(
      records.map((record) => [
        this.getRecordKey(record.itemKey, record.kind, record.triggerSignature),
        record,
      ]),
    );
    const store: ReadingLoopHistoryStore = {
      version: 1,
      records,
    };
    try {
      setPref("readingLoopHistory", JSON.stringify(store));
    } catch {
      // Tests and early startup may not have Zotero prefs available yet.
    }
  }

  private readPref(): string {
    try {
      return (getPref("readingLoopHistory") as string) || "";
    } catch {
      return "";
    }
  }

  private getRecordKey(
    itemKey: string,
    kind: ReadingSuggestionKind,
    triggerSignature: string,
  ): string {
    return [itemKey, kind, triggerSignature].join("\u001f");
  }

  private isHistoryStatus(status: unknown): status is ReadingLoopHistoryStatus {
    return (
      status === "suggested" || status === "accepted" || status === "completed"
    );
  }

  private isReadingSuggestionKind(
    kind: unknown,
  ): kind is ReadingSuggestionKind {
    return (
      kind === "explain_selection" ||
      kind === "save_selection_note" ||
      kind === "highlight_digest" ||
      kind === "explain_visual_context" ||
      kind === "explain_formula" ||
      kind === "trace_reference" ||
      kind === "section_checkpoint" ||
      kind === "reading_checkpoint" ||
      kind === "followup_questions"
    );
  }
}
