import {
  captureTranslationContext,
  type SelectionTranslationContext,
} from "./SelectionTranslationContext";
/**
 * ReaderChatEntry - PaperChat entry points inside the PDF reader.
 *
 * Two surfaces:
 * - a compact PaperChat icon next to the highlighted passage inside PDF.js.
 *   It is independent of Zotero's native text-selection popup.
 * - createAnnotationContextMenu: a menu entry on saved annotations that sends
 *   the annotation text (and its comment) to the chat panel.
 *
 * The selection entry expands into a comment composer and a streaming
 * translation action.
 * Annotation menu entries attach their passage directly to the chat panel.
 *
 * Reader listeners are registered globally per addonRef (not per window), so
 * registration is idempotent and torn down at shutdown.
 */

import { config } from "../../../package.json";
import { showReaderSelectionTranslation } from "./ReaderSelectionTranslation";
import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import {
  sendCommentSelectionToChat,
  showPanelWithSelectedText,
} from "./chat-panel";
import type { ChatPanelOpenSource } from "./chat-panel/ChatPanelManager";
import { cancelReaderFigureScreenshot } from "./ReaderFigureScreenshot";
import {
  captureSelectionRanges,
  collectAnnotationText,
  FLOATING_SELECTION_ENTRY_DIM_OPACITY,
  FLOATING_SELECTION_ENTRY_SIZE,
  getSelectionEntryRefreshAction,
  getSelectionEntryRect,
  getSelectionEntryExpandedWidth,
  getSelectionEntryPosition,
  isReaderSelectionEntryEnabled,
  isSelectionEntryPointerNear,
  isSelectionEntryTextEligible,
  restoreSelectionRanges,
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
/** Preference value the watched document's listeners were applied for. */
let watchedEntryEnabled: boolean | undefined;
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
  actionCount: number;
  translationContext: SelectionTranslationContext;
  dispose?: () => void;
  closeCommentPopover?: () => void;
  anchor: SelectionRect;
  doc: Document;
  text: string;
  signature: string;
  source: "selection" | "popup";
  /** Set while the translate popover for this entry is open. */
  translating?: boolean;
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

function isSelectionEntryEnabled(): boolean {
  return isReaderSelectionEntryEnabled(getPref("readerSelectionEntryEnabled"));
}

function removeFloatingSelectionEntry(): void {
  const entry = floatingSelectionEntry;
  floatingSelectionEntry = undefined;
  if (!entry) return;

  entry.closeCommentPopover?.();
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
  const width = entry.expanded
    ? getSelectionEntryExpandedWidth(entry.actionCount)
    : FLOATING_SELECTION_ENTRY_SIZE;
  entry.button.style.left = `${Math.max(0, Math.min(position.left, win.innerWidth - width))}px`;
  entry.button.style.top = `${position.top}px`;
}

type SelectionCommentHandlers = {
  onSend: (comment: string) => void;
  onAttach: (comment: string) => void;
  onClose: () => void;
};

/**
 * Open a small composer beside the entry so the user can annotate the passage
 * before it reaches the chat. Send hands the passage and the comment to the
 * panel immediately; attach only stages them in the composer draft.
 */
function showSelectionCommentPopover(
  doc: Document,
  entry: FloatingSelectionEntry,
  commentButton: HTMLElement,
  handlers: SelectionCommentHandlers,
): () => void {
  const frame = doc.defaultView?.frameElement;
  const popoverDoc = frame?.ownerDocument || doc;
  const win = popoverDoc.defaultView;
  if (!win || !popoverDoc.body) {
    return () => {};
  }

  const dark = win.matchMedia("(prefers-color-scheme: dark)")?.matches;
  const panel = popoverDoc.createElement("section");
  panel.className = "paperchat-selection-comment";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", getString("chat-reader-comment"));
  Object.assign(panel.style, {
    position: "fixed",
    zIndex: "2147483647",
    boxSizing: "border-box",
    width: `${Math.max(0, Math.min(300, win.innerWidth - 16))}px`,
    display: "flex",
    flexDirection: "column",
    padding: "4px 6px 6px",
    borderRadius: "10px",
    border: `1px solid ${dark ? "#505055" : "#dedee3"}`,
    background: dark ? "#27272b" : "#fff",
    color: dark ? "#eeeeef" : "#292930",
    boxShadow: "0 4px 18px rgba(0,0,0,.18)",
    font: "13px/1.5 system-ui, sans-serif",
  });

  const input = popoverDoc.createElement("textarea");
  input.rows = 3;
  input.placeholder = getString("chat-reader-comment-placeholder");
  Object.assign(input.style, {
    width: "100%",
    boxSizing: "border-box",
    resize: "none",
    padding: "6px 8px",
    border: "none",
    background: "transparent",
    color: "inherit",
    font: "14px/1.5 system-ui, sans-serif",
    outline: "none",
  });

  // Footer actions follow the chat composer: a plain cancel, a bare icon
  // action for keeping the passage in the draft, and the filled send button
  // that matches the panel's own bubble.
  const actions = popoverDoc.createElement("div");
  Object.assign(actions.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "4px",
    flexShrink: "0",
  });
  const makeTextButton = (label: string) => {
    const control = popoverDoc.createElement("button");
    control.type = "button";
    control.textContent = label;
    control.title = label;
    Object.assign(control.style, {
      border: "none",
      background: "transparent",
      color: dark ? "#a1a1aa" : "#6b7280",
      cursor: "pointer",
      padding: "6px 10px",
      borderRadius: "8px",
      font: "13px system-ui, sans-serif",
    });
    return control;
  };
  const makeIconButton = (label: string, filled: boolean) => {
    const control = popoverDoc.createElement("button");
    control.type = "button";
    control.title = label;
    control.setAttribute("aria-label", label);
    Object.assign(control.style, {
      border: "none",
      background: filled ? (dark ? "#283b52" : "#eaf2fc") : "transparent",
      color: dark ? "#e1ebf7" : "#263b53",
      cursor: "pointer",
      width: "28px",
      height: "28px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: "999px",
      padding: "0",
      flexShrink: "0",
    });
    return control;
  };
  const setIcon = (control: HTMLElement, name: string) => {
    const icon = popoverDoc.createElement("img");
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
  const cancelButton = makeTextButton(getString("chat-reader-comment-cancel"));
  const attachButton = makeIconButton(
    getString("chat-reader-comment-attach"),
    false,
  );
  setIcon(attachButton, "pushpin");
  const sendButton = makeIconButton(
    getString("chat-reader-comment-send"),
    true,
  );
  setIcon(sendButton, "send");
  actions.append(cancelButton, attachButton, sendButton);
  panel.append(input, actions);
  popoverDoc.body.append(panel);

  let disposed = false;
  // This composer lives in the reader document, so focusing it takes document
  // focus away from the PDF. The engine then clears the text-layer selection a
  // tick later, after any synchronous write-back, so capture the ranges first
  // and put them back the moment that clearing lands.
  const selectionRanges = captureSelectionRanges(doc.getSelection());
  const restoreSelectionAfterClear = () => {
    const selection = doc.getSelection();
    if (disposed || !selection || selection.rangeCount > 0) return;
    doc.removeEventListener("selectionchange", restoreSelectionAfterClear);
    restoreSelectionRanges(selection, selectionRanges);
  };
  const place = () => {
    const width = panel.getBoundingClientRect().width;
    const height = panel.getBoundingClientRect().height;
    const frameRect = frame?.getBoundingClientRect();
    const left = entry.anchor.left + (frameRect?.left || 0);
    const top = entry.anchor.top + (frameRect?.top || 0);
    const below = top + entry.anchor.height + 8;
    panel.style.left = `${Math.max(8, Math.min(left, win.innerWidth - width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(below + height <= win.innerHeight - 8 ? below : top - height - 8, win.innerHeight - height - 8))}px`;
  };
  place();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    panel.remove();
    popoverDoc.removeEventListener("pointerdown", outside, true);
    popoverDoc.removeEventListener("keydown", keydown, true);
    doc.removeEventListener("pointerdown", outside, true);
    doc.removeEventListener("keydown", keydown, true);
    doc.defaultView?.removeEventListener("pagehide", dispose);
    win.removeEventListener("pagehide", dispose);
    win.removeEventListener("resize", place);
    doc.removeEventListener("selectionchange", restoreSelectionAfterClear);
    handlers.onClose();
  };
  const outside = (event: Event) => {
    const target = event.target as Node | null;
    // The comment button toggles this popover closed, so dismissing here would
    // just reopen it and throw away whatever the user had typed.
    if (target && (panel.contains(target) || commentButton.contains(target))) {
      return;
    }
    dispose();
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dispose();
      return;
    }
    // Enter sends, Shift+Enter keeps the newline; the mention-free composer
    // mirrors the chat panel's own composer behavior.
    if (event.key === "Enter" && !event.shiftKey && event.target === input) {
      event.preventDefault();
      event.stopPropagation();
      const comment = input.value;
      dispose();
      handlers.onSend(comment);
    }
  };
  panel.addEventListener("pointerdown", (event) => event.stopPropagation());
  cancelButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dispose();
  });
  attachButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const comment = input.value;
    dispose();
    handlers.onAttach(comment);
  });
  sendButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const comment = input.value;
    dispose();
    handlers.onSend(comment);
  });
  popoverDoc.addEventListener("pointerdown", outside, true);
  popoverDoc.addEventListener("keydown", keydown, true);
  doc.addEventListener("pointerdown", outside, true);
  doc.addEventListener("keydown", keydown, true);
  doc.defaultView?.addEventListener("pagehide", dispose);
  win.addEventListener("pagehide", dispose);
  win.addEventListener("resize", place);
  if (selectionRanges.length > 0) {
    doc.addEventListener("selectionchange", restoreSelectionAfterClear);
  }
  input.focus();
  return dispose;
}

