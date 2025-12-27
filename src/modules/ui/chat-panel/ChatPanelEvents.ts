/**
 * ChatPanelEvents - Event handlers for the chat panel
 */

import type { ImageAttachment, FileAttachment } from "../../../types/chat";
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

// Import getActiveReaderItem from the manager module to avoid circular dependency
// This is set by ChatPanelManager during initialization
let getActiveReaderItemFn: (() => Zotero.Item | null) | null = null;

// State to track if a message is being sent (prevents duplicate sends)
let isSending = false;

/**
 * Set the getActiveReaderItem function reference
 * Called by ChatPanelManager to avoid circular imports
 */
export function setActiveReaderItemFn(fn: () => Zotero.Item | null): void {
  getActiveReaderItemFn = fn;
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
  const messageInput = container.querySelector("#chat-message-input") as HTMLTextAreaElement;
  const sendButton = container.querySelector("#chat-send-button") as HTMLButtonElement;
  const attachPdfCheckbox = container.querySelector("#chat-attach-pdf") as HTMLInputElement;
  const newChatBtn = container.querySelector("#chat-new") as HTMLButtonElement;
  const uploadFileBtn = container.querySelector("#chat-upload-file") as HTMLButtonElement;
  const historyBtn = container.querySelector("#chat-history-btn") as HTMLButtonElement;
  const historyDropdown = container.querySelector("#chat-history-dropdown") as HTMLElement;
  const attachmentsPreview = container.querySelector("#chat-attachments-preview") as HTMLElement;
  const userActionBtn = container.querySelector("#chat-user-action-btn") as HTMLButtonElement;
  const chatHistory = container.querySelector("#chat-history") as HTMLElement;
  const emptyState = container.querySelector("#chat-empty-state") as HTMLElement;

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
    ztoolkit.log("[Send] attachPdfCheckbox element:", attachPdfCheckbox);
    ztoolkit.log("[Send] attachPdfCheckbox.checked:", attachPdfCheckbox?.checked);
    await sendMessage(context, messageInput, sendButton, attachPdfCheckbox, attachmentsPreview);
  });

  // Input keydown - Enter to send (blocked while sending)
  messageInput?.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Block Enter key while sending
      if (isSending) {
        ztoolkit.log("Enter key blocked - message is being sent");
        return;
      }
      ztoolkit.log("Enter key pressed to send");
      ztoolkit.log("[Send] attachPdfCheckbox element:", attachPdfCheckbox);
      ztoolkit.log("[Send] attachPdfCheckbox.checked:", attachPdfCheckbox?.checked);
      sendMessage(context, messageInput, sendButton, attachPdfCheckbox, attachmentsPreview);
    }
  });

  // Input auto-resize
  messageInput?.addEventListener("input", () => {
    if (messageInput) {
      messageInput.style.height = "auto";
      messageInput.style.height = Math.min(messageInput.scrollHeight, 140) + "px";
    }
  });

  // Check for PDF when input is focused
  messageInput?.addEventListener("focus", () => {
    const currentItem = context.getCurrentItem();
    if (!currentItem) {
      const item = getActiveReaderItem();
      if (item) {
        context.setCurrentItem(item);
        context.updatePdfCheckboxVisibility(item);
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
        ztoolkit.log("Copied selected text via Ctrl+C:", selectedText.substring(0, 50));
      }
    }
  });

  // Make container focusable for keyboard events
  if (!container.hasAttribute("tabindex")) {
    container.setAttribute("tabindex", "-1");
  }

  // New chat button - start a new conversation
  newChatBtn?.addEventListener("click", async () => {
    ztoolkit.log("New chat button clicked");

    let item = getActiveReaderItem();
    if (item) {
      context.setCurrentItem(item);
    } else {
      const currentItem = context.getCurrentItem();
      if (!currentItem) {
        context.setCurrentItem({ id: 0 } as Zotero.Item);
        item = { id: 0 } as Zotero.Item;
      } else {
        item = currentItem;
      }
    }

    // Clear current session to start fresh
    await chatManager.clearSession(item!.id);

    // Clear attachments
    context.clearAttachments();
    context.updateAttachmentsPreview();

    if (attachPdfCheckbox) {
      attachPdfCheckbox.checked = false;
    }

    // Clear chat history display
    if (chatHistory && emptyState) {
      chatHistory.textContent = "";
      chatHistory.appendChild(emptyState);
      emptyState.style.display = "flex";
    }

    ztoolkit.log("New chat started for item:", item!.id);
  });

  // Upload file button - supports both images and text files
  uploadFileBtn?.addEventListener("click", async () => {
    ztoolkit.log("Upload file button clicked");
    const fp = new ztoolkit.FilePicker("Select File", "open", [
      ["All supported", "*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp;*.txt;*.md;*.json;*.xml;*.csv;*.log"],
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
          ztoolkit.log("[User Upload] Image uploaded:", fileName, "mimeType:", result.mimeType, "data length:", result.data.length);
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
          ztoolkit.log("[User Upload] Text file uploaded:", fileName, "content length:", fileContent.length);
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
    const sessions = await chatManager.getAllSessions();
    const theme = getCurrentTheme();

    populateHistoryDropdown(
      historyDropdown,
      container.ownerDocument!,
      sessions,
      historyState,
      theme,
      async (session: SessionInfo) => {
        ztoolkit.log("Loading session for item:", session.itemId);
        historyDropdown.style.display = "none";

        const loadedSession = await chatManager.loadSessionForItem(session.itemId);
        if (loadedSession) {
          let itemForSession: Zotero.Item | null = null;

          if (session.itemId === 0) {
            // Global chat - use fake item with id 0
            itemForSession = { id: 0 } as Zotero.Item;
          } else {
            try {
              const item = await Zotero.Items.getAsync(session.itemId);
              if (item) {
                itemForSession = item as Zotero.Item;
              } else {
                // Item was deleted - treat as global chat
                ztoolkit.log("Item not found, treating as global chat:", session.itemId);
                itemForSession = { id: 0 } as Zotero.Item;
              }
            } catch {
              // Error fetching item - treat as global chat
              ztoolkit.log("Error fetching item, treating as global chat:", session.itemId);
              itemForSession = { id: 0 } as Zotero.Item;
            }
          }

          // Always set the current item
          context.setCurrentItem(itemForSession);
          context.updatePdfCheckboxVisibility(itemForSession);
          context.renderMessages(loadedSession.messages);
        }
      },
    );
  });

  // Close dropdown when clicking outside
  if (historyDropdown && historyBtn) {
    setupClickOutsideHandler(container, historyDropdown, historyBtn);
  }

  ztoolkit.log("Event listeners attached to buttons");
}

/**
 * Update attachments preview display
 */
export function updateAttachmentsPreviewDisplay(
  container: HTMLElement,
  attachmentState: AttachmentState,
): void {
  const attachmentsPreview = container.querySelector("#chat-attachments-preview") as HTMLElement;
  if (!attachmentsPreview) return;

  attachmentsPreview.textContent = "";
  const doc = container.ownerDocument!;

  const tags = [
    ...(attachmentState.pendingSelectedText ? [{ text: "\uD83D\uDCDD Selection", type: "selection" }] : []),
    ...attachmentState.pendingImages.map((img) => ({ text: `\uD83D\uDDBC\uFE0F ${img.name || "image"}`, type: "image" })),
    ...attachmentState.pendingFiles.map((file) => ({ text: `\uD83D\uDCCE ${file.name}`, type: "file" })),
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
 * Send a message
 */
async function sendMessage(
  context: ChatPanelContext,
  messageInput: HTMLTextAreaElement | null,
  sendButton: HTMLButtonElement | null,
  attachPdfCheckbox: HTMLInputElement | null,
  _attachmentsPreview: HTMLElement | null,
): Promise<void> {
  // Prevent duplicate sends
  if (isSending) return;

  const content = messageInput?.value?.trim();
  if (!content) return;

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

  if (activeProviderId === "pdfaitalk") {
    if (!authManager.isLoggedIn()) {
      const success = await showAuthDialog("login");
      if (!success) return;
      context.updateUserBar();
    }
  } else if (!activeProvider?.isReady()) {
    ztoolkit.log("Provider not ready:", activeProviderId);
    return;
  }

  // Set sending state and disable send button
  isSending = true;
  if (sendButton) {
    sendButton.disabled = true;
    sendButton.style.opacity = "0.5";
    sendButton.style.cursor = "not-allowed";
  }

  // Get attachment state before clearing
  const attachmentState = context.getAttachmentState();
  const shouldAttachPdf = attachPdfCheckbox?.checked && activeReaderItem !== null;

  // Clear input immediately after getting the content
  if (messageInput) {
    messageInput.value = "";
    messageInput.style.height = "auto";
  }
  context.clearAttachments();
  context.updateAttachmentsPreview();

  // Build attachment options (shared between global and item chat)
  const attachmentOptions = {
    images: attachmentState.pendingImages.length > 0 ? attachmentState.pendingImages : undefined,
    files: attachmentState.pendingFiles.length > 0 ? attachmentState.pendingFiles : undefined,
    selectedText: attachmentState.pendingSelectedText || undefined,
  };

  try {
    // Determine target item: use active reader if attaching PDF, otherwise use chat context
    let targetItem = item;
    if (shouldAttachPdf) {
      targetItem = activeReaderItem;
      context.setCurrentItem(activeReaderItem!);
    }

    // Send message
    if (!targetItem || targetItem.id === 0) {
      // Global chat mode
      if (!context.getCurrentItem()) {
        context.setCurrentItem({ id: 0 } as Zotero.Item);
      }
      await chatManager.sendMessageGlobal(content, attachmentOptions);
    } else {
      await chatManager.sendMessage(targetItem, content, {
        attachPdf: shouldAttachPdf,
        ...attachmentOptions,
      });
    }
  } catch (error) {
    ztoolkit.log("Error in sendMessage:", error);
  } finally {
    // Re-enable send button and reset sending state
    isSending = false;
    if (sendButton) {
      sendButton.disabled = false;
      sendButton.style.opacity = "1";
      sendButton.style.cursor = "pointer";
    }
    messageInput?.focus();
  }
}

/**
 * Update user bar display
 * Only shows user bar when PDFAiTalk provider is active
 */
export function updateUserBarDisplay(container: HTMLElement, authManager: { isLoggedIn(): boolean; getUser(): { username: string } | null; formatBalance(): string }): void {
  const userBar = container.querySelector("#chat-user-bar") as HTMLElement;
  const userNameEl = container.querySelector("#chat-user-name") as HTMLElement;
  const userBalanceEl = container.querySelector("#chat-user-balance") as HTMLElement;
  const userActionBtn = container.querySelector("#chat-user-action-btn") as HTMLButtonElement;

  if (!userBar || !userNameEl || !userBalanceEl || !userActionBtn) return;

  // Only show user bar when PDFAiTalk provider is active
  const providerManager = getProviderManager();
  const activeProviderId = providerManager.getActiveProviderId();

  if (activeProviderId !== "pdfaitalk") {
    userBar.style.display = "none";
    return;
  }

  userBar.style.display = "flex";

  if (authManager.isLoggedIn()) {
    const user = authManager.getUser();
    userNameEl.textContent = user?.username || "";
    userBalanceEl.textContent = `${getString("user-panel-balance")}: ${authManager.formatBalance()}`;
    userActionBtn.textContent = getString("user-panel-logout-btn");
  } else {
    userNameEl.textContent = getString("user-panel-not-logged-in");
    userBalanceEl.textContent = "";
    userActionBtn.textContent = getString("user-panel-login-btn");
  }
}

/**
 * Update PDF checkbox visibility based on ACTIVE READER state
 * Checkbox is only visible when user is viewing a PDF in reader
 * This is independent of the current chat context/history
 */
export async function updatePdfCheckboxVisibilityForItem(
  container: HTMLElement,
  _item: Zotero.Item | null, // Ignored - we always check active reader
  chatManager: { hasPdfAttachment(item: Zotero.Item): Promise<boolean> },
): Promise<void> {
  const pdfLabel = container.querySelector("#chat-pdf-label") as HTMLElement;
  if (!pdfLabel) return;

  // Always check the active reader item, not the chat context
  const activeReaderItem = getActiveReaderItem();

  if (!activeReaderItem) {
    // No reader active - hide checkbox
    pdfLabel.style.display = "none";
    ztoolkit.log("PDF checkbox hidden: no active reader");
    return;
  }

  const hasPdf = await chatManager.hasPdfAttachment(activeReaderItem);
  pdfLabel.style.display = hasPdf ? "flex" : "none";
  ztoolkit.log("PDF checkbox visibility based on active reader:", hasPdf ? "visible" : "hidden");
}

/**
 * Focus the message input
 */
export function focusInput(container: HTMLElement): void {
  const messageInput = container.querySelector("#chat-message-input") as HTMLTextAreaElement;
  messageInput?.focus();
}
