/**
 * ChatPanelEvents - Event handlers for the chat panel
 */

import { config } from "../../../../package.json";
import type { ChatPanelContext, AttachmentState, SessionInfo } from "./types";
import { chatColors } from "../../../utils/colors";
import { createElement, copyToClipboard } from "./ChatPanelBuilder";
import { getCurrentTheme } from "./ChatPanelTheme";
import {
  createHistoryDropdownState,
  populateHistoryDropdown,
  toggleHistoryDropdown,
  setupClickOutsideHandler,
} from "./HistoryDropdown";
import { showAuthDialog } from "../AuthDialog";
import { getString } from "../../../utils/locale";
import { getProviderManager } from "../../providers";
import { getPref, setPref } from "../../../utils/prefs";
import { formatModelLabel } from "../../preferences/ModelsFetcher";
import type { PanelMode } from "./ChatPanelManager";
import { MentionSelector, type MentionResource } from "./MentionSelector";

// Import getActiveReaderItem from the manager module to avoid circular dependency
// This is set by ChatPanelManager during initialization
let getActiveReaderItemFn: (() => Zotero.Item | null) | null = null;

// Toggle panel mode function reference (set by ChatPanelManager)
let togglePanelModeFn: (() => void) | null = null;

// 发送锁（使用 Promise 实现更可靠的锁机制，防止竞态条件）
let sendLock: Promise<void> | null = null;
let resolveSendLock: (() => void) | null = null;

/**
 * Set the getActiveReaderItem function reference
 * Called by ChatPanelManager to avoid circular imports
 */
export function setActiveReaderItemFn(fn: () => Zotero.Item | null): void {
  getActiveReaderItemFn = fn;
}

/**
 * Set the togglePanelMode function reference
 * Called by ChatPanelManager to avoid circular imports
 */
export function setTogglePanelModeFn(fn: () => void): void {
  togglePanelModeFn = fn;
}

/**
 * Update panel mode button icon based on current mode
 */
export function updatePanelModeButtonIcon(
  container: HTMLElement,
  mode: PanelMode,
): void {
  const panelModeIcon = container.querySelector(
    "#chat-panel-mode-icon",
  ) as HTMLImageElement;
  const panelModeBtn = container.querySelector(
    "#chat-panel-mode-btn",
  ) as HTMLButtonElement;
  if (panelModeIcon && panelModeBtn) {
    // split.svg for sidebar mode (click to switch to floating)
    // right-bar.svg for floating mode (click to switch to sidebar)
    panelModeIcon.src =
      mode === "sidebar"
        ? `chrome://${config.addonRef}/content/icons/split.svg`
        : `chrome://${config.addonRef}/content/icons/right-bar.svg`;
    panelModeBtn.title =
      mode === "sidebar"
        ? getString("chat-switch-to-floating")
        : getString("chat-switch-to-sidebar");
  }
}

/**
 * Get the active reader item
 */
function getActiveReaderItem(): Zotero.Item | null {
  if (getActiveReaderItemFn) {
    return getActiveReaderItemFn();
  }
  return null;
}

/**
 * Setup all event handlers for the chat panel
 */
