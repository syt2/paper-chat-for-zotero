/**
 * ChatPanelManager - Main panel lifecycle and coordination
 */

import { config } from "../../../../package.json";
import { getString } from "../../../utils/locale";
import { ChatManager, type ChatMessage } from "../../chat";
import type { ImageAttachment, FileAttachment } from "../../../types/chat";
import { getAuthManager } from "../../auth";
import { getProviderManager } from "../../providers";

import type { ThemeColors, AttachmentState, ChatPanelContext } from "./types";
import { getTheme, getCurrentTheme, updateCurrentTheme, applyThemeToContainer, setupThemeListener } from "./ChatPanelTheme";
import { createChatContainer } from "./ChatPanelBuilder";
import { createMessageElement, renderMessages as renderMessageElements } from "./MessageRenderer";
import { setupEventHandlers, updateAttachmentsPreviewDisplay, updateUserBarDisplay, updatePdfCheckboxVisibilityForItem, focusInput, setActiveReaderItemFn } from "./ChatPanelEvents";

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

// Attachment state
let pendingImages: ImageAttachment[] = [];
let pendingFiles: FileAttachment[] = [];
let pendingSelectedText: string | null = null;

/**
 * Initialize the events module with function references
 */
function initializeEventsModule(): void {
  if (!eventsInitialized) {
    setActiveReaderItemFn(getActiveReaderItem);
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
 */
function getSidebar(): HTMLElement | null {
  const mainWindow = Zotero.getMainWindow() as Window & {
    Zotero_Tabs?: { selectedType: string };
  };
  const currentTab = mainWindow.Zotero_Tabs?.selectedType;
  const paneName = currentTab === "reader" ? "#zotero-context-pane" : "#zotero-item-pane";
  return mainWindow.document.querySelector(paneName) as HTMLElement | null;
}

/**
 * Get the splitter element
 */
function getSplitter(): HTMLElement | null {
  const mainWindow = Zotero.getMainWindow() as Window & {
    Zotero_Tabs?: { selectedType: string };
  };
  const currentTab = mainWindow.Zotero_Tabs?.selectedType;
  const splitterName = currentTab === "reader" ? "#zotero-context-splitter" : "#zotero-items-splitter";
  return mainWindow.document.querySelector(splitterName) as HTMLElement | null;
}

/**
 * Update container size to match sidebar
 */
function updateContainerSize(): void {
  const sidebar = getSidebar();
  if (!chatContainer || !sidebar) return;

  const rect = sidebar.getBoundingClientRect();
  chatContainer.style.width = `${rect.width}px`;
  chatContainer.style.height = `${rect.height}px`;
  chatContainer.style.left = `${rect.x}px`;
  chatContainer.style.top = `${rect.y}px`;
}

/**
 * Check if panel is shown
 */
export function isPanelShown(): boolean {
  return chatContainer?.style.display === "block";
}

/**
 * Show the chat panel
 */
export function showPanel(): void {
  const doc = Zotero.getMainWindow().document;
  const win = Zotero.getMainWindow();

  // Initialize events module
  initializeEventsModule();

  // Initialize theme
  updateCurrentTheme();

  // Create container if not exists or if it was detached from DOM
  if (!chatContainer || !chatContainer.isConnected) {
    if (chatContainer) {
      chatContainer = null;
    }
    chatContainer = createChatContainer(doc, getCurrentTheme());
    contentInitialized = false;
  }

  // Ensure sidebar is visible
  const sidebar = getSidebar();
  if (sidebar?.getAttribute("collapsed") === "true") {
    sidebar.setAttribute("collapsed", "false");
    const splitter = getSplitter();
    if (splitter) {
      splitter.setAttribute("state", "");
    }
  }

  // Update size
  updateContainerSize();

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
    });
  }

  // Add sidebar observer
  const mainWin = win as unknown as { MutationObserver?: typeof MutationObserver };
  const MutationObserverClass = mainWin.MutationObserver;
  if (!sidebarObserver && MutationObserverClass && sidebar) {
    sidebarObserver = new MutationObserverClass(() => updateContainerSize());
    sidebarObserver.observe(sidebar, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  }

  // Add tab notifier - update size and refresh chat when tab changes
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
  ztoolkit.log("Chat panel shown");

  // Update toolbar button pressed state
  updateToolbarButtonState(true);

  // Initialize chat content only once
  if (!contentInitialized) {
    initializeChatContent();
    contentInitialized = true;
  } else {
    refreshChatForCurrentItem();
  }
}

/**
 * Hide the chat panel
 */
