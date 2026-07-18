/**
 * HistoryDropdown - Chat history dropdown component with pagination
 */

import { getString } from "../../../utils/locale";
import { chatColors } from "../../../utils/colors";
import { MAX_SEARCH_QUERY_RAW_UTF16_LENGTH } from "../../chat/search/SearchQuery";
import { normalizeSearchValue } from "../../chat/search/SearchProjection";
import type {
  ChatHistoryMessageMatch,
  ChatHistoryMessagePage,
  ChatHistorySearchGroup,
  ChatHistorySearchPage,
  SearchHighlightRange,
  SearchHistoryGroupsRequest,
  SearchHistorySessionMatchesRequest,
} from "../../chat/search/SearchTypes";
import type { ThemeColors, SessionInfo } from "./types";
import { createElement } from "./ChatPanelBuilder";

// Number of sessions to show per page
export const SESSIONS_PER_PAGE = 20;
export const HISTORY_SEARCH_DEBOUNCE_MS = 200;
export const HISTORY_SEARCH_MIN_CODE_POINTS = 2;
export const HISTORY_SEARCH_INITIAL_MESSAGE_LIMIT = 3;
export const HISTORY_SEARCH_EXPANSION_LIMIT = 10;

const HISTORY_BODY_ID = "chat-history-dropdown-body";
const HISTORY_SEARCH_INPUT_ID = "chat-history-search-input";
const HISTORY_SEARCH_CLEAR_BUTTON_ID = "chat-history-search-clear";

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

export interface HistorySearchCache {
  normalizedQuery: string;
  queryKey: string;
  searchRevision: number;
}

export interface HistoryDropdownSearchCallbacks {
  searchGroups: (
    input: SearchHistoryGroupsRequest,
  ) => Promise<ChatHistorySearchPage>;
  searchSessionMatches: (
    input: SearchHistorySessionMatchesRequest,
  ) => Promise<ChatHistoryMessagePage>;
  onSelectTitleMatch: (
    sessionId: string,
    group: ChatHistorySearchGroup,
  ) => void | Promise<void>;
  onSelectMessageMatch: (
    sessionId: string,
    messageId: string,
    match: ChatHistoryMessageMatch,
    group: ChatHistorySearchGroup,
  ) => void | Promise<void>;
  onSearchError?: (error: unknown) => void;
}

interface OrdinaryHistoryCallbacks {
  onSelect: (session: SessionInfo) => void;
  onDelete?: (session: SessionInfo) => void;
  onEditTitle?: (session: SessionInfo, title: string | null) => Promise<void>;
}

interface HistoryDropdownSearchController {
  dropdown: HTMLElement;
  body: HTMLElement;
  input: HTMLInputElement;
  doc: Document;
  state: HistoryDropdownState;
  theme: ThemeColors;
  callbacks: HistoryDropdownSearchCallbacks;
  ordinaryCallbacks?: OrdinaryHistoryCallbacks;
  primarySearchActive: Promise<void> | null;
  pendingPrimarySearch: {
    append: boolean;
    resolve: () => void;
  } | null;
  disposed: boolean;
  dispose?: () => void;
}

const searchControllers = new WeakMap<
  HTMLElement,
  HistoryDropdownSearchController
>();

function getHistoryBody(dropdown: HTMLElement): HTMLElement {
  return (
    (dropdown.querySelector(`#${HISTORY_BODY_ID}`) as HTMLElement | null) ||
    dropdown
  );
}

function getHistorySearchInput(dropdown: HTMLElement): HTMLInputElement | null {
  return dropdown.querySelector(
    `#${HISTORY_SEARCH_INPUT_ID}`,
  ) as HTMLInputElement | null;
}

function getHistorySearchClearButton(
  dropdown: HTMLElement,
): HTMLButtonElement | null {
  return dropdown.querySelector(
    `#${HISTORY_SEARCH_CLEAR_BUTTON_ID}`,
  ) as HTMLButtonElement | null;
}

function normalizedCodePointLength(value: string): number {
  return Array.from(value).length;
}

export function isHistorySearchActive(state: HistoryDropdownState): boolean {
  return (
    normalizedCodePointLength(normalizeSearchValue(state.query)) >=
    HISTORY_SEARCH_MIN_CODE_POINTS
  );
}

