/**
 * MessageRenderer - Create and manage message bubble elements
 */

import { config } from "../../../../package.json";
import type {
  ChatMessage,
  ExecutionPlan,
  ExecutionPlanStep,
  ImageAttachment,
  QuotedMessageRef,
  ToolApprovalState,
} from "../../chat";
import type { UserInputRequestState } from "../../../types/chat";
import {
  NOTE_SUMMARY_DESTINATION_QUESTION_ID,
  NOTE_SUMMARY_STANDALONE_DESTINATION_VALUE,
} from "../../chat/note-summary-destination";
import type {
  RequestUserInputResponse,
  ToolApprovalResolution,
} from "../../../types/tool";
import { chatColors } from "../../../utils/colors";
import type { ThemeColors } from "./types";
import { HTML_NS } from "./types";
import {
  formatMarkdownForMessageCopy,
  type MarkdownRenderOptions,
  renderMarkdownToElement,
} from "./MarkdownRenderer";
import { isMaxIterationsNoticeContent } from "../../chat/agent-runtime/messages";
import { selectChatMessagePresentations } from "../../chat/message-presentation";
import { canSummarizeAssistantReply } from "./NoteSummaryActions";
import { canQuoteAssistantReply } from "../../chat/quoted-messages";

export function getStreamingContentSelector(messageId: string): string {
  return `[data-streaming-content-for="${messageId}"]`;
}

export function getStreamingReasoningSelector(messageId: string): string {
  return `[data-streaming-reasoning-for="${messageId}"]`;
}

export function getStreamingReasoningContainerSelector(
  messageId: string,
): string {
  return `[data-streaming-reasoning-container-for="${messageId}"]`;
}

const CHAT_HISTORY_BOTTOM_STICKY_THRESHOLD = 24;
const CHAT_HISTORY_AUTO_SCROLL_ATTR = "data-auto-scroll";
const CHAT_SCROLL_BOTTOM_BUTTON_ID = "chat-scroll-bottom-btn";
const STREAMING_TYPING_INDICATOR_ATTR = "data-streaming-typing-indicator";
const MESSAGE_ACTION_ICON_SIZE = "15px";
const MESSAGE_HIGHLIGHT_DURATION_MS = 1050;
const MESSAGE_HIGHLIGHT_OVERLAY_CLASS = "paperchat-message-highlight-overlay";
type MessageActionIconName =
  | "change"
  | "copy"
  | "fork"
  | "quote"
  | "refresh"
  | "write";
const userInputCountdownTimers = new WeakMap<
  HTMLElement,
  ReturnType<typeof setInterval>
>();

interface MessageHighlightLease {
  overlay: HTMLElement;
  surface: HTMLElement;
  previousPosition: string;
  pulseTimeoutIds: Array<ReturnType<typeof setTimeout>>;
  timeoutId: ReturnType<typeof setTimeout>;
}

const messageHighlightLeases = new WeakMap<
  HTMLElement,
  MessageHighlightLease
>();

function getChatHistoryBottomOffset(chatHistory: HTMLElement): number {
  return (
    chatHistory.scrollHeight - chatHistory.scrollTop - chatHistory.clientHeight
  );
}

export function isChatHistoryNearBottom(chatHistory: HTMLElement): boolean {
  return (
    getChatHistoryBottomOffset(chatHistory) <=
    CHAT_HISTORY_BOTTOM_STICKY_THRESHOLD
  );
}

export function shouldAutoScrollChatHistory(chatHistory: HTMLElement): boolean {
  if (!chatHistory.hasAttribute(CHAT_HISTORY_AUTO_SCROLL_ATTR)) {
    chatHistory.setAttribute(CHAT_HISTORY_AUTO_SCROLL_ATTR, "true");
  }
  return chatHistory.getAttribute(CHAT_HISTORY_AUTO_SCROLL_ATTR) !== "false";
}

export function updateChatHistoryAutoScrollState(
  chatHistory: HTMLElement,
): void {
  chatHistory.setAttribute(
    CHAT_HISTORY_AUTO_SCROLL_ATTR,
    isChatHistoryNearBottom(chatHistory) ? "true" : "false",
  );
  updateChatHistoryScrollBottomButton(chatHistory);
}

export function scrollChatHistoryToBottom(chatHistory: HTMLElement): void {
  chatHistory.scrollTop = chatHistory.scrollHeight;
  chatHistory.setAttribute(CHAT_HISTORY_AUTO_SCROLL_ATTR, "true");
  updateChatHistoryScrollBottomButton(chatHistory);
}

/**
 * Find a rendered message by exact ID without interpolating the ID into a CSS
 * selector. Message IDs are opaque and may contain selector metacharacters.
 */
export function findRenderedMessageElement(
  chatHistory: HTMLElement,
  messageId: string,
): HTMLElement | null {
  for (const child of Array.from(chatHistory.children)) {
    const element = child as HTMLElement;
    if (element.getAttribute("data-message-id") === messageId) {
      return element;
    }
  }
  return null;
}

function restoreMessageHighlight(lease: MessageHighlightLease): void {
  lease.pulseTimeoutIds.forEach(clearTimeout);
  lease.overlay.remove();
  lease.surface.style.position = lease.previousPosition;
}

function hasClass(element: HTMLElement, className: string): boolean {
  return (element.getAttribute("class") || "").split(/\s+/).includes(className);
}

function findMessageHighlightSurface(messageElement: HTMLElement): HTMLElement {
  for (const child of Array.from(messageElement.children)) {
    const element = child as HTMLElement;
    if (
      hasClass(element, "chat-bubble") ||
      hasClass(element, "system-notice-content")
    ) {
      return element;
    }
  }
  return messageElement;
}

export function clearRenderedMessageHighlight(chatHistory: HTMLElement): void {
  const lease = messageHighlightLeases.get(chatHistory);
  if (!lease) return;

  clearTimeout(lease.timeoutId);
  restoreMessageHighlight(lease);
  messageHighlightLeases.delete(chatHistory);
}

function centerMessageInChatHistory(
  chatHistory: HTMLElement,
  messageElement: HTMLElement,
): void {
  const historyRect = chatHistory.getBoundingClientRect();
  const messageRect = messageElement.getBoundingClientRect();
  const offset =
    messageRect.top +
    messageRect.height / 2 -
    (historyRect.top + historyRect.height / 2);

  chatHistory.scrollTop = Math.max(0, chatHistory.scrollTop + offset);
  chatHistory.setAttribute(CHAT_HISTORY_AUTO_SCROLL_ATTR, "false");
  updateChatHistoryScrollBottomButton(chatHistory);
}

/**
 * Center and briefly flash the rendered message bubble. Repeated calls replace
 * the previous lease so a timer from an earlier render cannot clear a newer
 * highlight.
 */
export function scrollToAndHighlightMessage(
  chatHistory: HTMLElement,
  messageId: string,
  durationMs: number = MESSAGE_HIGHLIGHT_DURATION_MS,
): HTMLElement | null {
  const messageElement = findRenderedMessageElement(chatHistory, messageId);
  if (!messageElement) return null;

  clearRenderedMessageHighlight(chatHistory);
  centerMessageInChatHistory(chatHistory, messageElement);

  const surface = findMessageHighlightSurface(messageElement);
  const safeDurationMs = Math.max(1, durationMs);
  const pulseTransitionMs = Math.max(1, safeDurationMs * 0.16);
  const overlay = createElement(
    messageElement.ownerDocument,
    "div",
    {
      position: "absolute",
      top: "0",
      right: "0",
      bottom: "0",
      left: "0",
      borderRadius: "inherit",
      backgroundColor: "rgba(59, 130, 246, 0.18)",
      opacity: "0.72",
      pointerEvents: "none",
      transition: `opacity ${pulseTransitionMs}ms ease-in-out`,
    },
    {
      class: MESSAGE_HIGHLIGHT_OVERLAY_CLASS,
      "aria-hidden": "true",
    },
  );

  // Ordinary bubbles already use relative positioning. System notices and
  // fallback message surfaces need an anchor for the absolute overlay.
  const previousPosition = surface.style.position;
  if (!surface.style.position) {
    surface.style.position = "relative";
  }
  surface.appendChild(overlay);

  const lease: MessageHighlightLease = {
    overlay,
    surface,
    previousPosition,
    pulseTimeoutIds: [],
    timeoutId: setTimeout(() => {
      if (messageHighlightLeases.get(chatHistory) !== lease) return;
      restoreMessageHighlight(lease);
      messageHighlightLeases.delete(chatHistory);
    }, safeDurationMs),
  };
  messageHighlightLeases.set(chatHistory, lease);

  const setPulseOpacity = (opacity: string): void => {
    if (messageHighlightLeases.get(chatHistory) !== lease) return;
    overlay.style.opacity = opacity;
  };
  lease.pulseTimeoutIds.push(
    setTimeout(() => setPulseOpacity("0"), safeDurationMs * 0.14),
    setTimeout(() => setPulseOpacity("0.58"), safeDurationMs * 0.43),
    setTimeout(() => setPulseOpacity("0"), safeDurationMs * 0.61),
  );
  return messageElement;
}

export function updateChatHistoryScrollBottomButton(
  chatHistory: HTMLElement,
): void {
  const button = chatHistory.parentElement?.querySelector(
    `#${CHAT_SCROLL_BOTTOM_BUTTON_ID}`,
  ) as HTMLElement | null;
  if (!button) return;

  const bottomPanel = chatHistory.parentElement?.querySelector(
    "#chat-execution-approval-panel",
  ) as HTMLElement | null;
  const bottomInset = Number(bottomPanel?.dataset.visibleHeight || 0);
  const hasScrollableContent =
    chatHistory.scrollHeight > chatHistory.clientHeight;
  const shouldShow =
    hasScrollableContent && !isChatHistoryNearBottom(chatHistory);

  button.style.bottom = `${16 + bottomInset}px`;
  button.style.opacity = shouldShow ? "1" : "0";
  button.style.transform = shouldShow
    ? "translateY(0) scale(1)"
    : "translateY(8px) scale(0.92)";
  button.style.pointerEvents = shouldShow ? "auto" : "none";
  button.setAttribute("aria-hidden", shouldShow ? "false" : "true");
  button.setAttribute("data-visible", shouldShow ? "true" : "false");
}
import { createElement, copyToClipboard } from "./ChatPanelBuilder";
import { getString } from "../../../utils/locale";
import {
  getPaperChatErrorDisplayMessage,
  parsePaperChatQuotaError,
} from "../../providers/paperchat-errors";
import { darkTheme } from "./ChatPanelTheme";
import { ANALYTICS_EVENTS, getAnalyticsService } from "../../analytics";

const RECOVERY_STEP_PREFIX = "replan:";

function getImageAttachmentSrc(image: ImageAttachment): string {
  if (image.type === "base64") {
    return `data:${image.mimeType};base64,${image.data}`;
  }
  return image.data;
}

function isRenderableImageAttachment(
  image: ImageAttachment,
): image is ImageAttachment {
  if (!image.data) {
    return false;
  }
  if (image.type === "base64") {
    return !!image.mimeType;
  }
  return true;
}

