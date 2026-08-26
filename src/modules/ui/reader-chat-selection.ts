/**
 * Selection/annotation text assembly for the reader chat entry points.
 *
 * Kept free of UI imports so it can be unit-tested against a stubbed Zotero
 * global; ReaderChatEntry owns the listener registration and panel wiring.
 */

export type ReaderLike = { itemID?: number };

export type SelectionRect = {
  left: number;
  right: number;
  top: number;
  height: number;
};

export const FLOATING_SELECTION_ENTRY_SIZE = 18;
const FLOATING_SELECTION_ENTRY_GAP = 4;
export const MIN_SELECTION_ENTRY_TEXT_LENGTH = 5;

export function isSelectionEntryTextEligible(text: string): boolean {
  return text.trim().length >= MIN_SELECTION_ENTRY_TEXT_LENGTH;
}

export type SelectionEntryRefreshAction = "reposition" | "replace";

/**
 * Keep an entry anchored while the same passage is being reflowed, but replace
 * it as soon as the user selects a different passage. Returning early for a
 * different text leaves the old button stranded beside the previous passage.
 */
export function getSelectionEntryRefreshAction(
  currentText: string,
  nextText: string,
): SelectionEntryRefreshAction {
  return currentText === nextText ? "reposition" : "replace";
}

/**
 * Pick the visually final selected line rather than trusting PDF.js range
 * order. Its range rectangles can be returned in document/DOM order even
 * when the selected text wraps or the selection was dragged backwards.
 */
export function getSelectionEntryRect(
  rects: SelectionRect[],
): SelectionRect | null {
  return rects.reduce<SelectionRect | null>((chosen, rect) => {
    if (!chosen) return rect;
    const verticalDelta = rect.top - chosen.top;
    if (
      verticalDelta > 1 ||
      (Math.abs(verticalDelta) <= 1 && rect.right > chosen.right)
    ) {
      return rect;
    }
    return chosen;
  }, null);
}

/**
 * Position the compact PaperChat entry beside the final visible line of a
 * reader selection. If it would fall off the right edge, place it to the left.
 */
export function getSelectionEntryPosition(
  rect: SelectionRect,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top: number } | null {
  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.right) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.height) ||
    viewportWidth < FLOATING_SELECTION_ENTRY_SIZE ||
    viewportHeight < FLOATING_SELECTION_ENTRY_SIZE
  ) {
    return null;
  }

  const maxLeft = viewportWidth - FLOATING_SELECTION_ENTRY_SIZE;
  const rightSideLeft = rect.right + FLOATING_SELECTION_ENTRY_GAP;
  const left =
    rightSideLeft <= maxLeft
      ? rightSideLeft
      : Math.max(
          0,
          Math.min(
            maxLeft,
            rect.left -
              FLOATING_SELECTION_ENTRY_GAP -
              FLOATING_SELECTION_ENTRY_SIZE,
          ),
        );
  const top = Math.max(
    0,
    Math.min(
      viewportHeight - FLOATING_SELECTION_ENTRY_SIZE,
      rect.top + (rect.height - FLOATING_SELECTION_ENTRY_SIZE) / 2,
    ),
  );
  return { left, top };
}

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