function normalizeHighlightRanges(
  ranges: SearchHighlightRange[],
  textLength: number,
): SearchHighlightRange[] {
  const sorted = ranges
    .map(({ start, end }) => ({
      start: Math.max(0, Math.min(textLength, start)),
      end: Math.max(0, Math.min(textLength, end)),
    }))
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const merged: SearchHighlightRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Render storage-provided UTF-16 ranges as text nodes. Matched text is never
 * interpreted as markup, including snippets containing angle brackets.
 */
export function appendHighlightedSearchText(
  container: HTMLElement,
  text: string,
  ranges: SearchHighlightRange[],
  doc: Document,
  theme: ThemeColors,
): void {
  let offset = 0;
  for (const range of normalizeHighlightRanges(ranges, text.length)) {
    if (range.start > offset) {
      container.appendChild(
        doc.createTextNode(text.slice(offset, range.start)),
      );
    }
    const highlight = createElement(doc, "span", {
      background: theme.buttonHoverBg,
      color: theme.textPrimary,
      borderRadius: "3px",
      padding: "0 1px",
      fontWeight: "600",
    });
    highlight.className = "history-search-highlight";
    highlight.appendChild(
      doc.createTextNode(text.slice(range.start, range.end)),
    );
    container.appendChild(highlight);
    offset = range.end;
  }
  if (offset < text.length) {
    container.appendChild(doc.createTextNode(text.slice(offset)));
  }
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
        ztoolkit.log(
          "[HistoryDropdown] Failed to update session title:",
          error,
        );
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

function invokeSafely(
  callback: () => void | Promise<void>,
  onError?: (error: unknown) => void,
): void {
  try {
    Promise.resolve(callback()).catch((error) => onError?.(error));
  } catch (error) {
    onError?.(error);
  }
}

function createSearchActionRow(
  doc: Document,
  theme: ThemeColors,
): HTMLButtonElement {
  return createElement(
    doc,
    "button",
    {
      display: "grid",
      gridTemplateRows: "auto auto",
      alignContent: "start",
      rowGap: "3px",
      width: "100%",
      height: "auto",
      minHeight: "0",
      maxHeight: "none",
      boxSizing: "border-box",
      margin: "1px 0",
      padding: "8px 10px",
      background: "transparent",
      border: "none",
      borderRadius: "6px",
      appearance: "none",
      overflow: "hidden",
      color: theme.textPrimary,
      fontFamily: "inherit",
      fontSize: "12px",
      lineHeight: "17px",
      textAlign: "left",
      whiteSpace: "normal",
      cursor: "pointer",
    },
    { type: "button" },
  ) as HTMLButtonElement;
}

function addSearchRowHover(row: HTMLElement, theme: ThemeColors): void {
  row.addEventListener("mouseenter", () => {
    row.style.background = theme.dropdownItemHoverBg;
  });
  row.addEventListener("mouseleave", () => {
    row.style.background = "transparent";
  });
}

function createTitleMatchRow(
  doc: Document,
  group: ChatHistorySearchGroup,
  theme: ThemeColors,
  callbacks: HistoryDropdownSearchCallbacks,
  disabled: boolean,
): HTMLElement {
  const row = createSearchActionRow(doc, theme);
  row.className = "history-search-title-match";
  row.setAttribute("data-session-id", group.sessionId);
  row.disabled = disabled;
  row.style.opacity = disabled ? "0.55" : "1";
  row.style.cursor = disabled ? "default" : "pointer";
  addSearchRowHover(row, theme);

  const label = createElement(doc, "span", {
    display: "block",
    color: theme.textMuted,
    fontSize: "10px",
    fontWeight: "600",
    lineHeight: "14px",
  });
  label.textContent = getString("chat-history-search-title-match");

  const snippet = createElement(doc, "span", {
    display: "block",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    lineHeight: "17px",
  });
  appendHighlightedSearchText(
    snippet,
    group.titleMatch?.snippet || group.sessionTitle || "",
    group.titleMatch?.highlightRanges || [],
    doc,
    theme,
  );
  row.appendChild(label);
  row.appendChild(snippet);
  row.addEventListener("click", (event) => {
    event.stopPropagation();
    if (row.disabled) return;
    invokeSafely(
      () => callbacks.onSelectTitleMatch(group.sessionId, group),
      callbacks.onSearchError,
    );
  });
  return row;
}

function createMessageMatchRow(
  doc: Document,
  group: ChatHistorySearchGroup,
  match: ChatHistoryMessageMatch,
  theme: ThemeColors,
  callbacks: HistoryDropdownSearchCallbacks,
  disabled: boolean,
): HTMLElement {
  const row = createSearchActionRow(doc, theme);
  row.className = "history-search-message-match";
  row.setAttribute("data-session-id", group.sessionId);
  row.setAttribute("data-message-id", match.messageId);
  row.disabled = disabled;
  row.style.opacity = disabled ? "0.55" : "1";
  row.style.cursor = disabled ? "default" : "pointer";
  addSearchRowHover(row, theme);

  const meta = createElement(doc, "span", {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) max-content",
    alignItems: "baseline",
    columnGap: "8px",
    minWidth: "0",
    color: theme.textMuted,
    fontSize: "10px",
    lineHeight: "14px",
  });
  const role = createElement(doc, "span", { fontWeight: "600" });
  role.textContent = getString(
    match.role === "user"
      ? "chat-history-search-user"
      : "chat-history-search-assistant",
  );
  const time = createElement(doc, "span", {
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  });
  time.textContent = formatTimestamp(match.messageTimestamp);
  meta.appendChild(role);
  meta.appendChild(time);

  const snippet = createElement(doc, "span", {
    color: theme.textSecondary,
    width: "100%",
    minWidth: "0",
    overflow: "hidden",
    display: "-webkit-box",
    webkitLineClamp: "2",
    webkitBoxOrient: "vertical",
    lineHeight: "17px",
    maxHeight: "34px",
    whiteSpace: "normal",
    overflowWrap: "anywhere",
    wordBreak: "break-word",
  });
  appendHighlightedSearchText(
    snippet,
    match.snippet,
    match.highlightRanges,
    doc,
    theme,
  );

  row.appendChild(meta);
  row.appendChild(snippet);
  row.addEventListener("click", (event) => {
    event.stopPropagation();
    if (row.disabled) return;
    invokeSafely(
      () =>
        callbacks.onSelectMessageMatch(
          group.sessionId,
          match.messageId,
          match,
          group,
        ),
      callbacks.onSearchError,
    );
  });
  return row;
}

function getSearchErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return String((error as { code?: unknown }).code || "");
}

