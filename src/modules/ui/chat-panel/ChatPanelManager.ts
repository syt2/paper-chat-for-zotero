/**
 * ChatPanelManager - Main panel lifecycle and coordination
 */

import { config } from "../../../../package.json";
import { getString } from "../../../utils/locale";
import { ChatManager, type ChatMessage, type ChatSession } from "../../chat";
import type {
  ExecutionPlan,
  ImageAttachment,
  FileAttachment,
  ToolApprovalState,
} from "../../../types/chat";
import type { ToolApprovalResolution } from "../../../types/tool";
import { getAuthManager } from "../../auth";
import { getProviderManager } from "../../providers";
import { isPaperChatQuotaError } from "../../providers/paperchat-errors";
import { getPref, setPref } from "../../../utils/prefs";

import type { AttachmentState, ChatPanelContext } from "./types";
import { chatColors } from "../../../utils/colors";
import {
  getCurrentTheme,
  updateCurrentTheme,
  applyThemeToContainer,
  setupThemeListener,
} from "./ChatPanelTheme";
import { createChatContainer } from "./ChatPanelBuilder";
import {
  ensureStreamingTypingIndicator,
  getStreamingContentSelector,
  getStreamingReasoningContainerSelector,
  getStreamingReasoningSelector,
  renderMessages as renderMessageElementsBase,
  scrollChatHistoryToBottom,
  shouldAutoScrollChatHistory,
  updateChatHistoryScrollBottomButton,
  updateExecutionPlanView,
  updateApprovalView,
  type ApprovalViewTransitionState,
} from "./MessageRenderer";
import {
  type MarkdownRenderOptions,
  renderMarkdownToElement,
  stripIncompleteTrailingToolCall,
} from "./MarkdownRenderer";
import { navigateToPdfQuote } from "./PdfQuoteNavigator";
import {
  setupEventHandlers,
  updateAttachmentsPreviewDisplay,
  updateUserBarDisplay,
  updatePdfCheckboxVisibilityForItem,
  focusInput,
  setActiveReaderItemFn,
  setTogglePanelModeFn,
  updatePanelModeButtonIcon,
  updateModelSelectorDisplay,
  refreshCheckinDisplay,
} from "./ChatPanelEvents";
import { loadCachedRatios } from "../../preferences/ModelsFetcher";
import { Guide } from "../Guide";
import { ANALYTICS_EVENTS, getAnalyticsService } from "../../analytics";
import { refreshPaperChatNotice } from "../../providers/PaperChatNoticeService";

// Panel display mode: 'sidebar' or 'floating'
export type PanelMode = "sidebar" | "floating";
export type ChatPanelOpenSource = "menu" | "toolbar" | "unknown";

const APPROVAL_RESOLVED_ANIMATION_MS = 260;
const APPROVAL_ENTER_ANIMATION_MS = 220;
const STREAMING_TEXT_RENDER_INTERVAL_MS = 80;
const STREAMING_MARKDOWN_RENDER_INTERVAL_MS = 1200;
const STREAMING_TEXT_TAIL_ATTR = "data-streaming-text-tail";

type PendingApprovalRequest = ToolApprovalState["pendingRequests"][number];

type ApprovalPanelTransitionEntry = ApprovalViewTransitionState & {
  sessionId: string | null;
  timeoutId?: number;
};

const approvalPanelTransitions = new WeakMap<
  HTMLElement,
  ApprovalPanelTransitionEntry
>();

type StreamingTextRenderState = {
  messageId: string;
  pendingContent: string;
  lastRenderedContent: string;
  lastMarkdownContent: string;
  lastRenderAt: number;
  lastMarkdownRenderAt: number;
  timeoutId: ReturnType<typeof setTimeout> | null;
};

const streamingTextRenderStates = new WeakMap<
  HTMLElement,
  StreamingTextRenderState
>();

function cancelPendingStreamingTextRender(container: HTMLElement): void {
  const state = streamingTextRenderStates.get(container);
  if (!state) return;
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
  }
  streamingTextRenderStates.delete(container);
}

function shouldForceStreamingMarkdownRender(
  content: string,
  state: StreamingTextRenderState,
): boolean {
  if (!content.includes("<tool-call")) {
    return false;
  }

  if (stripIncompleteTrailingToolCall(content) !== content) {
    return true;
  }

  if (!state.lastMarkdownContent) {
    return true;
  }

  const incrementalContent = content.startsWith(state.lastMarkdownContent)
    ? content.slice(state.lastMarkdownContent.length)
    : content;

  return (
    incrementalContent.includes("<tool-call") ||
    incrementalContent.includes("</tool-call>")
  );
}

function renderStreamingTextNow(
  container: HTMLElement,
  manager: ChatManager,
  state: StreamingTextRenderState,
  content: string,
  messageId: string,
  markdownOptions: MarkdownRenderOptions,
): boolean {
  const activeMessage = manager
    .getActiveSession()
    ?.messages.find((message) => message.id === messageId);
  if (
    !activeMessage ||
    activeMessage.role !== "assistant" ||
    activeMessage.streamingState !== "in_progress"
  ) {
    return false;
  }

  const streamingEl = container.querySelector(
    getStreamingContentSelector(messageId),
  ) as HTMLElement | null;
  if (!streamingEl) {
    return false;
  }

  const contentReplacedAfterMarkdownRender =
    Boolean(state.lastMarkdownContent) &&
    !content.startsWith(state.lastMarkdownContent);
  if (contentReplacedAfterMarkdownRender) {
    state.lastMarkdownContent = "";
  }

  const now = Date.now();
  const shouldRenderMarkdown =
    contentReplacedAfterMarkdownRender ||
    shouldForceStreamingMarkdownRender(content, state) ||
    now - state.lastMarkdownRenderAt >= STREAMING_MARKDOWN_RENDER_INTERVAL_MS;

  if (shouldRenderMarkdown) {
    renderMarkdownToElement(streamingEl, content, messageId, markdownOptions);
    const tail = streamingEl.ownerDocument.createElement("span");
    tail.setAttribute(STREAMING_TEXT_TAIL_ATTR, "true");
    streamingEl.appendChild(tail);
    state.lastMarkdownContent = content;
    state.lastMarkdownRenderAt = now;
  } else if (state.lastMarkdownContent) {
    let tail = streamingEl.querySelector(
      `[${STREAMING_TEXT_TAIL_ATTR}]`,
    ) as HTMLElement | null;
    if (!tail) {
      tail = streamingEl.ownerDocument.createElement("span");
      tail.setAttribute(STREAMING_TEXT_TAIL_ATTR, "true");
      streamingEl.appendChild(tail);
    }
    tail.textContent = content.slice(state.lastMarkdownContent.length);
  } else if (streamingEl.textContent !== content) {
    streamingEl.textContent = content;
  }

  ensureStreamingTypingIndicator(streamingEl, getCurrentTheme());

  if (state.lastRenderedContent !== content) {
    const chatHistory = container.querySelector(
      "#chat-history",
    ) as HTMLElement | null;
    if (chatHistory && shouldAutoScrollChatHistory(chatHistory)) {
      scrollChatHistoryToBottom(chatHistory);
    } else if (chatHistory) {
      updateChatHistoryScrollBottomButton(chatHistory);
    }
  }
  state.lastRenderedContent = content;
  return true;
}

