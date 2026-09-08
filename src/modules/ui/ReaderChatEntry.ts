/**
 * ReaderChatEntry - PaperChat entry points inside the PDF reader.
 *
 * Two surfaces:
 * - a compact PaperChat icon next to the highlighted passage inside PDF.js.
 *   It is independent of Zotero's native text-selection popup.
 * - createAnnotationContextMenu: a menu entry on saved annotations that sends
 *   the annotation text (and its comment) to the chat panel.
 *
 * The selection entry expands into attachment and streaming translation actions.
 * Annotation menu entries attach their passage directly to the chat panel.
 *
 * Reader listeners are registered globally per addonRef (not per window), so
 * registration is idempotent and torn down at shutdown.
 */

import { config } from "../../../package.json";
import { showReaderSelectionTranslation } from "./ReaderSelectionTranslation";
import { getString } from "../../utils/locale";
import { showPanelWithSelectedText } from "./chat-panel";
import type { ChatPanelOpenSource } from "./chat-panel/ChatPanelManager";
import { cancelReaderFigureScreenshot } from "./ReaderFigureScreenshot";
import {
  collectAnnotationText,
  FLOATING_SELECTION_ENTRY_SIZE,
  getSelectionEntryRefreshAction,
  getSelectionEntryRect,
  getSelectionEntryPosition,
  isSelectionEntryTextEligible,
  type ReaderLike,
  type SelectionRect,
} from "./reader-chat-selection";

type AnnotationMenuEvent = {
  params: { ids?: string[] };
  append: (options: { label: string; onCommand: () => void }) => void;
  reader: ReaderLike;
};

type SelectionPopupEvent = {
  doc: Document;
  params: {
    annotation?: {
      text?: string;
      position?: PdfAnnotationPosition;
    };
  };
  reader: ReaderLike;
};

type PdfAnnotationPosition = {
  pageIndex: number;
  rects?: number[][];
  nextPageRects?: number[][];
};

let annotationMenuHandler: ((event: AnnotationMenuEvent) => void) | undefined;
let selectionPopupHandler: ((event: SelectionPopupEvent) => void) | undefined;
let readerWatchTimer: ReturnType<typeof setInterval> | undefined;
let watchedPdfDocument: Document | undefined;
let dismissedSelectionSignature = "";
let selectionRefreshFrame: number | undefined;
let selectionRefreshWindow: Window | undefined;
let lastSelectionPointer:
  | { doc: Document; x: number; y: number; at: number }
  | undefined;

const READER_DOCUMENT_POLL_INTERVAL_MS = 500;
const selectionIconURLs = new Map<string, Promise<string>>();