export function setupEventHandlers(context: ChatPanelContext): void {
  const { container, chatManager, authManager } = context;

  // Get DOM elements
  const messageInput = container.querySelector(
    "#chat-message-input",
  ) as HTMLTextAreaElement;
  const sendButton = container.querySelector(
    "#chat-send-button",
  ) as HTMLButtonElement;
  const newChatBtn = container.querySelector("#chat-new") as HTMLButtonElement;
  const uploadFileBtn = container.querySelector(
    "#chat-upload-file",
  ) as HTMLButtonElement;
  const historyBtn = container.querySelector(
    "#chat-history-btn",
  ) as HTMLButtonElement;
  const historyDropdown = container.querySelector(
    "#chat-history-dropdown",
  ) as HTMLElement;
  const attachmentsPreview = container.querySelector(
    "#chat-attachments-preview",
  ) as HTMLElement;
  const userActionBtn = container.querySelector(
    "#chat-user-action-btn",
  ) as HTMLButtonElement;
  const chatHistory = container.querySelector("#chat-history") as HTMLElement;
  const emptyState = container.querySelector(
    "#chat-empty-state",
  ) as HTMLElement;

  // History dropdown state
  const historyState = createHistoryDropdownState();

  // User action button - login/logout
  userActionBtn?.addEventListener("click", async () => {
    ztoolkit.log("User action button clicked");
    if (authManager.isLoggedIn()) {
      await authManager.logout();
      context.updateUserBar();
    } else {
      const success = await showAuthDialog("login");
      if (success) context.updateUserBar();
    }
  });

  // Send button
  sendButton?.addEventListener("click", async () => {
    ztoolkit.log("Send button clicked");
    await sendMessage(context, messageInput, sendButton, attachmentsPreview);
  });

  // Input keydown - Enter to send (blocked while sending or when mention popup is open)
  messageInput?.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      // Check if mention popup is open - if so, let mention selector handle Enter
      const mentionPopup = container.querySelector(
        "#chat-mention-popup",
      ) as HTMLElement;
      if (mentionPopup && mentionPopup.style.display === "block") {
        // Mention popup is open, don't send message (mention selector will handle it)
        return;
      }

      e.preventDefault();
      // Block Enter key while sending (lock mechanism handles duplicate prevention)
      if (sendLock) {
        ztoolkit.log("Enter key blocked - message is being sent");
        return;
      }
      ztoolkit.log("Enter key pressed to send");
      sendMessage(context, messageInput, sendButton, attachmentsPreview);
    }
  });

  // Input auto-resize
  messageInput?.addEventListener("input", () => {
    if (messageInput) {
      messageInput.style.height = "auto";
      messageInput.style.height =
        Math.min(messageInput.scrollHeight, 140) + "px";
    }
  });

  // Set current item when input is focused
  messageInput?.addEventListener("focus", () => {
    const currentItem = context.getCurrentItem();
    if (!currentItem) {
      const item = getActiveReaderItem();
      if (item) {
        context.setCurrentItem(item);
      }
    }
  });

  // Handle Ctrl+C / Cmd+C for copying selected text
  container.addEventListener("keydown", (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "c") {
      const win = container.ownerDocument?.defaultView;
      const selection = win?.getSelection();
      const selectedText = selection?.toString();
      if (selectedText && selectedText.trim().length > 0) {
        e.preventDefault();
        copyToClipboard(selectedText);
        ztoolkit.log(
          "Copied selected text via Ctrl+C:",
          selectedText.substring(0, 50),
        );
      }
    }
  });

  // Make container focusable for keyboard events
  if (!container.hasAttribute("tabindex")) {
    container.setAttribute("tabindex", "-1");
  }

  // New chat button - create a new session
  newChatBtn?.addEventListener("click", async () => {
    ztoolkit.log("New chat button clicked");

    // Create a new session
    const newSession = await chatManager.createNewSession();

    // Update current item from reader if available
    const item = getActiveReaderItem();
    if (item) {
      context.setCurrentItem(item);
      chatManager.setCurrentItemKey(item.key);
    } else {
      context.setCurrentItem(null);
      chatManager.setCurrentItemKey(null);
    }

    // Clear attachments
    context.clearAttachments();
    context.updateAttachmentsPreview();

    // Clear chat history display
    if (chatHistory && emptyState) {
      chatHistory.textContent = "";
      chatHistory.appendChild(emptyState);
      emptyState.style.display = "flex";
    }

    ztoolkit.log("New session created:", newSession.id);
  });

  // Upload file button - supports both images and text files
  uploadFileBtn?.addEventListener("click", async () => {
    ztoolkit.log("Upload file button clicked");
    const fp = new ztoolkit.FilePicker("Select File", "open", [
      [
        "All supported",
        "*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp;*.txt;*.md;*.json;*.xml;*.csv;*.log",
      ],
      ["Images", "*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp"],
      ["Text files", "*.txt;*.md;*.json;*.xml;*.csv;*.log"],
    ]);
    const filePath = await fp.open();
    if (filePath) {
      const ext = filePath.toLowerCase().split(".").pop() || "";
      const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

      const extractor = chatManager.getPdfExtractor();
      const attachmentState = context.getAttachmentState();

      if (imageExts.includes(ext)) {
        // Handle as image
        const result = await extractor.imageFileToBase64(filePath);
        if (result) {
          const fileName = filePath.split(/[/\\]/).pop() || "image";
          ztoolkit.log(
            "[User Upload] Image uploaded:",
            fileName,
            "mimeType:",
            result.mimeType,
            "data length:",
            result.data.length,
          );
          attachmentState.pendingImages.push({
            type: "base64",
            data: result.data,
            mimeType: result.mimeType,
            name: fileName,
          });
          context.updateAttachmentsPreview();
        } else {
          ztoolkit.log("[User Upload] Failed to read image file:", filePath);
        }
      } else {
        // Handle as text file
        const fileContent = await extractor.readTextFile(filePath);
        if (fileContent) {
          const fileName = filePath.split(/[/\\]/).pop() || "file.txt";
          ztoolkit.log(
            "[User Upload] Text file uploaded:",
            fileName,
            "content length:",
            fileContent.length,
          );
          attachmentState.pendingFiles.push({
            name: fileName,
            content: fileContent.substring(0, 50000),
            type: "text",
          });
          context.updateAttachmentsPreview();
        } else {
          ztoolkit.log("[User Upload] Failed to read text file:", filePath);
        }
      }
    }
  });

  // History button - toggle dropdown with pagination
  historyBtn?.addEventListener("click", async () => {
    ztoolkit.log("History button clicked");
    if (!historyDropdown) return;

    const isNowVisible = toggleHistoryDropdown(historyDropdown);
    if (!isNowVisible) return;

    // Populate history dropdown
    await refreshHistoryDropdown();
  });

  // Helper function to refresh history dropdown
  const refreshHistoryDropdown = async () => {
    if (!historyDropdown) return;

    const sessions = await chatManager.getAllSessions();
    const theme = getCurrentTheme();

    populateHistoryDropdown(
      historyDropdown,
      container.ownerDocument!,
      sessions,
      historyState,
      theme,
      // onSelect callback
      async (session: SessionInfo) => {
        ztoolkit.log("Loading session:", session.id);
        historyDropdown.style.display = "none";

        const loadedSession = await chatManager.switchSession(session.id);
        if (loadedSession) {
          // Restore the item key from session
          const itemKey = loadedSession.lastActiveItemKey;
          if (itemKey) {
            // Try to get the item by key
            const libraryID = Zotero.Libraries.userLibraryID;
            const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
            if (item) {
              context.setCurrentItem(item as Zotero.Item);
              context.updatePdfCheckboxVisibility(item as Zotero.Item);
            } else {
              context.setCurrentItem(null);
            }
          } else {
            context.setCurrentItem(null);
          }

          context.renderMessages(loadedSession.messages);
        }
      },
      // onDelete callback
      async (session: SessionInfo) => {
        ztoolkit.log("Deleting session:", session.id);
        await chatManager.deleteSession(session.id);
        // Refresh the dropdown to reflect the deletion
        await refreshHistoryDropdown();
      },
    );
  };

  // Close dropdown when clicking outside
  if (historyDropdown && historyBtn) {
    setupClickOutsideHandler(container, historyDropdown, historyBtn);
  }

  // Model selector
  const modelSelectorBtn = container.querySelector(
    "#chat-model-selector-btn",
  ) as HTMLButtonElement;
  const modelDropdown = container.querySelector(
    "#chat-model-dropdown",
  ) as HTMLElement;

  if (modelSelectorBtn && modelDropdown) {
    // Initialize model selector text
    updateModelSelectorDisplay(container);

    // Toggle model dropdown
    modelSelectorBtn.addEventListener("click", () => {
      const isVisible = modelDropdown.style.display === "block";
      if (isVisible) {
        modelDropdown.style.display = "none";
      } else {
        populateModelDropdown(container, modelDropdown, context);
        modelDropdown.style.display = "block";
      }
    });

    // Close model dropdown when clicking outside
    container.ownerDocument?.addEventListener("click", (e: Event) => {
      const target = e.target as HTMLElement;
      if (
        !modelSelectorBtn.contains(target) &&
        !modelDropdown.contains(target)
      ) {
        modelDropdown.style.display = "none";
      }
    });
  }

  // Settings button - open preferences
  const settingsBtn = container.querySelector(
    "#chat-settings-btn",
  ) as HTMLButtonElement;
  if (settingsBtn) {
    settingsBtn.addEventListener("click", () => {
      ztoolkit.log("Settings button clicked");
      // Open preferences and navigate to this plugin's pane
      Zotero.Utilities.Internal.openPreferences("paperchat-prefpane");
    });

    // Hover effect
    settingsBtn.addEventListener("mouseenter", () => {
      settingsBtn.style.background = getCurrentTheme().dropdownItemHoverBg;
    });
    settingsBtn.addEventListener("mouseleave", () => {
      settingsBtn.style.background = "transparent";
    });
  }

  // User bar settings button (visible when not logged in) - open preferences
  const userBarSettingsBtn = container.querySelector(
    "#chat-user-bar-settings-btn",
  ) as HTMLButtonElement;
  if (userBarSettingsBtn) {
    userBarSettingsBtn.addEventListener("click", () => {
      ztoolkit.log("User bar settings button clicked");
      Zotero.Utilities.Internal.openPreferences("paperchat-prefpane");
    });

    // Hover effect
    userBarSettingsBtn.addEventListener("mouseenter", () => {
      userBarSettingsBtn.style.background = "rgba(255, 255, 255, 0.3)";
    });
    userBarSettingsBtn.addEventListener("mouseleave", () => {
      userBarSettingsBtn.style.background = "rgba(255, 255, 255, 0.15)";
    });
  }

  // Panel mode toggle button - switch between sidebar and floating mode
  const panelModeBtn = container.querySelector(
    "#chat-panel-mode-btn",
  ) as HTMLButtonElement;
  if (panelModeBtn) {
    panelModeBtn.addEventListener("click", () => {
      ztoolkit.log("Panel mode toggle button clicked");
      if (togglePanelModeFn) {
        togglePanelModeFn();
      }
    });

    // Hover effect
    panelModeBtn.addEventListener("mouseenter", () => {
      panelModeBtn.style.background = getCurrentTheme().dropdownItemHoverBg;
    });
    panelModeBtn.addEventListener("mouseleave", () => {
      panelModeBtn.style.background = "transparent";
    });
  }

  // @ Mention selector
  setupMentionSelector(context);

  ztoolkit.log("Event listeners attached to buttons");
}

