import { config } from "../../../../package.json";
import { getString } from "../../../utils/locale";
import { sendCommentSelectionToChat } from "./ChatPanelManager";
import { HTML_NS } from "./types";

type SelectionAnchor = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

type ChatSelection = {
  text: string;
  rect: DOMRect;
};

const BUTTON_SIZE = 28;
const POPOVER_WIDTH = 300;

function createElement<T extends HTMLElement>(doc: Document, tag: string): T {
  return doc.createElementNS(HTML_NS, tag) as T;
}

function getOverlayRoot(
  doc: Document,
  preferredRoot?: HTMLElement | null,
): HTMLElement | null {
  return (
    preferredRoot || doc.body || (doc.documentElement as HTMLElement | null)
  );
}

function getNodeElement(node: Node | null): Element | null {
  if (!node) return null;
  // The plugin sandbox has no global Node constructor, even for chrome DOMs.
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

function getSelectableChatNode(
  node: Node | null,
  history: HTMLElement,
): Element | null {
  const element = getNodeElement(node);
  if (!element || !history.contains(element)) return null;
  if (
    element.closest(
      'button, input, textarea, select, option, summary, [contenteditable="true"]',
    )
  ) {
    return null;
  }
  return element;
}

function getSelection(history: HTMLElement): ChatSelection | null {
  const selection =
    history.ownerDocument.getSelection?.() ??
    history.ownerDocument.defaultView?.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (
    !history.contains(range.startContainer) ||
    !history.contains(range.endContainer) ||
    !getSelectableChatNode(range.startContainer, history) ||
    !getSelectableChatNode(range.endContainer, history)
  ) {
    return null;
  }

  const text = selection.toString().trim();
  if (!text) return null;

  const rects = Array.from(range.getClientRects?.() || []).filter(
    (item) => item.width > 0 || item.height > 0,
  );
  const rect = rects.length
    ? (() => {
        const left = Math.min(...rects.map((item) => item.left));
        const top = Math.min(...rects.map((item) => item.top));
        const right = Math.max(...rects.map((item) => item.right));
        const bottom = Math.max(...rects.map((item) => item.bottom));
        return {
          left,
          top,
          right,
          bottom,
          width: right - left,
          height: bottom - top,
        } as DOMRect;
      })()
    : range.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return null;
  return { text, rect };
}

function getAnchor(rect: DOMRect): SelectionAnchor {
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
  };
}

function positionButton(button: HTMLElement, anchor: SelectionAnchor): void {
  const win = button.ownerDocument.defaultView;
  if (!win) return;
  const rect = button.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(anchor.right - rect.width, win.innerWidth - rect.width - 8),
  );
  const above = anchor.top - rect.height - 8;
  const top =
    above >= 8
      ? above
      : Math.min(anchor.bottom + 8, win.innerHeight - rect.height - 8);
  button.style.left = `${left}px`;
  button.style.top = `${Math.max(8, top)}px`;
}

/** Position the compact action beside the pointer that finished the drag. */
function positionButtonAtPointer(
  button: HTMLElement,
  clientX: number,
  clientY: number,
): void {
  const win = button.ownerDocument.defaultView;
  if (!win || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
  const rect = button.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(clientX + 4, win.innerWidth - rect.width - 8),
  );
  const top = Math.max(
    8,
    Math.min(clientY - rect.height / 2, win.innerHeight - rect.height - 8),
  );
  button.style.left = `${left}px`;
  button.style.top = `${top}px`;
}

function positionPopover(panel: HTMLElement, anchor: SelectionAnchor): void {
  const win = panel.ownerDocument.defaultView;
  if (!win) return;
  const panelRect = panel.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(anchor.left, win.innerWidth - panelRect.width - 8),
  );
  const below = anchor.bottom + 8;
  const top =
    below + panelRect.height <= win.innerHeight - 8
      ? below
      : anchor.top - panelRect.height - 8;
  panel.style.left = `${Math.max(8, left)}px`;
  panel.style.top = `${Math.max(8, Math.min(top, win.innerHeight - panelRect.height - 8))}px`;
}

function setIcon(button: HTMLElement): void {
  const icon = createElement<HTMLImageElement>(button.ownerDocument, "img");
  icon.src = `chrome://${config.addonRef}/content/icons/comment.svg`;
  icon.alt = "";
  icon.draggable = false;
  Object.assign(icon.style, {
    width: "16px",
    height: "16px",
    pointerEvents: "none",
  });
  button.append(icon);
}

