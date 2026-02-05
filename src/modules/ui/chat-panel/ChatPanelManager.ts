/**
 * ChatPanelManager - Main panel lifecycle and coordination
 */

import { config } from "../../../../package.json";
import { getString } from "../../../utils/locale";
import { ChatManager, type ChatMessage } from "../../chat";
import type { ImageAttachment, FileAttachment } from "../../../types/chat";
import { getAuthManager } from "../../auth";
import { getProviderManager } from "../../providers";
import { getPref, setPref } from "../../../utils/prefs";

import type { ChatPanelContext } from "./types";
import { chatColors } from "../../../utils/colors";
import {
  getCurrentTheme,
  updateCurrentTheme,
  applyThemeToContainer,
  setupThemeListener,
} from "./ChatPanelTheme";
import { createChatContainer } from "./ChatPanelBuilder";
import { renderMessages as renderMessageElements } from "./MessageRenderer";
import { renderMarkdownToElement } from "./MarkdownRenderer";
import {
  setupEventHandlers,
  updateAttachmentsPreviewDisplay,
  updateUserBarDisplay,
  updatePdfCheckboxVisibilityForItem,
  focusInput,
  setActiveReaderItemFn,
  setTogglePanelModeFn,
  updatePanelModeButtonIcon,
} from "./ChatPanelEvents";
import { loadCachedRatios } from "../../preferences/ModelsFetcher";
import { Guide } from "../Guide";

// Panel display mode: 'sidebar' or 'floating'
export type PanelMode = "sidebar" | "floating";

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
  const paneName = useContextPane ? "#zotero-context-pane" : "#zotero-item-pane";
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
function openFloatingWindow(): void {
  // Close existing floating window if any
  if (floatingWindow && !floatingWindow.closed) {
    floatingWindow.focus();
    return;
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
    return;
  }

  // Wait for window to load, then initialize content
  floatingWindow.addEventListener("load", () => {
    ztoolkit.log("Floating window load event fired");
    initializeFloatingWindowContent();

    // Handle window close - only after content is loaded
    floatingWindow?.addEventListener("unload", () => {
      ztoolkit.log("Floating window unload event");
      // Immediately reset state
      floatingWindow = null;
      floatingContainer = null;
      floatingContentInitialized = false;
      updateToolbarButtonState(false);
    });
  });

  ztoolkit.log("Floating window opened");
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
    onLoginStatusChange: () => context.updateUserBar(),
  });

  // Set provider change callback
  const providerManager = getProviderManager();
  providerManager.setOnProviderChange(() => {
    context.updateUserBar();
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
  }

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
    renderMessageElements(
      chatHistory,
      emptyState,
      session.messages,
      getCurrentTheme(),
    );
  }

  const messageInput = container.querySelector(
    "#chat-message-input",
  ) as HTMLTextAreaElement;
  messageInput?.focus();
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

  if (floatingWindow && !floatingWindow.closed) {
    floatingWindow.close();
  }
  floatingWindow = null;
  floatingContainer = null;
  floatingContentInitialized = false;
}

/**
 * Show sidebar panel
 */
function showSidebarPanel(): void {
  const doc = Zotero.getMainWindow().document;
  const win = Zotero.getMainWindow();

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
      }
      if (floatingContainer) {
        applyThemeToContainer(floatingContainer);
      }
    });

    // 延迟重新检测主题，因为启动时窗口可能还没完全应用暗黑模式
    // 使用多次检测确保主题正确应用
    const reapplyTheme = () => {
      updateCurrentTheme();
      if (chatContainer) {
        applyThemeToContainer(chatContainer);
      }
      if (floatingContainer) {
        applyThemeToContainer(floatingContainer);
      }
    };
    // 多次延迟检测，确保在窗口完全加载后正确应用主题
    setTimeout(reapplyTheme, 0);
    setTimeout(reapplyTheme, 100);
    setTimeout(reapplyTheme, 500);
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
    refreshChatForCurrentItem();
  }

  ztoolkit.log("Sidebar panel shown");
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
      context.renderMessages(messages);
    },
    onStreamingUpdate: (content) => {
      if (container) {
        const streamingEl = container.querySelector("#chat-streaming-content");
        if (streamingEl) {
          renderMarkdownToElement(streamingEl as HTMLElement, content);
        }
      }
    },
    onError: (error) => {
      ztoolkit.log("[ChatPanel] API Error:", error.message);
      context.appendError(error.message);
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

/**
 * Show the chat panel
 */
export function showPanel(): void {
  // Initialize events module
  initializeEventsModule();

  // Load saved panel mode
  loadPanelMode();

  // Update toolbar button pressed state
  updateToolbarButtonState(true);

  if (currentPanelMode === "sidebar") {
    showSidebarPanel();
  } else {
    openFloatingWindow();
  }
}

/**
 * Hide the chat panel
 */
export function hidePanel(): void {
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
export function togglePanel(): void {
  if (isPanelShown()) {
    hidePanel();
  } else {
    showPanel();
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
          listener: () => togglePanel(),
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
function createContext(container: HTMLElement): ChatPanelContext {
  const manager = getChatManager();
  const authManager = getAuthManager();

  return {
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
    getAttachmentState: () => ({
      pendingImages,
      pendingFiles,
      pendingSelectedText,
    }),
    clearAttachments: () => {
      pendingImages = [];
      pendingFiles = [];
      pendingSelectedText = null;
    },
    updateAttachmentsPreview: () => {
      if (container) {
        updateAttachmentsPreviewDisplay(container, {
          pendingImages,
          pendingFiles,
          pendingSelectedText,
        });
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
        const chatHistory = container.querySelector(
          "#chat-history",
        ) as HTMLElement;
        const emptyState = container.querySelector(
          "#chat-empty-state",
        ) as HTMLElement;
        if (chatHistory) {
          renderMessageElements(
            chatHistory,
            emptyState,
            messages,
            getCurrentTheme(),
          );
        }
      }
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
          chatHistory.scrollTop = chatHistory.scrollHeight;
          ztoolkit.log("[ChatPanel] Error message appended to chat history");
        }
      }
    },
  };
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
export function unregisterAll(): void {
  // Close floating window
  closeFloatingWindow();

  // Remove container
  if (chatContainer) {
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

  // Destroy chat manager
  if (chatManager) {
    chatManager.destroy();
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
    updateAttachmentsPreviewDisplay(chatContainer, {
      pendingImages,
      pendingFiles,
      pendingSelectedText,
    });
  }
}
