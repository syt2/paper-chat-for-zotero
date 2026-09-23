/**
 * Quick phrases submenu: hovering the tools menu entry opens a flyout beside it
 * with the saved phrases, where they can be inserted, added, or deleted.
 *
 * The flyout lives on the panel root — the element the chrome styles are scoped
 * to — and is positioned in window coordinates, so the tools menu's scroll box
 * cannot clip it and it reads like the reader's native submenus.
 */

import { getString } from "../../../utils/locale";
import { createElement } from "./ChatPanelBuilder";
import { dispatchInputEvent } from "./InputEvents";
import {
  MAX_QUICK_PHRASES,
  addQuickPhrase,
  appendQuickPhraseToDraft,
  canAddQuickPhrase,
  loadQuickPhrases,
  removeQuickPhrase,
  saveQuickPhrases,
} from "./QuickPhrases";
import type { ChatPanelContext } from "./types";

const HIDE_DELAY_MS = 160;
const SUBMENU_GAP_PX = 2;
const VIEWPORT_MARGIN_PX = 8;

export function attachQuickPhrasesMenu(context: ChatPanelContext): () => void {
  const { container } = context;
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const entry = container.querySelector(
    "#chat-quick-phrases-entry",
  ) as HTMLElement | null;
  const flyout = container.querySelector(
    "#chat-quick-phrases-flyout",
  ) as HTMLElement | null;
  if (!entry || !flyout) return () => {};
  const entryEl: HTMLElement = entry;
  const flyoutEl: HTMLElement = flyout;
  const toolsMenu = container.querySelector(
    "#chat-tools-menu",
  ) as HTMLDetailsElement | null;
  const toolbar = container.querySelector("#chat-toolbar");

  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let isOpen = false;

  const cancelHide = (): void => {
    if (!hideTimer) return;
    clearTimeout(hideTimer);
    hideTimer = null;
  };

  /** Open beside the entry like a native submenu, flipping when out of room. */
  const positionFlyout = (): void => {
    const entryRect = entryEl.getBoundingClientRect();
    const viewportWidth = win?.innerWidth || entryRect.right;
    const viewportHeight = win?.innerHeight || entryRect.bottom;
    const width = flyoutEl.offsetWidth || 180;
    const height = flyoutEl.offsetHeight;
    let left = entryRect.right + SUBMENU_GAP_PX;
    if (left + width > viewportWidth - VIEWPORT_MARGIN_PX) {
      left = entryRect.left - width - SUBMENU_GAP_PX;
    }
    left = Math.max(
      VIEWPORT_MARGIN_PX,
      Math.min(left, viewportWidth - width - VIEWPORT_MARGIN_PX),
    );
    // Native menus line up a little above the row they belong to.
    let top = entryRect.top - 6;
    top = Math.max(
      VIEWPORT_MARGIN_PX,
      Math.min(top, viewportHeight - height - VIEWPORT_MARGIN_PX),
    );
    flyoutEl.style.left = `${Math.round(left)}px`;
    flyoutEl.style.top = `${Math.round(top)}px`;
  };

  const insertPhrase = (phrase: string): void => {
    const input = container.querySelector(
      "#chat-message-input",
    ) as HTMLTextAreaElement | null;
    if (!input) return;
    input.value = appendQuickPhraseToDraft(input.value, phrase);
    input.setSelectionRange(input.value.length, input.value.length);
    dispatchInputEvent(input);
    input.focus();
  };

  function render(): void {
    const phrases = loadQuickPhrases();
    flyoutEl.replaceChildren();

    if (phrases.length === 0) {
      const empty = createElement(
        doc,
        "div",
        {},
        { class: "chat-quick-phrases-empty" },
      );
      empty.textContent = getString("chat-quick-phrases-empty");
      flyoutEl.appendChild(empty);
    }

    phrases.forEach((phrase, index) => {
      const row = createElement(
        doc,
        "div",
        {},
        { class: "chat-quick-phrase-row" },
      );
      const insert = createElement(
        doc,
        "button",
        {},
        { type: "button", class: "chat-quick-phrase-use", title: phrase },
      );
      insert.textContent = phrase;
      insert.addEventListener("click", () => {
        insertPhrase(phrase);
        setOpen(false);
        if (toolsMenu) toolsMenu.open = false;
      });

      const removeLabel = getString("chat-quick-phrases-remove", {
        args: { phrase },
      });
      const remove = createElement(
        doc,
        "button",
        {},
        {
          type: "button",
          class: "chat-quick-phrase-remove",
          title: removeLabel,
          "aria-label": removeLabel,
        },
      );
      remove.textContent = "×";
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        saveQuickPhrases(removeQuickPhrase(loadQuickPhrases(), index));
        render();
        positionFlyout();
      });

      row.append(insert, remove);
      flyoutEl.appendChild(row);
    });

    flyoutEl.appendChild(
      createElement(doc, "div", {}, { class: "chat-quick-phrases-separator" }),
    );

    if (!canAddQuickPhrase(phrases)) {
      const limit = createElement(
        doc,
        "div",
        {},
        { class: "chat-quick-phrases-limit" },
      );
      limit.textContent = getString("chat-quick-phrases-limit", {
        args: { max: MAX_QUICK_PHRASES },
      });
      flyoutEl.appendChild(limit);
      return;
    }

    const addRow = createElement(
      doc,
      "div",
      {},
      { class: "chat-quick-phrase-add-row" },
    );
    const add = createElement(
      doc,
      "button",
      {},
      {
        type: "button",
        class: "chat-quick-phrase-add",
        title: getString("chat-quick-phrases-add"),
        "aria-label": getString("chat-quick-phrases-add"),
      },
    );
    add.textContent = getString("chat-quick-phrases-add");
    add.addEventListener("click", () => showAddField(addRow));
    addRow.appendChild(add);
    flyoutEl.appendChild(addRow);
  }

  // Clicking "+" swaps the last row for an inline field: Enter saves, Escape or
  // leaving the field cancels, so a stray click never adds a phrase.
  const showAddField = (row: HTMLElement): void => {
    const field = createElement(
      doc,
      "input",
      {},
      {
        type: "text",
        class: "chat-quick-phrase-input",
        placeholder: getString("chat-quick-phrases-input"),
        "aria-label": getString("chat-quick-phrases-add"),
      },
    ) as HTMLInputElement;
    let settled = false;
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        settled = true;
        saveQuickPhrases(addQuickPhrase(loadQuickPhrases(), field.value));
        render();
        positionFlyout();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        settled = true;
        render();
        entryEl.focus();
      }
    });
    field.addEventListener("blur", () => {
      if (settled) return;
      settled = true;
      render();
    });
    row.replaceChildren(field);
    field.focus();
  };

  function setOpen(open: boolean): void {
    cancelHide();
    if (isOpen === open) return;
    isOpen = open;
    if (open) {
      render();
      flyoutEl.setAttribute("data-open", "true");
      positionFlyout();
      positionFlyout();
    } else {
      flyoutEl.setAttribute("data-open", "false");
    }
    entryEl.setAttribute("aria-expanded", String(open));
  }

  const hideSoon = (): void => {
    cancelHide();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      setOpen(false);
    }, HIDE_DELAY_MS);
  };

  const onEntryClick = (event: MouseEvent): void => {
    event.preventDefault();
    // Keyboard activation toggles; a pointer click only keeps open what hover
    // already opened.
    if (event.detail === 0 && isOpen) {
      setOpen(false);
      return;
    }
    setOpen(true);
  };
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !isOpen) return;
    // The inline add field cancels itself first; only a second Escape closes.
    const target = event.target as Node | null;
    if (target && flyoutEl.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    entryEl.focus();
  };
  const onDocumentPointerDown = (event: Event): void => {
    if (!isOpen) return;
    const target = event.target as Node | null;
    if (target && (entryEl.contains(target) || flyoutEl.contains(target)))
      return;
    setOpen(false);
  };
  const onToolsToggle = (): void => {
    if (!toolsMenu?.open) setOpen(false);
  };
  const onViewportChange = (): void => {
    if (isOpen) positionFlyout();
  };

  entryEl.addEventListener("mouseenter", () => setOpen(true));
  entryEl.addEventListener("mouseleave", hideSoon);
  entryEl.addEventListener("focus", () => setOpen(true));
  entryEl.addEventListener("click", onEntryClick);
  flyoutEl.addEventListener("mouseenter", cancelHide);
  flyoutEl.addEventListener("mouseleave", hideSoon);
  // Keep the tools menu open while the submenu is being used.
  flyoutEl.addEventListener("click", (event) => event.stopPropagation());
  toolsMenu?.addEventListener("toggle", onToolsToggle);
  toolbar?.addEventListener("scroll", onViewportChange);
  doc.addEventListener("pointerdown", onDocumentPointerDown, true);
  doc.addEventListener("keydown", onEscape, true);
  win?.addEventListener("resize", onViewportChange);

  return () => {
    cancelHide();
    toolsMenu?.removeEventListener("toggle", onToolsToggle);
    toolbar?.removeEventListener("scroll", onViewportChange);
    doc.removeEventListener("pointerdown", onDocumentPointerDown, true);
    doc.removeEventListener("keydown", onEscape, true);
    win?.removeEventListener("resize", onViewportChange);
  };
}
