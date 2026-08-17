function normalizeItemKey(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface PresentationMentionSource {
  itemKey: string;
  libraryID?: number;
  title?: string;
}

const PRESENTATION_RETRY_REQUEST_PATTERN =
  /(?:^|[\s,，。.!！?？])(?:重试(?:一下|下)?|再试(?:一次|一下|下)?|重新(?:生成|制作|导出)|retry|try again|again)(?:$|[\s,，。.!！?？])/i;

/**
 * Extract only the machine-authored Zotero mention markers from user text.
 * This is metadata parsing, not natural-language intent detection. It lets a
 * model or a fallback launcher preserve the exact library selected in the UI.
 * Both the current library-aware format and the legacy key-only format are
 * accepted for old chat history.
 */
export function extractPresentationMentionSources(
  text: string | null | undefined,
): PresentationMentionSource[] {
  if (!text) return [];
  const sources: PresentationMentionSource[] = [];
  const mentionRegex = /@\[([^\]]*)\]\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(text)) !== null) {
    const metadata = match[2];
    const key = /(?:^|,)\s*key:([^,\s)]+)/i.exec(metadata)?.[1]?.trim();
    if (!key) continue;
    const rawLibraryID = /(?:^|,)\s*library:(\d+)/i.exec(metadata)?.[1];
    const libraryID = rawLibraryID ? Number(rawLibraryID) : undefined;
    sources.push({
      itemKey: key,
      ...(Number.isSafeInteger(libraryID) && libraryID! > 0
        ? { libraryID }
        : {}),
      title: match[1]?.trim() || undefined,
    });
  }
  return sources;
}

/**
 * Recover an explicit paper marker for a short cross-turn retry. A new user
 * message such as “重试下” contains no marker of its own, so keep the last
 * machine-authored mention available to the guarded launcher. This does not
 * infer a paper from an ordinary @word or from natural-language title text.
 */
export function extractPresentationRetrySources(
  text: string | null | undefined,
  messages: readonly {
    role?: string;
    content?: string | null;
  }[] = [],
): PresentationMentionSource[] {
  const direct = extractPresentationMentionSources(text);
  if (
    direct.length > 0 ||
    !PRESENTATION_RETRY_REQUEST_PATTERN.test(text || "")
  ) {
    return direct;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const sources = extractPresentationMentionSources(message.content);
    if (sources.length > 0) return sources;
  }
  return [];
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
  const session = normalizeItemKey(sessionItemKey);
  if (session) return session;

  const explicit = normalizeItemKey(requestedItemKey);
  if (explicit) return explicit;

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