function applySearchPage(
  state: HistoryDropdownState,
  normalizedQuery: string,
  page: ChatHistorySearchPage,
  append: boolean,
): void {
  const existingGroups = append ? state.groups : [];
  const groupById = new Map(
    existingGroups.map((group) => [group.sessionId, group] as const),
  );
  for (const group of page.groups) {
    groupById.set(group.sessionId, group);
    state.expandedCounts[group.sessionId] = group.matches.length;
  }
  state.groups = [...groupById.values()];
  state.cache = {
    normalizedQuery,
    queryKey: page.queryKey,
    searchRevision: page.searchRevision,
  };
  state.sessionCursor = page.nextSessionCursor;
}

function mergeMessagePage(
  state: HistoryDropdownState,
  page: ChatHistoryMessagePage,
): void {
  const group = state.groups.find(
    (candidate) => candidate.sessionId === page.sessionId,
  );
  if (!group) return;

  const matches = new Map(
    group.matches.map((match) => [match.messageId, match] as const),
  );
  for (const match of page.matches) {
    matches.set(match.messageId, match);
  }
  group.matches = [...matches.values()];
  group.totalMessageMatches = page.totalMessageMatches;
  group.nextMessageCursor = page.nextMessageCursor;
  state.expandedCounts[group.sessionId] = group.matches.length;
}

function renderSearchEmptyState(
  body: HTMLElement,
  doc: Document,
  theme: ThemeColors,
): void {
  const empty = createElement(doc, "div", {
    padding: "24px 16px",
    textAlign: "center",
    color: theme.textMuted,
    fontSize: "13px",
  });
  empty.className = "history-search-empty";
  empty.textContent = getString("chat-history-search-no-results");
  body.appendChild(empty);
}

