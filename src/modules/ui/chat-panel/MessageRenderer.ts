/**
 * MessageRenderer - Create and manage message bubble elements
 */

import type {
  ChatMessage,
  ExecutionPlan,
  ExecutionPlanStep,
  ToolApprovalState,
} from "../../chat";
import type { ToolApprovalResolution } from "../../../types/tool";
import { chatColors } from "../../../utils/colors";
import type { ThemeColors } from "./types";
import { HTML_NS } from "./types";
import { renderMarkdownToElement } from "./MarkdownRenderer";
import { createElement, copyToClipboard } from "./ChatPanelBuilder";
import { getString } from "../../../utils/locale";
import {
  getPaperChatErrorDisplayMessage,
  parsePaperChatQuotaError,
} from "../../providers/paperchat-errors";
import { darkTheme } from "./ChatPanelTheme";
import { ANALYTICS_EVENTS, getAnalyticsService } from "../../analytics";

const RECOVERY_STEP_PREFIX = "replan:";

type ExecutionBannerKind =
  | "idle"
  | "running"
  | "waiting_approval"
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

type ExecutionInsetPanelElement = HTMLElement & {
  __executionInsetResizeObserver?: ResizeObserver;
};

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
    getAnalyticsService().track(ANALYTICS_EVENTS.paperChatQuotaTopupClicked, {
      source: "quota_error_card",
    });
    void import("../../preferences/UserAuthUI")
      .then((module) => module.openPaperChatSettingsForTopup())
      .catch((error) => {
        ztoolkit.log("[Chat] Failed to open PaperChat settings for topup:", error);
        Zotero.Utilities.Internal.openPreferences("paperchat-prefpane");
      });
  });
  return btn;
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
    { class: "chat-message system-notice" },
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
    { class: `chat-message ${msg.role}-message` },
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
  if (msg.role === "assistant" && isLastAssistant) {
    contentAttrs.id = "chat-streaming-content";
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
    let errorDisplay = getPaperChatErrorDisplayMessage(msg.content);
    quotaDetails = parsePaperChatQuotaError(msg.content);
    if (quotaDetails) {
      errorDisplay = quotaDetails.displayMessage;
    }
    content.textContent = `⚠️ ${errorDisplay}`;
    rawContent = quotaDetails?.rawMessage || errorDisplay;
  } else {
    // Render assistant message as markdown
    if (isLastAssistant && !msg.content) {
      // Show loading indicator for empty streaming placeholder
      const loader = createElement(
        doc,
        "div",
        {
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          padding: "4px 0",
        },
        { class: "typing-indicator" },
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
      content.appendChild(loader);

      // Inject animation keyframes
      injectTypingAnimation(doc);
    } else {
      renderMarkdownToElement(content, msg.content);
    }
  }

  // Add reasoning section for assistant messages (before content)
  if (msg.role === "assistant") {
    if (msg.streamingState === "interrupted") {
      const interruptedBadge = createElement(doc, "div", {
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        marginBottom: "8px",
        padding: "3px 8px",
        fontSize: "11px",
        fontWeight: "600",
        color: "#b45309",
        background: theme.buttonBg,
        border: `1px solid ${theme.borderColor}`,
        borderRadius: "999px",
      });
      interruptedBadge.textContent = getString("chat-interrupted");
      bubble.appendChild(interruptedBadge);
    }

    if (msg.reasoning) {
      // Completed message with reasoning - show collapsed
      const reasoningContainer = createReasoningContainer(
        doc,
        theme,
        msg.reasoning,
        false,
      );
      bubble.appendChild(reasoningContainer);
    } else if (isLastAssistant) {
      // Streaming placeholder - hidden by default, shown when reasoning arrives
      const reasoningContainer = createReasoningContainer(doc, theme, "", true);
      reasoningContainer.id = "chat-streaming-reasoning-container";
      reasoningContainer.style.display = "none";
      bubble.appendChild(reasoningContainer);
    }
  }

  bubble.appendChild(content);

  if (quotaDetails) {
    bubble.appendChild(createTopupButton(doc));
  }

  // Add copy button
  const copyBtn = createCopyButton(doc, theme, rawContent);
  setupCopyButtonHover(bubble, copyBtn);

  bubble.appendChild(copyBtn);

  if (showReroll && onReroll && !quotaDetails) {
    const rerollBtn = createRerollButton(doc, theme, onReroll, onRerollError);
    bubble.appendChild(rerollBtn);
  }

  wrapper.appendChild(bubble);
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
  label.textContent = "\uD83D\uDCAD Thinking";

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
    body.id = "chat-streaming-reasoning";
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

/**
 * Create a reroll button for retryable error messages
 */
function createRerollButton(
  doc: Document,
  theme: ThemeColors,
  onClick: () => void | Promise<void>,
  onError?: (error: Error) => void,
): HTMLElement {
  const btn = createElement(
    doc,
    "button",
    {
      position: "absolute",
      bottom: "4px",
      right: "36px",
      background: theme.copyBtnBg,
      border: "none",
      borderRadius: "4px",
      padding: "4px 8px",
      fontSize: "12px",
      cursor: "pointer",
      opacity: "1",
      transition: "background 0.2s, box-shadow 0.2s",
    },
    { class: "reroll-btn", title: getString("chat-reroll-model") },
  );
  btn.setAttribute("type", "button");
  btn.textContent = "🎲";
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
    btn.setAttribute("data-busy", "true");
    btn.style.opacity = "1";
    btn.style.cursor = "wait";
    Promise.resolve(onClick())
      .catch((error: unknown) => {
        const rerollError =
          error instanceof Error ? error : new Error(String(error));
        ztoolkit.log("[MessageRenderer] Reroll failed:", rerollError);
        onError?.(rerollError);
      })
      .finally(() => {
        btn.removeAttribute("data-busy");
        btn.style.cursor = "pointer";
      });
  });
  return btn;
}

