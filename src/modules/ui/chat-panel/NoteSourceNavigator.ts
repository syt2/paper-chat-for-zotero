const ZOTERO_ITEM_KEY_PATTERN = /^[A-Z0-9]{8}$/;

export function normalizeNoteSourceKey(key: string | undefined): string | null {
  const normalized = key?.trim().toUpperCase();
  return normalized && ZOTERO_ITEM_KEY_PATTERN.test(normalized)
    ? normalized
    : null;
}

export async function openNoteSource(noteKey: string): Promise<void> {
  const libraryID = Zotero.Libraries.userLibraryID;
  const note = Zotero.Items.getByLibraryAndKey(libraryID, noteKey);
  if (!note || !note.isNote?.()) {
    throw new Error(`Note with key "${noteKey}" was not found.`);
  }

  const pane = Zotero.getActiveZoteroPane();
  if (!pane) {
    throw new Error("The Zotero library pane is not available.");
  }

  await Promise.resolve(pane.selectItem(note.id));
  Zotero.getMainWindow()?.focus?.();
}
