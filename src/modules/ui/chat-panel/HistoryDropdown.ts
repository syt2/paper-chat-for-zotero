/**
 * HistoryDropdown - Chat history dropdown component with pagination
 */

import { getString } from "../../../utils/locale";
import { chatColors } from "../../../utils/colors";
import type { ThemeColors, SessionInfo } from "./types";
import { createElement } from "./ChatPanelBuilder";

// Number of sessions to show per page
export const SESSIONS_PER_PAGE = 20;

/**
 * Format timestamp to display string
 */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isThisYear = date.getFullYear() === now.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return isThisYear
    ? `${month}/${day} ${hours}:${minutes}`
    : `${date.getFullYear()}/${month}/${day} ${hours}:${minutes}`;
}

/**
 * Create a session item element for the history dropdown
 */
export function createSessionItem(
  doc: Document,
  session: SessionInfo,
  theme: ThemeColors,
  onSelect: (session: SessionInfo) => void,
  onDelete?: (session: SessionInfo) => void,
  onEditTitle?: (session: SessionInfo, title: string | null) => Promise<void>,
): HTMLElement {
  const sessionItem = createElement(doc, "div", {
    padding: "12px 14px",
    borderBottom: `1px solid ${theme.borderColor}`,
    cursor: "pointer",
    transition: "background 0.2s",
    position: "relative",
  });

  // Edit button (hidden by default, shown on hover)
  const editBtn = createElement(doc, "button", {
    position: "absolute",
    right: "36px",
    top: "50%",
    transform: "translateY(-50%)",
    width: "24px",
    height: "24px",
    background: "transparent",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    display: "none",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "13px",
    color: theme.textMuted,
    padding: "0",
  });
  editBtn.textContent = "✎";
  editBtn.title = getString("chat-edit-title");

  // Delete button (hidden by default, shown on hover)
  const deleteBtn = createElement(doc, "button", {
    position: "absolute",
    right: "8px",
    top: "50%",
    transform: "translateY(-50%)",
    width: "24px",
    height: "24px",
    background: "transparent",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    display: "none",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "14px",
    color: theme.textMuted,
    padding: "0",
  });
  deleteBtn.textContent = "×";
  deleteBtn.title = getString("chat-delete");

  // Hover effects
  sessionItem.addEventListener("mouseenter", () => {
    sessionItem.style.background = theme.dropdownItemHoverBg;
    editBtn.style.display = onEditTitle ? "flex" : "none";
    deleteBtn.style.display = "flex";
  });
  sessionItem.addEventListener("mouseleave", () => {
    sessionItem.style.background = "transparent";
    editBtn.style.display = "none";
    deleteBtn.style.display = "none";
  });

  // Delete button hover
  deleteBtn.addEventListener("mouseenter", () => {
    deleteBtn.style.background = "rgba(255, 0, 0, 0.1)";
    deleteBtn.style.color = "#e53935";
  });
  deleteBtn.addEventListener("mouseleave", () => {
    deleteBtn.style.background = "transparent";
    deleteBtn.style.color = theme.textMuted;
  });

  // Delete button click
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onDelete?.(session);
  });

  // Content wrapper (to keep content away from delete button)
  const contentWrapper = createElement(doc, "div", {
    paddingRight: onEditTitle ? "58px" : "30px",
  });

  const fallbackTitle = getString("chat-history-title", {
    args: { time: formatTimestamp(session.createdAt) },
  });

  // Session title
  const titleEl = createElement(doc, "div", {
    fontWeight: "600",
    fontSize: "13px",
    marginBottom: "4px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: theme.textPrimary,
  });
  titleEl.textContent = session.title || fallbackTitle;

  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!onEditTitle) return;

    const input = createElement(doc, "input", {
      width: "100%",
      boxSizing: "border-box",
      fontSize: "13px",
      fontWeight: "600",
      color: theme.textPrimary,
      background: theme.inputBg,
      border: `1px solid ${theme.inputBorderColor}`,
      borderRadius: "4px",
      padding: "2px 4px",
      outline: "none",
    }) as HTMLInputElement;
    input.value = session.title || "";
    titleEl.replaceWith(input);
    editBtn.style.display = "none";
    deleteBtn.style.display = "none";
    input.focus();
    input.select();

    let cancelled = false;
    let saved = false;
    const finish = async () => {
      if (saved || cancelled) return;
      saved = true;
      const nextTitle = input.value.trim() || null;
      try {
        await onEditTitle(session, nextTitle);
        session.title = nextTitle || undefined;
        titleEl.textContent = session.title || fallbackTitle;
      } catch (error) {
        ztoolkit.log("[HistoryDropdown] Failed to update session title:", error);
      } finally {
        input.replaceWith(titleEl);
      }
    };

    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void finish();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelled = true;
        input.replaceWith(titleEl);
      }
    });
    input.addEventListener("blur", () => {
      void finish();
    });
  });

  // Message preview
  const previewEl = createElement(doc, "div", {
    fontSize: "12px",
    color: theme.textSecondary,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    marginBottom: "4px",
  });
  previewEl.textContent =
    session.lastMessagePreview || getString("chat-no-messages");

  // Meta info (message count and last update)
  const metaEl = createElement(doc, "div", {
    fontSize: "11px",
    color: theme.textMuted,
    display: "flex",
    justifyContent: "space-between",
  });

  const msgCount = createElement(doc, "span", {});
  msgCount.textContent = getString("chat-message-count", {
    args: { count: session.messageCount },
  });

  const timeEl = createElement(doc, "span", {});
  timeEl.textContent = formatTimestamp(session.updatedAt);

  metaEl.appendChild(msgCount);
  metaEl.appendChild(timeEl);

  contentWrapper.appendChild(titleEl);
  contentWrapper.appendChild(previewEl);
  contentWrapper.appendChild(metaEl);

  sessionItem.appendChild(contentWrapper);
  sessionItem.appendChild(editBtn);
  sessionItem.appendChild(deleteBtn);

  // Click handler
  sessionItem.addEventListener("click", () => {
    onSelect(session);
  });

  return sessionItem;
}

