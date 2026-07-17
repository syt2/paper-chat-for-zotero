export const INITIAL_SEARCH_BACKFILL_BATCH_SIZE = 25;
export const MIN_SEARCH_BACKFILL_BATCH_SIZE = 1;
export const MAX_SEARCH_BACKFILL_BATCH_SIZE = 100;

export interface SearchBackfillSliceTiming {
  totalMs: number;
  transactionMs: number;
}

export function adaptSearchBackfillBatchSize(
  current: number,
  timing: SearchBackfillSliceTiming,
): number {
  const boundedCurrent = Math.max(
    MIN_SEARCH_BACKFILL_BATCH_SIZE,
    Math.min(MAX_SEARCH_BACKFILL_BATCH_SIZE, Math.floor(current)),
  );
  if (timing.totalMs > 16 || timing.transactionMs > 16) {
    return Math.max(
      MIN_SEARCH_BACKFILL_BATCH_SIZE,
      Math.floor(boundedCurrent / 2),
    );
  }
  if (timing.totalMs <= 8 && timing.transactionMs <= 8) {
    return Math.min(
      MAX_SEARCH_BACKFILL_BATCH_SIZE,
      Math.max(boundedCurrent + 1, Math.ceil(boundedCurrent * 1.5)),
    );
  }
  return boundedCurrent;
}

export interface MessageProjectionSource {
  id: string;
  role: string;
  content: string;
  selectedText?: string | null;
  toolCalls?: string | null;
  toolCallId?: string | null;
  streamingState?: string | null;
  apiOnly?: boolean | number | null;
  isSystemNotice?: boolean | number | null;
}

export function createMessageProjectionSignature(
  source: MessageProjectionSource,
): string {
  return JSON.stringify([
    source.id,
    source.role,
    source.content,
    source.selectedText ?? null,
    source.toolCalls ?? null,
    source.toolCallId ?? null,
    source.streamingState ?? null,
    source.apiOnly ? 1 : 0,
    source.isSystemNotice ? 1 : 0,
  ]);
}

export function createTitleProjectionSignature(
  id: string,
  title: string | null | undefined,
): string {
  return JSON.stringify([id, title ?? null]);
}