/**
 * Update attachments preview display
 */
export function updateAttachmentsPreviewDisplay(
  container: HTMLElement,
  attachmentState: AttachmentState,
): void {
  const attachmentsPreview = container.querySelector(
    "#chat-attachments-preview",
  ) as HTMLElement;
  if (!attachmentsPreview) return;

  attachmentsPreview.textContent = "";
  const doc = container.ownerDocument!;

  const tags = [
    ...(attachmentState.pendingSelectedText
      ? [{ text: "\uD83D\uDCDD Selection", type: "selection" }]
      : []),
    ...attachmentState.pendingImages.map((img) => ({
      text: `\uD83D\uDDBC\uFE0F ${img.name || "image"}`,
      type: "image",
    })),
    ...attachmentState.pendingFiles.map((file) => ({
      text: `\uD83D\uDCCE ${file.name}`,
      type: "file",
    })),
  ];

  for (const tag of tags) {
    const span = createElement(doc, "span", {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      background: chatColors.attachmentBg,
      border: `1px solid ${chatColors.attachmentBorder}`,
      borderRadius: "12px",
      padding: "4px 12px",
      fontSize: "11px",
      color: chatColors.attachmentText,
    });
    span.textContent = tag.text;
    attachmentsPreview.appendChild(span);
  }

  attachmentsPreview.style.display = tags.length > 0 ? "flex" : "none";
}

