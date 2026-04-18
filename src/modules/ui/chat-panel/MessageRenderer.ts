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
      interruptedBadge.textContent = "Interrupted";
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

  // Add copy button
  const copyBtn = createCopyButton(doc, theme, rawContent);
  setupCopyButtonHover(bubble, copyBtn);

  bubble.appendChild(copyBtn);

  if (showReroll && onReroll) {
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
  toolApprovalState?: ToolApprovalState,
  approvalActions?: {
    onResolveApproval: (
      requestId: string,
      resolution: ToolApprovalResolution,
    ) => void | Promise<void>;
  },
): void {
  const existing = panel.querySelector("#chat-execution-plan");
  if (existing) {
    existing.remove();
  }

  if (toolApprovalState?.pendingRequests.length) {
    const doc = panel.ownerDocument;
    if (!doc) return;

    const approvalElement = createApprovalElement(
      doc,
      toolApprovalState,
      theme,
      approvalActions,
    );
    panel.style.display = "block";
    panel.appendChild(approvalElement);
    syncExecutionPlanInset(panel);
    return;
  }

  if (!executionPlan || executionPlan.status !== "in_progress") {
    panel.style.display = "none";
    syncExecutionPlanInset(panel);
    return;
  }

  const doc = panel.ownerDocument;
  if (!doc) return;

  const planElement = createExecutionPlanElement(doc, executionPlan, theme);
  panel.style.display = "block";
  panel.appendChild(planElement);
  syncExecutionPlanInset(panel);
}

function syncExecutionPlanInset(panel: HTMLElement): void {
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
  const computedPaddingTop = Number.isFinite(inlinePaddingTop)
    ? inlinePaddingTop
    : 14;
  const basePaddingTop = Number(
    chatHistory.dataset.basePaddingTop || computedPaddingTop || 14,
  );
  chatHistory.dataset.basePaddingTop = String(basePaddingTop);

  const currentPaddingTop = Number.isFinite(inlinePaddingTop)
    ? inlinePaddingTop
    : basePaddingTop;
  const nextPaddingTop =
    panel.style.display === "none"
      ? basePaddingTop
      : basePaddingTop + panel.offsetHeight;

  if (Math.abs(nextPaddingTop - currentPaddingTop) < 1) {
    chatHistory.style.scrollPaddingTop = `${nextPaddingTop}px`;
    return;
  }

  const previousScrollTop = chatHistory.scrollTop;
  const shouldPreserveViewport = previousScrollTop > 0;

  chatHistory.style.paddingTop = `${nextPaddingTop}px`;
  chatHistory.style.scrollPaddingTop = `${nextPaddingTop}px`;

  if (shouldPreserveViewport) {
    chatHistory.scrollTop = Math.max(
      0,
      previousScrollTop + (nextPaddingTop - currentPaddingTop),
    );
  }
}

