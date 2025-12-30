/**
 * ChatPanelTheme - Theme management and dark mode support
 */

import type { ThemeColors } from "./types";

// Light theme colors
export const lightTheme: ThemeColors = {
  containerBg: "#f7f7f8",
  chatHistoryBg: "#f7f7f8",
  toolbarBg: "#fff",
  inputAreaBg: "#fff",
  inputBg: "#fff",
  assistantBubbleBg: "#fff",
  attachmentPreviewBg: "#f0f4ff",
  buttonBg: "#f5f5f5",
  buttonHoverBg: "#e8e8e8",
  dropdownBg: "#fff",
  dropdownItemHoverBg: "#f5f5f5",
  borderColor: "#e0e0e0",
  inputBorderColor: "#ddd",
  inputFocusBorderColor: "#667eea",
  textPrimary: "#333",
  textSecondary: "#555",
  textMuted: "#888",
  inlineCodeBg: "#f0f0f0",
  inlineCodeColor: "#e83e8c",
  codeBlockBg: "#1e1e1e",
  codeBlockColor: "#d4d4d4",
  scrollbarThumb: "#c1c1c1",
  scrollbarThumbHover: "#a1a1a1",
  copyBtnBg: "rgba(0,0,0,0.1)",
};

// Dark theme colors
export const darkTheme: ThemeColors = {
  containerBg: "#1e1e1e",
  chatHistoryBg: "#1e1e1e",
  toolbarBg: "#252525",
  inputAreaBg: "#252525",
  inputBg: "#333",
  assistantBubbleBg: "#2d2d2d",
  attachmentPreviewBg: "#252525",
  buttonBg: "#333",
  buttonHoverBg: "#444",
  dropdownBg: "#2d2d2d",
  dropdownItemHoverBg: "#3d3d3d",
  borderColor: "#444",
  inputBorderColor: "#555",
  inputFocusBorderColor: "#667eea",
  textPrimary: "#e0e0e0",
  textSecondary: "#ccc",
  textMuted: "#999",
  inlineCodeBg: "#333",
  inlineCodeColor: "#ff79c6",
  codeBlockBg: "#0d0d0d",
  codeBlockColor: "#d4d4d4",
  scrollbarThumb: "#555",
  scrollbarThumbHover: "#666",
  copyBtnBg: "rgba(255,255,255,0.1)",
};

// Current theme state
let currentTheme: ThemeColors = lightTheme;

/**
 * Check if dark mode is enabled
 * 使用多种方法检测，因为 matchMedia 在启动时可能不准确
 */
export function isDarkMode(): boolean {
  const win = Zotero.getMainWindow();
  if (!win) return false;
  const mediaQuery = win.matchMedia?.("(prefers-color-scheme: dark)");
  return mediaQuery?.matches ?? false;
}

/**
 * Get the current cached theme
 */
export function getCurrentTheme(): ThemeColors {
  return currentTheme;
}

/**
 * Update the cached theme
 */
export function updateCurrentTheme(): ThemeColors {
  currentTheme = isDarkMode() ? darkTheme : lightTheme;
  return currentTheme;
}

/**
 * Apply theme colors to container and its children
 */
export function applyThemeToContainer(container: HTMLElement): void {
  const theme = currentTheme;

  // Main container
  container.style.backgroundColor = theme.containerBg;
  container.style.borderLeftColor = theme.borderColor;

  // Chat history
  const chatHistory = container.querySelector("#chat-history") as HTMLElement;
  if (chatHistory) {
    chatHistory.style.background = theme.chatHistoryBg;
  }

  // Empty state
  const emptyState = container.querySelector("#chat-empty-state") as HTMLElement;
  if (emptyState) {
    emptyState.style.color = theme.textMuted;
  }

  // Toolbar
  const toolbar = container.querySelector("#chat-toolbar") as HTMLElement;
  if (toolbar) {
    toolbar.style.background = theme.toolbarBg;
    toolbar.style.borderTopColor = theme.borderColor;
  }

  // PDF label
  const pdfLabel = container.querySelector("#chat-pdf-label") as HTMLElement;
  if (pdfLabel) {
    pdfLabel.style.color = theme.textSecondary;
  }

  // Toolbar buttons
  container.querySelectorAll("#chat-new, #chat-upload-file, #chat-history-btn").forEach((btn: Element) => {
    const el = btn as HTMLElement;
    el.style.background = theme.buttonBg;
    el.style.borderColor = theme.inputBorderColor;
    el.style.color = theme.textPrimary;
  });

  // Attachments preview
  const attachmentsPreview = container.querySelector("#chat-attachments-preview") as HTMLElement;
  if (attachmentsPreview) {
    attachmentsPreview.style.background = theme.attachmentPreviewBg;
    attachmentsPreview.style.borderTopColor = theme.borderColor;
  }

  // Input area (parent of input wrapper)
  const inputWrapper = container.querySelector("#chat-input-wrapper") as HTMLElement;
  if (inputWrapper) {
    const inputArea = inputWrapper.parentElement as HTMLElement;
    if (inputArea) {
      inputArea.style.background = theme.inputAreaBg;
      inputArea.style.borderTopColor = theme.borderColor;
    }
    // Input wrapper background and border
    inputWrapper.style.background = theme.inputBg;
    inputWrapper.style.borderColor = theme.inputBorderColor;
  }

  // Message input
  const messageInput = container.querySelector("#chat-message-input") as HTMLElement;
  if (messageInput) {
    messageInput.style.color = theme.textPrimary;
  }

  // Model selector button
  const modelSelectorBtn = container.querySelector("#chat-model-selector-btn") as HTMLElement;
  if (modelSelectorBtn) {
    modelSelectorBtn.style.background = theme.buttonBg;
    modelSelectorBtn.style.borderColor = theme.inputBorderColor;
    modelSelectorBtn.style.color = theme.textSecondary;
  }

  // Model dropdown
  const modelDropdown = container.querySelector("#chat-model-dropdown") as HTMLElement;
  if (modelDropdown) {
    modelDropdown.style.background = theme.dropdownBg;
    modelDropdown.style.borderColor = theme.borderColor;
  }

  // History dropdown
  const historyDropdown = container.querySelector("#chat-history-dropdown") as HTMLElement;
  if (historyDropdown) {
    historyDropdown.style.background = theme.dropdownBg;
    historyDropdown.style.borderColor = theme.borderColor;
  }

  // Update existing message bubbles
  container.querySelectorAll(".assistant-message .chat-bubble").forEach((bubble: Element) => {
    const el = bubble as HTMLElement;
    el.style.background = theme.assistantBubbleBg;
    el.style.color = theme.textPrimary;
    el.style.borderColor = theme.borderColor;
  });

  // Update copy buttons
  container.querySelectorAll(".copy-btn").forEach((btn: Element) => {
    const el = btn as HTMLElement;
    el.style.background = theme.copyBtnBg;
  });
}

/**
 * Setup theme change listener
 * @returns cleanup function to remove the listener
 */
export function setupThemeListener(onThemeChange: () => void): () => void {
  const win = Zotero.getMainWindow();
  if (!win?.matchMedia) {
    return () => {};
  }

  const mediaQuery = win.matchMedia("(prefers-color-scheme: dark)");
  if (!mediaQuery) {
    return () => {};
  }

  const handler = () => {
    updateCurrentTheme();
    onThemeChange();
  };

  mediaQuery.addEventListener("change", handler);

  return () => {
    mediaQuery.removeEventListener("change", handler);
  };
}