/**
 * State for history dropdown pagination
 */
export interface HistoryDropdownState {
  allSessions: SessionInfo[];
  displayedCount: number;
}

/**
 * Create initial state for history dropdown
 */
export function createHistoryDropdownState(): HistoryDropdownState {
  return {
    allSessions: [],
    displayedCount: 0,
  };
}

/**
 * Render more sessions with pagination (appends to container)
 */
export function renderMoreSessions(
  container: HTMLElement,
  doc: Document,
  state: HistoryDropdownState,
  theme: ThemeColors,
  onSelect: (session: SessionInfo) => void,
  onDelete?: (session: SessionInfo) => void,
  onEditTitle?: (session: SessionInfo, title: string | null) => Promise<void>,
): void {
  const endIndex = Math.min(
    state.displayedCount + SESSIONS_PER_PAGE,
    state.allSessions.length,
  );

  // Remove existing "load more" button if any
  const existingLoadMore = container.querySelector(".load-more-btn");
  if (existingLoadMore) {
    existingLoadMore.remove();
  }

  // Add session items
  for (let i = state.displayedCount; i < endIndex; i++) {
    container.appendChild(
      createSessionItem(
        doc,
        state.allSessions[i],
        theme,
        onSelect,
        onDelete,
        onEditTitle,
      ),
    );
  }
  state.displayedCount = endIndex;

  // Add "load more" button if there are more sessions
  if (state.displayedCount < state.allSessions.length) {
    const loadMoreBtn = createElement(doc, "div", {
      padding: "12px 14px",
      textAlign: "center",
      color: chatColors.historyAccent,
      cursor: "pointer",
      fontWeight: "500",
      fontSize: "13px",
    });
    loadMoreBtn.className = "load-more-btn";
    loadMoreBtn.textContent = getString("chat-show-more", {
      args: { count: state.allSessions.length - state.displayedCount },
    });

    loadMoreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      renderMoreSessions(
        container,
        doc,
        state,
        theme,
        onSelect,
        onDelete,
        onEditTitle,
      );
    });
    loadMoreBtn.addEventListener("mouseenter", () => {
      loadMoreBtn.style.background = chatColors.loadMoreBg;
    });
    loadMoreBtn.addEventListener("mouseleave", () => {
      loadMoreBtn.style.background = "transparent";
    });

    container.appendChild(loadMoreBtn);
  }
}

/**
 * Populate the history dropdown with sessions
 */
export function populateHistoryDropdown(
  dropdown: HTMLElement,
  doc: Document,
  sessions: SessionInfo[],
  state: HistoryDropdownState,
  theme: ThemeColors,
  onSelect: (session: SessionInfo) => void,
  onDelete?: (session: SessionInfo) => void,
  onEditTitle?: (session: SessionInfo, title: string | null) => Promise<void>,
): void {
  // Reset state
  state.allSessions = sessions;
  state.displayedCount = 0;

  dropdown.textContent = "";

  if (sessions.length === 0) {
    const emptyMsg = createElement(doc, "div", {
      padding: "20px",
      textAlign: "center",
      color: chatColors.emptyText,
      fontSize: "13px",
    });
    emptyMsg.textContent = getString("chat-no-history");
    dropdown.appendChild(emptyMsg);
  } else {
    // Render first page
    renderMoreSessions(
      dropdown,
      doc,
      state,
      theme,
      onSelect,
      onDelete,
      onEditTitle,
    );
  }
}

/**
 * Toggle history dropdown visibility
 */
export function toggleHistoryDropdown(dropdown: HTMLElement): boolean {
  const isVisible = dropdown.style.display !== "none";
  if (isVisible) {
    dropdown.style.display = "none";
    return false;
  }
  dropdown.style.display = "block";
  return true;
}

/**
 * Hide history dropdown
 */
export function hideHistoryDropdown(dropdown: HTMLElement): void {
  dropdown.style.display = "none";
}

/**
 * Setup click-outside handler to close dropdown
 */
export function setupClickOutsideHandler(
  container: HTMLElement,
  dropdown: HTMLElement,
  historyBtn: HTMLElement,
): void {
  container.addEventListener("click", (e) => {
    if (dropdown.style.display !== "none") {
      if (
        !historyBtn.contains(e.target as Node) &&
        !dropdown.contains(e.target as Node)
      ) {
        dropdown.style.display = "none";
      }
    }
  });
}