function createApprovalElement(
  doc: Document,
  toolApprovalState: ToolApprovalState,
  theme: ThemeColors,
  approvalActions?: {
    onResolveApproval: (
      requestId: string,
      resolution: ToolApprovalResolution,
    ) => void | Promise<void>;
  },
): HTMLElement {
  const activeRequest = toolApprovalState.pendingRequests[0];
  const extraCount = Math.max(toolApprovalState.pendingRequests.length - 1, 0);

  const wrapper = createElement(
    doc,
    "div",
    {
      display: "block",
      margin: "0",
      pointerEvents: "auto",
    },
    { id: "chat-execution-plan", class: "chat-execution-plan" },
  );

  const bar = createElement(doc, "div", {
    border: `1px solid ${theme.borderColor}`,
    background: theme.assistantBubbleBg,
    borderRadius: "14px",
    padding: "8px 10px",
    boxShadow: "0 6px 18px rgba(0, 0, 0, 0.08)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "10px",
    minWidth: "0",
    flexWrap: "wrap",
  });

  const info = createElement(doc, "div", {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    minWidth: "0",
    flex: "1 1 200px",
  });

  const badge = createElement(doc, "span", {
    width: "20px",
    height: "20px",
    minWidth: "20px",
    borderRadius: "999px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(245, 158, 11, 0.16)",
    color: "#b45309",
    fontSize: "12px",
    fontWeight: "700",
    flexShrink: "0",
  });
  badge.textContent = "!";

  const textGroup = createElement(doc, "div", {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    minWidth: "0",
    flex: "1 1 auto",
  });

  const title = createElement(doc, "span", {
    fontSize: "12px",
    fontWeight: "700",
    color: theme.textPrimary,
    lineHeight: "1.2",
  });
  title.textContent = "Permission Required";

  const detail = createElement(doc, "div", {
    fontSize: "11px",
    color: theme.textSecondary,
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    lineHeight: "1.2",
  });
  detail.textContent = formatApprovalDetail(activeRequest, extraCount);

  const actions = createElement(doc, "div", {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "6px",
    flexWrap: "wrap",
    flexShrink: "0",
  });

  const buttonSpecs: Array<{
    label: string;
    resolution: ToolApprovalResolution;
  }> = [
    {
      label: "Allow Once",
      resolution: { verdict: "allow", scope: "once" },
    },
    {
      label: "Session",
      resolution: { verdict: "allow", scope: "session" },
    },
    {
      label: "Always",
      resolution: { verdict: "allow", scope: "always" },
    },
    {
      label: "Deny",
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
      borderRadius: "999px",
      padding: "4px 10px",
      fontSize: "11px",
      fontWeight: "600",
      cursor: approvalActions ? "pointer" : "default",
      opacity: approvalActions ? "1" : "0.6",
      boxShadow:
        spec.resolution.scope === "always"
          ? "inset 0 0 0 1px rgba(59, 130, 246, 0.15)"
          : "none",
    }) as HTMLButtonElement;
    button.textContent = spec.label;
    button.disabled = !approvalActions;
    if (approvalActions) {
      button.addEventListener("click", () => {
        void approvalActions.onResolveApproval(
          activeRequest.id,
          spec.resolution,
        );
      });
    }
    actions.appendChild(button);
  }

  textGroup.appendChild(title);
  textGroup.appendChild(detail);
  info.appendChild(badge);
  info.appendChild(textGroup);
  bar.appendChild(info);
  bar.appendChild(actions);
  wrapper.appendChild(bar);
  return wrapper;
}

function createExecutionPlanElement(
  doc: Document,
  plan: ExecutionPlan,
  theme: ThemeColors,
): HTMLElement {
  const activeStep = getActiveExecutionStep(plan);
  const completedCount = plan.steps.filter(
    (step) => step.status === "completed",
  ).length;
  const totalCount = plan.steps.length;

  const wrapper = createElement(
    doc,
    "div",
    {
      display: "block",
      margin: "0",
      pointerEvents: "auto",
    },
    { id: "chat-execution-plan", class: "chat-execution-plan" },
  );

  const bar = createElement(doc, "div", {
    border: `1px solid ${theme.borderColor}`,
    background: theme.assistantBubbleBg,
    borderRadius: "999px",
    padding: "7px 12px",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05)",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    minWidth: "0",
  });

  const badge = createElement(doc, "span", {
    fontSize: "12px",
    fontWeight: "700",
    color: getPlanStatusColor("in_progress", theme),
    flexShrink: "0",
  });
  badge.textContent = "⏳";

  const title = createElement(doc, "span", {
    fontSize: "12px",
    fontWeight: "600",
    color: theme.textPrimary,
    whiteSpace: "nowrap",
    flexShrink: "0",
  });
  title.textContent = "Execution Plan";

  const detail = createElement(doc, "div", {
    fontSize: "12px",
    color: theme.textSecondary,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: "0",
    flex: "1",
  });

  detail.textContent = formatExecutionPlanDetail(
    plan,
    activeStep,
    completedCount,
    totalCount,
  );

  bar.appendChild(badge);
  bar.appendChild(title);
  bar.appendChild(detail);

  wrapper.appendChild(bar);
  return wrapper;
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

function formatExecutionPlanDetail(
  plan: ExecutionPlan,
  activeStep: ExecutionPlanStep | undefined,
  completedCount: number,
  totalCount: number,
): string {
  const progressText =
    totalCount > 0 ? `${completedCount}/${totalCount} steps` : "preparing";
  const activeLabel = activeStep?.title || activeStep?.toolName || plan.summary;
  return `${progressText} · ${activeLabel}`;
}

function formatApprovalDetail(
  request: ToolApprovalState["pendingRequests"][number],
  extraCount: number,
): string {
  const suffix = extraCount > 0 ? ` +${extraCount}` : "";
  return `${request.toolName} · ${request.descriptor.riskLevel}${suffix}`;
}

function getPlanStatusColor(
  status: ExecutionPlan["status"] | ExecutionPlanStep["status"],
  theme: ThemeColors,
): string {
  switch (status) {
    case "completed":
      return "#1a7f37";
    case "denied":
      return "#b26b00";
    case "failed":
      return chatColors.errorBubbleText;
    case "in_progress":
      return theme.textPrimary;
    default:
      return theme.textMuted;
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
