/**
 * ChatPanelEvents - Event handlers for the chat panel
 */

import type { ImageAttachment, FileAttachment } from "../../../types/chat";
import type { ChatPanelContext, AttachmentState, SessionInfo } from "./types";
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

  // Input keydown - Enter to send
  messageInput?.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
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
          if (session.itemId === 0) {
            context.setCurrentItem({ id: 0 } as Zotero.Item);
          } else {
            try {
              const item = await Zotero.Items.getAsync(session.itemId);
              if (item) {
                context.setCurrentItem(item as Zotero.Item);
              }
            } catch {
              context.setCurrentItem({ id: session.itemId } as Zotero.Item);
            }
          }
          const currentItem = context.getCurrentItem();
          context.updatePdfCheckboxVisibility(currentItem);
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
      background: "#fff",
      border: "1px solid #d0d7ff",
      borderRadius: "12px",
      padding: "4px 12px",
      fontSize: "11px",
      color: "#555",
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
  attachmentsPreview: HTMLElement | null,
): Promise<void> {
  ztoolkit.log("sendMessage function called");
  const content = messageInput?.value?.trim();
  if (!content) {
    ztoolkit.log("No content to send");
    return;
  }
  ztoolkit.log("Message content:", content.substring(0, 50) + "...");

  const { chatManager, authManager } = context;

  // Use current item or get from reader
  let item = context.getCurrentItem();
  if (!item) {
    item = getActiveReaderItem();
    if (item) {
      context.setCurrentItem(item);
      context.updatePdfCheckboxVisibility(item);
    }
  }
  ztoolkit.log("Item for message:", item?.id ?? "global chat");

  // Only require PDFAiTalk login if using PDFAiTalk provider
  const providerManager = getProviderManager();
  const activeProviderId = providerManager.getActiveProviderId();
  const activeProvider = providerManager.getActiveProvider();

  if (activeProviderId === "pdfaitalk") {
    // PDFAiTalk requires login
    if (!authManager.isLoggedIn()) {
      ztoolkit.log("User not logged in, showing auth dialog");
      const success = await showAuthDialog("login");
      if (!success) return;
      context.updateUserBar();
    }
  } else {
    // Other providers require the provider to be ready (API key configured)
    if (!activeProvider || !activeProvider.isReady()) {
      ztoolkit.log("Provider not ready:", activeProviderId);
      // Could show an error message here
      return;
    }
  }

  ztoolkit.log("Disabling input, calling manager.sendMessage...");
  ztoolkit.log("[Debug] attachPdfCheckbox exists:", !!attachPdfCheckbox);
  ztoolkit.log("[Debug] attachPdfCheckbox.checked:", attachPdfCheckbox?.checked);
  if (sendButton) sendButton.disabled = true;
  if (messageInput) messageInput.disabled = true;

  try {
    const attachmentState = context.getAttachmentState();

    // If no item or global chat (id = 0), use global chat mode
    if (!item || item.id === 0) {
      ztoolkit.log("Using global chat mode - PDF attach checkbox is ignored in this mode");
      const currentItem = context.getCurrentItem();
      if (!currentItem) {
        context.setCurrentItem({ id: 0 } as Zotero.Item);
      }
      await chatManager.sendMessageGlobal(content, {
        images: attachmentState.pendingImages.length > 0 ? attachmentState.pendingImages : undefined,
        files: attachmentState.pendingFiles.length > 0 ? attachmentState.pendingFiles : undefined,
        selectedText: attachmentState.pendingSelectedText || undefined,
      });
    } else {
      ztoolkit.log("Calling manager.sendMessage for item:", item.id);
      await chatManager.sendMessage(item, content, {
        attachPdf: attachPdfCheckbox?.checked,
        images: attachmentState.pendingImages.length > 0 ? attachmentState.pendingImages : undefined,
        files: attachmentState.pendingFiles.length > 0 ? attachmentState.pendingFiles : undefined,
        selectedText: attachmentState.pendingSelectedText || undefined,
      });
    }
    ztoolkit.log("manager.sendMessage completed");

    if (messageInput) {
      messageInput.value = "";
      messageInput.style.height = "auto";
    }

    context.clearAttachments();
    context.updateAttachmentsPreview();
  } catch (error) {
    ztoolkit.log("Error in sendMessage:", error);
  } finally {
    if (sendButton) sendButton.disabled = false;
    if (messageInput) messageInput.disabled = false;
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
 * Update PDF checkbox visibility based on item
 */
export async function updatePdfCheckboxVisibilityForItem(
  container: HTMLElement,
  item: Zotero.Item | null,
  chatManager: { hasPdfAttachment(item: Zotero.Item): Promise<boolean> },
): Promise<void> {
  const pdfLabel = container.querySelector("#chat-pdf-label") as HTMLElement;
  if (!pdfLabel) return;

  if (!item || item.id === 0) {
    // Global chat mode - hide PDF checkbox
    pdfLabel.style.display = "none";
    return;
  }

  const hasPdf = await chatManager.hasPdfAttachment(item);
  pdfLabel.style.display = hasPdf ? "flex" : "none";
  ztoolkit.log("Updated PDF checkbox visibility:", hasPdf ? "visible" : "hidden");
}

/**
 * Focus the message input
 */
export function focusInput(container: HTMLElement): void {
  const messageInput = container.querySelector("#chat-message-input") as HTMLTextAreaElement;
  messageInput?.focus();
}