function createMessageImagesElement(
  doc: Document,
  images: ImageAttachment[],
): HTMLElement {
  const renderableImages = images.filter(isRenderableImageAttachment);
  const container = createElement(doc, "div", {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    marginTop: "10px",
  });

  for (const image of renderableImages) {
    const img = createElement(
      doc,
      "img",
      {
        display: "block",
        maxWidth: renderableImages.length === 1 ? "260px" : "128px",
        maxHeight: renderableImages.length === 1 ? "220px" : "128px",
        borderRadius: "10px",
        objectFit: "cover",
        background: "rgba(255, 255, 255, 0.18)",
      },
      {
        src: getImageAttachmentSrc(image),
        alt: image.name || "Attached image",
        title: image.name || "Attached image",
      },
    );
    container.appendChild(img);
  }

  return container;
}

function getMessageActionIconUrl(iconName: MessageActionIconName): string {
  return `chrome://${config.addonRef}/content/icons/${iconName}.svg`;
}

function createMessageActionIcon(
  doc: Document,
  iconName: MessageActionIconName,
  alt: string,
): HTMLElement {
  const icon = doc.createElementNS(HTML_NS, "img") as HTMLElement;
  icon.setAttribute("src", getMessageActionIconUrl(iconName));
  icon.setAttribute("alt", alt);
  Object.assign(icon.style, {
    width: MESSAGE_ACTION_ICON_SIZE,
    height: MESSAGE_ACTION_ICON_SIZE,
    display: "block",
    pointerEvents: "none",
  });
  return icon;
}

function setIconButtonImage(
  button: HTMLElement,
  iconName: MessageActionIconName,
  alt: string,
): void {
  button.textContent = "";
  button.appendChild(
    createMessageActionIcon(button.ownerDocument, iconName, alt),
  );
}

function createMessageActionButton(
  doc: Document,
  theme: ThemeColors,
  title: string,
): HTMLElement {
  const btn = createElement(
    doc,
    "button",
    {
      width: "28px",
      height: "28px",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      background: "transparent",
      border: "none",
      borderRadius: "4px",
      padding: "0",
      cursor: "pointer",
      transition: "opacity 0.2s, transform 0.2s",
      color: theme.textPrimary,
    },
    { title },
  );
  btn.setAttribute("type", "button");
  btn.setAttribute("aria-label", title);
  btn.addEventListener("mouseenter", () => {
    btn.style.transform = "translateY(-1px)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.transform = "translateY(0)";
  });
  return btn;
}

type ExecutionBannerKind =
  | "idle"
  | "running"
  | "waiting_approval"
  | "approval_resolved"
  | "recovering";

interface ExecutionBannerState {
  kind: ExecutionBannerKind;
  icon: string;
  title: string;
  detail: string;
  subdetail?: string;
  statusLabel?: string;
  accentColor?: string;
  accentBackground?: string;
  approvalRequest?: ToolApprovalState["pendingRequests"][number];
}

export interface MessageRenderOptions {
  markdown?: MarkdownRenderOptions;
  onRetry?: () => void | Promise<void>;
  onRetryError?: (error: Error) => void;
  onFork?: (assistantMessageId: string) => void | Promise<void>;
  onForkError?: (error: Error) => void;
  onQuoteReply?: (assistantMessageId: string) => void;
  onNavigateToQuotedMessage?: (quote: QuotedMessageRef) => void | Promise<void>;
  onSummarizeReply?: (assistantMessageId: string) => void | Promise<void>;
  onSummarizeReplyError?: (error: Error) => void;
  onRenderComplete?: () => void;
}

export function getMessageMarkdownRenderOptions(
  markdown: MarkdownRenderOptions | undefined,
  streamingState: ChatMessage["streamingState"],
  evidenceRecords?: ChatMessage["evidence"],
): MarkdownRenderOptions | undefined {
  if (!markdown) {
    return evidenceRecords?.length ? { evidenceRecords } : undefined;
  }
  if (streamingState === undefined) {
    return evidenceRecords?.length
      ? { ...markdown, evidenceRecords }
      : markdown;
  }
  return {
    ...markdown,
    evidenceRecords,
    blockquoteAction: undefined,
    sourceGroupAction: undefined,
    evidenceAction: undefined,
  };
}

type ExecutionInsetPanelElement = HTMLElement & {
  __executionInsetResizeObserver?: ResizeObserver;
};

export interface ApprovalViewTransitionState {
  phase: "resolved" | "entering";
  request: ToolApprovalState["pendingRequests"][number];
  resolution: ToolApprovalResolution;
  nextPendingCount: number;
}

function createTopupButton(doc: Document): HTMLElement {
  const btn = createElement(
    doc,
    "button",
    {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      marginTop: "12px",
      marginLeft: "auto",
      marginRight: "auto",
      padding: "7px 12px",
      borderRadius: "8px",
      border: "1px solid #f59e0b",
      background:
        "linear-gradient(135deg, rgba(255, 244, 214, 0.98), rgba(255, 223, 128, 0.98))",
      color: "#7c3e00",
      fontSize: "12px",
      fontWeight: "700",
      lineHeight: "1.2",
      textAlign: "center",
      cursor: "pointer",
      boxShadow: "0 2px 8px rgba(245, 158, 11, 0.2)",
    },
    { class: "paperchat-topup-btn" },
  );

  btn.setAttribute("type", "button");
  btn.textContent = getString("chat-error-paperchat-topup-action");
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    getAnalyticsService().track(
      ANALYTICS_EVENTS.paperChatPurchaseEntryClicked,
      {
        source: "quota_error_card",
      },
    );
    void import("../../preferences/UserAuthUI")
      .then((module) => module.openPaperChatSettingsForTopup())
      .catch((error) => {
        ztoolkit.log(
          "[Chat] Failed to open PaperChat settings for topup:",
          error,
        );
        Zotero.Utilities.Internal.openPreferences("paperchat-prefpane");
      });
  });
  return btn;
}

function getErrorDisplayDetails(msg: ChatMessage): {
  display: string;
  raw: string;
  quota: ReturnType<typeof parsePaperChatQuotaError>;
} {
  const quota = parsePaperChatQuotaError(msg.content);
  const display =
    quota?.displayMessage || getPaperChatErrorDisplayMessage(msg.content);
  return {
    display,
    raw: quota?.rawMessage || display,
    quota,
  };
}

function createInterruptedFooter(
  doc: Document,
  theme: ThemeColors,
  attachedError: ChatMessage | undefined,
  attachedNotices: ChatMessage[],
): HTMLElement {
  const footer = createElement(doc, "div", {
    marginTop: "10px",
    paddingTop: "9px",
    borderTop: `1px solid ${theme.borderColor}`,
    fontSize: "12px",
    lineHeight: "1.45",
    color: theme.textSecondary,
  });
  footer.setAttribute("data-interrupted-footer", "true");

  for (const notice of attachedNotices) {
    const noticeLine = createElement(doc, "div", {
      marginBottom: "6px",
      color: theme.textMuted,
    });
    noticeLine.setAttribute("data-attached-system-notice-id", notice.id);
    noticeLine.textContent = notice.content;
    footer.appendChild(noticeLine);
  }

  const status = createElement(doc, "div", { fontWeight: "600" });
  if (attachedError) {
    const details = getErrorDisplayDetails(attachedError);
    footer.setAttribute("data-attached-error-id", attachedError.id);
    status.textContent = `⚠️ ${details.display}`;
    footer.appendChild(status);
    if (details.quota) {
      footer.appendChild(createTopupButton(doc));
    }
    return footer;
  }

  status.textContent = getString("chat-interrupted");
  footer.appendChild(status);
  return footer;
}

/**
 * Create a system notice element (for item switching, etc.)
 */
function createSystemNoticeElement(
  doc: Document,
  msg: ChatMessage,
  theme: ThemeColors,
): HTMLElement {
  const wrapper = createElement(
    doc,
    "div",
    {
      display: "flex",
      justifyContent: "center",
      margin: "16px 0",
    },
    {
      class: "chat-message system-notice",
      "data-message-id": msg.id,
    },
  );

  const notice = createElement(
    doc,
    "div",
    {
      display: "inline-block",
      padding: "6px 16px",
      fontSize: "12px",
      color: theme.textMuted,
      background: theme.buttonBg,
      borderRadius: "12px",
      border: `1px solid ${theme.borderColor}`,
    },
    { class: "system-notice-content" },
  );

  notice.textContent = msg.content;
  wrapper.appendChild(notice);
  return wrapper;
}

/**
 * Inject typing animation CSS keyframes into the document (once)
 */
function injectTypingAnimation(doc: Document): void {
  if (doc.querySelector("#typing-indicator-style")) return;
  const style = doc.createElementNS(HTML_NS, "style") as HTMLStyleElement;
  style.id = "typing-indicator-style";
  style.textContent = `
    .typing-indicator span {
      display: block;
      animation: typing-bounce 1.4s ease-in-out infinite;
    }
    .typing-indicator span:nth-child(2) {
      animation-delay: 0.2s;
    }
    .typing-indicator span:nth-child(3) {
      animation-delay: 0.4s;
    }
    @keyframes typing-bounce {
      0%, 60%, 100% { opacity: 0.4; transform: translateY(0); }
      30% { opacity: 1; transform: translateY(-4px); }
    }
  `;
  doc.head?.appendChild(style);
}

function createTypingIndicator(doc: Document, theme: ThemeColors): HTMLElement {
  injectTypingAnimation(doc);

  const loader = createElement(
    doc,
    "div",
    {
      display: "flex",
      alignItems: "center",
      gap: "4px",
      marginTop: "6px",
      padding: "4px 0",
    },
    {
      class: "typing-indicator",
      [STREAMING_TYPING_INDICATOR_ATTR]: "true",
      "aria-hidden": "true",
    },
  );

  for (let i = 0; i < 3; i++) {
    const dot = createElement(doc, "span", {
      width: "6px",
      height: "6px",
      borderRadius: "50%",
      background: theme.textMuted,
      opacity: "0.4",
    });
    loader.appendChild(dot);
  }

  return loader;
}

function createQuotedMessagesElement(
  doc: Document,
  theme: ThemeColors,
  quotes: readonly QuotedMessageRef[],
  onNavigate?: (quote: QuotedMessageRef) => void | Promise<void>,
): HTMLElement {
  const container = createElement(doc, "div", {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    marginBottom: "8px",
    paddingBottom: "8px",
    borderBottom: `1px solid ${theme.borderColor}`,
  });
  container.setAttribute("class", "message-quoted-replies");

  for (const quote of quotes) {
    const row = createElement(
      doc,
      "button",
      {
        display: "block",
        width: "100%",
        minWidth: "0",
        overflow: "hidden",
        padding: "3px 7px",
        border: "none",
        borderLeft: `2px solid ${theme.textMuted}`,
        borderRadius: "0",
        background: "transparent",
        color: "inherit",
        fontSize: "11px",
        lineHeight: "16px",
        textAlign: "left",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        cursor: onNavigate ? "pointer" : "default",
        opacity: "0.82",
      },
      {
        type: "button",
        class: "message-quoted-reply",
        title: quote.preview,
        "data-quoted-message-id": quote.messageId,
      },
    );
    row.textContent = `${getString("chat-quoted-reply")}: ${quote.preview}`;
    if (onNavigate) {
      row.addEventListener("click", (event) => {
        event.stopPropagation();
        event.preventDefault();
        void Promise.resolve(onNavigate(quote)).catch((error: unknown) => {
          ztoolkit.log(
            "[MessageRenderer] Quoted reply navigation failed:",
            error,
          );
        });
      });
    } else {
      row.setAttribute("disabled", "true");
    }
    container.appendChild(row);
  }

  return container;
}