function showFloatingSelectionEntry(
  doc: Document,
  selection = getSelectionRect(doc),
  source: FloatingSelectionEntry["source"] = "selection",
): void {
  if (
    !selection ||
    !isSelectionEntryTextEligible(selection.text) ||
    !doc.body ||
    !isSelectionEntryEnabled()
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
    opacity: String(FLOATING_SELECTION_ENTRY_DIM_OPACITY),
    pointerEvents: "auto",
    transition: reducedMotion
      ? "none"
      : "width 180ms ease, left 180ms ease, opacity 120ms ease",
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
  const comment = makeButton(getString("chat-reader-comment"), 28);
  setIcon(comment, "comment");
  const translate = makeButton(getString("chat-reader-translate"), 28);
  setIcon(translate, "translate");
  comment.hidden = translate.hidden = true;
  // Inline display is explicit so the PDF reader's styles cannot override hidden.
  comment.style.display = translate.style.display = "none";
  let paperTitle: string | undefined;
  try {
    const tabs = (
      Zotero.getMainWindow() as Window & {
        Zotero_Tabs?: { selectedID?: string };
      }
    ).Zotero_Tabs;
    const reader = tabs?.selectedID
      ? Zotero.Reader.getByTabID(tabs.selectedID)
      : null;
    if (reader?.itemID && getPdfSelectionDocument(reader) === doc) {
      const attachment = Zotero.Items.get(reader.itemID);
      const paper = attachment?.parentID
        ? Zotero.Items.get(attachment.parentID)
        : attachment;
      paperTitle = String(paper?.getField("title") || "");
    }
  } catch {
    /* Translation still works without bibliographic context. */
  }
  const entry: FloatingSelectionEntry = {
    button,
    doc,
    expanded: false,
    actionCount: 2,
    translationContext: captureTranslationContext(
      doc,
      selection.text,
      paperTitle,
    ),
    anchor: selection.rect,
    text: selection.text,
    signature: getSelectionSignature(selection),
    source,
  };
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  // Gecko focuses a clicked button on mousedown, which pulls focus back into
  // the PDF and drops the text-layer selection. The pill handles its own
  // activation, so it never needs focus of its own.
  const keepPointerFocus = (event: Event) => event.preventDefault();
  button.addEventListener("mousedown", keepPointerFocus);
  button.addEventListener("click", (event) => event.stopPropagation());
  const activate = (control: HTMLButtonElement, action: () => void) => {
    control.addEventListener("mousedown", keepPointerFocus);
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
    comment.hidden = translate.hidden = !entry.expanded;
    comment.style.display = translate.style.display = entry.expanded
      ? "flex"
      : "none";
    button.style.width = entry.expanded
      ? `${getSelectionEntryExpandedWidth(entry.actionCount)}px`
      : `${FLOATING_SELECTION_ENTRY_SIZE}px`;
    positionFloatingSelectionEntry(entry, {
      text: entry.text,
      rect: entry.anchor,
    });
  };
  // Watch the whole menu so moving between its controls does not collapse it.
  button.addEventListener("mouseenter", () => setExpanded(true));
  button.addEventListener("mouseleave", () => setExpanded(false));
  let currentOpacity = FLOATING_SELECTION_ENTRY_DIM_OPACITY;
  const setOpacityForPointer = (pointerX?: number, pointerY?: number) => {
    let nextOpacity = FLOATING_SELECTION_ENTRY_DIM_OPACITY;
    if (pointerX !== undefined && pointerY !== undefined) {
      const rect = button.getBoundingClientRect();
      if (
        isSelectionEntryPointerNear(
          {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            height: rect.height,
          },
          pointerX,
          pointerY,
        )
      ) {
        nextOpacity = 1;
      }
    }
    if (nextOpacity === currentOpacity) return;
    currentOpacity = nextOpacity;
    button.style.opacity = String(nextOpacity);
  };
  const handlePointerMove = (event: PointerEvent) => {
    setOpacityForPointer(event.clientX, event.clientY);
  };
  const handlePointerLeave = () => setOpacityForPointer();
  doc.addEventListener("pointermove", handlePointerMove, true);
  doc.documentElement.addEventListener("pointerleave", handlePointerLeave);
  // Preserve keyboard/touch activation without toggling a hovered menu closed.
  activate(toggle, () => setExpanded(true));
  const dismiss = () => {
    entry.closeCommentPopover?.();
    dismissedSelectionSignature = entry.signature;
    removeFloatingSelectionEntry();
  };
  activate(comment, () => {
    if (entry.closeCommentPopover) {
      entry.closeCommentPopover();
      return;
    }
    entry.closeCommentPopover = showSelectionCommentPopover(
      doc,
      entry,
      comment,
      {
        onClose: () => {
          entry.closeCommentPopover = undefined;
        },
        onSend: (text) => {
          dismiss();
          sendCommentSelectionToChat(entry.text, text, true);
        },
        onAttach: (text) => {
          dismiss();
          sendCommentSelectionToChat(entry.text, text, false);
        },
      },
    );
  });
  activate(translate, () => {
    closeSelectionTranslation?.();
    // Translation is a read-only side panel, so the entry stays put: the user
    // can still comment, pin, or translate again without reselecting.
    entry.translating = true;
    setExpanded(true);
    closeSelectionTranslation = showReaderSelectionTranslation(
      doc,
      entry.text,
      entry.anchor,
      entry.translationContext,
      () => {
        entry.translating = false;
      },
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
    // A click on the translation popover is not a dismissal: that panel is the
    // entry's own side surface, and the user may still act on the passage.
    if (!entry.expanded || entry.translating) return;
    if (button.contains(event.target as Node)) return;
    if (
      (event.target as Element | null)?.closest?.(
        ".paperchat-selection-translation",
      )
    )
      return;
    dismiss();
  };
  doc.addEventListener("pointerdown", outside, true);
  entry.dispose = () => {
    doc.removeEventListener("pointerdown", outside, true);
    doc.removeEventListener("pointermove", handlePointerMove, true);
    doc.documentElement.removeEventListener("pointerleave", handlePointerLeave);
  };
  button.append(toggle, comment, translate);
  doc.body.appendChild(button);
  floatingSelectionEntry = entry;
  positionFloatingSelectionEntry(entry, selection);
  if (
    lastSelectionPointer?.doc === doc &&
    Date.now() - lastSelectionPointer.at < 2000
  ) {
    setOpacityForPointer(lastSelectionPointer.x, lastSelectionPointer.y);
  }
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
  const enabled = isSelectionEntryEnabled();
  // The reader poll calls this every 500ms, so an unchanged document and
  // preference must stay a cheap no-op. The preference is part of the guard so
  // toggling it re-applies the listeners even while the same PDF stays open.
  if (doc === watchedPdfDocument && enabled === watchedEntryEnabled) {
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
  watchedEntryEnabled = enabled;
  dismissedSelectionSignature = "";
  removeFloatingSelectionEntry();
  // Teardown runs before the gate so disabling the preference also drops a pill
  // that is already on screen, and the document listeners stay detached.
  if (!doc || !enabled) return;

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
    // Do not intercept Zotero's native popup at all while the entry is off.
    if (!isSelectionEntryEnabled()) return;
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

/**
 * Re-apply the entry preference at runtime. The annotation context-menu entry
 * is deliberately left registered, so toggling only affects the floating pill.
 * `watchActivePdfSelection` is idempotent, so this is safe to call repeatedly.
 */
export function applyReaderSelectionEntryPreference(): void {
  watchActivePdfSelection();
}
