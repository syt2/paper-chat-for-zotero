/**
 * ChatPanelBuilder - Build all DOM elements for the chat panel
 */

import { config } from "../../../../package.json";
import { getString } from "../../../utils/locale";
import { chatColors } from "../../../utils/colors";
import type { ThemeColors } from "./types";
import { HTML_NS } from "./types";

/**
 * Helper to create an element with styles (using proper HTML namespace for XHTML)
 */
export function createElement(
  doc: Document,
  tag: string,
  styles: Partial<CSSStyleDeclaration> = {},
  attrs: Record<string, string> = {},
): HTMLElement {
  const el = doc.createElementNS(HTML_NS, tag) as HTMLElement;
  Object.assign(el.style, styles);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  return el;
}

/**
 * Create the chat container element using DOM API
 */
export function createChatContainer(doc: Document, theme: ThemeColors): HTMLElement {
  // Main container
  const container = createElement(doc, "div", {
    display: "none",
    position: "fixed",
    backgroundColor: theme.containerBg,
    overflow: "hidden",
    borderLeft: `1px solid ${theme.borderColor}`,
    zIndex: "10000",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: "13px",
    pointerEvents: "auto",
  }, { id: `${config.addonRef}-chat-container` });

  // Root wrapper
  const root = createElement(doc, "div", {
    display: "flex",
    flexDirection: "column",
    height: "100%",
  }, { class: "chat-panel-root" });

  // Drag bar (only visible in floating mode)
  const dragBar = createElement(doc, "div", {
    display: "none",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 12px",
    background: theme.toolbarBg,
    borderBottom: `1px solid ${theme.borderColor}`,
    cursor: "move",
    userSelect: "none",
  }, { id: "chat-drag-bar" });

  const dragTitle = createElement(doc, "span", {
    fontSize: "13px",
    fontWeight: "600",
    color: theme.textPrimary,
    pointerEvents: "none",
  });
  dragTitle.textContent = "Paper Chat";

  const closeBtn = createElement(doc, "button", {
    width: "20px",
    height: "20px",
    background: "transparent",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0",
    fontSize: "14px",
    color: theme.textMuted,
  }, { id: "chat-close-btn", title: "关闭" });
  closeBtn.textContent = "✕";

  dragBar.appendChild(dragTitle);
  dragBar.appendChild(closeBtn);

  // User Bar
  const userBar = createElement(doc, "div", {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 14px",
    background: chatColors.userBubble,
    color: "#fff",
    fontSize: "12px",
  }, { id: "chat-user-bar" });

  const userInfo = createElement(doc, "div", {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  });

  const userName = createElement(doc, "span", {
    fontWeight: "600",
    fontSize: "14px",
  }, { id: "chat-user-name" });

  const userBalance = createElement(doc, "span", {
    fontSize: "11px",
    opacity: "0.9",
  }, { id: "chat-user-balance" });

  userInfo.appendChild(userName);
  userInfo.appendChild(userBalance);

  const userActionBtn = createElement(doc, "button", {
    background: "rgba(255, 255, 255, 0.2)",
    border: "1px solid rgba(255, 255, 255, 0.3)",
    borderRadius: "4px",
    padding: "5px 14px",
    color: "#fff",
    fontSize: "12px",
    cursor: "pointer",
  }, { id: "chat-user-action-btn" });

  userBar.appendChild(userInfo);
  userBar.appendChild(userActionBtn);

  // Chat History
  const chatHistory = createElement(doc, "div", {
    flex: "1",
    overflowY: "auto",
    overflowX: "hidden",
    padding: "14px",
    background: theme.chatHistoryBg,
  }, { id: "chat-history" });

  // Empty State
  const emptyState = createElement(doc, "div", {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    minHeight: "200px",
    color: theme.textMuted,
    textAlign: "center",
  }, { id: "chat-empty-state" });

  const emptyIcon = createElement(doc, "div", {
    fontSize: "48px",
    marginBottom: "16px",
    opacity: "0.6",
  });
  emptyIcon.textContent = "\uD83D\uDCAC"; // 💬

  const emptyText = createElement(doc, "div", {
    fontSize: "15px",
    color: theme.textMuted,
  });
  emptyText.textContent = getString("chat-start-conversation");

  emptyState.appendChild(emptyIcon);
  emptyState.appendChild(emptyText);
  chatHistory.appendChild(emptyState);

  // Toolbar
  const toolbar = createElement(doc, "div", {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 14px",
    background: theme.toolbarBg,
    borderTop: `1px solid ${theme.borderColor}`,
    flexWrap: "wrap",
    gap: "10px",
  }, { id: "chat-toolbar" });

  // PDF checkbox
  const pdfLabel = createElement(doc, "label", {
    display: "none",
    alignItems: "center",
    gap: "6px",
    fontSize: "12px",
    color: theme.textSecondary,
    cursor: "pointer",
  }, { id: "chat-pdf-label" });

  const pdfCheckbox = createElement(doc, "input", {
    margin: "0",
    cursor: "pointer",
  }, { type: "checkbox", id: "chat-attach-pdf" }) as HTMLInputElement;

  const pdfText = createElement(doc, "span", {});
  pdfText.textContent = getString("chat-attach-pdf");

  const pdfStatus = createElement(doc, "span", {
    fontSize: "11px",
    color: theme.textMuted,
    marginLeft: "4px",
  }, { id: "chat-pdf-status" });

  pdfLabel.appendChild(pdfCheckbox);
  pdfLabel.appendChild(pdfText);
  pdfLabel.appendChild(pdfStatus);

  // Toolbar buttons
  const toolbarButtons = createElement(doc, "div", {
    display: "flex",
    gap: "6px",
  });

  const btnStyle: Partial<CSSStyleDeclaration> = {
    background: theme.buttonBg,
    border: `1px solid ${theme.inputBorderColor}`,
    borderRadius: "4px",
    padding: "5px 10px",
    cursor: "pointer",
    fontSize: "15px",
    color: theme.textPrimary,
  };

  const iconStyle: Partial<CSSStyleDeclaration> = {
    width: "16px",
    height: "16px",
  };

  // New chat button
  const newChatBtn = createElement(doc, "button", btnStyle, { id: "chat-new", title: getString("chat-new-chat") });
  const newChatIcon = createElement(doc, "img", iconStyle, { src: `chrome://${config.addonRef}/content/icons/newlybuild.svg` });
  newChatBtn.appendChild(newChatIcon);

  // Upload file button (supports images and text files)
  const uploadFileBtn = createElement(doc, "button", btnStyle, { id: "chat-upload-file", title: getString("chat-upload-file") });
  const uploadIcon = createElement(doc, "img", iconStyle, { src: `chrome://${config.addonRef}/content/icons/upload-one.svg` });
  uploadFileBtn.appendChild(uploadIcon);

  // History button
  const historyBtn = createElement(doc, "button", btnStyle, { id: "chat-history-btn", title: getString("chat-history") });
  const historyIcon = createElement(doc, "img", iconStyle, { src: `chrome://${config.addonRef}/content/icons/history.svg` });
  historyBtn.appendChild(historyIcon);

  toolbarButtons.appendChild(newChatBtn);
  toolbarButtons.appendChild(uploadFileBtn);
  toolbarButtons.appendChild(historyBtn);

  toolbar.appendChild(pdfLabel);
  toolbar.appendChild(toolbarButtons);

  // Attachments Preview
  const attachmentsPreview = createElement(doc, "div", {
    display: "none",
    flexWrap: "wrap",
    gap: "8px",
    padding: "10px 14px",
    background: theme.attachmentPreviewBg,
    borderTop: `1px solid ${theme.borderColor}`,
  }, { id: "chat-attachments-preview" });

  // Input Area - ChatBox style with vertical layout
  const inputArea = createElement(doc, "div", {
    display: "flex",
    flexDirection: "column",
    padding: "14px",
    background: theme.inputAreaBg,
    borderTop: `1px solid ${theme.borderColor}`,
  });

  // Input wrapper - contains textarea
  const inputWrapper = createElement(doc, "div", {
    display: "flex",
    border: `1px solid ${theme.inputBorderColor}`,
    borderRadius: "12px",
    background: theme.inputBg,
    overflow: "hidden",
  }, { id: "chat-input-wrapper" });

  const messageInput = createElement(doc, "textarea", {
    flex: "1",
    minHeight: "60px",
    maxHeight: "140px",
    padding: "12px 14px",
    border: "none",
    fontFamily: "inherit",
    fontSize: "14px",
    resize: "none",
    outline: "none",
    background: "transparent",
    color: theme.textPrimary,
  }, { id: "chat-message-input", rows: "3", placeholder: getString("chat-input-placeholder") }) as HTMLTextAreaElement;

  inputWrapper.appendChild(messageInput);

  // Bottom bar - model selector + settings on left, send button on right
  const inputBottomBar = createElement(doc, "div", {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: "10px",
  });

  // Left side container (model selector + settings button)
  const leftContainer = createElement(doc, "div", {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  });

  // Model selector container
  const modelSelectorContainer = createElement(doc, "div", {
    position: "relative",
  });

  // Model selector button
  const modelSelectorBtn = createElement(doc, "button", {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 12px",
    background: theme.buttonBg,
    border: `1px solid ${theme.inputBorderColor}`,
    borderRadius: "8px",
    cursor: "pointer",
    fontSize: "12px",
    color: theme.textSecondary,
    maxWidth: "200px",
  }, { id: "chat-model-selector-btn" });

  const modelSelectorText = createElement(doc, "span", {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  }, { id: "chat-model-selector-text" });
  modelSelectorText.textContent = "选择模型";

  const modelSelectorArrow = createElement(doc, "span", {
    fontSize: "10px",
    opacity: "0.6",
  });
  modelSelectorArrow.textContent = "▼";

  modelSelectorBtn.appendChild(modelSelectorText);
  modelSelectorBtn.appendChild(modelSelectorArrow);

  // Model dropdown
  const modelDropdown = createElement(doc, "div", {
    display: "none",
    position: "absolute",
    bottom: "100%",
    left: "0",
    marginBottom: "4px",
    minWidth: "220px",
    maxWidth: "300px",
    maxHeight: "300px",
    overflowY: "auto",
    background: theme.dropdownBg,
    border: `1px solid ${theme.borderColor}`,
    borderRadius: "8px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
    zIndex: "10002",
  }, { id: "chat-model-dropdown" });

  modelSelectorContainer.appendChild(modelSelectorBtn);
  modelSelectorContainer.appendChild(modelDropdown);

  // Settings button (gear icon)
  const settingsBtn = createElement(doc, "button", {
    width: "28px",
    height: "28px",
    background: "transparent",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0",
  }, { id: "chat-settings-btn" });
  settingsBtn.title = "打开设置";

  // Settings icon (SVG)
  const settingsIcon = createElement(doc, "img", {
    width: "16px",
    height: "16px",
    opacity: "0.6",
  });
  (settingsIcon as HTMLImageElement).src = `chrome://${config.addonRef}/content/icons/config.svg`;
  settingsBtn.appendChild(settingsIcon);

  // Panel mode toggle button (sidebar/floating)
  const panelModeBtn = createElement(doc, "button", {
    width: "28px",
    height: "28px",
    background: "transparent",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0",
  }, { id: "chat-panel-mode-btn" });
  panelModeBtn.title = "切换侧边栏/悬浮窗模式";

  // Panel mode icon (SVG image)
  const panelModeIcon = createElement(doc, "img", {
    width: "16px",
    height: "16px",
    opacity: "0.6",
  }, { id: "chat-panel-mode-icon" });
  // Default: sidebar mode, show split icon (click to switch to floating)
  (panelModeIcon as HTMLImageElement).src = `chrome://${config.addonRef}/content/icons/split.svg`;
  panelModeBtn.appendChild(panelModeIcon);

  leftContainer.appendChild(modelSelectorContainer);
  leftContainer.appendChild(settingsBtn);
  leftContainer.appendChild(panelModeBtn);

  // Send button
  const sendButton = createElement(doc, "button", {
    width: "32px",
    height: "32px",
    background: chatColors.userBubble,
    color: "#fff",
    border: "none",
    borderRadius: "50%",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: "0",
    padding: "0",
  }, { id: "chat-send-button" });

  // Arrow up icon
  const sendIcon = createElement(doc, "span", {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "16px",
    fontWeight: "bold",
  });
  sendIcon.textContent = "↑";
  sendButton.appendChild(sendIcon);

  inputBottomBar.appendChild(leftContainer);
  inputBottomBar.appendChild(sendButton);

  inputArea.appendChild(inputWrapper);
  inputArea.appendChild(inputBottomBar);

  // History dropdown panel - append to container for proper positioning
  const historyDropdown = createElement(doc, "div", {
    display: "none",
    position: "absolute",
    bottom: "120px",
    right: "10px",
    width: "300px",
    maxHeight: "350px",
    overflowY: "auto",
    background: theme.dropdownBg,
    border: `1px solid ${theme.borderColor}`,
    borderRadius: "8px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
    zIndex: "10001",
  }, { id: "chat-history-dropdown" });

  // Assemble
  root.appendChild(dragBar);
  root.appendChild(userBar);
  root.appendChild(chatHistory);
  root.appendChild(toolbar);
  root.appendChild(attachmentsPreview);
  root.appendChild(inputArea);
  root.appendChild(historyDropdown);
  container.appendChild(root);

  doc.documentElement?.appendChild(container);
  return container;
}

