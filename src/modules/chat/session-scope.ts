/**
 * Session scope - resolving a chat session's scoped paper set.
 *
 * A scope is a list of Zotero item keys (a collection's papers, or a manual
 * multi-item selection) that the model should treat as the working set for
 * the conversation. Kept free of UI/ChatManager imports so it can be unit
 * tested against a stubbed Zotero global.
 */

import { getItemTitleSmart } from "../../utils/common";

/** Cap so a huge collection cannot blow up the system prompt. */
export const MAX_SCOPE_ITEMS = 50;

export interface ScopedPaper {
  key: string;
  title: string;
  year: string;
  firstAuthor: string;
}

export interface SessionScope {
  itemKeys: string[];
  label: string;
  /** True when the source had more papers than MAX_SCOPE_ITEMS. */
  truncated: boolean;
}

function isRegularItem(item: Zotero.Item | false | null): item is Zotero.Item {
  return !!item && !item.isAttachment?.() && !item.isNote?.();
}

/**
 * Build a scope from raw Zotero items, keeping only regular items (no
 * attachments/notes), de-duplicating, and capping the count.
 */
export function buildScopeFromItems(
  items: Array<Zotero.Item | false | null>,
  label: string,
): SessionScope | null {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRegularItem(item) || seen.has(item.key)) {
      continue;
    }
    seen.add(item.key);
    keys.push(item.key);
  }
  if (keys.length === 0) {
    return null;
  }
  return {
    itemKeys: keys.slice(0, MAX_SCOPE_ITEMS),
    label,
    truncated: keys.length > MAX_SCOPE_ITEMS,
  };
}

/**
 * Resolve scoped item keys into display records for the system prompt.
 * Keys that no longer resolve (deleted items) are dropped.
 */
export function resolveScopedPapers(
  itemKeys: readonly string[] | undefined,
): ScopedPaper[] {
  if (!itemKeys?.length) {
    return [];
  }
  const libraryID = Zotero.Libraries.userLibraryID;
  const papers: ScopedPaper[] = [];
  for (const key of itemKeys) {
    const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
    if (!isRegularItem(item)) {
      continue;
    }
    const creators = item.getCreators?.() || [];
    const firstAuthor = creators.length
      ? creators[0].lastName || (creators[0] as { name?: string }).name || ""
      : "";
    papers.push({
      key,
      title: getItemTitleSmart(item),
      year: String(item.getField("year") || ""),
      firstAuthor,
    });
  }
  return papers;
}

/** Render the scoped paper set as a system-prompt block. */
export function formatScopedPapersPrompt(
  papers: readonly ScopedPaper[],
  label: string | undefined,
): string {
  if (!papers.length) {
    return "";
  }
  const lines = papers.map((paper, index) => {
    const meta = [paper.firstAuthor, paper.year].filter(Boolean).join(", ");
    return `${index + 1}. [${paper.key}] ${paper.title}${meta ? ` (${meta})` : ""}`;
  });
  return (
    `\n=== SCOPED PAPERS ===\n` +
    `The user scoped this conversation to ${papers.length} paper(s)${
      label ? ` from "${label}"` : ""
    }. Treat these as the working set: prefer them over library-wide search, ` +
    `and pass their itemKey to PDF and metadata tools.\n` +
    `${lines.join("\n")}\n`
  );
}