function scheduleStreamingTextRender(
  container: HTMLElement,
  manager: ChatManager,
  content: string,
  messageId: string,
  markdownOptions: MarkdownRenderOptions,
): void {
  let state = streamingTextRenderStates.get(container);
  if (!state || state.messageId !== messageId) {
    cancelPendingStreamingTextRender(container);
    state = {
      messageId,
      pendingContent: content,
      lastRenderedContent: "",
      lastMarkdownContent: "",
      lastRenderAt: 0,
      lastMarkdownRenderAt: 0,
      timeoutId: null,
    };
    streamingTextRenderStates.set(container, state);
  }

  state.pendingContent = content;
  if (state.pendingContent === state.lastRenderedContent) {
    return;
  }

  const render = () => {
    const latestState = streamingTextRenderStates.get(container);
    if (!latestState || latestState.messageId !== messageId) {
      return;
    }
    latestState.timeoutId = null;
    const nextContent = latestState.pendingContent;
    if (
      !renderStreamingTextNow(
        container,
        manager,
        latestState,
        nextContent,
        messageId,
        markdownOptions,
      )
    ) {
      streamingTextRenderStates.delete(container);
      return;
    }
    latestState.lastRenderAt = Date.now();
  };

  const elapsed = Date.now() - state.lastRenderAt;
  if (elapsed >= STREAMING_TEXT_RENDER_INTERVAL_MS) {
    if (state.timeoutId) {
      clearTimeout(state.timeoutId);
      state.timeoutId = null;
    }
    render();
    return;
  }

  if (!state.timeoutId) {
    state.timeoutId = setTimeout(
      render,
      STREAMING_TEXT_RENDER_INTERVAL_MS - elapsed,
    );
  }
}

function createPdfQuoteMarkdownRenderOptions(
  context: Pick<ChatPanelContext, "getCurrentItem">,
): MarkdownRenderOptions {
  return {
    blockquoteAction: {
      label: getString("chat-jump-to-quote"),
      title: getString("chat-jump-to-quote-title"),
      onClick: async (quoteText) => {
        await navigateToPdfQuote(quoteText, context.getCurrentItem());
      },
    },
  };
}

function getItemByLibraryKey(
  itemKey: string | null | undefined,
): Zotero.Item | null {
  if (!itemKey) {
    return null;
  }
  const libraryID = Zotero.Libraries.userLibraryID;
  return (
    (Zotero.Items.getByLibraryAndKey(libraryID, itemKey) as
      | Zotero.Item
      | false) || null
  );
}

function getQuoteNavigationItem(
  session: ChatSession | null | undefined,
  currentItem: Zotero.Item | null,
): Zotero.Item | null {
  return (
    getItemByLibraryKey(session?.lastActiveItemKey) ||
    currentItem ||
    getActiveReaderItem()
  );
}

function renderMessageElementsWithPdfQuoteAction(
  chatHistory: HTMLElement,
  emptyState: HTMLElement | null,
  messages: ChatMessage[],
  getNavigationItem: () => Zotero.Item | null,
  retryableErrorMessageId?: string,
  onReroll?: () => void | Promise<void>,
  onRerollError?: (error: Error) => void,
): void {
  renderMessageElementsBase(
    chatHistory,
    emptyState,
    messages,
    getCurrentTheme(),
    retryableErrorMessageId,
    onReroll,
    onRerollError,
    {
      markdown: createPdfQuoteMarkdownRenderOptions({
        getCurrentItem: getNavigationItem,
      }),
    },
  );
}

function buildApprovalActionsForContainer(
  manager: ChatManager,
  container: HTMLElement,
): {
  onResolveApproval: (
    requestId: string,
    resolution: ToolApprovalResolution,
  ) => void;
} {
  return {
    onResolveApproval: (requestId, resolution) => {
      const currentRequest = getPendingApprovalRequestSnapshot(
        container,
        manager,
        requestId,
      );
      const decision = manager.resolveToolApprovalRequest(
        requestId,
        resolution,
      );
      if (decision && currentRequest) {
        startApprovalTransition(
          container,
          manager,
          currentRequest,
          resolution,
          requestId,
        );
        continueApprovalTransition(container, manager, requestId);
      }
    },
  };
}

function updateExecutionInsetsForContainer(
  container: HTMLElement,
  manager: ChatManager,
  executionPlan?: ExecutionPlan,
): void {
  const theme = getCurrentTheme();
  const activeSession = manager.getActiveSession();
  const activeSessionId = activeSession?.id || null;
  const toolApprovalState = activeSession?.toolApprovalState;
  const approvalActions = buildApprovalActionsForContainer(manager, container);
  const planPanel = container.querySelector(
    "#chat-execution-plan-panel",
  ) as HTMLElement | null;
  const approvalPanel = container.querySelector(
    "#chat-execution-approval-panel",
  ) as HTMLElement | null;
  const transitionState = approvalPanel
    ? approvalPanelTransitions.get(approvalPanel)
    : undefined;

  if (
    approvalPanel &&
    transitionState &&
    transitionState.sessionId !== activeSessionId
  ) {
    clearApprovalTransition(approvalPanel);
  }

  if (planPanel) {
    updateExecutionPlanView(planPanel, theme, executionPlan, toolApprovalState);
  }
  if (approvalPanel) {
    updateApprovalView(
      approvalPanel,
      theme,
      executionPlan,
      toolApprovalState,
      approvalActions,
      approvalPanelTransitions.get(approvalPanel),
    );
  }
}

function getPendingApprovalRequestSnapshot(
  container: HTMLElement,
  manager: ChatManager,
  requestId: string,
): PendingApprovalRequest | undefined {
  const session = manager.getActiveSession();
  if (!session?.toolApprovalState?.pendingRequests.length) {
    return undefined;
  }

  const request = session.toolApprovalState.pendingRequests.find(
    (entry) => entry.id === requestId,
  );
  if (!request) {
    return undefined;
  }

  return clonePendingApprovalRequest(request, container.ownerDocument);
}