/**
 * 获取发送锁（防止竞态条件）
 * @returns 是否成功获取锁
 */
function acquireSendLock(): boolean {
  if (sendLock) {
    return false; // 锁已被占用
  }
  sendLock = new Promise<void>((resolve) => {
    resolveSendLock = resolve;
  });
  return true;
}

/**
 * 释放发送锁
 */
function releaseSendLock(): void {
  if (resolveSendLock) {
    resolveSendLock();
    resolveSendLock = null;
  }
  sendLock = null;
}

/**
 * Send a message
 * PDF is automatically detected and attached if the item has a PDF
 */
async function sendMessage(
  context: ChatPanelContext,
  messageInput: HTMLTextAreaElement | null,
  sendButton: HTMLButtonElement | null,
  _attachmentsPreview: HTMLElement | null,
): Promise<void> {
  // 使用锁机制防止重复发送
  if (!acquireSendLock()) {
    ztoolkit.log("[sendMessage] Already sending, skipping");
    return;
  }

  const content = messageInput?.value?.trim();
  if (!content) {
    releaseSendLock();
    return;
  }

  const { chatManager, authManager } = context;

  // Get active reader item first (used for PDF attachment)
  const activeReaderItem = getActiveReaderItem();

  // Use current item or fall back to active reader
  let item = context.getCurrentItem();
  if (!item) {
    item = activeReaderItem;
    if (item) {
      context.setCurrentItem(item);
    }
  }

  // Check provider authentication/readiness
  const providerManager = getProviderManager();
  const activeProviderId = providerManager.getActiveProviderId();
  const activeProvider = providerManager.getActiveProvider();

  if (activeProviderId === "paperchat") {
    // For PaperChat, prompt login if not logged in
    if (!authManager.isLoggedIn()) {
      const success = await showAuthDialog("login");
      if (!success) {
        releaseSendLock();
        return;
      }
      context.updateUserBar();
    }
    // After login, ensure API key is available
    if (!activeProvider?.isReady()) {
      // Try to refresh the plugin token
      await authManager.ensurePluginToken(true);
      if (!activeProvider?.isReady()) {
        ztoolkit.log(
          "PaperChat provider still not ready after token refresh, forcing logout",
        );
        // Session is invalid and auto-relogin failed, force logout
        await authManager.logout();
        context.updateUserBar();
        // Show error in chat
        chatManager.showErrorMessage(getString("chat-error-session-expired"));
        // Prompt login again
        const success = await showAuthDialog("login");
        if (!success) {
          releaseSendLock();
          return;
        }
        context.updateUserBar();
        // Check again after re-login
        if (!activeProvider?.isReady()) {
          chatManager.showErrorMessage(getString("chat-error-no-provider"));
          releaseSendLock();
          return;
        }
      }
    }
  } else if (!activeProvider?.isReady()) {
    ztoolkit.log("Provider not ready:", activeProviderId);
    releaseSendLock();
    return;
  }

  // Disable send button
  if (sendButton) {
    sendButton.disabled = true;
    sendButton.style.opacity = "0.5";
    sendButton.style.cursor = "not-allowed";
  }

  // Get attachment state before clearing
  const attachmentState = context.getAttachmentState();
  // Auto-detect PDF: attach if we have an active reader item with PDF
  const shouldAttachPdf = activeReaderItem !== null;

  // Clear input immediately after getting the content
  if (messageInput) {
    messageInput.value = "";
    messageInput.style.height = "auto";
  }
  context.clearAttachments();
  context.updateAttachmentsPreview();

  // Build attachment options (shared between global and item chat)
  const attachmentOptions = {
    images:
      attachmentState.pendingImages.length > 0
        ? attachmentState.pendingImages
        : undefined,
    files:
      attachmentState.pendingFiles.length > 0
        ? attachmentState.pendingFiles
        : undefined,
    selectedText: attachmentState.pendingSelectedText || undefined,
  };

  try {
    // Determine target item: use active reader if attaching PDF, otherwise use chat context
    let targetItem = item;
    if (shouldAttachPdf) {
      targetItem = activeReaderItem;
      context.setCurrentItem(activeReaderItem!);
    }

    // Set current item for global chat if needed
    if (!targetItem || targetItem.id === 0) {
      if (!context.getCurrentItem()) {
        context.setCurrentItem({ id: 0 } as Zotero.Item);
      }
    }

    // Send message (unified API handles both global and item-bound chat)
    await chatManager.sendMessage(content, {
      item: targetItem,
      attachPdf: shouldAttachPdf,
      ...attachmentOptions,
    });
  } catch (error) {
    ztoolkit.log("Error in sendMessage:", error);
  } finally {
    // Re-enable send button and release lock
    if (sendButton) {
      sendButton.disabled = false;
      sendButton.style.opacity = "1";
      sendButton.style.cursor = "pointer";
    }
    messageInput?.focus();
    releaseSendLock();
  }
}