export function ensureStreamingTypingIndicator(
  content: HTMLElement,
  theme: ThemeColors,
): void {
  const existing = content.querySelector(
    `[${STREAMING_TYPING_INDICATOR_ATTR}]`,
  ) as HTMLElement | null;
  if (existing) {
    existing.querySelectorAll("span").forEach((dot) => {
      (dot as HTMLElement).style.background = theme.textMuted;
    });
    return;
  }

  content.appendChild(createTypingIndicator(content.ownerDocument, theme));
}

/**
 * Create a message element for display in chat history
 */
export function createMessageElement(
  doc: Document,
  msg: ChatMessage,
  theme: ThemeColors,
  isLastAssistant: boolean = false,
  showReroll: boolean = false,
  onReroll?: () => void | Promise<void>,
  onRerollError?: (error: Error) => void,
  renderOptions: MessageRenderOptions = {},
  attachedError?: ChatMessage,
  attachedNotices: ChatMessage[] = [],
): HTMLElement {
  // Handle system notices specially
  if (msg.isSystemNotice) {
    return createSystemNoticeElement(doc, msg, theme);
  }

  const wrapper = createElement(
    doc,
    "div",
    {
      display: "block",
      margin: "10px 0",
      textAlign: msg.role === "user" ? "right" : "left",
    },
    {
      class: `chat-message ${msg.role}-message`,
      "data-message-id": msg.id,
    },
  );

  // 根据角色设置气泡样式
  let bubbleStyle: Record<string, string>;
  if (msg.role === "user") {
    bubbleStyle = {
      background: theme.userBubbleBg,
      color: theme.userBubbleText,
      borderBottomRightRadius: "4px",
    };
  } else if (msg.role === "error") {
    bubbleStyle = {
      background: chatColors.errorBubbleBg,
      color: chatColors.errorBubbleText,
      border: `1px solid ${chatColors.errorBubbleBorder}`,
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

  const bubble = createElement(
    doc,
    "div",
    {
      position: "relative",
      display: "inline-block",
      maxWidth: "85%",
      padding: "12px 16px",
      borderRadius: "14px",
      wordWrap: "break-word",
      textAlign: "left",
      ...bubbleStyle,
    },
    { class: "chat-bubble" },
  );

  const contentAttrs: Record<string, string> = { class: "chat-content" };
  if (msg.role === "assistant" && msg.streamingState === "in_progress") {
    contentAttrs["data-streaming-content-for"] = msg.id;
  }

  const content = createElement(
    doc,
    "div",
    {
      lineHeight: "1.6",
      whiteSpace: "pre-wrap",
      userSelect: "text",
      cursor: "text",
    },
    contentAttrs,
  );

  // Store raw content for copying
  let rawContent = msg.content;
  let quotaDetails: ReturnType<typeof parsePaperChatQuotaError> = null;

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
    const details = getErrorDisplayDetails(msg);
    quotaDetails = details.quota;
    content.textContent = `⚠️ ${details.display}`;
    rawContent = details.raw;
  } else {
    // Render assistant message as markdown
    const markdownOptions = getMessageMarkdownRenderOptions(
      renderOptions.markdown,
      msg.streamingState,
      msg.evidence,
    );
    const hasCanonicalMaxIterationsNotice =
      msg.role === "assistant" &&
      msg.streamingState === undefined &&
      isMaxIterationsNoticeContent(msg.content);
    const trustedMarkdownOptions = hasCanonicalMaxIterationsNotice
      ? {
          ...markdownOptions,
          enableAgentMaxPlanningIterationsSettingsLink: true,
        }
      : markdownOptions;
    if (msg.streamingState === "in_progress") {
      renderMarkdownToElement(
        content,
        msg.content,
        msg.id,
        trustedMarkdownOptions,
      );
      ensureStreamingTypingIndicator(content, theme);
    } else {
      renderMarkdownToElement(
        content,
        msg.content,
        msg.id,
        trustedMarkdownOptions,
      );
    }
  }

  // Add reasoning section for assistant messages (before content)
  if (msg.role === "assistant") {
    if (msg.reasoning) {
      // Completed message with reasoning - show collapsed
      const reasoningContainer = createReasoningContainer(
        doc,
        theme,
        msg.reasoning,
        false,
      );
      bubble.appendChild(reasoningContainer);
    } else if (isLastAssistant && msg.streamingState === "in_progress") {
      // Streaming placeholder - hidden by default, shown when reasoning arrives
      const reasoningContainer = createReasoningContainer(doc, theme, "", true);
      reasoningContainer.setAttribute(
        "data-streaming-reasoning-container-for",
        msg.id,
      );
      const reasoningBody = reasoningContainer.querySelector(
        '[data-streaming-reasoning-role="body"]',
      ) as HTMLElement | null;
      reasoningBody?.setAttribute("data-streaming-reasoning-for", msg.id);
      reasoningContainer.style.display = "none";
      bubble.appendChild(reasoningContainer);
    }
  }

  if (msg.role === "user" && msg.quotedMessages?.length) {
    bubble.appendChild(
      createQuotedMessagesElement(
        doc,
        theme,
        msg.quotedMessages,
        renderOptions.onNavigateToQuotedMessage,
      ),
    );
  }

  bubble.appendChild(content);

  if (msg.role === "user" && msg.images?.some(isRenderableImageAttachment)) {
    bubble.appendChild(createMessageImagesElement(doc, msg.images));
  }

  if (msg.role === "assistant" && msg.streamingState === "interrupted") {
    bubble.appendChild(
      createInterruptedFooter(doc, theme, attachedError, attachedNotices),
    );
  }

  if (quotaDetails) {
    bubble.appendChild(createTopupButton(doc));
  }

  wrapper.appendChild(bubble);

  const actions = createMessageActions(
    doc,
    theme,
    msg,
    rawContent,
    showReroll && !quotaDetails,
    renderOptions.onRetry,
    renderOptions.onRetryError,
    onReroll,
    onRerollError,
    renderOptions.onFork,
    renderOptions.onForkError,
    renderOptions.onQuoteReply,
    renderOptions.onSummarizeReply,
    renderOptions.onSummarizeReplyError,
  );
  if (actions) {
    wrapper.appendChild(actions);
  }

  return wrapper;
}

/**
 * Create a collapsible reasoning/thinking container
 * Uses inline styles only (Zotero's XHTML context doesn't reliably support <style> injection)
 */
function createReasoningContainer(
  doc: Document,
  theme: ThemeColors,
  reasoning: string,
  isStreaming: boolean,
): HTMLElement {
  const container = createElement(doc, "div", {
    marginBottom: "8px",
    borderLeft: `3px solid ${theme.borderColor}`,
    borderRadius: "4px",
  });

  // Header with toggle
  const header = createElement(doc, "div", {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 10px",
    cursor: "pointer",
    userSelect: "none",
    fontSize: "12px",
    color: theme.textMuted,
    opacity: "0.7",
  });
  header.addEventListener("mouseenter", () => {
    header.style.opacity = "1";
  });
  header.addEventListener("mouseleave", () => {
    header.style.opacity = "0.7";
  });

  const arrow = createElement(doc, "span", {
    fontSize: "10px",
    display: "inline-block",
    transition: "transform 0.2s",
    transform: isStreaming ? "rotate(90deg)" : "rotate(0deg)",
  });
  arrow.textContent = "\u25B6";

  const label = createElement(doc, "span", {});
  label.textContent = `\uD83D\uDCAD ${getString("chat-thinking")}`;

  header.appendChild(arrow);
  header.appendChild(label);

  // Body
  const body = createElement(doc, "div", {
    padding: "4px 10px 8px 10px",
    fontSize: "13px",
    lineHeight: "1.5",
    color: theme.textMuted,
    opacity: "0.75",
    whiteSpace: "pre-wrap",
    wordWrap: "break-word",
    overflow: "hidden",
    display: isStreaming ? "block" : "none",
  });

  if (isStreaming) {
    body.setAttribute("data-streaming-reasoning-role", "body");
  } else {
    body.textContent = reasoning;
  }

  // Toggle handler — uses inline display style
  let collapsed = !isStreaming;
  header.addEventListener("click", () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? "none" : "block";
    arrow.style.transform = collapsed ? "rotate(0deg)" : "rotate(90deg)";
  });

  container.appendChild(header);
  container.appendChild(body);

  return container;
}

function createRetryActionButton(
  doc: Document,
  theme: ThemeColors,
  label: string,
  className: string,
  iconName: Extract<MessageActionIconName, "change" | "refresh">,
  onClick: () => void | Promise<void>,
  onError?: (error: Error) => void,
  onBusyChange?: (busy: boolean) => void,
): HTMLElement {
  const btn = createElement(
    doc,
    "button",
    {
      width: "28px",
      height: "28px",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      background: "transparent",
      border: "none",
      borderRadius: "4px",
      padding: "0",
      cursor: "pointer",
      opacity: "1",
      color: theme.textPrimary,
      transition: "box-shadow 0.2s, opacity 0.2s, transform 0.2s",
    },
    {
      class: `message-action-btn ${className}`,
      title: label,
    },
  );
  btn.setAttribute("type", "button");
  btn.setAttribute("aria-label", label);
  setIconButtonImage(btn, iconName, "");
  btn.addEventListener("mouseenter", () => {
    btn.style.transform = "translateY(-1px)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.transform = "translateY(0)";
  });
  btn.addEventListener("focus", () => {
    btn.style.boxShadow = `0 0 0 2px ${theme.borderColor}`;
  });
  btn.addEventListener("blur", () => {
    btn.style.boxShadow = "none";
  });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (btn.getAttribute("data-busy") === "true") {
      return;
    }
    onBusyChange?.(true);
    Promise.resolve(onClick())
      .catch((error: unknown) => {
        const retryError =
          error instanceof Error ? error : new Error(String(error));
        ztoolkit.log("[MessageRenderer] Retry action failed:", retryError);
        onError?.(retryError);
      })
      .finally(() => {
        onBusyChange?.(false);
      });
  });
  return btn;
}

function createForkButton(
  doc: Document,
  theme: ThemeColors,
  assistantMessageId: string,
  onFork: (assistantMessageId: string) => void | Promise<void>,
  onError?: (error: Error) => void,
): HTMLElement {
  const label = getString("chat-continue-in-new-chat");
  const btn = createMessageActionButton(doc, theme, label);
  btn.setAttribute("class", "message-action-btn fork-message-btn");
  setIconButtonImage(btn, "fork", "");

  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    if (btn.getAttribute("data-busy") === "true") {
      return;
    }

    btn.setAttribute("data-busy", "true");
    btn.setAttribute("aria-busy", "true");
    (btn as HTMLButtonElement).disabled = true;
    btn.style.cursor = "wait";
    btn.style.opacity = "0.6";

    Promise.resolve(onFork(assistantMessageId))
      .catch((error: unknown) => {
        const forkError =
          error instanceof Error ? error : new Error(String(error));
        ztoolkit.log("[MessageRenderer] Fork conversation failed:", forkError);
        onError?.(forkError);
      })
      .finally(() => {
        btn.removeAttribute("data-busy");
        btn.removeAttribute("aria-busy");
        (btn as HTMLButtonElement).disabled = false;
        btn.style.cursor = "pointer";
        btn.style.opacity = "1";
      });
  });

  return btn;
}