function clonePendingApprovalRequest(
  request: PendingApprovalRequest,
  doc: Document,
): PendingApprovalRequest {
  return (
    structuredCloneIfAvailable(request, doc.defaultView) || {
      ...request,
      descriptor: { ...request.descriptor },
      request: {
        ...request.request,
        toolCall: {
          ...request.request.toolCall,
          function: { ...request.request.toolCall.function },
        },
        args: { ...request.request.args },
      },
    }
  );
}

function structuredCloneIfAvailable<T>(
  value: T,
  view?: Window | null,
): T | null {
  const clone = view?.structuredClone || globalThis.structuredClone;
  if (typeof clone !== "function") {
    return null;
  }
  try {
    return clone(value);
  } catch {
    return null;
  }
}

function getApprovalPanel(container: HTMLElement): HTMLElement | null {
  return container.querySelector(
    "#chat-execution-approval-panel",
  ) as HTMLElement | null;
}

function clearApprovalTransition(panel: HTMLElement | null): void {
  if (!panel) {
    return;
  }

  const existing = approvalPanelTransitions.get(panel);
  if (typeof existing?.timeoutId === "number") {
    const view = panel.ownerDocument?.defaultView;
    (view || window).clearTimeout(existing.timeoutId);
  }
  approvalPanelTransitions.delete(panel);
}

function rerenderApprovalPanel(
  container: HTMLElement,
  manager: ChatManager,
): void {
  updateExecutionInsetsForContainer(
    container,
    manager,
    manager.getActiveSession()?.executionPlan,
  );
}

function startApprovalTransition(
  container: HTMLElement,
  manager: ChatManager,
  request: PendingApprovalRequest,
  resolution: ToolApprovalResolution,
  requestId: string,
): void {
  const panel = getApprovalPanel(container);
  if (!panel || request.id !== requestId) {
    return;
  }

  clearApprovalTransition(panel);
  approvalPanelTransitions.set(panel, {
    phase: "resolved",
    request,
    resolution,
    sessionId: manager.getActiveSession()?.id || null,
    nextPendingCount: 0,
  });
  rerenderApprovalPanel(container, manager);
}

function continueApprovalTransition(
  container: HTMLElement,
  manager: ChatManager,
  requestId: string,
): void {
  const panel = getApprovalPanel(container);
  const state = panel ? approvalPanelTransitions.get(panel) : undefined;
  if (!panel || !state || state.request.id !== requestId) {
    return;
  }

  const nextPendingCount =
    manager.getActiveSession()?.toolApprovalState?.pendingRequests.length || 0;
  const view = panel.ownerDocument?.defaultView || window;

  const timeoutId = view.setTimeout(() => {
    const current = approvalPanelTransitions.get(panel);
    if (!current || current.request.id !== requestId) {
      return;
    }

    if (nextPendingCount > 0) {
      approvalPanelTransitions.set(panel, {
        ...current,
        phase: "entering",
        nextPendingCount,
      });
      rerenderApprovalPanel(container, manager);

      const settleTimeoutId = view.setTimeout(() => {
        const latest = approvalPanelTransitions.get(panel);
        if (!latest || latest.request.id !== requestId) {
          return;
        }
        clearApprovalTransition(panel);
        rerenderApprovalPanel(container, manager);
      }, APPROVAL_ENTER_ANIMATION_MS);

      approvalPanelTransitions.set(panel, {
        ...(approvalPanelTransitions.get(panel) || current),
        timeoutId: settleTimeoutId,
      });
      return;
    }

    clearApprovalTransition(panel);
    rerenderApprovalPanel(container, manager);
  }, APPROVAL_RESOLVED_ANIMATION_MS);

  approvalPanelTransitions.set(panel, {
    ...state,
    nextPendingCount,
    timeoutId,
  });
}

// Floating window default size
const FLOATING_WIDTH = 420;
const FLOATING_HEIGHT = 600;

// Initialize the events module with the getActiveReaderItem function reference
// This is done immediately to avoid issues with early calls
let eventsInitialized = false;

/**
 * Get current active Zotero item from reader
 */
export function getActiveReaderItem(): Zotero.Item | null {
  const mainWindow = Zotero.getMainWindow() as Window & {
    Zotero_Tabs?: { selectedID: string };
  };
  const tabs = mainWindow.Zotero_Tabs;
  if (!tabs) return null;

  const reader = Zotero.Reader.getByTabID(tabs.selectedID);
  if (reader) {
    const itemID = reader.itemID;
    if (itemID) {
      return Zotero.Items.get(itemID) as Zotero.Item;
    }
  }
  return null;
}

// Singleton state
let chatManager: ChatManager | null = null;
let chatContainer: HTMLElement | null = null;
let resizeHandler: (() => void) | null = null;
let sidebarObserver: MutationObserver | null = null;
let tabNotifierID: string | null = null;
let globalTabNotifierID: string | null = null; // Persistent notifier for sidebar sync
let contentInitialized = false;
let moduleCurrentItem: Zotero.Item | null = null;
let themeCleanup: (() => void) | null = null;

// Panel mode state
let currentPanelMode: PanelMode = "sidebar";

// Floating window reference
let floatingWindow: Window | null = null;
let floatingContainer: HTMLElement | null = null;
let floatingContentInitialized = false;
let floatingTabNotifierID: string | null = null;
let panelVisibleSince: number | null = null;
let panelOpenSource: ChatPanelOpenSource = "unknown";
let suppressFloatingUnloadTracking = false;

// Attachment state
let pendingImages: ImageAttachment[] = [];
let pendingFiles: FileAttachment[] = [];
let pendingSelectedText: string | null = null;

/**
 * Get current panel mode
 */
export function getPanelMode(): PanelMode {
  return currentPanelMode;
}

/**
 * Set panel mode and update display
 */
export function setPanelMode(mode: PanelMode): void {
  if (currentPanelMode === mode) return;

  const wasShown = isPanelShown();
  const previousMode = currentPanelMode;

  currentPanelMode = mode;
  setPref("panelMode", mode);

  if (wasShown) {
    // Close the previous mode's panel
    if (previousMode === "sidebar") {
      hideSidebarPanel();
    } else {
      closeFloatingWindow();
    }

    // Open the new mode's panel
    if (mode === "sidebar") {
      showSidebarPanel();
    } else {
      openFloatingWindow();
    }
  }

  ztoolkit.log(`Panel mode changed to: ${mode}`);
}

/**
 * Toggle panel mode between sidebar and floating
 */
export function togglePanelMode(): void {
  const newMode = currentPanelMode === "sidebar" ? "floating" : "sidebar";
  setPanelMode(newMode);
}

/**
 * Load panel mode from preferences
 */
function loadPanelMode(): void {
  const savedMode = getPref("panelMode") as PanelMode | undefined;
  if (savedMode === "sidebar" || savedMode === "floating") {
    currentPanelMode = savedMode;
  }
}