/**
 * Copy text to clipboard using Zotero-compatible method
 */
export function copyToClipboard(text: string): void {
  try {
    const win = Zotero.getMainWindow() as Window & { navigator?: Navigator; document: Document };

    // Use XPCOM clipboard
    const clipboardHelper = (Components.classes as Record<string, { getService(iface: unknown): { copyString(text: string): void } }>)["@mozilla.org/widget/clipboardhelper;1"]
      ?.getService((Components.interfaces as unknown as Record<string, unknown>).nsIClipboardHelper);

    if (clipboardHelper) {
      clipboardHelper.copyString(text);
      ztoolkit.log("Copied to clipboard via nsIClipboardHelper");
      return;
    }

    // Fallback: try native clipboard API
    if (win.navigator?.clipboard?.writeText) {
      win.navigator.clipboard.writeText(text);
      ztoolkit.log("Copied to clipboard via navigator.clipboard");
      return;
    }

    // Fallback: use execCommand
    const textarea = win.document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    win.document.body?.appendChild(textarea);
    textarea.select();
    win.document.execCommand("copy");
    win.document.body?.removeChild(textarea);
    ztoolkit.log("Copied to clipboard via execCommand");
  } catch (e) {
    ztoolkit.log("Copy to clipboard failed:", e);
  }
}