function createQuoteReplyButton(
  doc: Document,
  theme: ThemeColors,
  assistantMessageId: string,
  onQuoteReply: (assistantMessageId: string) => void,
): HTMLElement {
  const label = getString("chat-quote-reply");
  const btn = createMessageActionButton(doc, theme, label);
  btn.setAttribute("class", "message-action-btn quote-reply-btn");
  setIconButtonImage(btn, "quote", "");
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    onQuoteReply(assistantMessageId);
  });
  return btn;
}

function createSummarizeReplyButton(
  doc: Document,
  theme: ThemeColors,
  assistantMessageId: string,
  onSummarizeReply: (assistantMessageId: string) => void | Promise<void>,
  onError?: (error: Error) => void,
): HTMLElement {
  const label = getString("chat-summarize-reply-note");
  const btn = createMessageActionButton(doc, theme, label);
  btn.setAttribute("class", "message-action-btn summarize-reply-note-btn");
  setIconButtonImage(btn, "write", "");

  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    if (btn.getAttribute("data-busy") === "true") {
      return;
    }

    btn.setAttribute("data-busy", "true");
    btn.setAttribute("aria-busy", "true");
    (btn as HTMLButtonElement).disabled = true;
    btn.style.cursor = "wait";
    btn.style.opacity = "0.6";

    Promise.resolve(onSummarizeReply(assistantMessageId))
      .catch((error: unknown) => {
        const summaryError =
          error instanceof Error ? error : new Error(String(error));
        ztoolkit.log(
          "[MessageRenderer] Summarize reply to note failed:",
          summaryError,
        );
        onError?.(summaryError);
      })
      .finally(() => {
        btn.removeAttribute("data-busy");
        btn.removeAttribute("aria-busy");
        (btn as HTMLButtonElement).disabled = false;
        btn.style.cursor = "pointer";
        btn.style.opacity = "1";
      });
  });

  return btn;
}

export function createCopyButton(
  doc: Document,
  theme: ThemeColors,
  contentToCopy: string,
): HTMLElement {
  const copyBtn = createMessageActionButton(doc, theme, getString("chat-copy"));
  copyBtn.setAttribute("class", "message-action-btn copy-message-btn");
  setIconButtonImage(copyBtn, "copy", getString("chat-copy"));

  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    copyToClipboard(contentToCopy);
    copyBtn.textContent = "\u2713"; // ✓
    setTimeout(() => {
      setIconButtonImage(copyBtn, "copy", getString("chat-copy"));
    }, 1500);
  });

  return copyBtn;
}

function createMessageActions(
  doc: Document,
  theme: ThemeColors,
  msg: ChatMessage,
  rawContent: string,
  showReroll: boolean,
  onRetry?: () => void | Promise<void>,
  onRetryError?: (error: Error) => void,
  onReroll?: () => void | Promise<void>,
  onRerollError?: (error: Error) => void,
  onFork?: (assistantMessageId: string) => void | Promise<void>,
  onForkError?: (error: Error) => void,
  onQuoteReply?: (assistantMessageId: string) => void,
  onSummarizeReply?: (assistantMessageId: string) => void | Promise<void>,
  onSummarizeReplyError?: (error: Error) => void,
): HTMLElement | null {
  const actions = createElement(
    doc,
    "div",
    {
      display: "flex",
      alignItems: "center",
      justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
      gap: "6px",
      width: "fit-content",
      maxWidth: "85%",
      marginTop: "4px",
      marginLeft: msg.role === "user" ? "auto" : "0",
      marginRight: msg.role === "user" ? "0" : "auto",
      opacity: "0.72",
      transition: "opacity 0.2s",
    },
    { class: "message-actions" },
  );

  const copyContent =
    msg.role === "assistant"
      ? formatMarkdownForMessageCopy(msg.content, {
          reasoning: msg.reasoning,
          evidenceRecords: msg.evidence,
        })
      : rawContent;
  const quotedContent =
    msg.role === "assistant"
      ? formatMarkdownForMessageCopy(msg.content, {
          evidenceRecords: msg.evidence,
        })
      : "";

  actions.appendChild(createCopyButton(doc, theme, copyContent));

  if (canQuoteAssistantReply(msg, quotedContent) && onQuoteReply) {
    actions.appendChild(
      createQuoteReplyButton(doc, theme, msg.id, onQuoteReply),
    );
  }

  if (canSummarizeAssistantReply(msg) && onSummarizeReply) {
    actions.appendChild(
      createSummarizeReplyButton(
        doc,
        theme,
        msg.id,
        onSummarizeReply,
        onSummarizeReplyError,
      ),
    );
  }

  const retryActionButtons: HTMLElement[] = [];
  const setRetryActionsBusy = (busy: boolean) => {
    for (const button of retryActionButtons) {
      if (busy) {
        button.setAttribute("data-busy", "true");
        button.setAttribute("disabled", "true");
        button.setAttribute("aria-busy", "true");
        button.style.opacity = "1";
        button.style.cursor = "wait";
      } else {
        button.removeAttribute("data-busy");
        button.removeAttribute("disabled");
        button.removeAttribute("aria-busy");
        button.style.cursor = "pointer";
      }
    }
  };

  if (
    msg.role === "assistant" &&
    !msg.apiOnly &&
    msg.streamingState === undefined &&
    onFork
  ) {
    actions.appendChild(
      createForkButton(doc, theme, msg.id, onFork, onForkError),
    );
  }

  if (showReroll && onRetry) {
    const retryButton = createRetryActionButton(
      doc,
      theme,
      getString("chat-retry"),
      "retry-btn",
      "refresh",
      onRetry,
      onRetryError,
      setRetryActionsBusy,
    );
    retryActionButtons.push(retryButton);
    actions.appendChild(retryButton);
  }

  if (showReroll && onReroll) {
    const rerollLabel = getString("chat-reroll-model");
    const rerollButton = createRetryActionButton(
      doc,
      theme,
      rerollLabel,
      "reroll-btn",
      "change",
      onReroll,
      onRerollError,
      setRetryActionsBusy,
    );
    retryActionButtons.push(rerollButton);
    actions.appendChild(rerollButton);
  }

  actions.addEventListener("mouseenter", () => {
    actions.style.opacity = "1";
  });
  actions.addEventListener("mouseleave", () => {
    actions.style.opacity = "0.72";
  });
  actions.addEventListener("focusin", () => {
    actions.style.opacity = "1";
  });
  actions.addEventListener("focusout", () => {
    actions.style.opacity = "0.72";
  });

  return actions.childElementCount > 0 ? actions : null;
}

function createChatEmptyState(doc: Document, theme: ThemeColors): HTMLElement {
  const emptyState = createElement(
    doc,
    "div",
    {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      height: "100%",
      minHeight: "200px",
      color: theme.textMuted,
      textAlign: "center",
    },
    { id: "chat-empty-state" },
  );

  const emptyIcon = createElement(doc, "div", {
    fontSize: "48px",
    marginBottom: "16px",
    opacity: "0.6",
  });
  emptyIcon.textContent = "\uD83D\uDCAC";

  const emptyText = createElement(doc, "div", {
    fontSize: "15px",
    color: theme.textMuted,
  });
  emptyText.textContent = getString("chat-start-conversation");

  emptyState.appendChild(emptyIcon);
  emptyState.appendChild(emptyText);
  return emptyState;
}

/**
 * Render all messages to the chat history element
 */
export function renderMessages(
  chatHistory: HTMLElement,
  emptyState: HTMLElement | null,
  messages: ChatMessage[],
  theme: ThemeColors,
  retryableErrorMessageId?: string,
  onReroll?: () => void | Promise<void>,
  onRerollError?: (error: Error) => void,
  renderOptions: MessageRenderOptions = {},
): void {
  const doc = chatHistory.ownerDocument;
  if (!doc) return;
  const shouldScrollToBottom = shouldAutoScrollChatHistory(chatHistory);

  chatHistory.textContent = "";

  if (messages.length === 0) {
    const visibleEmptyState = emptyState || createChatEmptyState(doc, theme);
    chatHistory.appendChild(visibleEmptyState);
    visibleEmptyState.style.display = "flex";
    updateChatHistoryScrollBottomButton(chatHistory);
    renderOptions.onRenderComplete?.();
    return;
  }

  if (emptyState) emptyState.style.display = "none";

  const presentations = selectChatMessagePresentations(messages);
  let lastAssistantIndex = -1;
  for (let index = presentations.length - 1; index >= 0; index--) {
    if (presentations[index].message.role === "assistant") {
      lastAssistantIndex = index;
      break;
    }
  }

  // Render each message
  for (let index = 0; index < presentations.length; index++) {
    const {
      message: msg,
      attachedError,
      attachedNotices,
    } = presentations[index];
    const isLastAssistant = index === lastAssistantIndex;
    const attachedQuota = attachedError
      ? parsePaperChatQuotaError(attachedError.content)
      : null;
    chatHistory.appendChild(
      createMessageElement(
        doc,
        msg,
        theme,
        isLastAssistant,
        (msg.role === "error" && retryableErrorMessageId === msg.id) ||
          (!!attachedError &&
            retryableErrorMessageId === attachedError.id &&
            !attachedQuota),
        onReroll,
        onRerollError,
        renderOptions,
        attachedError,
        attachedNotices,
      ),
    );
  }

  if (shouldScrollToBottom) {
    scrollChatHistoryToBottom(chatHistory);
  } else {
    updateChatHistoryScrollBottomButton(chatHistory);
  }
  renderOptions.onRenderComplete?.();
}

export function updateExecutionPlanView(
  panel: HTMLElement,
  theme: ThemeColors,
  executionPlan?: ExecutionPlan,
  _toolApprovalState?: ToolApprovalState,
): void {
  const banner = deriveExecutionBannerState(executionPlan);
  updateExecutionInsetPanel(panel, theme, banner, {
    placement: "top",
    showApprovalActions: false,
  });
}

export function updateApprovalView(
  panel: HTMLElement,
  theme: ThemeColors,
  executionPlan?: ExecutionPlan,
  toolApprovalState?: ToolApprovalState,
  approvalActions?: {
    onResolveApproval: (
      requestId: string,
      resolution: ToolApprovalResolution,
    ) => void | Promise<void>;
  },
  transitionState?: ApprovalViewTransitionState,
): void {
  const banner =
    transitionState?.phase === "resolved"
      ? deriveResolvedApprovalBannerState(
          transitionState.request,
          transitionState.resolution,
          transitionState.nextPendingCount,
        )
      : deriveApprovalBannerState(executionPlan, toolApprovalState);
  updateExecutionInsetPanel(panel, theme, banner, {
    placement: "bottom",
    showApprovalActions: true,
    approvalActions,
    animationPhase: transitionState?.phase,
  });
}