/**
 * Initialize the events module with function references
 */
function initializeEventsModule(): void {
  if (!eventsInitialized) {
    setActiveReaderItemFn(getActiveReaderItem);
    setTogglePanelModeFn(togglePanelMode);
    eventsInitialized = true;
  }
}

/**
 * Get or create the ChatManager instance
 */
export function getChatManager(): ChatManager {
  if (!chatManager) {
    chatManager = new ChatManager();
  }
  initializeEventsModule();
  return chatManager;
}

/**
 * Get the current sidebar element based on active tab
 * Tab types: 'library', 'reader', 'note'
 * - reader and note tabs use #zotero-context-pane
 * - library tab uses #zotero-item-pane
 */
function getSidebar(): HTMLElement | null {
  const mainWindow = Zotero.getMainWindow() as Window & {
    Zotero_Tabs?: { selectedType: string };
  };
  const currentTab = mainWindow.Zotero_Tabs?.selectedType;
  // Both 'reader' and 'note' tabs use context pane
  const useContextPane = currentTab === "reader" || currentTab === "note";
  const paneName = useContextPane
    ? "#zotero-context-pane"
    : "#zotero-item-pane";
  return mainWindow.document.querySelector(paneName) as HTMLElement | null;
}

/**
 * Get the splitter element
 * Tab types: 'library', 'reader', 'note'
 * - reader and note tabs use #zotero-context-splitter
 * - library tab uses #zotero-items-splitter
 */
function getSplitter(): HTMLElement | null {
  const mainWindow = Zotero.getMainWindow() as Window & {
    Zotero_Tabs?: { selectedType: string };
  };
  const currentTab = mainWindow.Zotero_Tabs?.selectedType;
  // Both 'reader' and 'note' tabs use context splitter
  const useContextSplitter = currentTab === "reader" || currentTab === "note";
  const splitterName = useContextSplitter
    ? "#zotero-context-splitter"
    : "#zotero-items-splitter";
  return mainWindow.document.querySelector(splitterName) as HTMLElement | null;
}

/**
 * Expand the sidebar (set collapsed to false)
 */
function expandSidebar(): void {
  const sidebar = getSidebar();
  if (sidebar?.getAttribute("collapsed") === "true") {
    sidebar.setAttribute("collapsed", "false");
    const splitter = getSplitter();
    if (splitter) {
      splitter.setAttribute("state", "");
    }
  }
}

/**
 * Collapse the sidebar (set collapsed to true)
 */
function collapseSidebar(): void {
  const sidebar = getSidebar();
  if (sidebar && sidebar.getAttribute("collapsed") !== "true") {
    sidebar.setAttribute("collapsed", "true");
    const splitter = getSplitter();
    if (splitter) {
      splitter.setAttribute("state", "collapsed");
    }
  }
}

/**
 * Update sidebar container position
 */
function updateSidebarContainerPosition(): void {
  if (!chatContainer) return;

  const sidebar = getSidebar();
  if (!sidebar) return;

  // Ensure sidebar is visible FIRST before getting dimensions
  expandSidebar();

  // Hide drag bar in sidebar mode
  const dragBar = chatContainer.querySelector("#chat-drag-bar") as HTMLElement;
  if (dragBar) {
    dragBar.style.display = "none";
  }

  // Use requestAnimationFrame to ensure layout is updated after expanding
  const win = Zotero.getMainWindow();
  win.requestAnimationFrame(() => {
    if (!chatContainer || !sidebar) return;

    const rect = sidebar.getBoundingClientRect();
    chatContainer.style.width = `${rect.width}px`;
    chatContainer.style.height = `${rect.height}px`;
    chatContainer.style.left = `${rect.x}px`;
    chatContainer.style.top = `${rect.y}px`;
    chatContainer.style.right = "auto";
    chatContainer.style.bottom = "auto";
    chatContainer.style.borderRadius = "0";
    chatContainer.style.boxShadow = "none";
    chatContainer.style.border = "none";
    chatContainer.style.borderLeft = "1px solid var(--fill-quinary)";
  });
}

/**
 * Update container size based on current panel mode
 */
function updateContainerSize(): void {
  if (currentPanelMode === "sidebar") {
    updateSidebarContainerPosition();
  }
}

/**
 * Open floating window
 */
function openFloatingWindow(): boolean {
  // Close existing floating window if any
  if (floatingWindow && !floatingWindow.closed) {
    floatingWindow.focus();
    return true;
  }

  // Reset state before opening new window
  floatingWindow = null;
  floatingContainer = null;
  floatingContentInitialized = false;

  const mainWindow = Zotero.getMainWindow();

  // Calculate position (center on main window)
  const width = FLOATING_WIDTH;
  const height = FLOATING_HEIGHT;
  const left = mainWindow.screenX + (mainWindow.outerWidth - width) / 2;
  const top = mainWindow.screenY + (mainWindow.outerHeight - height) / 2;

  // Open new window using openDialog for better control
  floatingWindow = (
    mainWindow as Window & { openDialog: (...args: unknown[]) => Window }
  ).openDialog(
    `chrome://${config.addonRef}/content/chatWindow.xhtml`,
    "paperchat-chat-window",
    `chrome,dialog=no,resizable=yes,centerscreen,width=${width},height=${height},left=${left},top=${top}`,
  );

  if (!floatingWindow) {
    ztoolkit.log("Failed to open floating window");
    return false;
  }

  // Wait for window to load, then initialize content
  floatingWindow.addEventListener("load", () => {
    ztoolkit.log("Floating window load event fired");
    initializeFloatingWindowContent();

    // Handle window close - only after content is loaded
    floatingWindow?.addEventListener("unload", () => {
      ztoolkit.log("Floating window unload event");
      if (!suppressFloatingUnloadTracking) {
        trackChatPanelClosed();
      }
      suppressFloatingUnloadTracking = false;
      // Immediately reset state
      floatingWindow = null;
      floatingContainer = null;
      floatingContentInitialized = false;
      updateToolbarButtonState(false);
    });
  });

  ztoolkit.log("Floating window opened");
  return true;
}

/**
 * Initialize floating window content
 */