/**
 * Update user bar display
 * Only shows user bar when PaperChat provider is active
 */
export function updateUserBarDisplay(
  container: HTMLElement,
  authManager: {
    isLoggedIn(): boolean;
    getUser(): { username: string } | null;
    formatBalance(): string;
  },
): void {
  const userBar = container.querySelector("#chat-user-bar") as HTMLElement;
  const userNameEl = container.querySelector("#chat-user-name") as HTMLElement;
  const userBalanceEl = container.querySelector(
    "#chat-user-balance",
  ) as HTMLElement;
  const userActionBtn = container.querySelector(
    "#chat-user-action-btn",
  ) as HTMLButtonElement;
  const userBarSettingsBtn = container.querySelector(
    "#chat-user-bar-settings-btn",
  ) as HTMLButtonElement;

  if (!userBar || !userNameEl || !userBalanceEl || !userActionBtn) return;

  // Only show user bar when PaperChat provider is active
  const providerManager = getProviderManager();
  const activeProviderId = providerManager.getActiveProviderId();

  if (activeProviderId !== "paperchat") {
    userBar.style.display = "none";
    return;
  }

  userBar.style.display = "flex";

  if (authManager.isLoggedIn()) {
    const user = authManager.getUser();
    userNameEl.textContent = user?.username || "";
    userBalanceEl.textContent = `${getString("user-panel-balance")}: ${authManager.formatBalance()}`;
    userActionBtn.textContent = getString("user-panel-logout-btn");
    // Hide settings button when logged in
    if (userBarSettingsBtn) {
      userBarSettingsBtn.style.display = "none";
    }
  } else {
    userNameEl.textContent = getString("user-panel-not-logged-in");
    userBalanceEl.textContent = "";
    userActionBtn.textContent = getString("user-panel-login-btn");
    // Show settings button when not logged in
    if (userBarSettingsBtn) {
      userBarSettingsBtn.style.display = "flex";
    }
  }
}

