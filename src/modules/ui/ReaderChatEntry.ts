/**
 * ReaderChatEntry - PaperChat entry points inside the PDF reader.
 *
 * Two surfaces:
 * - a compact PaperChat icon next to the highlighted passage inside PDF.js.
 *   It is independent of Zotero's native text-selection popup.
 * - createAnnotationContextMenu: a menu entry on saved annotations that sends
 *   the annotation text (and its comment) to the chat panel.
 *
 * Both seed the pending selected-text attachment and open the panel, so the
 * user lands in chat with the passage already attached.
 *
 * Reader listeners are registered globally per addonRef (not per window), so
 * registration is idempotent and torn down at shutdown.
 */

import { getString } from "../../utils/locale";
import { showPanelWithSelectedText } from "./chat-panel";
import type { ChatPanelOpenSource } from "./chat-panel/ChatPanelManager";
import {
  collectAnnotationText,
  FLOATING_SELECTION_ENTRY_SIZE,
  getSelectionEntryPosition,
  type ReaderLike,
  type SelectionRect,
} from "./reader-chat-selection";

type AnnotationMenuEvent = {
  params: { ids?: string[] };
  append: (options: { label: string; onCommand: () => void }) => void;
  reader: ReaderLike;
};

let annotationMenuHandler: ((event: AnnotationMenuEvent) => void) | undefined;
let readerWatchTimer: ReturnType<typeof setInterval> | undefined;
let watchedPdfDocument: Document | undefined;
let dismissedSelectionSignature = "";
let selectionRefreshFrame: number | undefined;
let selectionRefreshWindow: Window | undefined;

const READER_DOCUMENT_POLL_INTERVAL_MS = 500;

type FloatingSelectionEntry = {
  button: HTMLButtonElement;
  doc: Document;
  text: string;
  signature: string;
};

let floatingSelectionEntry: FloatingSelectionEntry | undefined;

type ReaderWithPdfWindow = ReaderLike & {
  _iframeWindow?: Window;
  _internalReader?: {
    _lastView?: {
      _iframeWindow?: Window;
    };
  };
};

/** Open the chat panel with `text` already attached as a quoted selection. */
function openChatWithSelection(
  text: string,
  source: ChatPanelOpenSource,
): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  showPanelWithSelectedText(trimmed, source);
}

function removeFloatingSelectionEntry(): void {
  const entry = floatingSelectionEntry;
  floatingSelectionEntry = undefined;
  if (!entry) return;

  entry.button.remove();
}

function cancelScheduledSelectionRefresh(): void {
  if (selectionRefreshFrame !== undefined) {
    selectionRefreshWindow?.cancelAnimationFrame(selectionRefreshFrame);
  }
  selectionRefreshFrame = undefined;
  selectionRefreshWindow = undefined;
}

