/**
 * Selection/annotation text assembly for the reader chat entry points.
 *
 * Kept free of UI imports so it can be unit-tested against a stubbed Zotero
 * global; ReaderChatEntry owns the listener registration and panel wiring.
 */

export type ReaderLike = { itemID?: number };

/**
 * Collect the text of the annotations a context menu was opened on.
 *
 * Each annotation contributes its highlighted text plus its comment, so the
 * user's own note travels into the chat alongside the passage. Multiple
 * annotations are separated by a horizontal rule.
 */
export function collectAnnotationText(
  reader: ReaderLike,
  ids: string[] | undefined,
): string {
  if (!ids?.length || !reader.itemID) {
    return "";
  }
  const attachment = Zotero.Items.get(reader.itemID);
  if (!attachment) {
    return "";
  }

  const parts: string[] = [];
  for (const key of ids) {
    const annotation = Zotero.Items.getByLibraryAndKey(
      attachment.libraryID,
      key,
    );
    if (!annotation) {
      continue;
    }
    const text = (annotation.annotationText || "").trim();
    const comment = (annotation.annotationComment || "").trim();
    if (text && comment) {
      parts.push(`${text}\n\n(${comment})`);
    } else if (text || comment) {
      parts.push(text || comment);
    }
  }
  return parts.join("\n\n---\n\n");
}