function initializeFloatingWindowContent(): void {
  if (!floatingWindow || floatingContentInitialized) {
    return;
  }

  const doc = floatingWindow.document;
  const root = doc.getElementById("chat-window-root");

  if (!root) {
    ztoolkit.log("Chat window root not found");
    return;
  }

  // Initialize theme
  updateCurrentTheme();

  // Create chat container in floating window
  floatingContainer = createChatContainer(doc, getCurrentTheme());

  // Move container into the root (it was appended to documentElement by createChatContainer)
  if (floatingContainer.parentElement) {
    floatingContainer.parentElement.removeChild(floatingContainer);
  }
  root.appendChild(floatingContainer);

  // Style adjustments for floating window
  floatingContainer.style.display = "block";
  floatingContainer.style.position = "relative";
  floatingContainer.style.width = "100%";
  floatingContainer.style.height = "100%";
  floatingContainer.style.borderLeft = "none";
  floatingContainer.style.border = "none";

  // Hide drag bar (window has its own title bar)
  const dragBar = floatingContainer.querySelector(
    "#chat-drag-bar",
  ) as HTMLElement;
  if (dragBar) {
    dragBar.style.display = "none";
  }

  // Update mode button icon for floating mode
  updatePanelModeButtonIcon(floatingContainer, currentPanelMode);

  // Initialize chat content
  initializeFloatingChatContent();
  floatingContentInitialized = true;
}

/**
 * Common initialization logic for chat content (shared between sidebar and floating)
 */
async function initializeChatContentCommon(
  container: HTMLElement,
): Promise<void> {
  const authManager = getAuthManager();
  const context = createContext(container);

  // Load cached model ratios for PaperChat
  loadCachedRatios();

  // Initialize auth
  await authManager.initialize();
  context.updateUserBar();

  // Set auth callbacks
  authManager.addListener({
    onBalanceUpdate: () => context.updateUserBar(),
    onLoginStatusChange: () => {
      context.updateUserBar();
      // Re-fetch check-in status on login status change (e.g. auto-relogin after session expiry)
      if (authManager.isLoggedIn()) {
        refreshCheckinDisplay(container, authManager);
      }
    },
  });

  // Set provider change callback
  const providerManager = getProviderManager();
  providerManager.setOnProviderChange(() => {
    context.updateUserBar();
    updateModelSelectorDisplay(container);
    const activeSession = manager.getActiveSession();
    if (activeSession) {
      context.renderMessages(activeSession.messages);
    }
  });

  // Setup event handlers
  setupEventHandlers(context);

  // Set up chat manager callbacks
  const manager = getChatManager();
  setupChatManagerCallbacks(manager, context, container);

  // Initialize ChatManager (handles migration and session loading)
  await manager.init();

  // Get current item from reader
  const activeItem = getActiveReaderItem();
  if (activeItem) {
    moduleCurrentItem = activeItem;
    manager.setCurrentItemKey(activeItem.key);
  } else {
    moduleCurrentItem = null;
    manager.setCurrentItemKey(null);
  }

  // Update PDF checkbox visibility
  await context.updatePdfCheckboxVisibility(moduleCurrentItem);

  // Load active session and render
  const session = manager.getActiveSession();
  if (session) {
    context.renderMessages(session.messages);
    context.renderExecutionPlan(session.executionPlan);
  }
  updateModelSelectorDisplay(container);

  focusInput(container);
}

/**
 * Refresh chat for current item (works for both sidebar and floating)
 * Note: This updates the current item tracking but does NOT switch sessions
 */
async function refreshChatForContainer(container: HTMLElement): Promise<void> {
  const activeItem = getActiveReaderItem();
  const manager = getChatManager();

  // Update current item tracking (session remains the same)
  if (activeItem) {
    moduleCurrentItem = activeItem;
    manager.setCurrentItemKey(activeItem.key);
  } else {
    moduleCurrentItem = null;
    manager.setCurrentItemKey(null);
  }

  // Update PDF checkbox visibility
  await updatePdfCheckboxVisibilityForItem(
    container,
    moduleCurrentItem,
    manager,
  );

  // Render current session messages (session doesn't change on tab switch)
  const session = manager.getActiveSession();
  const chatHistory = container.querySelector("#chat-history") as HTMLElement;
  const emptyState = container.querySelector(
    "#chat-empty-state",
  ) as HTMLElement;
  if (chatHistory && session) {
    renderMessageElementsWithPdfQuoteAction(
      chatHistory,
      emptyState,
      session.messages,
      () => getQuoteNavigationItem(session, moduleCurrentItem),
    );
    updateExecutionInsetsForContainer(
      container,
      manager,
      session.executionPlan,
    );
  }

  focusInput(container);
}

/**
 * Initialize chat content for floating window
 */
async function initializeFloatingChatContent(): Promise<void> {
  if (!floatingContainer) return;

  // Add tab notifier for floating window
  if (!floatingTabNotifierID) {
    floatingTabNotifierID = Zotero.Notifier.registerObserver(
      {
        notify: async () => {
          if (floatingContainer) {
            await refreshChatForContainer(floatingContainer);
          }
        },
      },
      ["tab"],
      `${config.addonRef}-floating-tab-notifier`,
    );
  }

  await initializeChatContentCommon(floatingContainer);
}

/**
 * Close floating window
 */
function closeFloatingWindow(): void {
  // Unregister tab notifier
  if (floatingTabNotifierID) {
    Zotero.Notifier.unregisterObserver(floatingTabNotifierID);
    floatingTabNotifierID = null;
  }

  if (floatingContainer) {
    cancelPendingStreamingTextRender(floatingContainer);
  }

  if (floatingWindow && !floatingWindow.closed) {
    suppressFloatingUnloadTracking = true;
    floatingWindow.close();
  } else {
    suppressFloatingUnloadTracking = false;
  }
  floatingWindow = null;
  floatingContainer = null;
  floatingContentInitialized = false;
}

/**
 * Show sidebar panel
 */