export function hidePanel(): void {
  if (chatContainer) {
    chatContainer.style.display = "none";
  }

  // Collapse the current page's sidebar
  const sidebar = getSidebar();
  if (sidebar) {
    sidebar.setAttribute("collapsed", "true");
    const splitter = getSplitter();
    if (splitter) {
      splitter.setAttribute("state", "collapsed");
    }
  }

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

  // Update toolbar button pressed state
  updateToolbarButtonState(false);

  ztoolkit.log("Chat panel hidden");
}

/**
 * Update toolbar button pressed state
 */
function updateToolbarButtonState(pressed: boolean): void {
  const doc = Zotero.getMainWindow().document;
  const button = doc.getElementById(`${config.addonRef}-toolbar-button`) as HTMLElement;
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
 * Sync sidebar state based on panel visibility
 */
function syncSidebarState(): void {
  const sidebar = getSidebar();
  const splitter = getSplitter();

  if (isPanelShown()) {
    // Panel is open - ensure sidebar is expanded
    if (sidebar?.getAttribute("collapsed") === "true") {
      sidebar.setAttribute("collapsed", "false");
      if (splitter) {
        splitter.setAttribute("state", "");
      }
    }
    updateContainerSize();
    refreshChatForCurrentItem();
  } else {
    // Panel is closed - collapse sidebar
    if (sidebar && sidebar.getAttribute("collapsed") !== "true") {
      sidebar.setAttribute("collapsed", "true");
      if (splitter) {
        splitter.setAttribute("state", "collapsed");
      }
    }
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

  const anchor = doc.querySelector("#zotero-tabs-toolbar > .zotero-tb-separator");
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
        title: getString("chat-toolbar-button-tooltip" as Parameters<typeof getString>[0]),
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
            (e.currentTarget as HTMLElement).style.backgroundColor = "var(--fill-quinary)";
          },
        },
        {
          type: "mouseout",
          listener: (e: Event) => {
            // Keep pressed state if panel is open
            if (!isPanelShown()) {
              (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
            }
          },
        },
      ],
    },
    anchor.nextElementSibling as Element,
  ) as HTMLElement;

  // Register global tab notifier for sidebar sync across tabs
  registerGlobalTabNotifier();

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
function createContext(): ChatPanelContext {
  const manager = getChatManager();
  const authManager = getAuthManager();

  return {
    container: chatContainer!,
    chatManager: manager,
    authManager,
    getCurrentItem: () => {
      if (!moduleCurrentItem) {
        moduleCurrentItem = getActiveReaderItem();
        if (moduleCurrentItem && chatContainer) {
          updatePdfCheckboxVisibilityForItem(chatContainer, moduleCurrentItem, manager);
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
      if (chatContainer) {
        updateAttachmentsPreviewDisplay(chatContainer, {
          pendingImages,
          pendingFiles,
          pendingSelectedText,
        });
      }
    },
    updateUserBar: () => {
      if (chatContainer) {
        updateUserBarDisplay(chatContainer, authManager);
      }
    },
    updatePdfCheckboxVisibility: async (item: Zotero.Item | null) => {
      if (chatContainer) {
        await updatePdfCheckboxVisibilityForItem(chatContainer, item, manager);
      }
    },
    renderMessages: (messages: ChatMessage[]) => {
      if (chatContainer) {
        const chatHistory = chatContainer.querySelector("#chat-history") as HTMLElement;
        const emptyState = chatContainer.querySelector("#chat-empty-state") as HTMLElement;
        if (chatHistory) {
          renderMessageElements(chatHistory, emptyState, messages, getCurrentTheme());
        }
      }
    },
    appendError: (errorMessage: string) => {
      ztoolkit.log("[ChatPanel] appendError called:", errorMessage.substring(0, 100));
      ztoolkit.log("[ChatPanel] chatContainer:", chatContainer ? "exists" : "null");

      if (chatContainer) {
        const chatHistory = chatContainer.querySelector("#chat-history") as HTMLElement;
        const doc = chatContainer.ownerDocument;
        ztoolkit.log("[ChatPanel] chatHistory:", chatHistory ? "exists" : "null");
        ztoolkit.log("[ChatPanel] doc:", doc ? "exists" : "null");

        if (chatHistory && doc) {
          const wrapper = doc.createElement("div");
          wrapper.className = "message-wrapper error-message-wrapper";

          const bubble = doc.createElement("div");
          bubble.className = "message-bubble error-bubble";
          bubble.style.cssText = "background: #ffebee; border: 1px solid #f44336; color: #c62828; padding: 12px; border-radius: 8px; margin: 8px 0;";

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
 * Initialize chat content and event handlers
 */
async function initializeChatContent(): Promise<void> {
  if (!chatContainer) return;

  const authManager = getAuthManager();
  const context = createContext();

  // Initialize auth
  await authManager.initialize();
  context.updateUserBar();

  // Set auth callbacks
  authManager.setCallbacks({
    onBalanceUpdate: () => context.updateUserBar(),
    onLoginStatusChange: () => context.updateUserBar(),
  });

  // Set provider change callback to update user bar visibility
  const providerManager = getProviderManager();
  providerManager.setOnProviderChange(() => {
    context.updateUserBar();
  });

  // Setup event handlers
  setupEventHandlers(context);

  // Set up chat manager callbacks
  const manager = getChatManager();
  manager.setCallbacks({
    onMessageUpdate: (itemId, messages) => {
      ztoolkit.log("onMessageUpdate callback fired, itemId:", itemId, "moduleCurrentItem:", moduleCurrentItem?.id);
      if (moduleCurrentItem && itemId === moduleCurrentItem.id) {
        context.renderMessages(messages);
      }
    },
    onStreamingUpdate: (itemId, content) => {
      if (moduleCurrentItem && itemId === moduleCurrentItem.id && chatContainer) {
        const streamingEl = chatContainer.querySelector("#chat-streaming-content");
        if (streamingEl) {
          const { renderMarkdownToElement } = require("./MarkdownRenderer");
          renderMarkdownToElement(streamingEl as HTMLElement, content);
        }
      }
    },
    onError: (error) => {
      ztoolkit.log("[ChatPanel] API Error:", error.message);
      context.appendError(error.message);
    },
    onPdfAttached: () => {
      // PDF已附加，取消勾选checkbox
      if (chatContainer) {
        const attachPdfCheckbox = chatContainer.querySelector("#chat-attach-pdf") as HTMLInputElement;
        if (attachPdfCheckbox) {
          attachPdfCheckbox.checked = false;
          ztoolkit.log("[PDF Attach] Checkbox unchecked after successful attachment");
        }
      }
    },
    onMessageComplete: async () => {
      // 消息完成后刷新余额（仅PDFAiTalk provider）
      const providerManager = getProviderManager();
      if (providerManager.getActiveProviderId() === "pdfaitalk") {
        ztoolkit.log("[Balance] Refreshing balance after message completion");
        await authManager.refreshUserInfo();
        context.updateUserBar();
      }
    },
  });

  // Get current item
  const activeItem = getActiveReaderItem();
  moduleCurrentItem = activeItem;

  if (!activeItem) {
    const pdfLabel = chatContainer.querySelector("#chat-pdf-label") as HTMLElement;
    if (pdfLabel) {
      pdfLabel.style.display = "none";
    }
    focusInput(chatContainer);
    return;
  }

  // Load session and render
  const session = await manager.getSession(activeItem);
  manager.setActiveItem(activeItem.id);

  // Update PDF checkbox visibility
  await context.updatePdfCheckboxVisibility(activeItem);

  // Render existing messages
  ztoolkit.log("Initial render, messages count:", session.messages.length);
  context.renderMessages(session.messages);

  focusInput(chatContainer);
}

/**
 * Refresh chat content for current item
 */
async function refreshChatForCurrentItem(): Promise<void> {
  if (!chatContainer) return;

  const activeItem = getActiveReaderItem();
  moduleCurrentItem = activeItem;

  if (!activeItem) {
    const pdfLabel = chatContainer.querySelector("#chat-pdf-label") as HTMLElement;
    if (pdfLabel) {
      pdfLabel.style.display = "none";
    }
    return;
  }

  const manager = getChatManager();
  const session = await manager.getSession(activeItem);
  manager.setActiveItem(activeItem.id);

  // Get DOM elements
  const chatHistory = chatContainer.querySelector("#chat-history") as HTMLElement;
  const emptyState = chatContainer.querySelector("#chat-empty-state") as HTMLElement;
  const attachPdfCheckbox = chatContainer.querySelector("#chat-attach-pdf") as HTMLInputElement;
  const pdfStatus = chatContainer.querySelector("#chat-pdf-status") as HTMLElement;
  const messageInput = chatContainer.querySelector("#chat-message-input") as HTMLTextAreaElement;

  // Check PDF status and show/hide checkbox
  const hasPdf = await manager.hasPdfAttachment(activeItem);
  const pdfLabel = chatContainer.querySelector("#chat-pdf-label") as HTMLElement;
  if (pdfLabel) {
    pdfLabel.style.display = hasPdf ? "flex" : "none";
  }
  if (pdfStatus) {
    pdfStatus.textContent = "";
  }
  if (attachPdfCheckbox) {
    attachPdfCheckbox.checked = false;
  }

  // Render messages
  if (chatHistory) {
    renderMessageElements(chatHistory, emptyState, session.messages, getCurrentTheme());
  }

  messageInput?.focus();
}

/**
 * Unregister all and clean up
 */
export function unregisterAll(): void {
  // Remove container
  if (chatContainer) {
    chatContainer.remove();
    chatContainer = null;
  }

  // Reset initialization flag
  contentInitialized = false;

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