function openCommentPopover(
  doc: Document,
  overlayRoot: HTMLElement,
  button: HTMLElement,
  selectedText: string,
  anchor: SelectionAnchor,
  onClose: () => void,
): () => void {
  const win = doc.defaultView;
  if (!win) return () => {};
  const dark = win.matchMedia("(prefers-color-scheme: dark)")?.matches;
  const panel = createElement<HTMLElement>(doc, "section");
  panel.className = "paperchat-chat-selection-comment";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", getString("chat-reader-comment"));
  Object.assign(panel.style, {
    position: "fixed",
    zIndex: "2147483647",
    boxSizing: "border-box",
    width: `${Math.min(POPOVER_WIDTH, Math.max(0, win.innerWidth - 16))}px`,
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

  const quote = createElement<HTMLElement>(doc, "div");
  quote.textContent = selectedText.replace(/\s+/g, " ").trim();
  Object.assign(quote.style, {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    margin: "2px 2px 4px",
    padding: "0 0 4px",
    borderBottom: `1px solid ${dark ? "#3a3a40" : "#ececf1"}`,
    color: dark ? "#9b9ba4" : "#71717a",
    font: "12px/1.5 system-ui, sans-serif",
  });

  const input = createElement<HTMLTextAreaElement>(doc, "textarea");
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

  const actions = createElement<HTMLElement>(doc, "div");
  Object.assign(actions.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "4px",
  });
  const makeTextButton = (label: string): HTMLButtonElement => {
    const control = createElement<HTMLButtonElement>(doc, "button");
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
  const makeIconButton = (label: string, iconName: string, filled: boolean) => {
    const control = createElement<HTMLButtonElement>(doc, "button");
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
    });
    const icon = createElement<HTMLImageElement>(doc, "img");
    icon.src = `chrome://${config.addonRef}/content/icons/${iconName}.svg`;
    icon.alt = "";
    icon.draggable = false;
    Object.assign(icon.style, {
      width: "16px",
      height: "16px",
      pointerEvents: "none",
    });
    control.append(icon);
    return control;
  };

  const cancelButton = makeTextButton(getString("chat-reader-comment-cancel"));
  const attachButton = makeIconButton(
    getString("chat-reader-comment-attach"),
    "pushpin",
    false,
  );
  const sendButton = makeIconButton(
    getString("chat-reader-comment-send"),
    "send",
    true,
  );
  actions.append(cancelButton, attachButton, sendButton);
  panel.append(quote, input, actions);
  overlayRoot.append(panel);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    panel.remove();
    doc.removeEventListener("pointerdown", outside, true);
    doc.removeEventListener("keydown", keydown, true);
    win.removeEventListener("resize", place);
    onClose();
  };
  const outside = (event: Event) => {
    const target = event.target as Node | null;
    if (target && (panel.contains(target) || button.contains(target))) return;
    dispose();
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dispose();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && event.target === input) {
      event.preventDefault();
      event.stopPropagation();
      const comment = input.value;
      dispose();
      sendCommentSelectionToChat(selectedText, comment, true);
    }
  };
  const place = () => positionPopover(panel, anchor);
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
    sendCommentSelectionToChat(selectedText, comment, false);
  });
  sendButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const comment = input.value;
    dispose();
    sendCommentSelectionToChat(selectedText, comment, true);
  });
  doc.addEventListener("pointerdown", outside, true);
  doc.addEventListener("keydown", keydown, true);
  win.addEventListener("resize", place);
  place();
  return dispose;
}