function showSidebarPanel(): boolean {
  const doc = Zotero.getMainWindow().document;
  const win = Zotero.getMainWindow();
  const manager = getChatManager();

  // Create container if not exists
  if (!chatContainer || !chatContainer.isConnected) {
    if (chatContainer) {
      chatContainer = null;
    }
    chatContainer = createChatContainer(doc, getCurrentTheme());
    contentInitialized = false;
  }

  // Update position
  updateSidebarContainerPosition();

  // Update mode button icon
  updatePanelModeButtonIcon(chatContainer, currentPanelMode);

  // Add resize listener
  if (!resizeHandler) {
    resizeHandler = () => updateContainerSize();
    win.addEventListener("resize", resizeHandler);
  }

  // Add theme change listener
  if (!themeCleanup) {
    themeCleanup = setupThemeListener(() => {
      if (chatContainer) {
        applyThemeToContainer(chatContainer);
        const session = manager.getActiveSession();
        if (session) {
          createContext(chatContainer).renderExecutionPlan(
            session.executionPlan,
          );
        }
      }
      if (floatingContainer) {
        applyThemeToContainer(floatingContainer);
        const session = manager.getActiveSession();
        if (session) {
          createContext(floatingContainer).renderExecutionPlan(
            session.executionPlan,
          );
        }
      }
    });

    // 启动时延迟检测主题，因为窗口可能还没完全应用暗黑模式
    // 使用 requestAnimationFrame + setTimeout 确保在 DOM 完全渲染后检测
    // MutationObserver 会处理后续的动态变化
    const reapplyTheme = () => {
      updateCurrentTheme();
      if (chatContainer) {
        applyThemeToContainer(chatContainer);
        const session = manager.getActiveSession();
        if (session) {
          createContext(chatContainer).renderExecutionPlan(
            session.executionPlan,
          );
        }
      }
      if (floatingContainer) {
        applyThemeToContainer(floatingContainer);
        const session = manager.getActiveSession();
        if (session) {
          createContext(floatingContainer).renderExecutionPlan(
            session.executionPlan,
          );
        }
      }
    };
    // 立即检测一次
    win.requestAnimationFrame(reapplyTheme);
    // 延迟 100ms 再检测一次，确保暗黑模式已应用
    setTimeout(reapplyTheme, 100);
  }

  // Add sidebar observer
  const mainWin = win as unknown as {
    MutationObserver?: typeof MutationObserver;
  };
  const MutationObserverClass = mainWin.MutationObserver;
  const sidebar = getSidebar();
  if (!sidebarObserver && MutationObserverClass && sidebar) {
    sidebarObserver = new MutationObserverClass(() => updateContainerSize());
    sidebarObserver.observe(sidebar, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  }

  // Add tab notifier
  if (!tabNotifierID) {
    tabNotifierID = Zotero.Notifier.registerObserver(
      {
        notify: () => {
          updateContainerSize();
          if (chatContainer?.style.display !== "none") {
            refreshChatForCurrentItem();
          }
        },
      },
      ["tab"],
      `${config.addonRef}-chat-panel-tab-notifier`,
    );
  }

  chatContainer.style.display = "block";

  // Update toolbar button state
  updateToolbarButtonState(true);

  // Initialize chat content only once
  if (!contentInitialized) {
    initializeChatContent();
    contentInitialized = true;
  } else {
    // Re-bind callbacks to point to the sidebar container
    // (they may have been redirected to a floating window container)
    const manager = getChatManager();
    const context = createContext(chatContainer);
    setupChatManagerCallbacks(manager, context, chatContainer);
    refreshChatForCurrentItem();
  }

  ztoolkit.log("Sidebar panel shown");
  return true;
}

/**
 * Hide sidebar panel
 */
function hideSidebarPanel(): void {
  if (chatContainer) {
    chatContainer.style.display = "none";
  }

  collapseSidebar();

  // Clean up listeners
  if (resizeHandler) {
    Zotero.getMainWindow().removeEventListener("resize", resizeHandler);
    resizeHandler = null;
  }

  if (sidebarObserver) {
    sidebarObserver.disconnect();
    sidebarObserver = null;
  }

  if (tabNotifierID) {
    Zotero.Notifier.unregisterObserver(tabNotifierID);
    tabNotifierID = null;
  }

  ztoolkit.log("Sidebar panel hidden");
}

/**
 * Setup chat manager callbacks
 */
function setupChatManagerCallbacks(
  manager: ChatManager,
  context: ChatPanelContext,
  container: HTMLElement,
): void {
  const authManager = getAuthManager();

  manager.setCallbacks({
    onMessageUpdate: (messages) => {
      ztoolkit.log(
        "onMessageUpdate callback fired, messages:",
        messages.length,
      );
      cancelPendingStreamingTextRender(container);
      context.renderMessages(messages);
      updateModelSelectorDisplay(container);
    },
    onStreamingUpdate: (content, messageId) => {
      if (container) {
        scheduleStreamingTextRender(
          container,
          manager,
          content,
          messageId,
          createPdfQuoteMarkdownRenderOptions({
            getCurrentItem: () =>
              getQuoteNavigationItem(
                manager.getActiveSession(),
                moduleCurrentItem,
              ),
          }),
        );
      }
    },
    onReasoningUpdate: (reasoning, messageId) => {
      if (container) {
        const activeMessage = manager
          .getActiveSession()
          ?.messages.find((message) => message.id === messageId);
        if (
          !activeMessage ||
          activeMessage.role !== "assistant" ||
          activeMessage.streamingState !== "in_progress"
        ) {
          return;
        }
        const reasoningEl = container.querySelector(
          getStreamingReasoningSelector(messageId),
        );
        if (reasoningEl) {
          reasoningEl.textContent = reasoning;
          // Show the reasoning container when content arrives
          const reasoningContainer = container.querySelector(
            getStreamingReasoningContainerSelector(messageId),
          ) as HTMLElement;
          if (reasoningContainer && reasoning) {
            reasoningContainer.style.display = "block";
          }
        }
      }
    },
    onExecutionPlanUpdate: (plan) => {
      context.renderExecutionPlan(plan);
    },
    onRuntimeEvent: (event) => {
      if (manager.getActiveSession()?.id !== event.sessionId) {
        return;
      }
      if (
        event.type === "approval_requested" ||
        event.type === "approval_resolved"
      ) {
        context.renderExecutionPlan(manager.getActiveSession()?.executionPlan);
      }
    },
    onError: (error) => {
      ztoolkit.log("[ChatPanel] API Error:", error.message);
      context.appendError(error.message);
      if (isPaperChatQuotaError(error)) {
        void (async () => {
          try {
            ztoolkit.log("[Balance] Refreshing balance after quota error");
            await authManager.refreshUserInfo();
            context.updateUserBar();
          } catch (refreshError) {
            ztoolkit.log(
              "[Balance] Failed to refresh balance after quota error:",
              refreshError,
            );
          }
        })();
      }
    },
    onPdfAttached: () => {
      if (container) {
        const attachPdfCheckbox = container.querySelector(
          "#chat-attach-pdf",
        ) as HTMLInputElement;
        if (attachPdfCheckbox) {
          attachPdfCheckbox.checked = false;
          ztoolkit.log(
            "[PDF Attach] Checkbox unchecked after successful attachment",
          );
        }
      }
    },
    onMessageComplete: async () => {
      const providerManager = getProviderManager();
      if (providerManager.getActiveProviderId() === "paperchat") {
        ztoolkit.log("[Balance] Refreshing balance after message completion");
        await authManager.refreshUserInfo();
        context.updateUserBar();
      }
    },
    onFallbackNotice: (fromProvider: string, toProvider: string) => {
      ztoolkit.log(
        `[Fallback] Provider ${fromProvider} unavailable, switching to ${toProvider}`,
      );
    },
  });
}

/**
 * Check if panel is shown (either sidebar or floating)
 */
export function isPanelShown(): boolean {
  if (currentPanelMode === "sidebar") {
    return chatContainer?.style.display === "block";
  } else {
    return floatingWindow !== null && !floatingWindow.closed;
  }
}

function trackChatPanelClosed(): void {
  if (panelVisibleSince == null) {
    return;
  }

  getAnalyticsService().track(ANALYTICS_EVENTS.chatPanelClosed, {
    panel_mode: currentPanelMode,
    open_source: panelOpenSource,
    visible_duration_ms: Math.max(0, Date.now() - panelVisibleSince),
  });
  panelVisibleSince = null;
  panelOpenSource = "unknown";
}

/**
 * Show the chat panel
 */
export function showPanel(source: ChatPanelOpenSource = "unknown"): void {
  // Initialize events module
  initializeEventsModule();

  // Load saved panel mode
  loadPanelMode();

  const didOpen =
    currentPanelMode === "sidebar" ? showSidebarPanel() : openFloatingWindow();
  if (!didOpen) {
    updateToolbarButtonState(false);
    return;
  } else {
    updateToolbarButtonState(true);
  }

  if (getProviderManager().getActiveProviderId() === "paperchat") {
    void refreshPaperChatNotice();
  }

  panelVisibleSince = Date.now();
  panelOpenSource = source;
  getAnalyticsService().track(ANALYTICS_EVENTS.chatPanelOpened, {
    panel_mode: currentPanelMode,
    open_source: source,
  });
}

/**
 * Hide the chat panel
 */
export function hidePanel(): void {
  trackChatPanelClosed();
  if (currentPanelMode === "sidebar") {
    hideSidebarPanel();
  } else {
    closeFloatingWindow();
  }

  // Update toolbar button pressed state
  updateToolbarButtonState(false);
}

/**
 * Update toolbar button pressed state
 */
function updateToolbarButtonState(pressed: boolean): void {
  const doc = Zotero.getMainWindow().document;
  const button = doc.getElementById(
    `${config.addonRef}-toolbar-button`,
  ) as HTMLElement;
  if (button) {
    if (pressed) {
      button.style.backgroundColor = "var(--fill-quinary)";
      button.style.boxShadow = "inset 0 1px 3px rgba(0,0,0,0.2)";
    } else {
      button.style.backgroundColor = "transparent";
      button.style.boxShadow = "none";
    }
  }
}

/**
 * Sync sidebar state based on panel visibility and mode
 */
function syncSidebarState(): void {
  if (isPanelShown() && currentPanelMode === "sidebar") {
    // Sidebar panel is open - update position
    updateSidebarContainerPosition();
    refreshChatForCurrentItem();
  } else if (!isPanelShown() && currentPanelMode === "sidebar") {
    // Sidebar panel is closed - collapse sidebar
    collapseSidebar();
  }
}

/**
 * Register global tab notifier for sidebar sync
 */
function registerGlobalTabNotifier(): void {
  if (globalTabNotifierID) return;

  globalTabNotifierID = Zotero.Notifier.registerObserver(
    {
      notify: () => {
        // Sync sidebar state when switching tabs
        syncSidebarState();
      },
    },
    ["tab"],
    `${config.addonRef}-global-tab-notifier`,
  );
  ztoolkit.log("Global tab notifier registered");
}

/**
 * Unregister global tab notifier
 */
function unregisterGlobalTabNotifier(): void {
  if (globalTabNotifierID) {
    Zotero.Notifier.unregisterObserver(globalTabNotifierID);
    globalTabNotifierID = null;
    ztoolkit.log("Global tab notifier unregistered");
  }
}

/**
 * Toggle the chat panel
 */
export function togglePanel(source: ChatPanelOpenSource = "unknown"): void {
  if (isPanelShown()) {
    hidePanel();
  } else {
    showPanel(source);
  }
}

/**
 * Register toolbar button
 */
export function registerToolbarButton(): void {
  const doc = Zotero.getMainWindow().document;

  if (doc.getElementById(`${config.addonRef}-toolbar-button`)) {
    return;
  }

  const anchor = doc.querySelector(
    "#zotero-tabs-toolbar > .zotero-tb-separator",
  );
  if (!anchor) {
    ztoolkit.log("Tabs toolbar separator not found");
    return;
  }

  const button = ztoolkit.UI.insertElementBefore(
    {
      tag: "div",
      namespace: "html",
      id: `${config.addonRef}-toolbar-button`,
      attributes: {
        title: getString(
          "chat-toolbar-button-tooltip" as Parameters<typeof getString>[0],
        ),
      },
      styles: {
        backgroundImage: `url(chrome://${config.addonRef}/content/icons/favicon.svg)`,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "center",
        backgroundSize: "18px",
        display: "flex",
        width: "28px",
        height: "28px",
        alignItems: "center",
        borderRadius: "5px",
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: () => togglePanel("toolbar"),
        },
        {
          type: "mouseover",
          listener: (e: Event) => {
            (e.currentTarget as HTMLElement).style.backgroundColor =
              "var(--fill-quinary)";
          },
        },
        {
          type: "mouseout",
          listener: (e: Event) => {
            // Keep pressed state if panel is open
            if (!isPanelShown()) {
              (e.currentTarget as HTMLElement).style.backgroundColor =
                "transparent";
            }
          },
        },
      ],
    },
    anchor.nextElementSibling as Element,
  ) as HTMLElement;

  // Register global tab notifier for sidebar sync across tabs
  registerGlobalTabNotifier();

  // Initialize guide prefs and show guide if needed
  Guide.initPrefs();
  setTimeout(() => {
    Guide.showToolbarGuideIfNeed(Zotero.getMainWindow());
  }, 500);

  ztoolkit.log("Toolbar button registered", button);
}