export function updateUserInputRequestView(
  panel: HTMLElement,
  theme: ThemeColors,
  userInputRequestState?: UserInputRequestState,
  actions?: {
    onResolveUserInput: (
      requestId: string,
      response: RequestUserInputResponse,
    ) => void | Promise<void>;
  },
): void {
  const doc = panel.ownerDocument;
  if (!doc) return;
  const request = userInputRequestState?.pendingRequests[0];
  if (!request) {
    const existing = panel.querySelector(
      ".chat-user-input-request-banner",
    ) as HTMLElement | null;
    if (existing) {
      clearUserInputCountdownTimer(existing);
    }
    panel.replaceChildren();
    updateExecutionInsetPanel(
      panel,
      theme,
      {
        kind: "idle",
        icon: "",
        title: "",
        detail: "",
      },
      {
        placement: "bottom",
        showApprovalActions: false,
      },
    );
    return;
  }

  const existing = panel.querySelector(
    ".chat-user-input-request-banner",
  ) as HTMLElement | null;
  const wrapper =
    existing ||
    createExecutionBannerElement(doc, {
      className: "chat-user-input-request-banner",
      placement: "bottom",
    });
  clearUserInputCountdownTimer(wrapper);
  populateUserInputRequestElement(wrapper, doc, theme, request, actions);
  if (!existing) {
    panel.replaceChildren(wrapper);
  }
  panel.style.pointerEvents = "auto";
  panel.style.opacity = "1";
  panel.style.transform = "translateY(0)";
  syncExecutionInsetHeight(panel, wrapper);
  attachExecutionInsetResizeObserver(panel, wrapper);
  syncExecutionInsets(panel);
}

function updateExecutionInsetPanel(
  panel: HTMLElement,
  theme: ThemeColors,
  banner: ExecutionBannerState,
  options: {
    placement: "top" | "bottom";
    showApprovalActions: boolean;
    approvalActions?: {
      onResolveApproval: (
        requestId: string,
        resolution: ToolApprovalResolution,
      ) => void | Promise<void>;
    };
    animationPhase?: ApprovalViewTransitionState["phase"];
  },
): void {
  const doc = panel.ownerDocument;
  if (!doc) return;
  const existing = panel.querySelector(
    ".chat-execution-banner",
  ) as HTMLElement | null;

  if (banner.kind === "idle") {
    existing?.remove();
    detachExecutionInsetResizeObserver(panel);
    panel.dataset.visibleHeight = "0";
    panel.style.height = "0px";
    panel.style.opacity = "0";
    panel.style.transform =
      options.placement === "top" ? "translateY(-6px)" : "translateY(6px)";
    syncExecutionInsets(panel);
    return;
  }

  const wrapper =
    existing ||
    createExecutionBannerElement(doc, {
      className: "chat-execution-banner",
      placement: options.placement,
    });
  populateExecutionBannerElement(wrapper, doc, banner, theme, {
    showApprovalActions: options.showApprovalActions,
    approvalActions: options.approvalActions,
  });
  if (!existing) {
    panel.appendChild(wrapper);
  }

  syncExecutionInsetHeight(panel, wrapper);
  attachExecutionInsetResizeObserver(panel, wrapper);
  panel.style.opacity = "1";
  panel.style.transform = "translateY(0)";
  runExecutionBannerAnimation(wrapper, options.animationPhase);
  syncExecutionInsets(panel);
}

