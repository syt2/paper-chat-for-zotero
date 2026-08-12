function normalizeItemKey(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve the paper for a presentation request without broadening the context
 * rules used by the rest of PaperChat. Explicit tool arguments and the
 * session-bound paper remain authoritative. The Zotero library selection is a
 * last-resort convenience for the normal "为这篇论文生成一个 PPT" flow, where
 * the model is allowed to call presentation with an empty object.
 */
export function resolvePresentationSourceItemKey(
  requestedItemKey: unknown,
  sessionItemKey?: string | null,
): string | undefined {
  const explicit = normalizeItemKey(requestedItemKey);
  if (explicit) return explicit;

  const session = normalizeItemKey(sessionItemKey);
  if (session) return session;

  try {
    const selected = Array.from(
      (Zotero.getActiveZoteroPane()?.getSelectedItems() as
        | Zotero.Item[]
        | undefined) || [],
    );
    if (selected.length !== 1) return undefined;
    return normalizeItemKey(selected[0]?.key);
  } catch {
    // The pane is not available during early startup and Node-based tests.
    return undefined;
  }
}