function renderSearchGroup(
  container: HTMLElement,
  doc: Document,
  group: ChatHistorySearchGroup,
  theme: ThemeColors,
  callbacks: HistoryDropdownSearchCallbacks,
  state: HistoryDropdownState,
  onExpand: (sessionId: string) => void,
  actionsDisabled: boolean,
): void {
  const wrapper = createElement(doc, "section", {
    padding: "10px 8px 12px",
    borderBottom: `1px solid ${theme.borderColor}`,
  });
  wrapper.className = "history-search-group";
  wrapper.setAttribute("data-session-id", group.sessionId);

  const header = createElement(doc, "div", {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) max-content",
    alignItems: "baseline",
    columnGap: "10px",
    padding: "2px 6px 6px",
  });
  header.className = "history-search-group-header";
  const title = createElement(doc, "div", {
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: theme.textPrimary,
    fontSize: "13px",
    fontWeight: "600",
    lineHeight: "18px",
  });
  title.textContent =
    group.sessionTitle ||
    getString("chat-history-title", {
      args: { time: formatTimestamp(group.sessionUpdatedAt) },
    });
  const updatedAt = createElement(doc, "div", {
    flexShrink: "0",
    color: theme.textMuted,
    fontSize: "10px",
    lineHeight: "14px",
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  });
  updatedAt.textContent = formatTimestamp(group.sessionUpdatedAt);
  header.appendChild(title);
  header.appendChild(updatedAt);
  wrapper.appendChild(header);

  if (group.titleMatch) {
    wrapper.appendChild(
      createTitleMatchRow(doc, group, theme, callbacks, actionsDisabled),
    );
  }
  for (const match of group.matches) {
    wrapper.appendChild(
      createMessageMatchRow(
        doc,
        group,
        match,
        theme,
        callbacks,
        actionsDisabled,
      ),
    );
  }

  const remaining = Math.max(
    0,
    group.totalMessageMatches - group.matches.length,
  );
  if (remaining > 0 && group.nextMessageCursor) {
    const expand = createSearchActionRow(doc, theme);
    expand.className = "history-search-expand-matches";
    expand.style.color = theme.textSecondary;
    expand.style.textAlign = "center";
    expand.style.fontWeight = "500";
    expand.textContent = getString("chat-history-search-more-matches", {
      args: { count: remaining },
    });
    const pending =
      actionsDisabled || state.pendingExpansionSessionIds.has(group.sessionId);
    expand.disabled = pending;
    expand.style.opacity = pending ? "0.55" : "1";
    expand.style.cursor = pending ? "default" : "pointer";
    expand.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!expand.disabled) onExpand(group.sessionId);
    });
    wrapper.appendChild(expand);
  }

  container.appendChild(wrapper);
}

/**
 * State for history dropdown pagination
 */
export interface HistoryDropdownState {
  allSessions: SessionInfo[];
  displayedCount: number;
  query: string;
  normalizedQuery: string;
  cache: HistorySearchCache | null;
  groups: ChatHistorySearchGroup[];
  expandedCounts: Record<string, number>;
  sessionCursor?: string;
  scrollTop: number;
  generation: number;
  debounceHandle: ReturnType<typeof setTimeout> | null;
  isComposing: boolean;
  searchPending: boolean;
  pendingExpansionSessionIds: Set<string>;
}

/**
 * Create initial state for history dropdown
 */
export function createHistoryDropdownState(): HistoryDropdownState {
  return {
    allSessions: [],
    displayedCount: 0,
    query: "",
    normalizedQuery: "",
    cache: null,
    groups: [],
    expandedCounts: {},
    sessionCursor: undefined,
    scrollTop: 0,
    generation: 0,
    debounceHandle: null,
    isComposing: false,
    searchPending: false,
    pendingExpansionSessionIds: new Set<string>(),
  };
}

function renderOrdinaryHistory(
  controller: HistoryDropdownSearchController,
): void {
  const { body, doc, state, theme, ordinaryCallbacks } = controller;
  if (!ordinaryCallbacks) return;
  body.textContent = "";
  state.displayedCount = 0;
  if (state.allSessions.length === 0) {
    const emptyMsg = createElement(doc, "div", {
      padding: "20px",
      textAlign: "center",
      color: chatColors.emptyText,
      fontSize: "13px",
    });
    emptyMsg.textContent = getString("chat-no-history");
    body.appendChild(emptyMsg);
    return;
  }
  renderMoreSessions(
    body,
    doc,
    state,
    theme,
    ordinaryCallbacks.onSelect,
    ordinaryCallbacks.onDelete,
    ordinaryCallbacks.onEditTitle,
  );
}