function runExecutionBannerAnimation(
  wrapper: HTMLElement,
  phase?: ApprovalViewTransitionState["phase"],
): void {
  if (!phase) {
    return;
  }

  const bar = wrapper.firstElementChild as HTMLElement | null;
  const animate = bar?.animate?.bind(bar);
  if (!bar || !animate) {
    return;
  }

  if (phase === "resolved") {
    animate(
      [
        {
          opacity: 0.88,
          transform: "translateY(0) scale(0.985)",
          filter: "saturate(0.95)",
        },
        {
          opacity: 1,
          transform: "translateY(0) scale(1.02)",
          filter: "saturate(1.08)",
        },
        {
          opacity: 1,
          transform: "translateY(0) scale(1)",
          filter: "saturate(1)",
        },
      ],
      {
        duration: 260,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    );
    return;
  }

  animate(
    [
      {
        opacity: 0,
        transform: "translateY(12px) scale(0.985)",
      },
      {
        opacity: 1,
        transform: "translateY(0) scale(1)",
      },
    ],
    {
      duration: 220,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    },
  );
}

function syncExecutionInsetHeight(
  panel: HTMLElement,
  wrapper: HTMLElement,
): void {
  const measuredHeight = Math.ceil(wrapper.offsetHeight);
  panel.dataset.visibleHeight = String(measuredHeight);
  panel.style.height = `${measuredHeight}px`;
}

function attachExecutionInsetResizeObserver(
  panel: HTMLElement,
  wrapper: HTMLElement,
): void {
  const panelWithObserver = panel as ExecutionInsetPanelElement;
  if (panelWithObserver.__executionInsetResizeObserver) {
    panelWithObserver.__executionInsetResizeObserver.disconnect();
  }

  const ResizeObserverCtor = panel.ownerDocument?.defaultView?.ResizeObserver;
  if (!ResizeObserverCtor) {
    return;
  }

  const observer = new ResizeObserverCtor(() => {
    syncExecutionInsetHeight(panel, wrapper);
    syncExecutionInsets(panel);
  });
  observer.observe(wrapper);
  panelWithObserver.__executionInsetResizeObserver = observer;
}

function detachExecutionInsetResizeObserver(panel: HTMLElement): void {
  const panelWithObserver = panel as ExecutionInsetPanelElement;
  panelWithObserver.__executionInsetResizeObserver?.disconnect();
  delete panelWithObserver.__executionInsetResizeObserver;
}

function syncExecutionInsets(panel: HTMLElement): void {
  const viewport = panel.parentElement;
  if (!viewport) {
    return;
  }

  const chatHistory = viewport.querySelector(
    "#chat-history",
  ) as HTMLElement | null;
  if (!chatHistory) {
    return;
  }

  const inlinePaddingTop = parseFloat(chatHistory.style.paddingTop || "14");
  const inlinePaddingBottom = parseFloat(
    chatHistory.style.paddingBottom || "14",
  );
  const computedPaddingTop = Number.isFinite(inlinePaddingTop)
    ? inlinePaddingTop
    : 14;
  const computedPaddingBottom = Number.isFinite(inlinePaddingBottom)
    ? inlinePaddingBottom
    : 14;
  const basePaddingTop = Number(
    chatHistory.dataset.basePaddingTop || computedPaddingTop || 14,
  );
  const basePaddingBottom = Number(
    chatHistory.dataset.basePaddingBottom || computedPaddingBottom || 14,
  );
  chatHistory.dataset.basePaddingTop = String(basePaddingTop);
  chatHistory.dataset.basePaddingBottom = String(basePaddingBottom);

  const currentPaddingTop = Number.isFinite(inlinePaddingTop)
    ? inlinePaddingTop
    : basePaddingTop;
  const currentPaddingBottom = Number.isFinite(inlinePaddingBottom)
    ? inlinePaddingBottom
    : basePaddingBottom;
  const topPanel = viewport.querySelector(
    "#chat-execution-plan-panel",
  ) as HTMLElement | null;
  const bottomPanel = viewport.querySelector(
    "#chat-execution-approval-panel",
  ) as HTMLElement | null;
  const topPanelHeight = Number(
    topPanel?.dataset.visibleHeight || topPanel?.offsetHeight || 0,
  );
  const bottomPanelHeight = Number(
    bottomPanel?.dataset.visibleHeight || bottomPanel?.offsetHeight || 0,
  );
  const nextPaddingTop =
    topPanelHeight > 0 ? basePaddingTop + topPanelHeight : basePaddingTop;
  const nextPaddingBottom =
    bottomPanelHeight > 0
      ? basePaddingBottom + bottomPanelHeight
      : basePaddingBottom;

  if (
    Math.abs(nextPaddingTop - currentPaddingTop) < 1 &&
    Math.abs(nextPaddingBottom - currentPaddingBottom) < 1
  ) {
    chatHistory.style.paddingTop = `${nextPaddingTop}px`;
    chatHistory.style.paddingBottom = `${nextPaddingBottom}px`;
    chatHistory.style.scrollPaddingTop = `${nextPaddingTop}px`;
    chatHistory.style.scrollPaddingBottom = `${nextPaddingBottom}px`;
    updateChatHistoryScrollBottomButton(chatHistory);
    return;
  }

  const previousScrollTop = chatHistory.scrollTop;
  const previousScrollHeight = chatHistory.scrollHeight;
  const wasNearBottom =
    isChatHistoryNearBottom(chatHistory) ||
    shouldAutoScrollChatHistory(chatHistory);
  const shouldPreserveViewport = previousScrollTop > 0;

  chatHistory.style.paddingTop = `${nextPaddingTop}px`;
  chatHistory.style.paddingBottom = `${nextPaddingBottom}px`;
  chatHistory.style.scrollPaddingTop = `${nextPaddingTop}px`;
  chatHistory.style.scrollPaddingBottom = `${nextPaddingBottom}px`;

  if (wasNearBottom) {
    scrollChatHistoryToBottom(chatHistory);
    return;
  }

  if (shouldPreserveViewport) {
    chatHistory.scrollTop = Math.max(
      0,
      previousScrollTop +
        (nextPaddingTop - currentPaddingTop) +
        (nextPaddingBottom - currentPaddingBottom),
    );
  }
  updateChatHistoryScrollBottomButton(chatHistory);
}

function deriveExecutionBannerState(
  executionPlan?: ExecutionPlan,
): ExecutionBannerState {
  const activeStep = executionPlan
    ? getActiveExecutionStep(executionPlan)
    : undefined;
  const progressLabel = executionPlan
    ? formatExecutionPlanProgress(executionPlan)
    : undefined;

  if (!executionPlan || executionPlan.status !== "in_progress") {
    return {
      kind: "idle",
      icon: "",
      title: "",
      detail: "",
    };
  }

  if (activeStep?.id?.startsWith(RECOVERY_STEP_PREFIX)) {
    return {
      kind: "recovering",
      icon: "↺",
      title: getString("chat-banner-auto-recovering"),
      detail: activeStep.title || getString("chat-banner-auto-recovering"),
      subdetail: activeStep.detail || executionPlan.summary,
      statusLabel: progressLabel,
      accentColor: "#1d4ed8",
      accentBackground: "rgba(37, 99, 235, 0.14)",
    };
  }

  return {
    kind: "running",
    icon: "…",
    title: getString("chat-banner-running"),
    detail: activeStep?.title || activeStep?.toolName || executionPlan.summary,
    subdetail: activeStep?.detail || executionPlan.summary,
    statusLabel: progressLabel,
    accentColor: "#334155",
    accentBackground: "rgba(100, 116, 139, 0.14)",
  };
}

function deriveApprovalBannerState(
  _executionPlan?: ExecutionPlan,
  toolApprovalState?: ToolApprovalState,
): ExecutionBannerState {
  if (!toolApprovalState?.pendingRequests.length) {
    return {
      kind: "idle",
      icon: "",
      title: "",
      detail: "",
    };
  }

  const activeRequest = toolApprovalState.pendingRequests[0];
  const extraApprovalCount = Math.max(
    toolApprovalState.pendingRequests.length - 1,
    0,
  );

  return {
    kind: "waiting_approval",
    icon: "!",
    title: getString("chat-banner-waiting-approval"),
    detail: formatApprovalSummary(activeRequest, extraApprovalCount),
    statusLabel: formatPendingApprovalLabel(
      toolApprovalState.pendingRequests.length,
    ),
    accentColor: "#b45309",
    accentBackground: "rgba(245, 158, 11, 0.16)",
    approvalRequest: activeRequest,
  };
}

function deriveResolvedApprovalBannerState(
  request: ToolApprovalState["pendingRequests"][number],
  resolution: ToolApprovalResolution,
  nextPendingCount: number,
): ExecutionBannerState {
  const resolvedLabel = formatApprovalResolutionLabel(resolution);
  const wasAllowed = resolution.verdict === "allow";

  return {
    kind: "approval_resolved",
    icon: wasAllowed ? "✓" : "×",
    title: wasAllowed
      ? getString("chat-banner-approval-applied")
      : getString("chat-banner-denial-applied"),
    detail: `${request.toolName} · ${resolvedLabel}`,
    subdetail:
      nextPendingCount > 0 ? getString("chat-banner-next-up") : undefined,
    statusLabel:
      nextPendingCount > 0
        ? formatPendingApprovalLabel(nextPendingCount)
        : undefined,
    accentColor: wasAllowed ? "#15803d" : "#b91c1c",
    accentBackground: wasAllowed
      ? "rgba(34, 197, 94, 0.16)"
      : "rgba(239, 68, 68, 0.14)",
  };
}

function createExecutionBannerElement(
  doc: Document,
  options: {
    className: string;
    placement: "top" | "bottom";
  },
): HTMLElement {
  const wrapper = createElement(
    doc,
    "div",
    {
      display: "block",
      paddingTop: options.placement === "top" ? "6px" : "8px",
      paddingBottom: options.placement === "bottom" ? "8px" : "0",
      pointerEvents: "auto",
    },
    { class: options.className },
  );

  return wrapper;
}

function populateExecutionBannerElement(
  wrapper: HTMLElement,
  doc: Document,
  banner: ExecutionBannerState,
  theme: ThemeColors,
  options: {
    showApprovalActions: boolean;
    approvalActions?: {
      onResolveApproval: (
        requestId: string,
        resolution: ToolApprovalResolution,
      ) => void | Promise<void>;
    };
  },
): void {
  wrapper.replaceChildren();
  const isApprovalDock =
    options.showApprovalActions && banner.kind === "waiting_approval";
  const isApprovalSummary =
    !options.showApprovalActions && banner.kind === "waiting_approval";
  const accent = resolveExecutionBannerAccent(theme, banner);
  const isDark = theme === darkTheme;

  const bar = createElement(doc, "div", {
    border: `1px solid ${
      isApprovalDock ? accent.borderColor : theme.borderColor
    }`,
    background: theme.assistantBubbleBg,
    borderRadius: isApprovalDock ? "16px" : "12px",
    padding: isApprovalDock
      ? "8px 10px"
      : isApprovalSummary
        ? "7px 9px"
        : "8px 10px",
    boxShadow: isApprovalDock
      ? "0 8px 22px rgba(0, 0, 0, 0.1)"
      : "0 3px 10px rgba(0, 0, 0, 0.06)",
    display: "flex",
    flexDirection: "column",
    gap: isApprovalDock ? "6px" : "5px",
    minWidth: "0",
    boxSizing: "border-box",
  });

  const header = createElement(doc, "div", {
    display: "flex",
    alignItems: "center",
    gap: isApprovalDock ? "6px" : "5px",
    minWidth: "0",
    width: "100%",
    flexWrap: "nowrap",
  });

  const badge = createElement(doc, "span", {
    width: isApprovalDock ? "20px" : "16px",
    height: isApprovalDock ? "20px" : "16px",
    minWidth: isApprovalDock ? "20px" : "16px",
    borderRadius: "999px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: accent.background,
    color: accent.color,
    fontSize: isApprovalDock ? "10px" : "9px",
    fontWeight: "700",
    flexShrink: "0",
  });
  badge.textContent = banner.icon;

  const textGroup = createElement(doc, "div", {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: "0",
    flex: "1 1 220px",
  });

  const titleRow = createElement(doc, "div", {
    display: "flex",
    alignItems: "center",
    gap: "5px",
    minWidth: "0",
  });

  const title = createElement(doc, "span", {
    fontSize: isApprovalDock ? "12px" : "11px",
    fontWeight: "700",
    color: theme.textPrimary,
    lineHeight: "1.2",
    minWidth: "0",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  });
  title.textContent = banner.title;

  const detail = createElement(doc, "div", {
    fontSize: isApprovalDock ? "10px" : "10px",
    color: theme.textSecondary,
    minWidth: "0",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    lineHeight: "1.25",
  });
  detail.textContent = banner.detail;

  titleRow.appendChild(badge);
  titleRow.appendChild(title);
  textGroup.appendChild(titleRow);
  textGroup.appendChild(detail);
  if (banner.subdetail) {
    const subdetail = createElement(doc, "div", {
      fontSize: "9px",
      color: theme.textMuted,
      minWidth: "0",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      lineHeight: "1.25",
    });
    subdetail.textContent = banner.subdetail;
    textGroup.appendChild(subdetail);
  }

  header.appendChild(textGroup);
  if (banner.statusLabel) {
    const statusPill = createElement(doc, "span", {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      minHeight: isApprovalDock ? "22px" : "20px",
      padding: isApprovalDock ? "0 8px" : "0 7px",
      borderRadius: "999px",
      fontSize: "9px",
      fontWeight: "700",
      color: accent.color,
      background: accent.background,
      whiteSpace: "nowrap",
      flexShrink: "0",
      marginLeft: isApprovalDock ? "6px" : "5px",
      border: isDark ? `1px solid ${accent.borderColor}` : "none",
    });
    statusPill.textContent = banner.statusLabel;
    header.appendChild(statusPill);
  }
  bar.appendChild(header);

  if (
    options.showApprovalActions &&
    banner.kind === "waiting_approval" &&
    banner.approvalRequest
  ) {
    bar.appendChild(
      createApprovalActionsRow(
        doc,
        theme,
        banner.approvalRequest,
        options.approvalActions,
      ),
    );
  }

  wrapper.appendChild(bar);
}

function resolveExecutionBannerAccent(
  theme: ThemeColors,
  banner: ExecutionBannerState,
): {
  color: string;
  background: string;
  borderColor: string;
} {
  const isDark = theme === darkTheme;

  switch (banner.kind) {
    case "running":
      return isDark
        ? {
            color: "#cbd5e1",
            background: "rgba(148, 163, 184, 0.18)",
            borderColor: "rgba(148, 163, 184, 0.28)",
          }
        : {
            color: "#334155",
            background: "rgba(100, 116, 139, 0.14)",
            borderColor: "rgba(100, 116, 139, 0.22)",
          };
    case "recovering":
      return isDark
        ? {
            color: "#93c5fd",
            background: "rgba(59, 130, 246, 0.22)",
            borderColor: "rgba(96, 165, 250, 0.32)",
          }
        : {
            color: "#1d4ed8",
            background: "rgba(37, 99, 235, 0.14)",
            borderColor: "rgba(37, 99, 235, 0.2)",
          };
    case "waiting_approval":
      return isDark
        ? {
            color: "#fbbf24",
            background: "rgba(245, 158, 11, 0.24)",
            borderColor: "rgba(251, 191, 36, 0.32)",
          }
        : {
            color: "#b45309",
            background: "rgba(245, 158, 11, 0.16)",
            borderColor: "rgba(245, 158, 11, 0.24)",
          };
    case "approval_resolved":
      return banner.accentColor === "#b91c1c"
        ? isDark
          ? {
              color: "#fca5a5",
              background: "rgba(239, 68, 68, 0.22)",
              borderColor: "rgba(248, 113, 113, 0.3)",
            }
          : {
              color: "#b91c1c",
              background: "rgba(239, 68, 68, 0.12)",
              borderColor: "rgba(239, 68, 68, 0.2)",
            }
        : isDark
          ? {
              color: "#86efac",
              background: "rgba(34, 197, 94, 0.22)",
              borderColor: "rgba(74, 222, 128, 0.3)",
            }
          : {
              color: "#15803d",
              background: "rgba(34, 197, 94, 0.14)",
              borderColor: "rgba(34, 197, 94, 0.2)",
            };
    default:
      return {
        color: banner.accentColor || theme.textPrimary,
        background: banner.accentBackground || theme.buttonBg,
        borderColor: theme.borderColor,
      };
  }
}

function createApprovalActionsRow(
  doc: Document,
  theme: ThemeColors,
  request: ToolApprovalState["pendingRequests"][number],
  approvalActions?: {
    onResolveApproval: (
      requestId: string,
      resolution: ToolApprovalResolution,
    ) => void | Promise<void>;
  },
): HTMLElement {
  const actions = createElement(doc, "div", {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    width: "100%",
    flexWrap: "nowrap",
  });

  const buttonSpecs: Array<{
    label: string;
    resolution: ToolApprovalResolution;
  }> = [
    {
      label: getString("chat-banner-allow-once"),
      resolution: { verdict: "allow", scope: "once" },
    },
    {
      label: getString("chat-banner-session"),
      resolution: { verdict: "allow", scope: "session" },
    },
    {
      label: getString("chat-banner-always"),
      resolution: { verdict: "allow", scope: "always" },
    },
    {
      label: getString("chat-banner-deny"),
      resolution: { verdict: "deny", scope: "once" },
    },
  ];

  for (const spec of buttonSpecs) {
    const button = createElement(doc, "button", {
      border: `1px solid ${theme.borderColor}`,
      background:
        spec.resolution.verdict === "deny" ? theme.buttonBg : theme.inputBg,
      color:
        spec.resolution.verdict === "deny"
          ? theme.textSecondary
          : theme.textPrimary,
      borderRadius: "9px",
      padding: "4px 6px",
      fontSize: "9px",
      fontWeight: "600",
      lineHeight: "1",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      cursor: approvalActions ? "pointer" : "default",
      opacity: approvalActions ? "1" : "0.6",
      flex: "1 1 0",
      minWidth: "0",
      minHeight: "26px",
      boxShadow:
        spec.resolution.scope === "always"
          ? "inset 0 0 0 1px rgba(59, 130, 246, 0.15)"
          : "none",
    }) as HTMLButtonElement;
    button.textContent = spec.label;
    button.disabled = !approvalActions;
    if (approvalActions) {
      button.addEventListener("click", () => {
        void approvalActions.onResolveApproval(request.id, spec.resolution);
      });
    }
    actions.appendChild(button);
  }

  return actions;
}

function populateUserInputRequestElement(
  wrapper: HTMLElement,
  doc: Document,
  theme: ThemeColors,
  request: UserInputRequestState["pendingRequests"][number],
  actions?: {
    onResolveUserInput: (
      requestId: string,
      response: RequestUserInputResponse,
    ) => void | Promise<void>;
  },
): void {
  wrapper.replaceChildren();
  const questions = request.args.questions;
  if (questions.length === 0) {
    return;
  }

  const form = createElement(doc, "form", {
    border: `1px solid ${theme.borderColor}`,
    background: theme.assistantBubbleBg,
    borderRadius: "16px",
    padding: "8px 10px",
    boxShadow: "0 8px 22px rgba(0, 0, 0, 0.1)",
    display: "flex",
    flexDirection: "column",
    gap: "7px",
    minWidth: "0",
    boxSizing: "border-box",
  }) as HTMLFormElement;

  const header = createElement(doc, "div", {
    display: "flex",
    alignItems: "flex-start",
    gap: "7px",
    minWidth: "0",
  });

  const badge = createElement(doc, "span", {
    width: "20px",
    height: "20px",
    minWidth: "20px",
    borderRadius: "999px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(37, 99, 235, 0.14)",
    color: "#1d4ed8",
    fontSize: "12px",
    fontWeight: "700",
    flexShrink: "0",
  });
  badge.textContent = "?";

  const textGroup = createElement(doc, "div", {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: "0",
    flex: "1 1 auto",
  });

  const title = createElement(doc, "div", {
    fontSize: "12px",
    fontWeight: "700",
    color: theme.textPrimary,
    lineHeight: "1.25",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  });
  title.textContent =
    questions.length === 1
      ? questions[0].header || getString("chat-user-input-title")
      : getString("chat-user-input-title");

  const detail = createElement(doc, "div", {
    fontSize: "10px",
    color: theme.textSecondary,
    lineHeight: "1.3",
    whiteSpace: "normal",
    overflowWrap: "anywhere",
  });
  detail.textContent =
    questions.length === 1
      ? questions[0].question
      : request.args.reason || questions.map((item) => item.header).join(" · ");

  textGroup.appendChild(title);
  textGroup.appendChild(detail);
  header.appendChild(badge);
  header.appendChild(textGroup);
  form.appendChild(header);

  if (request.expiresAt) {
    const autoLabel = createElement(doc, "div", {
      color: theme.textMuted,
      fontSize: "9px",
      lineHeight: "1.2",
    });
    updateUserInputCountdownLabel(autoLabel, request.expiresAt);
    attachUserInputCountdownTimer(wrapper, autoLabel, request.expiresAt);
    form.appendChild(autoLabel);
  }

  for (const question of questions) {
    form.appendChild(
      createUserInputQuestionControl(doc, theme, request.id, question),
    );
  }

  const error = createElement(
    doc,
    "div",
    {
      display: "none",
      color: "#b91c1c",
      fontSize: "10px",
      lineHeight: "1.25",
    },
    { "data-user-input-error": "true" },
  );
  form.appendChild(error);

  const actionsRow = createElement(doc, "div", {
    display: "flex",
    alignItems: "stretch",
    justifyContent: "flex-end",
    gap: "5px",
    width: "100%",
  });

  const cancelButton = createElement(doc, "button", {
    border: `1px solid ${theme.borderColor}`,
    background: theme.buttonBg,
    color: theme.textSecondary,
    borderRadius: "9px",
    padding: "5px 8px",
    fontSize: "10px",
    fontWeight: "600",
    lineHeight: "1.15",
    cursor: actions ? "pointer" : "default",
    opacity: actions ? "1" : "0.6",
    minHeight: "28px",
  }) as HTMLButtonElement;
  cancelButton.type = "button";
  cancelButton.textContent = getString("chat-user-input-cancel");
  cancelButton.disabled = !actions;
  if (actions) {
    cancelButton.addEventListener("click", () => {
      void actions.onResolveUserInput(
        request.id,
        createCancelledUserInputUiResponse(request),
      );
    });
  }

  const submitButton = createElement(doc, "button", {
    border: `1px solid ${theme.borderColor}`,
    background: theme.inputBg,
    color: theme.textPrimary,
    borderRadius: "9px",
    padding: "5px 10px",
    fontSize: "10px",
    fontWeight: "700",
    lineHeight: "1.15",
    cursor: actions ? "pointer" : "default",
    opacity: actions ? "1" : "0.6",
    minHeight: "28px",
  }) as HTMLButtonElement;
  submitButton.type = "submit";
  submitButton.textContent = getString("chat-user-input-submit");
  submitButton.disabled = !actions;
  actionsRow.appendChild(cancelButton);
  actionsRow.appendChild(submitButton);
  form.appendChild(actionsRow);

  if (actions) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const collected = collectUserInputResponse(form, request);
      if (!collected.ok) {
        error.textContent = collected.error;
        error.style.display = "block";
        syncExecutionInsetHeight(wrapper.parentElement as HTMLElement, wrapper);
        return;
      }
      void actions.onResolveUserInput(request.id, collected.response);
    });
  }

  wrapper.appendChild(form);
}

