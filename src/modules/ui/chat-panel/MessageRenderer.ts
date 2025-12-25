/**
 * MessageRenderer - Create and manage message bubble elements
 */

import type { ChatMessage } from "../../chat";
import type { ThemeColors } from "./types";
import { HTML_NS } from "./types";
import { renderMarkdownToElement } from "./MarkdownRenderer";
import { createElement, copyToClipboard } from "./ChatPanelBuilder";

/**
 * Create a message element for display in chat history
 */
export function createMessageElement(
  doc: Document,
  msg: ChatMessage,
  theme: ThemeColors,
  isLastAssistant: boolean = false,
): HTMLElement {
  const wrapper = createElement(doc, "div", {
    display: "block",
    margin: "10px 0",
    textAlign: msg.role === "user" ? "right" : "left",
  }, { class: `chat-message ${msg.role}-message` });

  // 根据角色设置气泡样式
  let bubbleStyle: Record<string, string>;
  if (msg.role === "user") {
    bubbleStyle = {
      background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
      color: "#fff",
      borderBottomRightRadius: "4px",
    };
  } else if (msg.role === "error") {
    bubbleStyle = {
      background: "#ffebee",
      color: "#c62828",
      border: "1px solid #f44336",
      borderBottomLeftRadius: "4px",
    };
  } else {
    bubbleStyle = {
      background: theme.assistantBubbleBg,
      color: theme.textPrimary,
      border: `1px solid ${theme.borderColor}`,
      borderBottomLeftRadius: "4px",
      boxShadow: "0 1px 3px rgba(0, 0, 0, 0.08)",
    };
  }

  const bubble = createElement(doc, "div", {
    position: "relative",
    display: "inline-block",
    maxWidth: "85%",
    padding: "12px 16px",
    borderRadius: "14px",
    wordWrap: "break-word",
    textAlign: "left",
    ...bubbleStyle,
  }, { class: "chat-bubble" });

  const contentAttrs: Record<string, string> = { class: "chat-content" };
  if (msg.role === "assistant" && isLastAssistant) {
    contentAttrs.id = "chat-streaming-content";
  }

  const content = createElement(doc, "div", {
    lineHeight: "1.6",
    whiteSpace: "pre-wrap",
    userSelect: "text",
    cursor: "text",
  }, contentAttrs);

  // Store raw content for copying
  let rawContent = msg.content;

  if (msg.role === "user") {
    // Format user message for display
    const displayContent = msg.selectedText
      ? `[Selected]: ${msg.selectedText}\n\n${msg.content.split("[Question]:").pop()?.trim() || msg.content}`
      : msg.content.includes("[Question]:")
        ? msg.content.split("[Question]:").pop()?.trim() || msg.content
        : msg.content;
    content.textContent = displayContent;
    rawContent = displayContent;
  } else if (msg.role === "error") {
    // 错误消息显示为纯文本，带警告图标
    // 尝试解析 JSON 错误消息以获取更友好的显示
    let errorDisplay = msg.content;
    try {
      // 尝试从 "API Error: 403 - {json}" 格式中提取错误信息
      const jsonMatch = msg.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const errorJson = JSON.parse(jsonMatch[0]);
        if (errorJson.error?.message) {
          errorDisplay = errorJson.error.message;
        }
      }
    } catch {
      // 解析失败，使用原始内容
    }
    content.textContent = `⚠️ ${errorDisplay}`;
    rawContent = errorDisplay;
  } else {
    // Render assistant message as markdown
    renderMarkdownToElement(content, msg.content);
  }

  bubble.appendChild(content);

  // Add copy button
  const copyBtn = createCopyButton(doc, theme, rawContent);
  setupCopyButtonHover(bubble, copyBtn);

  bubble.appendChild(copyBtn);
  wrapper.appendChild(bubble);
  return wrapper;
}

/**
 * Create a copy button for message bubbles
 */
export function createCopyButton(
  doc: Document,
  theme: ThemeColors,
  contentToCopy: string,
): HTMLElement {
  const copyBtn = createElement(doc, "button", {
    position: "absolute",
    bottom: "4px",
    right: "4px",
    background: theme.copyBtnBg,
    border: "none",
    borderRadius: "4px",
    padding: "4px 8px",
    fontSize: "12px",
    cursor: "pointer",
    opacity: "0",
    transition: "opacity 0.2s",
  }, { class: "copy-btn", title: "Copy" });
  copyBtn.textContent = "\uD83D\uDCCB"; // 📋

  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    copyToClipboard(contentToCopy);
    copyBtn.textContent = "\u2713"; // ✓
    setTimeout(() => {
      copyBtn.textContent = "\uD83D\uDCCB"; // 📋
    }, 1500);
  });

  return copyBtn;
}

/**
 * Setup hover behavior for copy button visibility
 */
export function setupCopyButtonHover(bubble: HTMLElement, copyBtn: HTMLElement): void {
  bubble.addEventListener("mouseenter", () => {
    copyBtn.style.opacity = "1";
  });
  bubble.addEventListener("mouseleave", () => {
    copyBtn.style.opacity = "0";
  });
}

/**
 * Render all messages to the chat history element
 */
export function renderMessages(
  chatHistory: HTMLElement,
  emptyState: HTMLElement | null,
  messages: ChatMessage[],
  theme: ThemeColors,
): void {
  const doc = chatHistory.ownerDocument;
  if (!doc) return;

  ztoolkit.log("renderMessages called, count:", messages.length);
  chatHistory.textContent = "";

  if (messages.length === 0) {
    if (emptyState) {
      chatHistory.appendChild(emptyState);
      emptyState.style.display = "flex";
    }
    return;
  }

  if (emptyState) emptyState.style.display = "none";

  // Find the last assistant message index for streaming content ID
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  // Render each message
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isLastAssistant = i === lastAssistantIndex;
    chatHistory.appendChild(createMessageElement(doc, msg, theme, isLastAssistant));
  }

  // Scroll to bottom
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

/**
 * Update streaming content in the last assistant message
 */
export function updateStreamingContent(container: HTMLElement, content: string): void {
  const streamingEl = container.querySelector("#chat-streaming-content");
  if (streamingEl) {
    renderMarkdownToElement(streamingEl as HTMLElement, content);
  }
}

/**
 * Scroll chat history to the bottom
 */
export function scrollToBottom(chatHistory: HTMLElement): void {
  chatHistory.scrollTop = chatHistory.scrollHeight;
}
