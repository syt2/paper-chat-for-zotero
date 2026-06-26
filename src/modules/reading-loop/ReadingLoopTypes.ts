export type ReadingLoopState =
  | "idle"
  | "suggested"
  | "running"
  | "completed"
  | "attention";

export type ReadingSuggestionKind =
  | "explain_selection"
  | "save_selection_note"
  | "highlight_digest"
  | "explain_visual_context"
  | "explain_formula"
  | "trace_reference"
  | "section_checkpoint"
  | "reading_checkpoint"
  | "followup_questions";

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
  triggerSignature?: string;
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
