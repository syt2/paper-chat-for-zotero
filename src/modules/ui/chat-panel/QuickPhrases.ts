/**
 * Quick phrases: user-managed prompt snippets offered next to the composer.
 *
 * The list lives in a single prefs string so it survives restarts, and stays
 * free of DOM access so the rules can be unit-tested.
 */

import { getString } from "../../../utils/locale";
import { getPref, setPref } from "../../../utils/prefs";

export const MAX_QUICK_PHRASES = 10;

/**
 * Presets handed to a fresh install. They are ordinary entries afterwards: the
 * user may edit or delete them and nothing restores them automatically.
 */
export function defaultQuickPhrases(): string[] {
  return [
    getString("chat-quick-phrases-preset-summarize"),
    getString("chat-quick-phrases-preset-contributions"),
    getString("chat-quick-phrases-preset-limitations"),
  ];
}

/** Trim, drop empties and duplicates, and bound the list to the limit. */
export function sanitizeQuickPhrases(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const phrase = entry.trim();
    if (!phrase || seen.has(phrase)) continue;
    seen.add(phrase);
    phrases.push(phrase);
    if (phrases.length >= MAX_QUICK_PHRASES) break;
  }
  return phrases;
}

export function canAddQuickPhrase(list: readonly string[]): boolean {
  return list.length < MAX_QUICK_PHRASES;
}

/** Append a phrase, ignoring blanks, duplicates, and a full list. */
export function addQuickPhrase(
  list: readonly string[],
  phrase: string,
): string[] {
  const trimmed = phrase.trim();
  if (!trimmed || !canAddQuickPhrase(list) || list.includes(trimmed)) {
    return [...list];
  }
  return [...list, trimmed];
}

export function removeQuickPhrase(
  list: readonly string[],
  index: number,
): string[] {
  if (!Number.isInteger(index) || index < 0 || index >= list.length) {
    return [...list];
  }
  return list.filter((_, position) => position !== index);
}

/** Extend whatever the composer already holds rather than replacing it. */
export function appendQuickPhraseToDraft(
  draft: string,
  phrase: string,
): string {
  const trimmed = phrase.trim();
  if (!trimmed) return draft;
  const existing = draft.trim();
  return existing ? `${existing}\n${trimmed}` : trimmed;
}

/**
 * Read the stored phrases and seed the presets the first time. An empty list is
 * stored as `[]`, which is distinct from the unset pref, so deleting every
 * phrase does not bring the presets back.
 */
export function loadQuickPhrases(): string[] {
  const raw = getPref("quickPhrases");
  if (!raw) {
    const seeded = defaultQuickPhrases();
    saveQuickPhrases(seeded);
    return seeded;
  }
  try {
    return sanitizeQuickPhrases(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveQuickPhrases(list: readonly string[]): void {
  setPref("quickPhrases", JSON.stringify(sanitizeQuickPhrases(list)));
}