/**
 * Unregister toolbar button
 */
export function unregisterToolbarButton(): void {
  const doc = Zotero.getMainWindow().document;
  const button = doc.getElementById(`${config.addonRef}-toolbar-button`);
  if (button) {
    button.remove();
  }

  // Unregister global tab notifier
  unregisterGlobalTabNotifier();
}

/**
 * Create context for event handlers
 */
function cloneAttachmentState(state: AttachmentState): AttachmentState {
  return {
    pendingImages: [...state.pendingImages],
    pendingFiles: [...state.pendingFiles],
    pendingSelectedText: state.pendingSelectedText,
  };
}

function renderPendingAttachmentsPreview(container: HTMLElement): void {
  updateAttachmentsPreviewDisplay(
    container,
    {
      pendingImages,
      pendingFiles,
      pendingSelectedText,
    },
    {
      onRemoveImage: (index) => {
        if (index < 0 || index >= pendingImages.length) return;
        pendingImages = pendingImages.filter(
          (_image, imageIndex) => imageIndex !== index,
        );
        renderPendingAttachmentsPreview(container);
      },
    },
  );
}

function createContext(container: HTMLElement): ChatPanelContext {
  const manager = getChatManager();
  const authManager = getAuthManager();

  const context: ChatPanelContext = {
    container: container,
    chatManager: manager,
    authManager,
    getCurrentItem: () => {
      if (!moduleCurrentItem) {
        moduleCurrentItem = getActiveReaderItem();
        if (moduleCurrentItem && container) {
          updatePdfCheckboxVisibilityForItem(
            container,
            moduleCurrentItem,
            manager,
          );
        }
      }
      return moduleCurrentItem;
    },
    setCurrentItem: (item: Zotero.Item | null) => {
      moduleCurrentItem = item;
    },
    getTheme: getCurrentTheme,
    getAttachmentState: () =>
      cloneAttachmentState({
        pendingImages,
        pendingFiles,
        pendingSelectedText,
      }),
    setAttachmentState: (state) => {
      const nextState = cloneAttachmentState(state);
      pendingImages = nextState.pendingImages;
      pendingFiles = nextState.pendingFiles;
      pendingSelectedText = nextState.pendingSelectedText;
    },
    clearAttachments: () => {
      pendingImages = [];
      pendingFiles = [];
      pendingSelectedText = null;
    },
    updateAttachmentsPreview: () => {
      if (container) {
        renderPendingAttachmentsPreview(container);
      }
    },
    updateUserBar: () => {
      if (container) {
        updateUserBarDisplay(container, authManager);
      }
    },
    updatePdfCheckboxVisibility: async (item: Zotero.Item | null) => {
      if (container) {
        await updatePdfCheckboxVisibilityForItem(container, item, manager);
      }
    },
    renderMessages: (messages: ChatMessage[]) => {
      if (container) {
        cancelPendingStreamingTextRender(container);
        const chatHistory = container.querySelector(
          "#chat-history",
        ) as HTMLElement;
        const planPanel = container.querySelector(
          "#chat-execution-plan-panel",
        ) as HTMLElement;
        const emptyState = container.querySelector(
          "#chat-empty-state",
        ) as HTMLElement;
        const session = manager.getActiveSession();
        const retryableErrorMessageId =
          getProviderManager().getActiveProviderId() === "paperchat"
            ? session?.lastRetryableErrorMessageId
            : undefined;
        if (chatHistory) {
          renderMessageElementsWithPdfQuoteAction(
            chatHistory,
            emptyState,
            messages,
            () => getQuoteNavigationItem(session, moduleCurrentItem),
            retryableErrorMessageId,
            async () => {
              await context.rerollPaperChatTierForCurrentSession();
            },
            (error) => {
              context.appendError(error.message);
            },
          );
        }
        if (planPanel) {
          updateExecutionInsetsForContainer(
            container,
            manager,
            manager.getActiveSession()?.executionPlan,
          );
        }
      }
    },
    renderExecutionPlan: (plan?: ExecutionPlan) => {
      if (!container) return;
      updateExecutionInsetsForContainer(container, manager, plan);
    },
    appendError: (errorMessage: string) => {
      ztoolkit.log(
        "[ChatPanel] appendError called:",
        errorMessage.substring(0, 100),
      );
      ztoolkit.log("[ChatPanel] container:", container ? "exists" : "null");

      if (container) {
        const chatHistory = container.querySelector(
          "#chat-history",
        ) as HTMLElement;
        const doc = container.ownerDocument;
        ztoolkit.log(
          "[ChatPanel] chatHistory:",
          chatHistory ? "exists" : "null",
        );
        ztoolkit.log("[ChatPanel] doc:", doc ? "exists" : "null");

        if (chatHistory && doc) {
          const wrapper = doc.createElement("div");
          wrapper.className = "message-wrapper error-message-wrapper";

          const bubble = doc.createElement("div");
          bubble.className = "message-bubble error-bubble";
          bubble.style.cssText = `background: ${chatColors.errorBubbleBg}; border: 1px solid ${chatColors.errorBubbleBorder}; color: ${chatColors.errorBubbleText}; padding: 12px; border-radius: 8px; margin: 8px 0;`;

          const content = doc.createElement("div");
          content.className = "message-content";
          content.textContent = `⚠️ ${errorMessage}`;

          bubble.appendChild(content);
          wrapper.appendChild(bubble);
          chatHistory.appendChild(wrapper);
          if (shouldAutoScrollChatHistory(chatHistory)) {
            scrollChatHistoryToBottom(chatHistory);
          } else {
            updateChatHistoryScrollBottomButton(chatHistory);
          }
          ztoolkit.log("[ChatPanel] Error message appended to chat history");
        }
      }
    },
    rerollPaperChatTierForCurrentSession: async () => {
      const reroute = await manager.rerollCurrentPaperChatFailureAndRetry();
      if (!reroute) {
        throw new Error(
          "No alternate PaperChat model is available for this tier.",
        );
      }
      updateModelSelectorDisplay(container);
      return reroute;
    },
  };

  return context;
}

