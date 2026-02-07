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
  attachmentPreviewBg: "#f3f4f6",
  buttonBg: "#f5f5f5",
  buttonHoverBg: "#e8e8e8",
  dropdownBg: "#fff",
  dropdownItemHoverBg: "#f5f5f5",
  hoverBg: "#f0f0f0",
  borderColor: "#e0e0e0",
  inputBorderColor: "#ddd",
  inputFocusBorderColor: "#6b7280",
  textPrimary: "#333",
  textSecondary: "#555",
  textMuted: "#888",
  inlineCodeBg: "#f0f0f0",
  inlineCodeColor: "#e83e8c",
  codeBlockBg: "#1e1e1e",
  codeBlockColor: "#d4d4d4",
  userBubbleBg: "#e5e7eb",
  userBubbleText: "#374151",
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
  hoverBg: "#383838",
  borderColor: "#444",
  inputBorderColor: "#555",
  inputFocusBorderColor: "#6b7280",
  textPrimary: "#e0e0e0",
  textSecondary: "#ccc",
  textMuted: "#999",
  inlineCodeBg: "#333",
  inlineCodeColor: "#ff79c6",
  codeBlockBg: "#0d0d0d",
  codeBlockColor: "#d4d4d4",
  userBubbleBg: "linear-gradient(135deg, #6b7280 0%, #4b5563 100%)",
  userBubbleText: "#ffffff",
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
  const emptyState = container.querySelector(
    "#chat-empty-state",
  ) as HTMLElement;
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
  container
    .querySelectorAll("#chat-new, #chat-upload-file, #chat-history-btn")
    .forEach((btn: Element) => {
      const el = btn as HTMLElement;
      el.style.background = theme.buttonBg;
      el.style.borderColor = theme.inputBorderColor;
      el.style.color = theme.textPrimary;
    });

  // Attachments preview
  const attachmentsPreview = container.querySelector(
    "#chat-attachments-preview",
  ) as HTMLElement;
  if (attachmentsPreview) {
    attachmentsPreview.style.background = theme.attachmentPreviewBg;
    attachmentsPreview.style.borderTopColor = theme.borderColor;
  }

  // Input area (parent of input wrapper)
  const inputWrapper = container.querySelector(
    "#chat-input-wrapper",
  ) as HTMLElement;
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
  const messageInput = container.querySelector(
    "#chat-message-input",
  ) as HTMLElement;
  if (messageInput) {
    messageInput.style.color = theme.textPrimary;
  }

  // Model selector button
  const modelSelectorBtn = container.querySelector(
    "#chat-model-selector-btn",
  ) as HTMLElement;
  if (modelSelectorBtn) {
    modelSelectorBtn.style.background = theme.buttonBg;
    modelSelectorBtn.style.borderColor = theme.inputBorderColor;
    modelSelectorBtn.style.color = theme.textSecondary;
  }

  // Model dropdown
  const modelDropdown = container.querySelector(
    "#chat-model-dropdown",
  ) as HTMLElement;
  if (modelDropdown) {
    modelDropdown.style.background = theme.dropdownBg;
    modelDropdown.style.borderColor = theme.borderColor;
  }

  // History dropdown
  const historyDropdown = container.querySelector(
    "#chat-history-dropdown",
  ) as HTMLElement;
  if (historyDropdown) {
    historyDropdown.style.background = theme.dropdownBg;
    historyDropdown.style.borderColor = theme.borderColor;
  }

  // Mention popup
  const mentionPopup = container.querySelector(
    "#chat-mention-popup",
  ) as HTMLElement;
  if (mentionPopup) {
    mentionPopup.style.background = theme.dropdownBg;
    mentionPopup.style.borderColor = theme.borderColor;
  }

  // User bar
  const userBar = container.querySelector("#chat-user-bar") as HTMLElement;
  if (userBar) {
    userBar.style.background = theme.userBubbleBg;
    userBar.style.color = theme.userBubbleText;
  }

  // User bar buttons (action btn + settings btn) - adapt to light/dark bg
  const isDark = theme === darkTheme;
  const btnBg = isDark ? "rgba(255, 255, 255, 0.2)" : "rgba(0, 0, 0, 0.06)";
  const btnBorder = isDark ? "rgba(255, 255, 255, 0.3)" : "rgba(0, 0, 0, 0.1)";

  const userActionBtn = container.querySelector("#chat-user-action-btn") as HTMLElement;
  if (userActionBtn) {
    userActionBtn.style.background = btnBg;
    userActionBtn.style.borderColor = btnBorder;
    userActionBtn.style.color = theme.userBubbleText;
  }

  const userBarSettingsBtn = container.querySelector("#chat-user-bar-settings-btn") as HTMLElement;
  if (userBarSettingsBtn) {
    userBarSettingsBtn.style.background = btnBg;
    userBarSettingsBtn.style.borderColor = btnBorder;
    // Update icon filter
    const icon = userBarSettingsBtn.querySelector("img") as HTMLElement;
    if (icon) {
      icon.style.filter = isDark ? "brightness(0) invert(1)" : "brightness(0) invert(0.3)";
    }
  }

  // Send button
  const sendButton = container.querySelector("#chat-send-button") as HTMLElement;
  if (sendButton) {
    sendButton.style.background = theme.userBubbleBg;
    sendButton.style.color = theme.userBubbleText;
  }

  // Update existing user message bubbles
  container
    .querySelectorAll(".user-message .chat-bubble")
    .forEach((bubble: Element) => {
      const el = bubble as HTMLElement;
      el.style.background = theme.userBubbleBg;
      el.style.color = theme.userBubbleText;
    });

  // Update existing assistant message bubbles
  container
    .querySelectorAll(".assistant-message .chat-bubble")
    .forEach((bubble: Element) => {
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
 * Uses both matchMedia and MutationObserver for reliable theme detection
 * @returns cleanup function to remove the listener
 */
export function setupThemeListener(onThemeChange: () => void): () => void {
  const win = Zotero.getMainWindow();
  if (!win) {
    return () => {};
  }

  const cleanups: (() => void)[] = [];

  // 追踪最后一次主题状态，用于防止重复触发
  let lastThemeState = isDarkMode();

  // 统一的主题变化处理函数，带防重复检查
  const handleThemeChange = () => {
    const newThemeState = isDarkMode();
    if (newThemeState !== lastThemeState) {
      lastThemeState = newThemeState;
      updateCurrentTheme();
      onThemeChange();
    }
  };

  // 1. 监听系统主题变化 (prefers-color-scheme)
  if (win.matchMedia) {
    const mediaQuery = win.matchMedia("(prefers-color-scheme: dark)");
    if (mediaQuery) {
      mediaQuery.addEventListener("change", handleThemeChange);
      cleanups.push(() => mediaQuery.removeEventListener("change", handleThemeChange));
    }
  }

  // 2. 使用 MutationObserver 监听 documentElement 的类名/属性变化
  // Zotero/Firefox 可能通过修改 document 的 class 或 data 属性来切换主题
  const MutationObserverClass = (win as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  if (MutationObserverClass) {
    const observer = new MutationObserverClass(handleThemeChange);

    // 监听 html 元素的属性变化（class, data-* 等）
    observer.observe(win.document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-color-scheme"],
    });

    cleanups.push(() => observer.disconnect());
  }

  // 返回统一的清理函数
  return () => {
    cleanups.forEach((cleanup) => cleanup());
  };
}