/**
 * Update PDF checkbox visibility (deprecated - checkbox removed)
 * PDF is now auto-detected and attached via tool calling
 * This function is kept for compatibility but does nothing
 */
export async function updatePdfCheckboxVisibilityForItem(
  _container: HTMLElement,
  _item: Zotero.Item | null,
  _chatManager: { hasPdfAttachment(item: Zotero.Item): Promise<boolean> },
): Promise<void> {
  // No-op: PDF checkbox has been removed
  // PDF is now automatically detected and attached via tool calling
}

/**
 * Focus the message input
 */
export function focusInput(container: HTMLElement): void {
  const messageInput = container.querySelector(
    "#chat-message-input",
  ) as HTMLTextAreaElement;
  messageInput?.focus();
}

/**
 * Update model selector display with current model
 */
export function updateModelSelectorDisplay(container: HTMLElement): void {
  const modelSelectorText = container.querySelector(
    "#chat-model-selector-text",
  ) as HTMLElement;
  if (!modelSelectorText) return;

  const providerManager = getProviderManager();
  const activeProvider = providerManager.getActiveProvider();
  const currentModel = getPref("model") as string;

  if (activeProvider && currentModel) {
    // Show provider name + model (truncated)
    const providerName = activeProvider.getName();
    const modelShort =
      currentModel.length > 20
        ? currentModel.substring(0, 18) + "..."
        : currentModel;
    modelSelectorText.textContent = `${providerName}: ${modelShort}`;
  } else if (activeProvider) {
    modelSelectorText.textContent = activeProvider.getName();
  } else {
    modelSelectorText.textContent = getString("chat-select-model");
  }
}

/**
 * Populate model dropdown with providers and their models
 */