export function renderHistorySearchResults(
  dropdown: HTMLElement,
  doc: Document,
  state: HistoryDropdownState,
  theme: ThemeColors,
  callbacks: HistoryDropdownSearchCallbacks,
  onExpand?: (sessionId: string) => void,
  onNextSessions?: () => void,
): void {
  const body = getHistoryBody(dropdown);
  const preservedScrollTop = state.scrollTop;
  const actionsDisabled =
    state.cache !== null &&
    state.cache.normalizedQuery !== normalizeSearchValue(state.query);
  if (state.groups.length === 0 && state.searchPending) {
    body.textContent = "";
    body.scrollTop = preservedScrollTop;
    return;
  }
  body.textContent = "";

  if (state.groups.length === 0) {
    renderSearchEmptyState(body, doc, theme);
    body.scrollTop = preservedScrollTop;
    return;
  }

  for (const group of state.groups) {
    renderSearchGroup(
      body,
      doc,
      group,
      theme,
      callbacks,
      state,
      onExpand || (() => {}),
      actionsDisabled,
    );
  }

  if (state.sessionCursor && onNextSessions) {
    const next = createSearchActionRow(doc, theme);
    next.className = "history-search-next-sessions";
    next.style.padding = "12px 14px";
    next.style.color = theme.textSecondary;
    next.style.textAlign = "center";
    next.style.fontWeight = "500";
    next.textContent = getString("chat-history-search-more-sessions");
    const pending = state.searchPending || actionsDisabled;
    next.disabled = pending;
    next.style.opacity = pending ? "0.55" : "1";
    next.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!next.disabled) onNextSessions();
    });
    body.appendChild(next);
  }
  body.scrollTop = preservedScrollTop;
}

async function executePrimarySearch(
  controller: HistoryDropdownSearchController,
  append = false,
): Promise<void> {
  const { state, callbacks } = controller;
  const normalizedQuery = normalizeSearchValue(state.query);
  if (
    controller.disposed ||
    normalizedCodePointLength(normalizedQuery) < HISTORY_SEARCH_MIN_CODE_POINTS
  ) {
    return;
  }
  if (append && state.searchPending) return;

  const generation = state.generation;
  const expectedCursor = append ? state.sessionCursor : undefined;
  state.searchPending = true;
  renderHistorySearchResults(
    controller.dropdown,
    controller.doc,
    state,
    controller.theme,
    callbacks,
    (sessionId) => void expandSearchGroup(controller, sessionId),
    () => void runPrimarySearch(controller, true),
  );

  try {
    const page = await callbacks.searchGroups({
      query: state.query,
      sessionLimit: SESSIONS_PER_PAGE,
      sessionCursor: expectedCursor,
      initialMessageLimit: HISTORY_SEARCH_INITIAL_MESSAGE_LIMIT,
    });
    if (
      controller.disposed ||
      generation !== state.generation ||
      normalizeSearchValue(state.query) !== normalizedQuery
    ) {
      return;
    }
    if (
      append &&
      state.cache &&
      (page.queryKey !== state.cache.queryKey ||
        page.searchRevision !== state.cache.searchRevision ||
        expectedCursor !== state.sessionCursor)
    ) {
      return;
    }

    const desiredCounts = { ...state.expandedCounts };
    applySearchPage(state, normalizedQuery, page, append);
    state.searchPending = false;
    renderHistorySearchResults(
      controller.dropdown,
      controller.doc,
      state,
      controller.theme,
      callbacks,
      (sessionId) => void expandSearchGroup(controller, sessionId),
      () => void runPrimarySearch(controller, true),
    );
    for (const group of page.groups) {
      const desired = desiredCounts[group.sessionId] || 0;
      if (desired > group.matches.length && group.nextMessageCursor) {
        void expandSearchGroup(controller, group.sessionId, desired);
      }
    }
  } catch (error) {
    if (generation !== state.generation || controller.disposed) return;
    state.searchPending = false;
    if (getSearchErrorCode(error) === "STALE_SEARCH") {
      state.sessionCursor = undefined;
      void runPrimarySearch(controller, false);
      return;
    }
    callbacks.onSearchError?.(error);
    renderHistorySearchResults(
      controller.dropdown,
      controller.doc,
      state,
      controller.theme,
      callbacks,
      (sessionId) => void expandSearchGroup(controller, sessionId),
      () => void runPrimarySearch(controller, true),
    );
  } finally {
    if (!controller.disposed && generation === state.generation) {
      const needsPendingRefresh = state.searchPending;
      state.searchPending = false;
      if (needsPendingRefresh) {
        renderHistorySearchResults(
          controller.dropdown,
          controller.doc,
          state,
          controller.theme,
          callbacks,
          (sessionId) => void expandSearchGroup(controller, sessionId),
          () => void runPrimarySearch(controller, true),
        );
      }
    }
  }
}