/** Install the single comment action shown when text is selected in chat. */
export function setupChatSelectionComment(history: HTMLElement): () => void {
  const doc = history.ownerDocument;
  const overlayRoot = getOverlayRoot(
    doc,
    history.closest<HTMLElement>(".chat-panel-root"),
  );
  if (!overlayRoot) return () => {};
  let button: HTMLButtonElement | null = null;
  let closePopover: (() => void) | undefined;
  let selectionText = "";
  let anchor: SelectionAnchor | null = null;
  let frame: number | undefined;
  let pointerSelecting = false;
  let selectionChangedDuringPointer = false;
  let releasePointer: { x: number; y: number } | undefined;

  const remove = () => {
    if (frame !== undefined) {
      doc.defaultView?.cancelAnimationFrame(frame);
      frame = undefined;
    }
    closePopover?.();
    closePopover = undefined;
    button?.remove();
    button = null;
    selectionText = "";
    anchor = null;
    selectionChangedDuringPointer = false;
    releasePointer = undefined;
  };
  const refresh = () => {
    frame = undefined;
    if (pointerSelecting) {
      if (button && !closePopover) button.style.visibility = "hidden";
      return;
    }
    const selection = getSelection(history);
    if (!selection) {
      if (!closePopover) remove();
      return;
    }
    const nextAnchor = getAnchor(selection.rect);
    if (closePopover && selection.text !== selectionText) {
      closePopover();
      closePopover = undefined;
    }
    if (!button) {
      button = createElement<HTMLButtonElement>(doc, "button");
      button.type = "button";
      button.className = "paperchat-chat-selection-comment-button";
      button.title = getString("chat-reader-comment");
      button.setAttribute("aria-label", getString("chat-reader-comment"));
      Object.assign(button.style, {
        position: "fixed",
        zIndex: "2147483646",
        width: `${BUTTON_SIZE}px`,
        height: `${BUTTON_SIZE}px`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0",
        border: "1px solid rgba(128,128,140,.3)",
        borderRadius: "999px",
        background: doc.defaultView?.matchMedia("(prefers-color-scheme: dark)")
          ?.matches
          ? "#303035"
          : "#fff",
        boxShadow: "0 1px 4px rgba(0,0,0,.16)",
        cursor: "pointer",
      });
      setIcon(button);
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!selectionText || !anchor) return;
        if (closePopover) {
          closePopover();
          closePopover = undefined;
          return;
        }
        const selected = selectionText;
        const selectedAnchor = anchor;
        closePopover = openCommentPopover(
          doc,
          overlayRoot,
          button as HTMLButtonElement,
          selected,
          selectedAnchor,
          () => {
            closePopover = undefined;
          },
        );
      });
      overlayRoot.append(button);
    }
    button.style.visibility = "visible";
    selectionText = selection.text;
    anchor = nextAnchor;
    if (releasePointer && selectionChangedDuringPointer) {
      positionButtonAtPointer(button, releasePointer.x, releasePointer.y);
    } else if (!button.style.left || !button.style.top) {
      positionButton(button, nextAnchor);
    }
    if (closePopover) {
      const panel = doc.querySelector<HTMLElement>(
        ".paperchat-chat-selection-comment",
      );
      if (panel) positionPopover(panel, nextAnchor);
    }
  };
  const schedule = () => {
    if (frame !== undefined) return;
    frame = doc.defaultView?.requestAnimationFrame(refresh) ?? 0;
  };
  const onSelectionChange = () => {
    if (pointerSelecting) {
      const selection = getSelection(history);
      const currentText = selection?.text ?? "";
      if (currentText !== selectionText) {
        selectionChangedDuringPointer = true;
      }
    }
    schedule();
  };
  const isCommentButtonTarget = (event: Event): boolean => {
    const target = event.target as Node | null;
    return !!button && !!target && button.contains(target);
  };
  const onPointerDown = (event: Event) => {
    if (isCommentButtonTarget(event)) return;
    if (!pointerSelecting) {
      pointerSelecting = true;
      selectionChangedDuringPointer = false;
      releasePointer = undefined;
    }
    schedule();
  };
  const onMouseDown = (event: Event) => {
    if (isCommentButtonTarget(event)) return;
    if (!pointerSelecting) {
      pointerSelecting = true;
      selectionChangedDuringPointer = false;
      releasePointer = undefined;
    }
    schedule();
  };
  const onPointerUp = (event: Event) => {
    pointerSelecting = false;
    const pointer = event as PointerEvent;
    if (
      selectionChangedDuringPointer &&
      Number.isFinite(pointer.clientX) &&
      Number.isFinite(pointer.clientY)
    ) {
      releasePointer = { x: pointer.clientX, y: pointer.clientY };
    }
    schedule();
  };
  const onMouseUp = (event: Event) => {
    pointerSelecting = false;
    const mouse = event as MouseEvent;
    if (
      selectionChangedDuringPointer &&
      Number.isFinite(mouse.clientX) &&
      Number.isFinite(mouse.clientY)
    ) {
      releasePointer = { x: mouse.clientX, y: mouse.clientY };
    }
    schedule();
  };
  const onScroll = () => schedule();
  doc.addEventListener("selectionchange", onSelectionChange);
  doc.defaultView?.addEventListener("selectionchange", onSelectionChange);
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("mousedown", onMouseDown, true);
  doc.addEventListener("pointerup", onPointerUp, true);
  doc.addEventListener("mouseup", onMouseUp, true);
  history.addEventListener("scroll", onScroll, true);
  doc.defaultView?.addEventListener("resize", onScroll);
  return () => {
    doc.removeEventListener("selectionchange", onSelectionChange);
    doc.defaultView?.removeEventListener("selectionchange", onSelectionChange);
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("mousedown", onMouseDown, true);
    doc.removeEventListener("pointerup", onPointerUp, true);
    doc.removeEventListener("mouseup", onMouseUp, true);
    history.removeEventListener("scroll", onScroll, true);
    doc.defaultView?.removeEventListener("resize", onScroll);
    remove();
  };
}