function populateModelDropdown(
  container: HTMLElement,
  dropdown: HTMLElement,
  context: ChatPanelContext,
): void {
  const doc = container.ownerDocument!;
  const theme = getCurrentTheme();
  dropdown.textContent = "";

  const providerManager = getProviderManager();
  const providers = providerManager.getConfiguredProviders();
  const activeProviderId = providerManager.getActiveProviderId();
  const currentModel = getPref("model") as string;

  for (const provider of providers) {
    // Provider section header
    const sectionHeader = createElement(doc, "div", {
      padding: "8px 12px",
      fontSize: "11px",
      fontWeight: "600",
      color: theme.textMuted,
      background: theme.buttonBg,
      borderBottom: `1px solid ${theme.borderColor}`,
      textTransform: "uppercase",
      letterSpacing: "0.5px",
    });
    sectionHeader.textContent = provider.getName();
    dropdown.appendChild(sectionHeader);

    // Get models for this provider
    const config = provider.config;
    const models = config.availableModels || [];
    const isActiveProvider = config.id === activeProviderId;

    if (models.length === 0) {
      // No models - show placeholder
      const noModels = createElement(doc, "div", {
        padding: "8px 12px",
        fontSize: "12px",
        color: theme.textMuted,
        fontStyle: "italic",
      });
      noModels.textContent = getString("chat-no-models");
      dropdown.appendChild(noModels);
    } else {
      // List models
      for (const model of models) {
        const isCurrentModel = isActiveProvider && model === currentModel;

        const modelItem = createElement(doc, "div", {
          padding: "8px 12px",
          fontSize: "12px",
          color: isCurrentModel ? chatColors.userBubble : theme.textPrimary,
          cursor: "pointer",
          background: isCurrentModel
            ? theme.dropdownItemHoverBg
            : "transparent",
          display: "flex",
          alignItems: "center",
          gap: "8px",
        });

        // Checkmark for current model
        if (isCurrentModel) {
          const check = createElement(doc, "span", {
            color: chatColors.userBubble,
            fontWeight: "bold",
          });
          check.textContent = "✓";
          modelItem.appendChild(check);
        }

        const modelName = createElement(doc, "span", {
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        });
        modelName.textContent = formatModelLabel(model, config.id);
        modelItem.appendChild(modelName);

        // Hover effect
        modelItem.addEventListener("mouseenter", () => {
          if (!isCurrentModel) {
            modelItem.style.background = theme.dropdownItemHoverBg;
          }
        });
        modelItem.addEventListener("mouseleave", () => {
          if (!isCurrentModel) {
            modelItem.style.background = "transparent";
          }
        });

        // Click to select model
        modelItem.addEventListener("click", () => {
          // Switch provider if needed
          if (!isActiveProvider) {
            providerManager.setActiveProvider(config.id);
          }

          // Set model
          setPref("model", model);

          // Update provider config
          providerManager.updateProviderConfig(config.id, {
            defaultModel: model,
          });

          // Update display and close dropdown
          updateModelSelectorDisplay(container);
          dropdown.style.display = "none";

          // Update user bar (provider might have changed)
          context.updateUserBar();

          ztoolkit.log(`Model switched to: ${config.id}/${model}`);
        });

        dropdown.appendChild(modelItem);
      }
    }
  }

  // If no providers configured
  if (providers.length === 0) {
    const noProviders = createElement(doc, "div", {
      padding: "12px",
      fontSize: "12px",
      color: theme.textMuted,
      textAlign: "center",
    });
    noProviders.textContent = getString("chat-configure-provider");
    dropdown.appendChild(noProviders);
  }
}

// ========== @ Mention Selector ==========

/**
 * Setup @ mention selector for the chat input
 * When user types @, show a popup to select resources (Items, Attachments, Notes)
 * Selected resource will be inserted as @[title] and added to context
 */