function runPrimarySearch(
  controller: HistoryDropdownSearchController,
  append = false,
): Promise<void> {
  if (controller.disposed) return Promise.resolve();

  const active = controller.primarySearchActive;
  if (active) {
    // Session-page clicks are disabled while a primary request is active. A
    // raw-query refresh supersedes any older queued refresh and runs as soon as
    // the current non-cancellable storage request settles.
    if (append) return active;
    controller.pendingPrimarySearch?.resolve();
    return new Promise<void>((resolve) => {
      controller.pendingPrimarySearch = { append, resolve };
    });
  }

  const request = executePrimarySearch(controller, append);
  controller.primarySearchActive = request;
  void request.finally(() => {
    if (controller.primarySearchActive === request) {
      controller.primarySearchActive = null;
    }
    const pending = controller.pendingPrimarySearch;
    controller.pendingPrimarySearch = null;
    if (!pending) return;
    if (controller.disposed) {
      pending.resolve();
      return;
    }
    void runPrimarySearch(controller, pending.append).finally(pending.resolve);
  });
  return request;
}

async function expandSearchGroup(
  controller: HistoryDropdownSearchController,
  sessionId: string,
  desiredCount?: number,
): Promise<void> {
  const { state, callbacks } = controller;
  const cache = state.cache;
  const group = state.groups.find(
    (candidate) => candidate.sessionId === sessionId,
  );
  if (
    !cache ||
    !group ||
    !group.nextMessageCursor ||
    state.pendingExpansionSessionIds.has(sessionId) ||
    controller.disposed
  ) {
    return;
  }

  const generation = state.generation;
  const expectedCursor = group.nextMessageCursor;
  const targetCount =
    desiredCount || group.matches.length + HISTORY_SEARCH_EXPANSION_LIMIT;
  state.pendingExpansionSessionIds.add(sessionId);
  renderHistorySearchResults(
    controller.dropdown,
    controller.doc,
    state,
    controller.theme,
    callbacks,
    (nextSessionId) => void expandSearchGroup(controller, nextSessionId),
    () => void runPrimarySearch(controller, true),
  );

  try {
    const page = await callbacks.searchSessionMatches({
      query: state.query,
      queryKey: cache.queryKey,
      searchRevision: cache.searchRevision,
      sessionId,
      limit: Math.min(
        HISTORY_SEARCH_EXPANSION_LIMIT,
        Math.max(1, targetCount - group.matches.length),
      ),
      messageCursor: expectedCursor,
    });
    const latestGroup = state.groups.find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (
      controller.disposed ||
      generation !== state.generation ||
      state.cache?.queryKey !== cache.queryKey ||
      state.cache?.searchRevision !== cache.searchRevision ||
      latestGroup?.nextMessageCursor !== expectedCursor ||
      page.queryKey !== cache.queryKey ||
      page.searchRevision !== cache.searchRevision ||
      page.sessionId !== sessionId
    ) {
      return;
    }
    mergeMessagePage(state, page);
  } catch (error) {
    const requestIsCurrent =
      !controller.disposed &&
      generation === state.generation &&
      state.cache?.queryKey === cache.queryKey &&
      state.cache?.searchRevision === cache.searchRevision;
    if (!requestIsCurrent) return;
    if (getSearchErrorCode(error) === "STALE_SEARCH") {
      void runPrimarySearch(controller, false);
    } else {
      callbacks.onSearchError?.(error);
    }
  } finally {
    const requestIsCurrent =
      !controller.disposed &&
      generation === state.generation &&
      state.cache?.queryKey === cache.queryKey &&
      state.cache?.searchRevision === cache.searchRevision;
    if (requestIsCurrent) {
      state.pendingExpansionSessionIds.delete(sessionId);
      renderHistorySearchResults(
        controller.dropdown,
        controller.doc,
        state,
        controller.theme,
        callbacks,
        (nextSessionId) => void expandSearchGroup(controller, nextSessionId),
        () => void runPrimarySearch(controller, true),
      );
      const latestGroup = state.groups.find(
        (candidate) => candidate.sessionId === sessionId,
      );
      if (
        desiredCount &&
        latestGroup &&
        latestGroup.matches.length < desiredCount &&
        latestGroup.nextMessageCursor
      ) {
        void expandSearchGroup(controller, sessionId, desiredCount);
      }
    }
  }
}