/**
 * Initialize chat content and event handlers (for sidebar)
 */
async function initializeChatContent(): Promise<void> {
  if (!chatContainer) return;
  await initializeChatContentCommon(chatContainer);
}

/**
 * Refresh chat content for current item (for sidebar)
 */
async function refreshChatForCurrentItem(): Promise<void> {
  if (!chatContainer) return;
  await refreshChatForContainer(chatContainer);
}

/**
 * Unregister all and clean up
 */
export async function unregisterAll(): Promise<void> {
  // Close floating window
  closeFloatingWindow();

  // Remove container
  if (chatContainer) {
    cancelPendingStreamingTextRender(chatContainer);
    chatContainer.remove();
    chatContainer = null;
  }

  // Reset initialization flags
  contentInitialized = false;
  floatingContentInitialized = false;

  // Remove toolbar button
  unregisterToolbarButton();

  // Clean up listeners
  if (resizeHandler) {
    Zotero.getMainWindow().removeEventListener("resize", resizeHandler);
    resizeHandler = null;
  }

  if (sidebarObserver) {
    sidebarObserver.disconnect();
    sidebarObserver = null;
  }

  if (tabNotifierID) {
    Zotero.Notifier.unregisterObserver(tabNotifierID);
    tabNotifierID = null;
  }

  // Clean up theme listener
  if (themeCleanup) {
    themeCleanup();
    themeCleanup = null;
  }

  // Destroy chat manager — await so DB writes complete before StorageDatabase is torn down
  if (chatManager) {
    await chatManager.destroy();
    chatManager = null;
  }

  // Clear attachment state
  pendingImages = [];
  pendingFiles = [];
  pendingSelectedText = null;
  moduleCurrentItem = null;
}

/**
 * Add selected text as attachment
 */
export function addSelectedTextAttachment(text: string): void {
  pendingSelectedText = text;
  if (chatContainer) {
    renderPendingAttachmentsPreview(chatContainer);
  }
}