function clearUserInputCountdownTimer(scope: HTMLElement): void {
  const timer = userInputCountdownTimers.get(scope);
  if (!timer) {
    return;
  }
  clearInterval(timer);
  userInputCountdownTimers.delete(scope);
}

function attachUserInputCountdownTimer(
  scope: HTMLElement,
  label: HTMLElement,
  expiresAt: number,
): void {
  clearUserInputCountdownTimer(scope);
  const timer = setInterval(() => {
    updateUserInputCountdownLabel(label, expiresAt);
    if (expiresAt <= Date.now()) {
      clearUserInputCountdownTimer(scope);
    }
  }, 1000);
  userInputCountdownTimers.set(scope, timer);
}

function updateUserInputCountdownLabel(
  label: HTMLElement,
  expiresAt: number,
): void {
  const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  label.textContent = getString("chat-user-input-auto", {
    args: { seconds },
  });
}

type UserInputRequestViewModel =
  UserInputRequestState["pendingRequests"][number];
type UserInputQuestionViewModel =
  UserInputRequestViewModel["args"]["questions"][number];

function createUserInputQuestionControl(
  doc: Document,
  theme: ThemeColors,
  requestId: string,
  question: UserInputQuestionViewModel,
): HTMLElement {
  const field = createElement(doc, "div", {
    display: "flex",
    flexDirection: "column",
    gap: "5px",
    minWidth: "0",
  });

  const labelRow = createElement(doc, "div", {
    display: "flex",
    alignItems: "center",
    gap: "5px",
    minWidth: "0",
  });
  const label = createElement(doc, "label", {
    color: theme.textPrimary,
    fontSize: "10px",
    fontWeight: "700",
    lineHeight: "1.25",
    overflowWrap: "anywhere",
  });
  label.textContent = question.question;
  labelRow.appendChild(label);
  if (question.required === false) {
    const optional = createElement(doc, "span", {
      color: theme.textMuted,
      fontSize: "9px",
      lineHeight: "1.2",
      whiteSpace: "nowrap",
    });
    optional.textContent = getString("chat-user-input-optional");
    labelRow.appendChild(optional);
  }
  field.appendChild(labelRow);

  if (
    question.type === "single_choice" ||
    question.type === "confirm" ||
    question.type === "multi_choice"
  ) {
    field.appendChild(
      createChoiceQuestionControl(doc, theme, requestId, question),
    );
    return field;
  }

  const input = createElement(
    doc,
    question.type === "secret" ? "input" : "textarea",
    {
      border: `1px solid ${theme.borderColor}`,
      background: theme.inputBg,
      color: theme.textPrimary,
      borderRadius: "9px",
      padding: "6px 7px",
      fontSize: "11px",
      lineHeight: "1.35",
      minHeight: question.type === "secret" ? "30px" : "54px",
      resize: question.type === "secret" ? "none" : "vertical",
      boxSizing: "border-box",
      width: "100%",
    },
  ) as HTMLInputElement | HTMLTextAreaElement;
  input.setAttribute("data-question-id", question.id);
  input.setAttribute("data-question-type", question.type || "text");
  input.placeholder = question.placeholder || "";
  if (question.type === "secret") {
    const secretInput = input as HTMLInputElement;
    secretInput.type = "password";
    secretInput.autocomplete = "off";
  }
  if (typeof question.defaultValue === "string" && question.type !== "secret") {
    input.value = question.defaultValue;
  }
  field.appendChild(input);
  return field;
}

function createChoiceQuestionControl(
  doc: Document,
  theme: ThemeColors,
  requestId: string,
  question: UserInputQuestionViewModel,
): HTMLElement {
  if (
    question.id === NOTE_SUMMARY_DESTINATION_QUESTION_ID &&
    (question.options?.length || 0) > 4 &&
    question.type === "single_choice"
  ) {
    return createNoteDestinationSelectControl(doc, theme, requestId, question);
  }

  const optionsWrap = createElement(doc, "div", {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    minWidth: "0",
  });
  const inputType = question.type === "multi_choice" ? "checkbox" : "radio";
  const groupName = `user-input-${requestId}-${question.id}`;
  const defaultValues = getQuestionDefaultValues(question);

  for (const option of question.options || []) {
    const value = option.value || option.label;
    const optionLabel = createElement(doc, "label", {
      border: `1px solid ${theme.borderColor}`,
      background: option.recommended ? theme.inputBg : theme.buttonBg,
      color: theme.textPrimary,
      borderRadius: "9px",
      padding: "6px 7px",
      display: "flex",
      alignItems: "flex-start",
      gap: "6px",
      cursor: "pointer",
      minWidth: "0",
    });
    const input = doc.createElement("input") as HTMLInputElement;
    input.type = inputType;
    input.name = groupName;
    input.value = value;
    input.checked = defaultValues.has(value) || option.recommended === true;
    input.setAttribute("data-question-id", question.id);
    input.setAttribute("data-question-type", question.type || "single_choice");
    input.style.margin = "1px 0 0 0";
    input.style.flexShrink = "0";

    const textGroup = createElement(doc, "span", {
      display: "flex",
      flexDirection: "column",
      gap: "2px",
      minWidth: "0",
      flex: "1 1 auto",
    });
    const optionTitle = createElement(doc, "span", {
      fontSize: "10px",
      fontWeight: option.recommended ? "700" : "600",
      lineHeight: "1.2",
      overflowWrap: "anywhere",
    });
    optionTitle.textContent = option.label;
    textGroup.appendChild(optionTitle);
    if (option.description) {
      const optionDetail = createElement(doc, "span", {
        color: theme.textSecondary,
        fontSize: "9px",
        lineHeight: "1.25",
        overflowWrap: "anywhere",
      });
      optionDetail.textContent = option.description;
      textGroup.appendChild(optionDetail);
    }

    optionLabel.appendChild(input);
    optionLabel.appendChild(textGroup);
    optionsWrap.appendChild(optionLabel);
  }

  if (question.allowOther) {
    const otherRow = createElement(doc, "label", {
      border: `1px solid ${theme.borderColor}`,
      background: theme.buttonBg,
      color: theme.textPrimary,
      borderRadius: "9px",
      padding: "6px 7px",
      display: "flex",
      alignItems: "center",
      gap: "6px",
      cursor: "pointer",
      minWidth: "0",
    });
    const input = doc.createElement("input") as HTMLInputElement;
    input.type = inputType;
    input.name = groupName;
    input.value = "__other__";
    input.setAttribute("data-question-id", question.id);
    input.setAttribute("data-question-type", question.type || "single_choice");
    const otherInput = doc.createElement("input") as HTMLInputElement;
    otherInput.type = "text";
    otherInput.placeholder = getString("chat-user-input-other");
    otherInput.setAttribute("data-other-for", question.id);
    otherInput.style.flex = "1 1 auto";
    otherInput.style.minWidth = "0";
    otherInput.style.border = "none";
    otherInput.style.outline = "none";
    otherInput.style.background = "transparent";
    otherInput.style.color = theme.textPrimary;
    otherInput.style.fontSize = "10px";
    otherInput.addEventListener("focus", () => {
      input.checked = true;
    });
    otherRow.appendChild(input);
    otherRow.appendChild(otherInput);
    optionsWrap.appendChild(otherRow);
  }

  return optionsWrap;
}

