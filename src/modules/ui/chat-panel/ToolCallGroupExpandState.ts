/**
 * Persists the expand/collapse state of tool-call groups and keyed cards
 * across streaming re-renders. Only expanded entries are stored; collapsed
 * is the default, so the Map shrinks when users collapse back.
 */

const state = new Map<string, true>();

export function getToolCallGroupExpandKey(
  messageId: string | undefined,
  groupIndex: number,
): string | null {
  return messageId ? `${messageId}#${groupIndex}` : null;
}

export function getToolCallCardExpandKey(
  messageId: string | undefined,
  cardId: string | undefined,
): string | null {
  return messageId && cardId ? `${messageId}#card#${cardId}` : null;
}

export function isToolCallGroupExpanded(key: string | null): boolean {
  return key !== null && state.has(key);
}

export function setToolCallGroupExpanded(
  key: string | null,
  isExpanded: boolean,
): void {
  if (!key) {
    return;
  }
  if (isExpanded) {
    state.set(key, true);
  } else {
    state.delete(key);
  }
}

export function resetToolCallGroupExpandState(): void {
  state.clear();
}

export function getToolCallGroupExpandStateSize(): number {
  return state.size;
}
