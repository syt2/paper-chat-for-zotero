/**
 * ReaderChatEntry - "Ask in chat" entry points inside the PDF reader.
 *
 * Two surfaces:
 * - renderTextSelectionPopup: a button in the reader's text-selection popup
 *   that sends the highlighted passage to the chat panel.
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
import { addSelectedTextAttachment, showPanel } from "./chat-panel";
import type { ChatPanelOpenSource } from "./chat-panel/ChatPanelManager";
import {
  collectAnnotationText,
  type ReaderLike,
} from "./reader-chat-selection";

type SelectionPopupEvent = {
  doc: Document;
  params: { annotation?: { text?: string } };
  append: (...nodes: Array<Node | string>) => void;
  reader: ReaderLike;
};

type AnnotationMenuEvent = {
  params: { ids?: string[] };
  append: (options: { label: string; onCommand: () => void }) => void;
  reader: ReaderLike;
};

let selectionPopupHandler: ((event: SelectionPopupEvent) => void) | undefined;
let annotationMenuHandler: ((event: AnnotationMenuEvent) => void) | undefined;

/** Open the chat panel with `text` already attached as a quoted selection. */
function openChatWithSelection(
  text: string,
  source: ChatPanelOpenSource,
): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  // Panel first: showPanel builds the container synchronously, so the
  // attachment preview has somewhere to render.
  showPanel(source);
  addSelectedTextAttachment(trimmed);
}

function buildSelectionPopupButton(
  doc: Document,
  onCommand: () => void,
): HTMLElement {
  const button = doc.createElement("button");
  button.className = "toolbar-button paperchat-ask-button";
  button.textContent = getString("chat-reader-ask");
  button.title = getString("chat-reader-ask-tooltip");
  button.style.cursor = "pointer";
  button.style.whiteSpace = "nowrap";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onCommand();
  });
  return button;
}

export function registerReaderChatEntries(): void {
  if (!Zotero.Reader?.registerEventListener) {
    ztoolkit.log(
      "[ReaderChatEntry] Zotero.Reader.registerEventListener not available",
    );
    return;
  }
  if (selectionPopupHandler || annotationMenuHandler) {
    return;
  }

  selectionPopupHandler = (event: SelectionPopupEvent) => {
    const selected = event.params?.annotation?.text || "";
    if (!selected.trim()) {
      return;
    }
    event.append(
      buildSelectionPopupButton(event.doc, () => {
        openChatWithSelection(selected, "reader_selection");
      }),
    );
  };

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
    "renderTextSelectionPopup",
    selectionPopupHandler as never,
    addon.data.config.addonRef,
  );
  Zotero.Reader.registerEventListener(
    "createAnnotationContextMenu",
    annotationMenuHandler as never,
    addon.data.config.addonRef,
  );

  ztoolkit.log("[ReaderChatEntry] Reader chat entries registered");
}

export function unregisterReaderChatEntries(): void {
  if (!Zotero.Reader?.unregisterEventListener) {
    selectionPopupHandler = undefined;
    annotationMenuHandler = undefined;
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