function schedulePrimarySearch(
  controller: HistoryDropdownSearchController,
): void {
  const { state } = controller;
  if (state.debounceHandle) {
    clearTimeout(state.debounceHandle);
  }
  state.debounceHandle = setTimeout(() => {
    state.debounceHandle = null;
    void runPrimarySearch(controller, false);
  }, HISTORY_SEARCH_DEBOUNCE_MS);
}

/**
 * Attach the async grouped-search controller to the fixed dropdown shell.
 * ChatPanelEvents supplies storage and navigation callbacks without the UI
 * depending on ChatManager or SessionStorageService.
 */
export function setupHistoryDropdownSearch(
  dropdown: HTMLElement,
  doc: Document,
  state: HistoryDropdownState,
  theme: ThemeColors,
  callbacks: HistoryDropdownSearchCallbacks,
): () => void {
  searchControllers.get(dropdown)?.dispose?.();
  const input = getHistorySearchInput(dropdown);
  if (!input) {
    throw new Error("History dropdown search input is missing");
  }
  const clearButton = getHistorySearchClearButton(dropdown);
  if (!clearButton) {
    throw new Error("History dropdown search clear button is missing");
  }
  input.setAttribute("maxlength", String(MAX_SEARCH_QUERY_RAW_UTF16_LENGTH));
  const body = getHistoryBody(dropdown);
  const controller: HistoryDropdownSearchController & {
    dispose?: () => void;
  } = {
    dropdown,
    body,
    input,
    doc,
    state,
    theme,
    callbacks,
    primarySearchActive: null,
    pendingPrimarySearch: null,
    disposed: false,
  };
  searchControllers.set(dropdown, controller);
  input.value = state.query;
  body.scrollTop = state.scrollTop;

  const updateClearButtonVisibility = () => {
    clearButton.style.display = input.value ? "flex" : "none";
  };

  const onInput = () => {
    updateClearButtonVisibility();
    const previousNormalizedQuery = state.normalizedQuery;
    state.query = input.value;
    state.normalizedQuery = normalizeSearchValue(state.query);
    if (state.normalizedQuery !== previousNormalizedQuery) {
      state.expandedCounts = {};
    }
    state.generation += 1;
    state.pendingExpansionSessionIds.clear();
    if (state.debounceHandle) {
      clearTimeout(state.debounceHandle);
      state.debounceHandle = null;
    }
    controller.pendingPrimarySearch?.resolve();
    controller.pendingPrimarySearch = null;
    if (state.isComposing) return;

    if (
      normalizedCodePointLength(state.normalizedQuery) <
      HISTORY_SEARCH_MIN_CODE_POINTS
    ) {
      state.cache = null;
      state.groups = [];
      state.expandedCounts = {};
      state.sessionCursor = undefined;
      state.searchPending = false;
      state.scrollTop = 0;
      renderOrdinaryHistory(controller);
      return;
    }
    if (state.cache?.normalizedQuery === state.normalizedQuery) {
      renderHistorySearchResults(
        dropdown,
        doc,
        state,
        theme,
        callbacks,
        (sessionId) => void expandSearchGroup(controller, sessionId),
        () => void runPrimarySearch(controller, true),
      );
      return;
    }
    state.scrollTop = 0;
    state.searchPending = true;
    renderHistorySearchResults(
      dropdown,
      doc,
      state,
      theme,
      callbacks,
      (sessionId) => void expandSearchGroup(controller, sessionId),
      () => void runPrimarySearch(controller, true),
    );
    schedulePrimarySearch(controller);
  };
  const onCompositionStart = () => {
    state.isComposing = true;
  };
  const onCompositionEnd = () => {
    state.isComposing = false;
    onInput();
  };
  const onScroll = () => {
    state.scrollTop = body.scrollTop;
  };
  const onClear = () => {
    state.isComposing = false;
    input.value = "";
    onInput();
    input.focus();
  };

  input.addEventListener("input", onInput);
  input.addEventListener("compositionstart", onCompositionStart);
  input.addEventListener("compositionend", onCompositionEnd);
  body.addEventListener("scroll", onScroll);
  clearButton.addEventListener("click", onClear);
  updateClearButtonVisibility();

  const dispose = () => {
    if (controller.disposed) return;
    controller.disposed = true;
    if (state.debounceHandle) {
      clearTimeout(state.debounceHandle);
      state.debounceHandle = null;
    }
    controller.pendingPrimarySearch?.resolve();
    controller.pendingPrimarySearch = null;
    input.removeEventListener("input", onInput);
    input.removeEventListener("compositionstart", onCompositionStart);
    input.removeEventListener("compositionend", onCompositionEnd);
    body.removeEventListener("scroll", onScroll);
    clearButton.removeEventListener("click", onClear);
    if (searchControllers.get(dropdown) === controller) {
      searchControllers.delete(dropdown);
    }
  };
  controller.dispose = dispose;

  if (isHistorySearchActive(state) && state.groups.length > 0) {
    renderHistorySearchResults(
      dropdown,
      doc,
      state,
      theme,
      callbacks,
      (sessionId) => void expandSearchGroup(controller, sessionId),
      () => void runPrimarySearch(controller, true),
    );
  }
  return dispose;
}