function getSelectionRect(doc: Document): {
  text: string;
  rect: SelectionRect;
} | null {
  const selection = doc.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const text = selection.toString().trim();
  if (!text) return null;
  const range = selection.getRangeAt(selection.rangeCount - 1);
  const viewportWidth = doc.defaultView?.innerWidth || 0;
  const viewportHeight = doc.defaultView?.innerHeight || 0;
  const rects = Array.from(range.getClientRects() || []).filter(
    (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right >= 0 &&
      rect.left <= viewportWidth &&
      rect.bottom >= 0 &&
      rect.top <= viewportHeight,
  );
  const rect = rects.at(-1);
  if (!rect) return null;
  return { text, rect };
}

function getPdfSelectionDocument(reader: ReaderLike): Document | null {
  const readerWithPdfWindow = reader as ReaderWithPdfWindow;
  const documents = [
    readerWithPdfWindow._internalReader?._lastView?._iframeWindow?.document,
    readerWithPdfWindow._iframeWindow?.document,
  ].filter((doc): doc is Document => !!doc);
  const currentDocument = documents.find(
    (doc) => doc === watchedPdfDocument && !!doc.defaultView,
  );
  if (currentDocument) return currentDocument;
  // A reader can expose both its outer reader frame and the nested PDF.js
  // frame. Only PDF.js owns the text-layer selection we need to observe.
  return (
    documents.find(
      (doc) =>
        !!doc.defaultView &&
        !!doc.querySelector("#viewer, .textLayer, [data-page-number]"),
    ) || null
  );
}

function getActivePdfSelectionDocument(): Document | null {
  try {
    const mainWindow = Zotero.getMainWindow() as Window & {
      Zotero_Tabs?: { selectedID?: string };
    };
    const selectedID = mainWindow.Zotero_Tabs?.selectedID;
    const reader = selectedID ? Zotero.Reader?.getByTabID(selectedID) : null;
    return reader ? getPdfSelectionDocument(reader as ReaderLike) : null;
  } catch {
    return null;
  }
}

function getSelectionSignature(selection: {
  text: string;
  rect: SelectionRect;
}): string {
  const { text, rect } = selection;
  return [text, rect.left, rect.right, rect.top, rect.height].join("|");
}

function positionFloatingSelectionEntry(
  entry: FloatingSelectionEntry,
  selection = getSelectionRect(entry.doc),
): void {
  const win = entry.doc.defaultView;
  if (!selection || !win) {
    removeFloatingSelectionEntry();
    return;
  }

  entry.text = selection.text;
  entry.signature = getSelectionSignature(selection);
  const position = getSelectionEntryPosition(
    selection.rect,
    win.innerWidth,
    win.innerHeight,
  );
  if (!position) {
    removeFloatingSelectionEntry();
    return;
  }
  entry.button.style.left = `${position.left}px`;
  entry.button.style.top = `${position.top}px`;
}

function showFloatingSelectionEntry(
  doc: Document,
  selection = getSelectionRect(doc),
): void {
  if (!selection || !doc.body) {
    removeFloatingSelectionEntry();
    return;
  }

  removeFloatingSelectionEntry();
  const button = doc.createElement("button");
  button.className = "paperchat-selection-entry";
  button.title = getString("chat-reader-open-selection-tooltip");
  button.setAttribute(
    "aria-label",
    getString("chat-reader-open-selection-tooltip"),
  );
  Object.assign(button.style, {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    position: "fixed",
    zIndex: "1000",
    width: `${FLOATING_SELECTION_ENTRY_SIZE}px`,
    height: `${FLOATING_SELECTION_ENTRY_SIZE}px`,
    minWidth: `${FLOATING_SELECTION_ENTRY_SIZE}px`,
    padding: "0",
    borderRadius: "50%",
    background: "#2563eb",
    border: "1px solid rgba(30, 64, 175, 0.8)",
    boxShadow: "0 1px 2px rgba(15, 23, 42, 0.24)",
    color: "#ffffff",
    cursor: "pointer",
    appearance: "none",
    MozAppearance: "none",
    boxSizing: "border-box",
    pointerEvents: "auto",
    fontSize: "12px",
    fontWeight: "700",
    lineHeight: "16px",
    transition: "filter 100ms ease, box-shadow 100ms ease",
  });
  button.textContent = "?";
  const entry: FloatingSelectionEntry = {
    button,
    doc,
    text: selection.text,
    signature: getSelectionSignature(selection),
  };
  let didActivate = false;
  const activateSelection = (event: Event) => {
    if (didActivate) return;
    didActivate = true;
    event.preventDefault();
    event.stopPropagation();
    const text = entry.text;
    dismissedSelectionSignature = entry.signature;
    removeFloatingSelectionEntry();
    openChatWithSelection(text, "reader_selection");
  };
  // PDF.js can clear its range before a click bubbles. Activate on pointerdown
  // while the range is intact, with click as an accessibility fallback.
  button.addEventListener("pointerdown", activateSelection, true);
  button.addEventListener("click", activateSelection, true);
  button.addEventListener("mouseenter", () => {
    button.style.filter = "brightness(1.12)";
  });
  button.addEventListener("mouseleave", () => {
    button.style.filter = "none";
  });
  button.addEventListener("focus", () => {
    button.style.outline = "2px solid rgba(37, 99, 235, 0.45)";
    button.style.outlineOffset = "1px";
  });
  button.addEventListener("blur", () => {
    button.style.outline = "";
    button.style.outlineOffset = "";
  });
  doc.body.appendChild(button);
  floatingSelectionEntry = entry;
  positionFloatingSelectionEntry(entry, selection);
}

function refreshFloatingSelectionEntry(doc: Document): void {
  const selection = getSelectionRect(doc);
  if (!selection) {
    dismissedSelectionSignature = "";
    removeFloatingSelectionEntry();
    return;
  }

  const signature = getSelectionSignature(selection);
  if (signature === dismissedSelectionSignature) {
    return;
  }

  const entry = floatingSelectionEntry;
  if (entry?.doc === doc) {
    positionFloatingSelectionEntry(entry, selection);
    return;
  }

  removeFloatingSelectionEntry();
  showFloatingSelectionEntry(doc, selection);
}

function watchActivePdfSelection(): void {
  const doc = getActivePdfSelectionDocument();
  if (doc === watchedPdfDocument) {
    return;
  }

  cancelScheduledSelectionRefresh();
  if (watchedPdfDocument) {
    watchedPdfDocument.removeEventListener(
      "selectionchange",
      handlePdfSelectionChange,
    );
    watchedPdfDocument.removeEventListener(
      "scroll",
      handlePdfSelectionChange,
      true,
    );
  }
  watchedPdfDocument = doc || undefined;
  dismissedSelectionSignature = "";
  removeFloatingSelectionEntry();
  if (!doc) return;

  doc.addEventListener("selectionchange", handlePdfSelectionChange);
  doc.addEventListener("scroll", handlePdfSelectionChange, true);
  refreshFloatingSelectionEntry(doc);
}

function handlePdfSelectionChange(): void {
  const doc = watchedPdfDocument;
  const win = doc?.defaultView;
  if (!doc || !win || selectionRefreshFrame !== undefined) return;

  selectionRefreshWindow = win;
  selectionRefreshFrame = win.requestAnimationFrame(() => {
    selectionRefreshFrame = undefined;
    selectionRefreshWindow = undefined;
    if (watchedPdfDocument === doc) refreshFloatingSelectionEntry(doc);
  });
}

export function registerReaderChatEntries(): void {
  if (!Zotero.Reader?.registerEventListener) {
    ztoolkit.log(
      "[ReaderChatEntry] Zotero.Reader.registerEventListener not available",
    );
    return;
  }
  if (readerWatchTimer || annotationMenuHandler) {
    return;
  }

  annotationMenuHandler = (event: AnnotationMenuEvent) => {
    const text = collectAnnotationText(event.reader, event.params?.ids);
    if (!text) {
      return;
    }
    event.append({
      label: getString("chat-reader-discuss-annotation"),
      onCommand: () => {
        openChatWithSelection(text, "reader_annotation");
      },
    });
  };

  Zotero.Reader.registerEventListener(
    "createAnnotationContextMenu",
    annotationMenuHandler as never,
    addon.data.config.addonRef,
  );
  watchActivePdfSelection();
  readerWatchTimer = setInterval(
    watchActivePdfSelection,
    READER_DOCUMENT_POLL_INTERVAL_MS,
  );

  ztoolkit.log("[ReaderChatEntry] Reader chat entries registered");
}

export function unregisterReaderChatEntries(): void {
  removeFloatingSelectionEntry();
  cancelScheduledSelectionRefresh();
  if (readerWatchTimer) {
    clearInterval(readerWatchTimer);
    readerWatchTimer = undefined;
  }
  if (watchedPdfDocument) {
    watchedPdfDocument.removeEventListener(
      "selectionchange",
      handlePdfSelectionChange,
    );
    watchedPdfDocument.removeEventListener(
      "scroll",
      handlePdfSelectionChange,
      true,
    );
    watchedPdfDocument = undefined;
  }
  dismissedSelectionSignature = "";
  if (!Zotero.Reader?.unregisterEventListener) {
    annotationMenuHandler = undefined;
    return;
  }

  if (annotationMenuHandler) {
    Zotero.Reader.unregisterEventListener(
      "createAnnotationContextMenu",
      annotationMenuHandler as never,
    );
    annotationMenuHandler = undefined;
  }

  ztoolkit.log("[ReaderChatEntry] Reader chat entries unregistered");
}