export function createCopyButton(
  doc: Document,
  theme: ThemeColors,
  contentToCopy: string,
): HTMLElement {
  const copyBtn = createElement(
    doc,
    "button",
    {
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
    },
    { class: "copy-btn", title: getString("chat-copy") },
  );
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
export function setupCopyButtonHover(
  bubble: HTMLElement,
  copyBtn: HTMLElement,
): void {
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
  retryableErrorMessageId?: string,
  onReroll?: () => void | Promise<void>,
  onRerollError?: (error: Error) => void,
): void {
  const doc = chatHistory.ownerDocument;
  if (!doc) return;

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
    chatHistory.appendChild(
      createMessageElement(
        doc,
        msg,
        theme,
        isLastAssistant,
        msg.role === "error" && retryableErrorMessageId === msg.id,
        onReroll,
        onRerollError,
      ),
    );
  }

  // Scroll to bottom
  chatHistory.scrollTop = chatHistory.scrollHeight;
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
): void {
  const banner = deriveApprovalBannerState(executionPlan, toolApprovalState);
  updateExecutionInsetPanel(panel, theme, banner, {
    placement: "bottom",
    showApprovalActions: true,
    approvalActions,
  });
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
  syncExecutionInsets(panel);
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
    return;
  }

  const previousScrollTop = chatHistory.scrollTop;
  const previousScrollHeight = chatHistory.scrollHeight;
  const previousBottomOffset =
    previousScrollHeight - chatHistory.clientHeight - previousScrollTop;
  const wasNearBottom = previousBottomOffset <= 48;
  const shouldPreserveViewport = previousScrollTop > 0;

  chatHistory.style.paddingTop = `${nextPaddingTop}px`;
  chatHistory.style.paddingBottom = `${nextPaddingBottom}px`;
  chatHistory.style.scrollPaddingTop = `${nextPaddingTop}px`;
  chatHistory.style.scrollPaddingBottom = `${nextPaddingBottom}px`;

  if (wasNearBottom) {
    chatHistory.scrollTop = chatHistory.scrollHeight;
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
      isApprovalDock
        ? accent.borderColor
        : theme.borderColor
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
): void {
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