export function refreshHistoryDropdownSearch(
  dropdown: HTMLElement,
): Promise<void> {
  const controller = searchControllers.get(dropdown);
  if (!controller || !isHistorySearchActive(controller.state)) {
    return Promise.resolve();
  }
  controller.state.generation += 1;
  controller.state.pendingExpansionSessionIds.clear();
  return runPrimarySearch(controller, false);
}

export function updateHistoryDropdownSearchTheme(
  dropdown: HTMLElement,
  theme: ThemeColors,
): void {
  const controller = searchControllers.get(dropdown);
  if (!controller) return;
  controller.theme = theme;
  if (isHistorySearchActive(controller.state)) {
    renderHistorySearchResults(
      dropdown,
      controller.doc,
      controller.state,
      theme,
      controller.callbacks,
      (sessionId) => void expandSearchGroup(controller, sessionId),
      () => void runPrimarySearch(controller, true),
    );
  }
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
  state.allSessions = sessions;
  const body = getHistoryBody(dropdown);
  const controller = searchControllers.get(dropdown);
  const ordinaryCallbacks: OrdinaryHistoryCallbacks = {
    onSelect,
    onDelete,
    onEditTitle,
  };
  if (controller) {
    controller.ordinaryCallbacks = ordinaryCallbacks;
  }

  // Opening or refreshing history must not overwrite an active search.
  if (isHistorySearchActive(state)) {
    if (controller && state.groups.length > 0) {
      renderHistorySearchResults(
        dropdown,
        doc,
        state,
        theme,
        controller.callbacks,
        (sessionId) => void expandSearchGroup(controller, sessionId),
        () => void runPrimarySearch(controller, true),
      );
    }
    return;
  }

  state.displayedCount = 0;
  body.textContent = "";

  if (sessions.length === 0) {
    const emptyMsg = createElement(doc, "div", {
      padding: "20px",
      textAlign: "center",
      color: chatColors.emptyText,
      fontSize: "13px",
    });
    emptyMsg.textContent = getString("chat-no-history");
    body.appendChild(emptyMsg);
  } else {
    // Render first page
    renderMoreSessions(
      body,
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
  dropdown.style.display = "flex";
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