function createNoteDestinationSelectControl(
  doc: Document,
  theme: ThemeColors,
  requestId: string,
  question: UserInputQuestionViewModel,
): HTMLElement {
  const optionsWrap = createElement(doc, "div", {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    minWidth: "0",
  });
  const standaloneOption = question.options?.find(
    (option) =>
      (option.value || option.label) ===
      NOTE_SUMMARY_STANDALONE_DESTINATION_VALUE,
  );
  const paperOptions = (question.options || []).filter(
    (option) => option !== standaloneOption,
  );
  if (!standaloneOption || paperOptions.length === 0) {
    return optionsWrap;
  }

  const groupName = `user-input-${requestId}-${question.id}`;
  const createRow = (): HTMLLabelElement =>
    createElement(doc, "label", {
      border: `1px solid ${theme.borderColor}`,
      background: theme.inputBg,
      color: theme.textPrimary,
      borderRadius: "9px",
      padding: "6px 7px",
      display: "flex",
      alignItems: "center",
      gap: "6px",
      cursor: "pointer",
      minWidth: "0",
    }) as HTMLLabelElement;
  const createRadio = (value: string): HTMLInputElement => {
    const input = doc.createElement("input") as HTMLInputElement;
    input.type = "radio";
    input.name = groupName;
    input.value = value;
    input.setAttribute("data-question-id", question.id);
    input.setAttribute("data-question-type", "single_choice");
    input.style.margin = "0";
    input.style.flexShrink = "0";
    return input;
  };

  const standaloneRow = createRow();
  const standaloneRadio = createRadio(
    standaloneOption.value || standaloneOption.label,
  );
  const defaultValues = getQuestionDefaultValues(question);
  const defaultPaper = paperOptions.find((option) =>
    defaultValues.has(option.value || option.label),
  );
  standaloneRadio.checked =
    defaultValues.has(standaloneRadio.value) || !defaultPaper;
  const standaloneText = createElement(doc, "span", {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: "0",
  });
  const standaloneTitle = createElement(doc, "span", {
    fontSize: "10px",
    fontWeight: "700",
    lineHeight: "1.2",
  });
  standaloneTitle.textContent = standaloneOption.label;
  standaloneText.appendChild(standaloneTitle);
  if (standaloneOption.description) {
    const description = createElement(doc, "span", {
      color: theme.textSecondary,
      fontSize: "9px",
      lineHeight: "1.25",
    });
    description.textContent = standaloneOption.description;
    standaloneText.appendChild(description);
  }
  standaloneRow.appendChild(standaloneRadio);
  standaloneRow.appendChild(standaloneText);
  optionsWrap.appendChild(standaloneRow);

  const paperRow = createRow();
  paperRow.style.alignItems = "center";
  const paperRadio = createRadio(
    paperOptions[0].value || paperOptions[0].label,
  );
  const paperLabel = createElement(doc, "span", {
    fontSize: "10px",
    fontWeight: "600",
    whiteSpace: "nowrap",
  });
  paperLabel.textContent = getString(
    "chat-note-summary-destination-paper-select",
  );
  const select = doc.createElement("select") as HTMLSelectElement;
  select.style.flex = "1 1 auto";
  select.style.minWidth = "0";
  select.style.border = `1px solid ${theme.borderColor}`;
  select.style.borderRadius = "7px";
  select.style.padding = "4px 6px";
  select.style.background = theme.inputBg;
  select.style.color = theme.textPrimary;
  select.style.fontSize = "10px";
  for (const option of paperOptions) {
    const selectOption = doc.createElement("option") as HTMLOptionElement;
    selectOption.value = option.value || option.label;
    selectOption.textContent = option.label;
    select.appendChild(selectOption);
  }
  if (defaultPaper) {
    select.value = defaultPaper.value || defaultPaper.label;
  }
  paperRadio.value = select.value;
  paperRadio.checked = !!defaultPaper;
  const selectPaper = () => {
    paperRadio.value = select.value;
    paperRadio.checked = true;
    standaloneRadio.checked = false;
  };
  select.addEventListener("change", selectPaper);
  select.addEventListener("focus", selectPaper);
  paperRow.appendChild(paperRadio);
  paperRow.appendChild(paperLabel);
  paperRow.appendChild(select);
  optionsWrap.appendChild(paperRow);

  return optionsWrap;
}

function getQuestionDefaultValues(
  question: UserInputQuestionViewModel,
): Set<string> {
  if (Array.isArray(question.defaultValue)) {
    return new Set(question.defaultValue);
  }
  if (typeof question.defaultValue === "string") {
    return new Set([question.defaultValue]);
  }
  return new Set();
}

function createCancelledUserInputUiResponse(
  request: UserInputRequestViewModel,
): RequestUserInputResponse {
  const answers: RequestUserInputResponse["answers"] = {};
  for (const question of request.args.questions) {
    answers[question.id] = { cancelled: true };
  }
  return { answers, cancelled: true };
}

function collectUserInputResponse(
  form: HTMLFormElement,
  request: UserInputRequestViewModel,
):
  | { ok: true; response: RequestUserInputResponse }
  | { ok: false; error: string } {
  const answers: RequestUserInputResponse["answers"] = {};

  for (const question of request.args.questions) {
    const type = question.type || "single_choice";
    if (type === "text" || type === "secret") {
      const input = form.querySelector(
        `[data-question-id="${question.id}"][data-question-type="${type}"]`,
      ) as HTMLInputElement | HTMLTextAreaElement | null;
      const text = (input?.value || "").trim();
      if (question.required !== false && !text) {
        return {
          ok: false,
          error: getString("chat-user-input-required"),
        };
      }
      answers[question.id] =
        type === "secret"
          ? {
              secretRef: text
                ? `secret-${request.id}-${question.id}-${Date.now()}`
                : undefined,
            }
          : { text };
      continue;
    }

    const checked = [
      ...form.querySelectorAll(
        `[data-question-id="${question.id}"][data-question-type="${type}"]`,
      ),
    ].filter((input): input is HTMLInputElement => {
      const candidate = input as HTMLInputElement;
      return typeof candidate.checked === "boolean" && candidate.checked;
    });
    const values = checked
      .filter((input) => input.value !== "__other__")
      .map((input) => input.value);
    const otherChecked = checked.some((input) => input.value === "__other__");
    const otherInput = form.querySelector(
      `[data-other-for="${question.id}"]`,
    ) as HTMLInputElement | null;
    const other = otherChecked ? (otherInput?.value || "").trim() : "";
    const totalSelections = values.length + (other ? 1 : 0);

    if (question.required !== false && totalSelections === 0) {
      return {
        ok: false,
        error: getString("chat-user-input-required"),
      };
    }
    if (
      type === "multi_choice" &&
      question.minSelections !== undefined &&
      totalSelections < question.minSelections
    ) {
      return {
        ok: false,
        error: getString("chat-user-input-too-few", {
          args: { count: question.minSelections },
        }),
      };
    }
    if (
      type === "multi_choice" &&
      question.maxSelections !== undefined &&
      totalSelections > question.maxSelections
    ) {
      return {
        ok: false,
        error: getString("chat-user-input-too-many", {
          args: { count: question.maxSelections },
        }),
      };
    }
    answers[question.id] = {
      answers: values,
      other: other || undefined,
    };
  }

  return {
    ok: true,
    response: { answers },
  };
}

function getActiveExecutionStep(
  plan: ExecutionPlan,
): ExecutionPlanStep | undefined {
  if (plan.activeStepId) {
    const activeStep = plan.steps.find((step) => step.id === plan.activeStepId);
    if (activeStep) return activeStep;
  }

  return (
    plan.steps.find((step) => step.status === "in_progress") ||
    plan.steps[plan.steps.length - 1]
  );
}

function formatExecutionPlanProgress(plan: ExecutionPlan): string {
  const completedCount = plan.steps.filter(
    (step) => step.status === "completed",
  ).length;
  const totalCount = plan.steps.length;
  return totalCount > 0
    ? getString("chat-banner-progress", {
        args: { completed: completedCount, total: totalCount },
      })
    : getString("chat-banner-preparing");
}

function formatApprovalSummary(
  request: ToolApprovalState["pendingRequests"][number],
  extraCount: number,
): string {
  const suffix =
    extraCount > 0
      ? ` ${getString("chat-banner-extra-many", {
          args: { count: extraCount },
        })}`
      : "";
  return `${request.toolName} · ${formatRiskLevel(request.descriptor.riskLevel)}${suffix}`;
}

function formatPendingApprovalLabel(count: number): string {
  return count === 1
    ? getString("chat-banner-pending-one")
    : getString("chat-banner-pending-many", {
        args: { count },
      });
}

function formatApprovalResolutionLabel(
  resolution: ToolApprovalResolution,
): string {
  if (resolution.verdict === "deny") {
    return getString("chat-banner-deny");
  }

  switch (resolution.scope) {
    case "always":
      return getString("chat-banner-always");
    case "session":
      return getString("chat-banner-session");
    default:
      return getString("chat-banner-allow-once");
  }
}

function formatRiskLevel(
  riskLevel: ToolApprovalState["pendingRequests"][number]["descriptor"]["riskLevel"],
): string {
  switch (riskLevel) {
    case "read":
      return getString("chat-banner-risk-read");
    case "network":
      return getString("chat-banner-risk-network");
    case "write":
      return getString("chat-banner-risk-write");
    case "memory":
      return getString("chat-banner-risk-memory");
    case "high_cost":
      return getString("chat-banner-risk-high-cost");
    default:
      return riskLevel;
  }
}

/**
 * Update streaming content in the last assistant message
 */
export function updateStreamingContent(
  container: HTMLElement,
  content: string,
  messageId: string,
): void {
  const streamingEl = container.querySelector(
    getStreamingContentSelector(messageId),
  );
  if (streamingEl) {
    streamingEl.textContent = content;
  }
}

/**
 * Scroll chat history to the bottom
 */
export function scrollToBottom(chatHistory: HTMLElement): void {
  scrollChatHistoryToBottom(chatHistory);
}