function setupMentionSelector(context: ChatPanelContext): void {
  const { container, chatManager } = context;
  const theme = getCurrentTheme();

  const messageInput = container.querySelector(
    "#chat-message-input",
  ) as HTMLTextAreaElement;
  const mentionPopup = container.querySelector(
    "#chat-mention-popup",
  ) as HTMLElement;

  if (!messageInput || !mentionPopup) {
    ztoolkit.log("[MentionSelector] Required elements not found");
    return;
  }

  // Create and initialize the MentionSelector
  const mentionSelector = new MentionSelector(
    mentionPopup,
    theme,
    (resource: MentionResource) => {
      // Insert @[title] into input
      insertMentionIntoInput(messageInput, resource);
      // Add resource to chat context
      chatManager.addItemToSelection(resource.key);
      ztoolkit.log(
        `[MentionSelector] Selected: ${resource.type}/${resource.key} - ${resource.title}`,
      );
    },
  );

  // Track the position where @ was typed
  let mentionStartPos = -1;

  // Handle input events - detect @ typing
  messageInput.addEventListener("input", async (e: Event) => {
    const inputEvent = e as InputEvent;
    const cursorPos = messageInput.selectionStart;
    const text = messageInput.value;

    // Check if @ was just typed
    if (inputEvent.data === "@") {
      mentionStartPos = cursorPos;
      await mentionSelector.show();
      return;
    }

    // If popup is visible, update the filter
    if (mentionSelector.isVisible()) {
      const beforeCursor = text.substring(0, cursorPos);
      const atPos = beforeCursor.lastIndexOf("@");

      // @ was deleted or cursor moved before @
      if (atPos === -1 || atPos < mentionStartPos - 1) {
        mentionSelector.hide();
        mentionStartPos = -1;
        return;
      }

      // Extract query after @
      const query = beforeCursor.substring(atPos + 1);

      // If query contains space or newline, close popup (user finished mention)
      if (/[\s\n]/.test(query)) {
        mentionSelector.hide();
        mentionStartPos = -1;
        return;
      }

      // Update filter
      mentionSelector.filter(query);
    }
  });

  // Handle keydown events for navigation
  messageInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (!mentionSelector.isVisible()) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        mentionSelector.moveDown();
        break;

      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        mentionSelector.moveUp();
        break;

      case "Enter":
        // If mention popup is visible, select instead of sending
        e.preventDefault();
        e.stopPropagation();
        mentionSelector.selectCurrent();
        mentionStartPos = -1;
        break;

      case "Tab":
        e.preventDefault();
        e.stopPropagation();
        mentionSelector.selectCurrent();
        mentionStartPos = -1;
        break;

      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        mentionSelector.hide();
        mentionStartPos = -1;
        break;
    }
  });

  // Close popup when clicking outside
  container.ownerDocument?.addEventListener("click", (e: Event) => {
    const target = e.target as HTMLElement;
    if (
      mentionSelector.isVisible() &&
      !mentionPopup.contains(target) &&
      target !== messageInput
    ) {
      mentionSelector.hide();
      mentionStartPos = -1;
    }
  });

  // Close popup when input loses focus (with small delay to allow popup clicks)
  messageInput.addEventListener("blur", () => {
    setTimeout(() => {
      if (mentionSelector.isVisible() && !mentionPopup.matches(":hover")) {
        mentionSelector.hide();
        mentionStartPos = -1;
      }
    }, 150);
  });

  ztoolkit.log("[MentionSelector] Setup complete");
}

/**
 * Insert a mention into the input at the current cursor position
 * Replaces @query with @[title]
 */
function insertMentionIntoInput(
  input: HTMLTextAreaElement,
  resource: MentionResource,
): void {
  const text = input.value;
  const cursorPos = input.selectionStart;

  // Find the @ position before cursor
  const beforeCursor = text.substring(0, cursorPos);
  const atPos = beforeCursor.lastIndexOf("@");

  if (atPos === -1) return;

  // Build the mention text
  const mentionText = `@[${resource.title}] `;

  // Replace @query with @[title]
  const beforeAt = text.substring(0, atPos);
  const afterCursor = text.substring(cursorPos);

  input.value = beforeAt + mentionText + afterCursor;

  // Move cursor after the mention
  const newCursorPos = atPos + mentionText.length;
  input.setSelectionRange(newCursorPos, newCursorPos);
  input.focus();

  // Trigger input event for auto-resize
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