function getSelectionIconURL(name: string): Promise<string> {
  let pending = selectionIconURLs.get(name);
  if (!pending) {
    pending = Zotero.File.getContentsFromURLAsync(
      `chrome://${config.addonRef}/content/icons/${name}.svg`,
    ).then((svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`);
    selectionIconURLs.set(name, pending);
    void pending.catch(() => selectionIconURLs.delete(name));
  }
  return pending;
}

type FloatingSelectionEntry = {
  button: HTMLElement;
  expanded: boolean;
  dispose?: () => void;
  anchor: SelectionRect;
  doc: Document;
  text: string;
  signature: string;
  source: "selection" | "popup";
};

let floatingSelectionEntry: FloatingSelectionEntry | undefined;
let closeSelectionTranslation: (() => void) | undefined;

type ReaderWithPdfWindow = ReaderLike & {
  _iframeWindow?: Window;
  _internalReader?: {
    _lastView?: {
      _iframeWindow?: Window;
      getClientRectForPopup?: (position: PdfAnnotationPosition) => number[];
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

  entry.dispose?.();
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

  if (
    selection.anchorNode?.parentElement?.closest(
      ".paperchat-selection-translation",
    )
  )
    return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const range = selection.getRangeAt(selection.rangeCount - 1);
  const viewportWidth = doc.defaultView?.innerWidth || 0;
  const viewportHeight = doc.defaultView?.innerHeight || 0;
  const isVisibleRect = (rect: DOMRect, allowCollapsedWidth = false) =>
    (allowCollapsedWidth ? rect.width >= 0 : rect.width > 0) &&
    rect.height > 0 &&
    rect.right >= 0 &&
    rect.left <= viewportWidth &&
    rect.bottom >= 0 &&
    rect.top <= viewportHeight;
  const rects = Array.from(range.getClientRects() || []).filter((rect) =>
    isVisibleRect(rect),
  );
  const rect = getSelectionEntryRect(rects);
  if (!rect) return null;
  return { text, rect };
}

function getPopupSelectionRect(
  event: SelectionPopupEvent,
): { doc: Document; rect: SelectionRect } | null {
  const position = event.params.annotation?.position;
  const view = (event.reader as ReaderWithPdfWindow)._internalReader?._lastView;
  const doc = view?._iframeWindow?.document;
  const getClientRectForPopup = view?.getClientRectForPopup;
  if (!doc) return null;

  const pointer = lastSelectionPointer;
  if (pointer?.doc === doc && Date.now() - pointer.at < 2000) {
    return {
      doc,
      rect: {
        left: pointer.x,
        right: pointer.x,
        top: pointer.y - FLOATING_SELECTION_ENTRY_SIZE / 2,
        height: FLOATING_SELECTION_ENTRY_SIZE,
      },
    };
  }
  if (!position || !getClientRectForPopup) return null;

  const rects: SelectionRect[] = [];
  const addRects = (pageIndex: number, sourceRects: number[][] | undefined) => {
    for (const sourceRect of sourceRects || []) {
      const rawRect = getClientRectForPopup.call(view, {
        pageIndex,
        rects: [sourceRect],
      });
      if (!Array.isArray(rawRect) || rawRect.length < 4) continue;
      const [left, top, right, bottom] = rawRect.map(Number);
      if (
        ![left, top, right, bottom].every(Number.isFinite) ||
        right <= left ||
        bottom <= top
      ) {
        continue;
      }
      rects.push({ left, right, top, height: bottom - top });
    }
  };
  addRects(position.pageIndex, position.rects);
  addRects(position.pageIndex + 1, position.nextPageRects);

  const rect = getSelectionEntryRect(rects);
  return rect ? { doc, rect } : null;
}

function getPdfSelectionDocument(reader: ReaderLike): Document | null {
  const readerWithPdfWindow = reader as ReaderWithPdfWindow;
  const documents = [
    readerWithPdfWindow._internalReader?._lastView?._iframeWindow?.document,
    readerWithPdfWindow._iframeWindow?.document,
  ].filter(
    (doc, index, all): doc is Document => !!doc && all.indexOf(doc) === index,
  );

  const hasSelection = (doc: Document): boolean => {
    try {
      return !!doc.getSelection()?.toString().trim();
    } catch {
      return false;
    }
  };
  const focusedSelection = documents.find(
    (doc) => doc.defaultView?.document.hasFocus() && hasSelection(doc),
  );
  if (focusedSelection) return focusedSelection;
  const activeSelection = documents.find(hasSelection);
  if (activeSelection) return activeSelection;

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

  entry.anchor = selection.rect;
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
  entry.button.style.left = `${Math.max(0, Math.min(position.left, win.innerWidth - (entry.expanded ? 74 : FLOATING_SELECTION_ENTRY_SIZE)))}px`;
  entry.button.style.top = `${position.top}px`;
}

function showFloatingSelectionEntry(
  doc: Document,
  selection = getSelectionRect(doc),
  source: FloatingSelectionEntry["source"] = "selection",
): void {
  if (
    !selection ||
    !isSelectionEntryTextEligible(selection.text) ||
    !doc.body
  ) {
    removeFloatingSelectionEntry();
    return;
  }

  if (
    floatingSelectionEntry?.doc === doc &&
    floatingSelectionEntry.expanded &&
    floatingSelectionEntry.text === selection.text
  )
    return;
  removeFloatingSelectionEntry();
  const button = doc.createElement("div");
  button.className = "paperchat-selection-entry";
  const dark = doc.defaultView?.matchMedia(
    "(prefers-color-scheme: dark)",
  )?.matches;
  const reducedMotion = doc.defaultView?.matchMedia(
    "(prefers-reduced-motion: reduce)",
  )?.matches;
  Object.assign(button.style, {
    display: "flex",
    alignItems: "center",
    position: "fixed",
    zIndex: "1001",
    width: `${FLOATING_SELECTION_ENTRY_SIZE}px`,
    height: "24px",
    borderRadius: "12px",
    background: dark ? "#303035" : "#fff",
    border: "1px solid rgba(128,128,140,.3)",
    boxShadow: "0 1px 4px rgba(0,0,0,.12)",
    color: dark ? "#eee" : "#333",
    boxSizing: "border-box",
    overflow: "hidden",
    pointerEvents: "auto",
    transition: reducedMotion ? "none" : "width 180ms ease, left 180ms ease",
  });
  const makeButton = (label: string, width: number) => {
    const control = doc.createElement("button");
    control.type = "button";
    control.title = label;
    control.setAttribute("aria-label", label);
    Object.assign(control.style, {
      flex: `0 0 ${width}px`,
      width: `${width}px`,
      height: "22px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      border: "0",
      padding: "0",
      background: "transparent",
      color: "inherit",
      cursor: "pointer",
      font: "12px system-ui, sans-serif",
      borderRadius: "6px",
    });
    return control;
  };
  const toggle = makeButton(getString("chat-reader-selection-menu"), 16);
  toggle.textContent = "?";
  toggle.setAttribute("aria-expanded", "false");
  const setIcon = (control: HTMLButtonElement, name: string) => {
    const icon = doc.createElement("img");
    // The PDF content principal cannot load privileged chrome images directly.
    void getSelectionIconURL(name)
      .then((url) => {
        icon.src = url;
      })
      .catch((error) =>
        ztoolkit.log("[ReaderChatEntry] Icon load failed:", error),
      );
    icon.alt = "";
    icon.draggable = false;
    Object.assign(icon.style, {
      width: "16px",
      height: "16px",
      pointerEvents: "none",
    });
    control.append(icon);
  };
  const attach = makeButton(
    getString("chat-reader-open-selection-tooltip"),
    28,
  );
  setIcon(attach, "send");
  const translate = makeButton(getString("chat-reader-translate"), 28);
  setIcon(translate, "translate");
  attach.hidden = translate.hidden = true;
  // Inline display is explicit so the PDF reader's styles cannot override hidden.
  attach.style.display = translate.style.display = "none";
  const entry: FloatingSelectionEntry = {
    button,
    doc,
    expanded: false,
    anchor: selection.rect,
    text: selection.text,
    signature: getSelectionSignature(selection),
    source,
  };
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", (event) => event.stopPropagation());
  const activate = (control: HTMLButtonElement, action: () => void) => {
    control.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    control.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Pointer clicks already ran before PDF.js could clear its range.
      // Keyboard and accessibility activation use detail === 0.
      if (event.detail > 0) return;
      action();
    });
  };
  const setExpanded = (expanded: boolean) => {
    if (entry.expanded === expanded) return;
    entry.expanded = expanded;
    toggle.setAttribute("aria-expanded", String(entry.expanded));
    attach.hidden = translate.hidden = !entry.expanded;
    attach.style.display = translate.style.display = entry.expanded
      ? "flex"
      : "none";
    button.style.width = entry.expanded
      ? "74px"
      : `${FLOATING_SELECTION_ENTRY_SIZE}px`;
    positionFloatingSelectionEntry(entry, {
      text: entry.text,
      rect: entry.anchor,
    });
  };
  // Watch the whole menu so moving between its controls does not collapse it.
  button.addEventListener("mouseenter", () => setExpanded(true));
  button.addEventListener("mouseleave", () => setExpanded(false));
  // Preserve keyboard/touch activation without toggling a hovered menu closed.
  activate(toggle, () => setExpanded(true));
  const dismiss = () => {
    dismissedSelectionSignature = entry.signature;
    removeFloatingSelectionEntry();
  };
  activate(attach, () => {
    dismiss();
    openChatWithSelection(entry.text, "reader_selection");
  });
  activate(translate, () => {
    dismiss();
    closeSelectionTranslation?.();
    closeSelectionTranslation = showReaderSelectionTranslation(
      doc,
      entry.text,
      entry.anchor,
    );
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }
  });
  const outside = (event: Event) => {
    if (entry.expanded && !button.contains(event.target as Node)) dismiss();
  };
  doc.addEventListener("pointerdown", outside, true);
  entry.dispose = () => doc.removeEventListener("pointerdown", outside, true);
  button.append(toggle, attach, translate);
  doc.body.appendChild(button);
  floatingSelectionEntry = entry;
  positionFloatingSelectionEntry(entry, selection);
}

function refreshFloatingSelectionEntry(doc: Document): void {
  const selection = getSelectionRect(doc);
  if (
    !selection &&
    floatingSelectionEntry?.doc === doc &&
    floatingSelectionEntry.expanded
  )
    return;
  if (!selection || !isSelectionEntryTextEligible(selection.text)) {
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
    if (entry.source === "popup") {
      return;
    }
    // Zotero may replace the native range while opening its annotation
    // palette. Do not move an entry captured for a different visible passage
    // until that passage is explicitly reselected.
    if (
      getSelectionEntryRefreshAction(entry.text, selection.text) ===
      "reposition"
    ) {
      positionFloatingSelectionEntry(entry, selection);
      return;
    }
    removeFloatingSelectionEntry();
    showFloatingSelectionEntry(doc, selection);
    return;
  }

  removeFloatingSelectionEntry();
  showFloatingSelectionEntry(doc, selection);
}

export function watchActivePdfSelection(): void {
  const doc = getActivePdfSelectionDocument();
  if (doc === watchedPdfDocument) {
    return;
  }

  cancelReaderFigureScreenshot();
  closeSelectionTranslation?.();
  closeSelectionTranslation = undefined;
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
    watchedPdfDocument.removeEventListener(
      "pointerup",
      handlePdfPointerUp,
      true,
    );
  }
  watchedPdfDocument = doc || undefined;
  dismissedSelectionSignature = "";
  removeFloatingSelectionEntry();
  if (!doc) return;

  doc.addEventListener("selectionchange", handlePdfSelectionChange);
  doc.addEventListener("scroll", handlePdfSelectionChange, true);
  doc.addEventListener("pointerup", handlePdfPointerUp, true);
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

function handlePdfPointerUp(event: PointerEvent): void {
  const doc = watchedPdfDocument;
  if (
    !doc ||
    !Number.isFinite(event.clientX) ||
    !Number.isFinite(event.clientY)
  ) {
    return;
  }
  lastSelectionPointer = {
    doc,
    x: event.clientX,
    y: event.clientY,
    at: Date.now(),
  };
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

  selectionPopupHandler = (event: SelectionPopupEvent) => {
    const text = event.params?.annotation?.text?.trim();
    if (!text || !isSelectionEntryTextEligible(text)) return;
    const popupSelection = getPopupSelectionRect(event);
    if (popupSelection) {
      showFloatingSelectionEntry(
        popupSelection.doc,
        { rect: popupSelection.rect, text },
        "popup",
      );
      return;
    }
    const doc = getPdfSelectionDocument(event.reader);
    const selection = doc ? getSelectionRect(doc) : null;
    if (doc && selection) showFloatingSelectionEntry(doc, selection, "popup");
  };

  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    selectionPopupHandler as never,
    addon.data.config.addonRef,
  );

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
  closeSelectionTranslation?.();
  closeSelectionTranslation = undefined;
  cancelReaderFigureScreenshot();
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
    watchedPdfDocument.removeEventListener(
      "pointerup",
      handlePdfPointerUp,
      true,
    );
    watchedPdfDocument = undefined;
  }
  lastSelectionPointer = undefined;
  dismissedSelectionSignature = "";
  if (!Zotero.Reader?.unregisterEventListener) {
    annotationMenuHandler = undefined;
    selectionPopupHandler = undefined;
    return;
  }

  if (selectionPopupHandler) {
    Zotero.Reader.unregisterEventListener(
      "renderTextSelectionPopup",
      selectionPopupHandler as never,
    );
    selectionPopupHandler = undefined;
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
