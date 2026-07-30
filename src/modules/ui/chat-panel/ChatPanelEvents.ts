/**
 * ChatPanelEvents - Event handlers for the chat panel
 */

import { config } from "../../../../package.json";
import type { ChatPanelContext, AttachmentState, SessionInfo } from "./types";
import { createElement, copyToClipboard } from "./ChatPanelBuilder";
import { getCurrentTheme } from "./ChatPanelTheme";
import {
  createHistoryDropdownState,
  refreshHistoryDropdownSearch,
  populateHistoryDropdown,
  setupHistoryDropdownSearch,
  setupClickOutsideHandler,
  toggleHistoryDropdown,
} from "./HistoryDropdown";
import { showAuthDialog } from "../AuthDialog";
import { getString } from "../../../utils/locale";
import { getProviderManager } from "../../providers";
import type { PaperChatProviderConfig } from "../../../types/provider";
import type { SubscriptionUsageSummary } from "../../../types/auth";
import { getPref, setPref } from "../../../utils/prefs";
import {
  formatModelLabel,
  getModelRatios,
  getModelRoutingMeta,
} from "../../preferences/ModelsFetcher";
import {
  PAPERCHAT_TIERS,
  deriveTierPools,
  getAvailablePaperChatTiers,
  parseTierState,
  type PaperChatTier,
} from "../../providers/paperchat-tier-routing";
import { getChatManager, type PanelMode } from "./ChatPanelManager";
import {
  MentionSelector,
  type MentionResource,
  findMentionAtCursor,
} from "./MentionSelector";
import {
  scrollToAndHighlightMessage,
  scrollChatHistoryToBottom,
  shouldAutoScrollChatHistory,
  updateChatHistoryAutoScrollState,
  updateChatHistoryScrollBottomButton,
} from "./MessageRenderer";
import { ANALYTICS_EVENTS, getAnalyticsService } from "../../analytics";
import { buildErrorProps } from "../../analytics/errorProps";
import { LOW_BALANCE_WARNING_THRESHOLD } from "../../preferences/UserAuthUI";
import {
  extractStatusCode,
  isNetworkErrorMessage,
} from "../../analytics/errorClassify";
import { getReadingLoopService } from "../../reading-loop";
import {
  hasConversationMessages,
  shouldResetSummaryButtonBusyState,
} from "./NoteSummaryActions";
import type {
  ChatMessage,
  ChatSession,
  ImageAttachment,
  QuotedMessageRef,
} from "../../chat";
import {
  sessionTurnQueue,
  type QueuedTurn,
  type TurnRunResult,
} from "./SessionTurnQueue";

// Import getActiveReaderItem from the manager module to avoid circular dependency
// This is set by ChatPanelManager during initialization
let getActiveReaderItemFn: (() => Zotero.Item | null) | null = null;

// Toggle panel mode function reference (set by ChatPanelManager)
let togglePanelModeFn: (() => void) | null = null;

const conversationSummaryRuns = new WeakMap<HTMLButtonElement, symbol>();
let queuedTurnSequence = 0;

// Duration (ms) to show the "+quota" flash on the check-in button after a successful check-in
const CHECKIN_FLASH_DURATION_MS = 5000;

function resetUserBalanceLowBalanceStyles(userBalanceEl: HTMLElement): void {
  userBalanceEl.style.color = "";
  userBalanceEl.style.fontWeight = "";
  userBalanceEl.style.textDecoration = "";
  userBalanceEl.style.textUnderlineOffset = "";
  userBalanceEl.style.cursor = "";
  userBalanceEl.style.opacity = "0.9";
  userBalanceEl.removeAttribute("role");
  userBalanceEl.removeAttribute("tabindex");
  userBalanceEl.removeAttribute("data-low-balance-clickable");
}

function applyUserBalanceLowBalanceStyles(userBalanceEl: HTMLElement): void {
  userBalanceEl.style.color = "#dc2626";
  userBalanceEl.style.fontWeight = "700";
  userBalanceEl.style.textDecoration = "underline";
  userBalanceEl.style.textUnderlineOffset = "2px";
  userBalanceEl.style.cursor = "pointer";
  userBalanceEl.style.opacity = "1";
  userBalanceEl.setAttribute("role", "button");
  userBalanceEl.setAttribute("tabindex", "0");
  userBalanceEl.setAttribute("data-low-balance-clickable", "true");
}

function resetSubscriptionLimitStyles(subscriptionEl: HTMLElement): void {
  subscriptionEl.style.color = "";
  subscriptionEl.style.fontWeight = "";
  subscriptionEl.style.textDecoration = "";
  subscriptionEl.style.textUnderlineOffset = "";
  subscriptionEl.style.cursor = "";
  subscriptionEl.removeAttribute("role");
  subscriptionEl.removeAttribute("tabindex");
  subscriptionEl.removeAttribute("data-subscription-limit-clickable");
}

function applySubscriptionLimitStyles(subscriptionEl: HTMLElement): void {
  subscriptionEl.style.color = "#dc2626";
  subscriptionEl.style.fontWeight = "700";
  subscriptionEl.style.textDecoration = "underline";
  subscriptionEl.style.textUnderlineOffset = "2px";
  subscriptionEl.style.cursor = "pointer";
  subscriptionEl.setAttribute("role", "button");
  subscriptionEl.setAttribute("tabindex", "0");
  subscriptionEl.setAttribute("data-subscription-limit-clickable", "true");
}
const MESSAGE_INPUT_MIN_HEIGHT = 60;
const MESSAGE_INPUT_MAX_HEIGHT = 140;
const CHAT_HISTORY_BOTTOM_STICKY_THRESHOLD = 24;

function resetConversationSummaryButtonBusyState(
  button: HTMLButtonElement,
): void {
  conversationSummaryRuns.delete(button);
  button.disabled = false;
  button.removeAttribute("aria-busy");
  button.removeAttribute("data-summary-session-id");
  button.style.cursor = "pointer";
  button.style.opacity = "1";
}

export function updateConversationNoteSummaryButton(
  container: HTMLElement,
  messages: ChatMessage[],
  sessionId?: string,
  supportsToolCalling: boolean = false,
): void {
  const button = container.querySelector(
    "#chat-summarize-conversation-note",
  ) as HTMLButtonElement | null;
  if (!button) {
    return;
  }
  const busySessionId = button.getAttribute("data-summary-session-id");
  if (shouldResetSummaryButtonBusyState(busySessionId, sessionId)) {
    resetConversationSummaryButtonBusyState(button);
  }
  button.style.display =
    supportsToolCalling && hasConversationMessages(messages)
      ? "inline-flex"
      : "none";
}

interface AttachmentPreviewActions {
  onRemoveImage?: (index: number) => void;
  onRemoveQuote?: (index: number) => void;
  onNavigateQuote?: (quote: QuotedMessageRef) => void | Promise<void>;
}

function clearPendingQuotedMessages(context: ChatPanelContext): void {
  const state = context.getAttachmentState();
  if (state.pendingQuotedMessages.length === 0) return;
  state.pendingQuotedMessages = [];
  context.setAttachmentState(state);
  context.updateAttachmentsPreview();
}

function trackChatModelSwitched(props: Record<string, string | boolean>): void {
  getAnalyticsService().track(ANALYTICS_EVENTS.chatModelSwitched, props);
}

function mapSignInReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  const status = extractStatusCode(message);

  if (status !== null && status >= 500) {
    return "server_error";
  }
  if (isNetworkErrorMessage(message) && status === null) {
    return "network_error";
  }
  if (
    normalized.includes("今天已签到") ||
    normalized.includes("already checked in") ||
    normalized.includes("already signed in")
  ) {
    return "already_signed_in";
  }
  if (
    normalized.includes("未登录") ||
    normalized.includes("unauthorized") ||
    normalized.includes("not authenticated") ||
    normalized.includes("无权")
  ) {
    return "not_authenticated";
  }
  if (
    normalized.includes("rate limit") ||
    normalized.includes("too many") ||
    normalized.includes("429") ||
    normalized.includes("频繁") ||
    normalized.includes("稍后再试")
  ) {
    return "rate_limited";
  }

  return "unknown";
}

function getPaperChatTierLabel(tier: PaperChatTier): string {
  if (tier === "paperchat-lite") {
    return getString("chat-tier-lite");
  }

  if (tier === "paperchat-pro") {
    return getString("chat-tier-pro");
  }

  if (tier === "paperchat-ultra") {
    return getString("chat-tier-ultra");
  }

  return getString("chat-tier-standard");
}

function isHighConsumptionPaperChatTier(tier: PaperChatTier): boolean {
  return tier === "paperchat-pro" || tier === "paperchat-ultra";
}

function getPaperChatTierRank(tier: PaperChatTier): number {
  return PAPERCHAT_TIERS.indexOf(tier);
}

function getPaperChatTierDropdownLabel(tier: PaperChatTier): string {
  const label = getPaperChatTierLabel(tier);
  if (tier === "paperchat-pro") {
    return `${label} · ${getString("chat-tier-high-consumption")}`;
  }
  if (tier === "paperchat-ultra") {
    return `${label} · ${getString("chat-tier-very-high-consumption")}`;
  }
  return label;
}

function shouldWarnForPaperChatTierSwitch(
  currentTier: PaperChatTier,
  nextTier: PaperChatTier,
): boolean {
  return (
    getPaperChatTierRank(nextTier) > getPaperChatTierRank(currentTier) &&
    isHighConsumptionPaperChatTier(nextTier) &&
    getPref("paperchatSuppressHighTierWarning") !== true
  );
}

function confirmHighConsumptionTierSwitch(
  doc: Document,
  tier: PaperChatTier,
): Promise<boolean> {
  const theme = getCurrentTheme();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean, dontShowAgain = checkbox.checked) => {
      if (settled) {
        return;
      }
      settled = true;
      if (dontShowAgain) {
        setPref("paperchatSuppressHighTierWarning", true);
      }
      overlay.remove();
      resolve(confirmed);
    };

    const overlay = createElement(doc, "div", {
      position: "fixed",
      inset: "0",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "20px",
      background: "rgba(0,0,0,0.38)",
      zIndex: "10020",
      boxSizing: "border-box",
    });

    const dialog = createElement(doc, "div", {
      width: "min(360px, 100%)",
      padding: "18px",
      borderRadius: "8px",
      border: `1px solid ${theme.borderColor}`,
      background: theme.dropdownBg,
      color: theme.textPrimary,
      boxShadow: "0 16px 44px rgba(0,0,0,0.3)",
      boxSizing: "border-box",
    });

    const title = createElement(doc, "div", {
      fontSize: "15px",
      fontWeight: "700",
      lineHeight: "20px",
      marginBottom: "8px",
    });
    title.textContent =
      tier === "paperchat-ultra"
        ? getString("chat-very-high-tier-warning-title")
        : getString("chat-high-tier-warning-title");

    const message = createElement(doc, "div", {
      fontSize: "13px",
      lineHeight: "20px",
      color: theme.textSecondary,
      marginBottom: "14px",
    });
    message.textContent = getString("chat-high-tier-warning-message");

    const checkboxRow = createElement(doc, "label", {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      fontSize: "12px",
      lineHeight: "16px",
      color: theme.textSecondary,
      marginBottom: "16px",
      cursor: "pointer",
      userSelect: "none",
    });
    const checkbox = createElement(doc, "input", {
      margin: "0",
    }) as HTMLInputElement;
    checkbox.type = "checkbox";
    checkboxRow.appendChild(checkbox);
    const checkboxLabel = createElement(doc, "span", {});
    checkboxLabel.textContent = getString("chat-high-tier-warning-dont-show");
    checkboxRow.appendChild(checkboxLabel);

    const actions = createElement(doc, "div", {
      display: "flex",
      justifyContent: "flex-end",
      gap: "8px",
    });

    const cancelBtn = createElement(doc, "button", {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      minWidth: "72px",
      height: "32px",
      padding: "0 12px",
      borderRadius: "6px",
      border: `1px solid ${theme.inputBorderColor}`,
      background: theme.buttonBg,
      color: theme.textPrimary,
      cursor: "pointer",
      fontSize: "12px",
      lineHeight: "16px",
      boxSizing: "border-box",
    }) as HTMLButtonElement;
    cancelBtn.type = "button";
    cancelBtn.textContent = getString("chat-high-tier-warning-cancel");

    const confirmBtn = createElement(doc, "button", {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      minWidth: "88px",
      height: "32px",
      padding: "0 12px",
      borderRadius: "6px",
      border: "none",
      background: theme.userBubbleBg,
      color: theme.userBubbleText,
      cursor: "pointer",
      fontSize: "12px",
      lineHeight: "16px",
      fontWeight: "600",
      boxSizing: "border-box",
    }) as HTMLButtonElement;
    confirmBtn.type = "button";
    confirmBtn.textContent = getString("chat-high-tier-warning-confirm");

    cancelBtn.addEventListener("click", () => finish(false));
    confirmBtn.addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        finish(false);
      }
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(title);
    dialog.appendChild(message);
    dialog.appendChild(checkboxRow);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    const mountNode = doc.body ?? doc.documentElement;
    if (!mountNode) {
      resolve(false);
      return;
    }
    mountNode.appendChild(overlay);
    confirmBtn.focus();
  });
}

function setCheckinButtonReadyState(button: HTMLButtonElement): void {
  button.textContent = getString("user-checkin-btn");
  button.disabled = false;
}

function setCheckinButtonCheckedInState(button: HTMLButtonElement): void {
  button.textContent = getString("user-checked-in");
  button.disabled = true;
  button.style.opacity = "0.65";
  button.style.cursor = "default";
}

function focusTextarea(input: HTMLTextAreaElement | null | undefined): void {
  if (!input) return;

  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus();
  }
}

function resizeMessageInput(
  messageInput: HTMLTextAreaElement | null | undefined,
  chatHistory?: HTMLElement | null,
): void {
  if (!messageInput) {
    return;
  }

  const previousChatHistoryHeight = chatHistory?.clientHeight ?? 0;
  const previousChatHistoryScrollTop = chatHistory?.scrollTop ?? 0;
  const previousBottomOffset = chatHistory
    ? chatHistory.scrollHeight -
      chatHistory.scrollTop -
      chatHistory.clientHeight
    : 0;

  messageInput.style.height = `${MESSAGE_INPUT_MIN_HEIGHT}px`;
  const measuredHeight = messageInput.scrollHeight;
  const nextHeight = Math.max(
    MESSAGE_INPUT_MIN_HEIGHT,
    Math.min(measuredHeight, MESSAGE_INPUT_MAX_HEIGHT),
  );
  messageInput.style.height = `${nextHeight}px`;
  messageInput.style.overflowY =
    measuredHeight > MESSAGE_INPUT_MAX_HEIGHT ? "auto" : "hidden";

  if (!chatHistory) {
    return;
  }

  const nextChatHistoryHeight = chatHistory.clientHeight;
  if (nextChatHistoryHeight === previousChatHistoryHeight) {
    return;
  }

  if (
    previousBottomOffset <= CHAT_HISTORY_BOTTOM_STICKY_THRESHOLD &&
    shouldAutoScrollChatHistory(chatHistory)
  ) {
    scrollChatHistoryToBottom(chatHistory);
    return;
  }

  const heightDelta = previousChatHistoryHeight - nextChatHistoryHeight;
  chatHistory.scrollTop = Math.max(
    0,
    previousChatHistoryScrollTop + heightDelta,
  );
}

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
 * Fetch check-in status and update the check-in button in the user bar.
 * Call this once on init (if logged in) and after a successful login.
 */
export async function refreshCheckinDisplay(
  container: HTMLElement,
  authManager: {
    fetchCheckinStatus(): Promise<{
      success: boolean;
      enabled: boolean;
      checkedInToday: boolean;
      checkinCount: number;
    }>;
  },
): Promise<void> {
  const checkinBtn = container.querySelector(
    "#chat-checkin-btn",
  ) as HTMLButtonElement | null;
  if (!checkinBtn) return;

  const result = await authManager.fetchCheckinStatus();
  if (!result.success || !result.enabled) {
    checkinBtn.style.display = "none";
    return;
  }

  checkinBtn.style.display = "inline-flex";

  if (result.checkedInToday) {
    checkinBtn.textContent = getString("user-checked-in");
    checkinBtn.disabled = true;
    checkinBtn.style.opacity = "0.65";
    checkinBtn.style.cursor = "default";
  } else {
    checkinBtn.textContent = getString("user-checkin-btn");
    checkinBtn.disabled = false;
    checkinBtn.style.opacity = "1";
    checkinBtn.style.cursor = "pointer";
  }
}

/**
 * Setup all event handlers for the chat panel
 */
export function setupEventHandlers(context: ChatPanelContext): () => void {
  const { container, chatManager, authManager } = context;

  // Disposers for listeners attached to long-lived targets (document/window).
  // Element-scoped listeners are freed with their nodes, but listeners on the
  // document or window outlive the panel and must be removed on teardown to
  // avoid leaking them (and the DOM they close over) on every panel rebuild.
  const disposers: Array<() => void> = [];

  const openPluginPreferencesSafely = (): void => {
    void import("../../preferences/UserAuthUI")
      .then((module) => module.openPaperChatPreferences())
      .catch((error) => {
        ztoolkit.log("[Chat] Failed to open PaperChat preferences:", error);
        Zotero.Utilities.Internal.openPreferences("paperchat-prefpane");
      });
  };

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
  const summarizeConversationBtn = container.querySelector(
    "#chat-summarize-conversation-note",
  ) as HTMLButtonElement | null;
  const debugContextBtn = container.querySelector(
    "#chat-debug-context-btn",
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
  const checkinBtn = container.querySelector(
    "#chat-checkin-btn",
  ) as HTMLButtonElement;
  const chatHistory = container.querySelector(
    "#chat-history",
  ) as HTMLElement | null;
  const scrollBottomBtn = container.querySelector(
    "#chat-scroll-bottom-btn",
  ) as HTMLButtonElement | null;
  const emptyState = container.querySelector(
    "#chat-empty-state",
  ) as HTMLElement;
  let submitPending = false;
  const submitMessage = async (): Promise<void> => {
    if (submitPending) return;
    submitPending = true;
    try {
      await sendMessage(context, messageInput, sendButton, attachmentsPreview);
    } finally {
      submitPending = false;
    }
  };
  const turnQueue = container.querySelector(
    "#chat-turn-queue",
  ) as HTMLElement | null;

  disposers.push(
    sessionTurnQueue.subscribe((sessionId) => {
      const session = chatManager.getActiveSession();
      if (session?.id !== sessionId) return;
      syncSendButtonState(sendButton, chatManager);
      context.renderMessages(session.messages);
    }),
  );
  syncSendButtonState(sendButton, chatManager);

  turnQueue?.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest(
      "button[data-queue-action]",
    ) as HTMLButtonElement | null;
    const session = chatManager.getActiveSession();
    const turnId = button?.getAttribute("data-turn-id");
    const action = button?.getAttribute("data-queue-action");
    if (!session || !turnId || !action) return;

    if (action === "delete") {
      sessionTurnQueue.remove(session.id, turnId);
      return;
    }
    if (action === "edit") {
      const draft = context.getAttachmentState();
      if (
        messageInput.value.trim() ||
        draft.pendingImages.length ||
        draft.pendingFiles.length ||
        draft.pendingSelectedText ||
        draft.pendingQuotedMessages.length
      ) {
        context.appendError(getString("chat-queue-draft-conflict"));
        return;
      }
      const turn = sessionTurnQueue.remove(session.id, turnId);
      if (!turn) return;
      messageInput.value = turn.draft.content;
      context.setAttachmentState(turn.draft.attachmentState);
      context.updateAttachmentsPreview();
      resizeMessageInput(messageInput, chatHistory);
      focusTextarea(messageInput);
      return;
    }
    if (action === "guide") {
      void sessionTurnQueue.guide(session.id, turnId).catch((error) => {
        context.appendError(
          error instanceof Error ? error.message : String(error),
        );
      });
    }
  });

  if (chatHistory) {
    chatHistory.addEventListener("scroll", () => {
      updateChatHistoryAutoScrollState(chatHistory);
    });
    updateChatHistoryScrollBottomButton(chatHistory);
  }

  scrollBottomBtn?.addEventListener("click", () => {
    if (!chatHistory) return;
    scrollChatHistoryToBottom(chatHistory);
  });

  // History dropdown state
  const historyState = createHistoryDropdownState();
  let historySearchDisposer: (() => void) | null = null;
  const historyIntegration = { disposed: false };
  let historyBackfillStarted = false;
  let historyNavigationToken = 0;
  let historyNavigationTail: Promise<void> = Promise.resolve();
  let pendingHistoryMessageTarget: {
    sessionId: string;
    messageId: string;
    navigationToken: number;
  } | null = null;
  let historyNotice: HTMLElement | null = null;
  let historyNoticeTimer: ReturnType<typeof setTimeout> | null = null;

  const clearHistoryNotice = (): void => {
    if (historyNoticeTimer) {
      clearTimeout(historyNoticeTimer);
      historyNoticeTimer = null;
    }
    historyNotice?.remove();
    historyNotice = null;
  };

  const showHistoryNotice = (message: string): void => {
    const doc = container.ownerDocument;
    if (!doc || historyIntegration.disposed) return;
    clearHistoryNotice();
    const theme = getCurrentTheme();
    const notice = createElement(
      doc,
      "div",
      {
        position: "absolute",
        top: "58px",
        left: "16px",
        right: "16px",
        zIndex: "10010",
        padding: "9px 12px",
        border: `1px solid ${theme.borderColor}`,
        borderRadius: "8px",
        background: theme.dropdownBg,
        color: theme.textPrimary,
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.2)",
        fontSize: "12px",
        lineHeight: "18px",
        textAlign: "center",
        pointerEvents: "none",
      },
      {
        class: "chat-history-search-local-notice",
        role: "status",
        "aria-live": "polite",
      },
    );
    notice.textContent = message;
    container.appendChild(notice);
    historyNotice = notice;
    historyNoticeTimer = setTimeout(clearHistoryNotice, 2800);
  };

  const showHistoryTargetMissingNotice = (): void => {
    showHistoryNotice(getString("chat-history-search-target-missing"));
  };

  const invalidateHistoryNavigation = (): void => {
    historyNavigationToken += 1;
    pendingHistoryMessageTarget = null;
    clearHistoryNotice();
  };

  const reportHistoryNavigationError = (error: unknown): void => {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = rawMessage.trim() || getString("unknown");
    ztoolkit.log("[ChatPanel] History navigation/search error:", error);
    showHistoryNotice(message);
  };

  const openHistorySession = (
    sessionId: string,
    target?: { messageId: string },
  ): Promise<void> => {
    const navigationToken = ++historyNavigationToken;
    clearHistoryNotice();
    pendingHistoryMessageTarget = target
      ? { sessionId, messageId: target.messageId, navigationToken }
      : null;
    if (historyDropdown) historyDropdown.style.display = "none";

    const operation = historyNavigationTail.then(async () => {
      if (
        historyIntegration.disposed ||
        navigationToken !== historyNavigationToken
      ) {
        return;
      }

      ztoolkit.log("Loading session:", sessionId);
      const loadedSession = await chatManager.switchSession(sessionId);
      if (
        historyIntegration.disposed ||
        navigationToken !== historyNavigationToken
      ) {
        return;
      }
      if (!loadedSession) {
        pendingHistoryMessageTarget = null;
        if (target) showHistoryTargetMissingNotice();
        return;
      }

      clearPendingQuotedMessages(context);

      syncSendButtonState(sendButton, chatManager);
      const itemKey = loadedSession.lastActiveItemKey;
      if (itemKey) {
        const libraryID = Zotero.Libraries.userLibraryID;
        const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
        if (item) {
          context.setCurrentItem(item as Zotero.Item);
          await context.updatePdfCheckboxVisibility(item as Zotero.Item);
        } else {
          context.setCurrentItem(null);
          await context.updatePdfCheckboxVisibility(null);
        }
      } else {
        context.setCurrentItem(null);
        await context.updatePdfCheckboxVisibility(null);
      }

      if (
        historyIntegration.disposed ||
        navigationToken !== historyNavigationToken
      ) {
        return;
      }

      const activeSession = chatManager.getActiveSession() || loadedSession;
      context.renderMessages(activeSession.messages);
      context.renderExecutionPlan(activeSession.executionPlan);
      updateModelSelectorDisplay(container);

      const renderFinalSession = (): void => {
        if (
          historyIntegration.disposed ||
          navigationToken !== historyNavigationToken
        ) {
          return;
        }
        const latestSession = chatManager.getActiveSession();
        if (!latestSession || latestSession.id !== sessionId) {
          pendingHistoryMessageTarget = null;
          return;
        }

        context.renderMessages(latestSession.messages, () => {
          const pendingTarget = pendingHistoryMessageTarget;
          if (
            !target ||
            !pendingTarget ||
            historyIntegration.disposed ||
            navigationToken !== historyNavigationToken ||
            pendingTarget.navigationToken !== navigationToken ||
            pendingTarget.sessionId !== sessionId ||
            pendingTarget.messageId !== target.messageId
          ) {
            return;
          }

          const found = chatHistory
            ? scrollToAndHighlightMessage(chatHistory, target.messageId)
            : null;
          pendingHistoryMessageTarget = null;
          if (!found) showHistoryTargetMissingNotice();
        });
        context.renderExecutionPlan(latestSession.executionPlan);
        updateModelSelectorDisplay(container);
      };

      const view = container.ownerDocument?.defaultView;
      if (view && typeof view.requestAnimationFrame === "function") {
        view.requestAnimationFrame(renderFinalSession);
      } else {
        setTimeout(renderFinalSession, 0);
      }
    });

    historyNavigationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation.catch((error) => {
      if (navigationToken === historyNavigationToken) {
        pendingHistoryMessageTarget = null;
      }
      throw error;
    });
  };

  if (historyDropdown && container.ownerDocument) {
    historySearchDisposer = setupHistoryDropdownSearch(
      historyDropdown,
      container.ownerDocument,
      historyState,
      getCurrentTheme(),
      {
        searchGroups: (input) => chatManager.searchHistoryGroups(input),
        searchSessionMatches: (input) =>
          chatManager.searchHistorySessionMatches(input),
        onSelectTitleMatch: (sessionId) => openHistorySession(sessionId),
        onSelectMessageMatch: (sessionId, messageId) =>
          openHistorySession(sessionId, { messageId }),
        onSearchError: reportHistoryNavigationError,
      },
    );
  }

  // Check-in button
  checkinBtn?.addEventListener("click", async () => {
    if (checkinBtn.disabled) return;
    checkinBtn.disabled = true;
    checkinBtn.textContent = "...";

    let result;
    try {
      result = await authManager.doCheckin();
    } catch (error) {
      getAnalyticsService().track(ANALYTICS_EVENTS.signInCompleted, {
        success: false,
        ...buildErrorProps(mapSignInReason(error), error),
      });
      setCheckinButtonReadyState(checkinBtn);
      return;
    }

    if (result.success) {
      const rewardCount = result.quotaAwarded || undefined;
      getAnalyticsService().track(ANALYTICS_EVENTS.signInCompleted, {
        success: true,
        ...(rewardCount !== undefined ? { reward_count: rewardCount } : {}),
      });

      try {
        await authManager.refreshUserInfo();
        updateUserBarDisplay(container, authManager);
      } catch (error) {
        ztoolkit.log(
          "[ChatPanel] Failed to refresh balance after check-in:",
          error,
        );
      }

      // Flash "+quota" for 5 s, then settle into the checked-in state
      if (result.quotaAwarded) {
        checkinBtn.textContent = `+${result.quotaAwarded}`;
        setTimeout(() => {
          void refreshCheckinDisplay(container, authManager).catch((error) => {
            ztoolkit.log(
              "[ChatPanel] Failed to refresh check-in state:",
              error,
            );
            setCheckinButtonCheckedInState(checkinBtn);
          });
        }, CHECKIN_FLASH_DURATION_MS);
      } else {
        try {
          await refreshCheckinDisplay(container, authManager);
        } catch (error) {
          ztoolkit.log("[ChatPanel] Failed to refresh check-in state:", error);
          setCheckinButtonCheckedInState(checkinBtn);
        }
      }
      return;
    }

    const reason = mapSignInReason(result.message);
    getAnalyticsService().track(ANALYTICS_EVENTS.signInCompleted, {
      success: false,
      ...buildErrorProps(reason, result.message),
    });
    setCheckinButtonReadyState(checkinBtn);
  });

  // Fetch check-in status on init if already logged in
  if (authManager.isLoggedIn()) {
    refreshCheckinDisplay(container, authManager);
  }

  // User action button - login/logout
  userActionBtn?.addEventListener("click", async () => {
    ztoolkit.log("User action button clicked");
    if (authManager.isLoggedIn()) {
      await authManager.logout();
      context.updateUserBar();
    } else {
      const success = await showAuthDialog("login");
      if (success) {
        context.updateUserBar();
        refreshCheckinDisplay(container, authManager);
      }
    }
  });

  // Send button
  sendButton?.addEventListener("click", async () => {
    ztoolkit.log("Send button clicked");
    const activeSession = chatManager.getActiveSession();
    if (
      activeSession &&
      sessionTurnQueue.snapshot(activeSession.id).status === "running" &&
      !messageInput.value.trim()
    ) {
      await sessionTurnQueue.stop(activeSession.id);
      syncSendButtonState(sendButton, chatManager);
      focusTextarea(messageInput);
      return;
    }
    await submitMessage();
  });

  // Input keydown - Enter sends now or queues behind the active turn.
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
      ztoolkit.log("Enter key pressed to send");
      void submitMessage();
    }
  });

  // Input auto-resize
  messageInput?.addEventListener("input", () => {
    resizeMessageInput(messageInput, chatHistory);
    syncSendButtonState(sendButton, chatManager);
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

  resizeMessageInput(messageInput, chatHistory);

  // New chat button - create a new session
  newChatBtn?.addEventListener("click", async () => {
    ztoolkit.log("New chat button clicked");
    invalidateHistoryNavigation();

    // Create a new session
    const newSession = await chatManager.createNewSession();

    // The new session has its own queue state.
    syncSendButtonState(sendButton, chatManager);

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

    context.renderMessages(newSession.messages);
    context.renderExecutionPlan(newSession.executionPlan);
    updateModelSelectorDisplay(container);

    ztoolkit.log("New session created:", newSession.id);
  });

  summarizeConversationBtn?.addEventListener("click", async () => {
    if (summarizeConversationBtn.disabled) {
      return;
    }
    const sessionId = chatManager.getActiveSession()?.id;
    const runToken = Symbol(sessionId);
    conversationSummaryRuns.set(summarizeConversationBtn, runToken);
    summarizeConversationBtn.disabled = true;
    summarizeConversationBtn.setAttribute("aria-busy", "true");
    if (sessionId) {
      summarizeConversationBtn.setAttribute(
        "data-summary-session-id",
        sessionId,
      );
    }
    summarizeConversationBtn.style.cursor = "wait";
    summarizeConversationBtn.style.opacity = "0.6";
    try {
      await context.summarizeConversationToNote();
    } catch (error) {
      context.appendError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (conversationSummaryRuns.get(summarizeConversationBtn) === runToken) {
        resetConversationSummaryButtonBusyState(summarizeConversationBtn);
      }
    }
  });

  debugContextBtn?.addEventListener("click", async () => {
    const originalText = debugContextBtn.textContent || "CTX";
    debugContextBtn.disabled = true;
    debugContextBtn.textContent = "...";
    let resetImmediately = true;
    try {
      const filePath = await chatManager.exportCurrentDebugContext(
        context.getCurrentItem(),
      );
      copyToClipboard(filePath);
      debugContextBtn.textContent = "\u2713";
      debugContextBtn.title = getString("chat-debug-context-exported");
      resetImmediately = false;
      setTimeout(() => {
        debugContextBtn.textContent = originalText;
        debugContextBtn.title = getString("chat-debug-context-export");
        debugContextBtn.disabled = false;
      }, 1600);
    } catch (error) {
      context.appendError(
        error instanceof Error ? error.message : String(error),
      );
      debugContextBtn.textContent = originalText;
    } finally {
      if (resetImmediately) {
        debugContextBtn.disabled = false;
      }
    }
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
          context.setAttachmentState(attachmentState);
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
          context.setAttachmentState(attachmentState);
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

    if (!historyBackfillStarted) {
      historyBackfillStarted = true;
      chatManager.startSearchHistoryBackfill();
    }

    // Populate ordinary history first. For an active query the dropdown keeps
    // its cached groups/scroll position visible while this refresh runs.
    await refreshHistoryDropdown();
  });

  // Helper function to refresh history dropdown
  const refreshHistoryDropdown = async () => {
    if (!historyDropdown || historyIntegration.disposed) return;

    const sessions = await chatManager.getAllSessions();
    if (historyIntegration.disposed) return;
    const theme = getCurrentTheme();

    populateHistoryDropdown(
      historyDropdown,
      container.ownerDocument!,
      sessions,
      historyState,
      theme,
      // onSelect callback
      (session: SessionInfo) => {
        void openHistorySession(session.id).catch(reportHistoryNavigationError);
      },
      // onDelete callback
      async (session: SessionInfo) => {
        ztoolkit.log("Deleting session:", session.id);
        const deletingActiveSession =
          chatManager.getActiveSession()?.id === session.id;
        sessionTurnQueue.clear(session.id);
        await chatManager.deleteSession(session.id);
        if (deletingActiveSession) {
          clearPendingQuotedMessages(context);
        }

        const activeSession = chatManager.getActiveSession();
        const itemKey = activeSession?.lastActiveItemKey;
        if (itemKey) {
          const libraryID = Zotero.Libraries.userLibraryID;
          const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
          if (item) {
            context.setCurrentItem(item as Zotero.Item);
            await context.updatePdfCheckboxVisibility(item as Zotero.Item);
          } else {
            context.setCurrentItem(null);
            await context.updatePdfCheckboxVisibility(null);
          }
        } else {
          context.setCurrentItem(null);
          await context.updatePdfCheckboxVisibility(null);
        }

        if (activeSession) {
          context.renderMessages(activeSession.messages);
        } else if (chatHistory && emptyState) {
          chatHistory.textContent = "";
          chatHistory.appendChild(emptyState);
          emptyState.style.display = "flex";
          updateConversationNoteSummaryButton(container, [], undefined, false);
        }
        updateModelSelectorDisplay(container);
        syncSendButtonState(sendButton, chatManager);

        // Refresh the dropdown to reflect the deletion
        await refreshHistoryDropdown();
      },
      async (session: SessionInfo, title: string | null) => {
        await chatManager.updateSessionTitle(session.id, title, "user");
        await refreshHistoryDropdown();
      },
    );

    // Empty/short queries remain on the ordinary list. An active query keeps
    // cached results visible and refreshes against the latest revision. A
    // hidden dropdown keeps its cache without doing foreground search work.
    if (historyDropdown.style.display !== "none") {
      await refreshHistoryDropdownSearch(historyDropdown);
    }
  };

  chatManager.setSessionListUpdateCallback(refreshHistoryDropdown);

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
    const ownerDoc = container.ownerDocument;
    const closeModelDropdownOnOutsideClick = (e: Event): void => {
      const target = e.target as HTMLElement;
      if (
        !modelSelectorBtn.contains(target) &&
        !modelDropdown.contains(target)
      ) {
        modelDropdown.style.display = "none";
      }
    };
    ownerDoc?.addEventListener("click", closeModelDropdownOnOutsideClick);
    disposers.push(() =>
      ownerDoc?.removeEventListener("click", closeModelDropdownOnOutsideClick),
    );
  }

  // Settings button - open preferences
  const settingsBtn = container.querySelector(
    "#chat-settings-btn",
  ) as HTMLButtonElement;
  if (settingsBtn) {
    settingsBtn.addEventListener("click", () => {
      ztoolkit.log("Settings button clicked");
      openPluginPreferencesSafely();
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
      openPluginPreferencesSafely();
    });

    // Hover effect
    userBarSettingsBtn.addEventListener("mouseenter", () => {
      userBarSettingsBtn.style.background = "rgba(255, 255, 255, 0.3)";
    });
    userBarSettingsBtn.addEventListener("mouseleave", () => {
      userBarSettingsBtn.style.background = "rgba(255, 255, 255, 0.15)";
    });
  }

  const userBalanceEl = container.querySelector(
    "#chat-user-balance",
  ) as HTMLElement;
  if (userBalanceEl) {
    const openLowBalanceTopup = () => {
      if (userBalanceEl.getAttribute("data-low-balance-clickable") !== "true") {
        return;
      }
      getAnalyticsService().track(ANALYTICS_EVENTS.paperChatLowBalanceClicked, {
        source: "chat_user_bar_balance",
        low_balance: true,
      });
      getAnalyticsService().track(
        ANALYTICS_EVENTS.paperChatPurchaseEntryClicked,
        {
          source: "chat_user_bar_balance",
          low_balance: true,
        },
      );
      void import("../../preferences/UserAuthUI")
        .then((module) => module.openPaperChatSettingsForTopup())
        .catch((error) => {
          ztoolkit.log(
            "[Chat] Failed to open PaperChat settings for low balance:",
            error,
          );
          Zotero.Utilities.Internal.openPreferences("paperchat-prefpane");
        });
    };
    userBalanceEl.addEventListener("click", openLowBalanceTopup);
    userBalanceEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      openLowBalanceTopup();
    });
  }

  const userSubscriptionEl = container.querySelector(
    "#chat-user-subscription",
  ) as HTMLElement;
  if (userSubscriptionEl) {
    const openSubscriptionTopup = () => {
      if (
        userSubscriptionEl.getAttribute("data-subscription-limit-clickable") !==
        "true"
      ) {
        return;
      }
      getAnalyticsService().track(
        ANALYTICS_EVENTS.paperChatPurchaseEntryClicked,
        {
          source: "chat_user_bar_subscription",
        },
      );
      void import("../../preferences/UserAuthUI")
        .then((module) => module.openPaperChatSettingsForTopup())
        .catch((error) => {
          ztoolkit.log(
            "[Chat] Failed to open PaperChat settings for subscription limit:",
            error,
          );
          Zotero.Utilities.Internal.openPreferences("paperchat-prefpane");
        });
    };
    userSubscriptionEl.addEventListener("click", openSubscriptionTopup);
    userSubscriptionEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      openSubscriptionTopup();
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
  disposers.push(setupMentionSelector(context));

  ztoolkit.log("Event listeners attached to buttons");

  return () => {
    if (historyIntegration.disposed) return;
    historyIntegration.disposed = true;
    invalidateHistoryNavigation();
    historySearchDisposer?.();
    historySearchDisposer = null;
    clearHistoryNotice();
    disposers.forEach((dispose) => dispose());
    disposers.length = 0;
  };
}

/**
 * Update attachments preview display
 */
export function updateAttachmentsPreviewDisplay(
  container: HTMLElement,
  attachmentState: AttachmentState,
  actions: AttachmentPreviewActions = {},
): void {
  const attachmentsPreview = container.querySelector(
    "#chat-attachments-preview",
  ) as HTMLElement;
  if (!attachmentsPreview) return;

  attachmentsPreview.textContent = "";
  const doc = container.ownerDocument!;
  const theme = getCurrentTheme();

  const createTag = (): HTMLElement =>
    createElement(doc, "span", {
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      minWidth: "0",
      maxWidth: "100%",
      background: theme.inputBg,
      border: `1px solid ${theme.borderColor}`,
      borderRadius: "6px",
      padding: "4px 8px",
      fontSize: "11px",
      color: theme.textSecondary,
    });

  const createLabel = (text: string): HTMLElement => {
    const label = createElement(doc, "span", {
      minWidth: "0",
      overflow: "hidden",
      whiteSpace: "nowrap",
      textOverflow: "ellipsis",
    });
    label.textContent = text;
    return label;
  };

  const createRemoveButton = (
    label: string,
    onRemove: () => void,
  ): HTMLElement => {
    const removeBtn = createElement(
      doc,
      "button",
      {
        flex: "0 0 auto",
        width: "18px",
        height: "18px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        padding: "0",
        cursor: "pointer",
        fontSize: "12px",
        color: theme.textSecondary,
        opacity: "0.7",
        lineHeight: "1",
      },
      { type: "button", "aria-label": label },
    );
    removeBtn.textContent = "x";
    removeBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onRemove();
    });
    removeBtn.addEventListener("mouseenter", () => {
      removeBtn.style.opacity = "1";
    });
    removeBtn.addEventListener("mouseleave", () => {
      removeBtn.style.opacity = "0.7";
    });
    return removeBtn;
  };

  attachmentState.pendingQuotedMessages.forEach((quote, index) => {
    const tag = createTag();
    tag.setAttribute("class", "pending-quoted-message");
    tag.setAttribute("data-quoted-message-id", quote.messageId);
    tag.setAttribute("title", quote.preview);
    tag.appendChild(
      createLabel(`${getString("chat-quoted-reply")}: ${quote.preview}`),
    );
    if (actions.onRemoveQuote) {
      tag.appendChild(
        createRemoveButton(getString("chat-remove-quoted-reply"), () =>
          actions.onRemoveQuote?.(index),
        ),
      );
    }
    if (actions.onNavigateQuote) {
      tag.setAttribute("role", "button");
      tag.setAttribute("tabindex", "0");
      tag.style.cursor = "pointer";
      const navigate = () => {
        void Promise.resolve(actions.onNavigateQuote?.(quote)).catch(
          (error: unknown) => {
            ztoolkit.log("[ChatPanel] Quote navigation failed:", error);
          },
        );
      };
      tag.addEventListener("click", navigate);
      tag.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        navigate();
      });
    }
    attachmentsPreview.appendChild(tag);
  });

  if (attachmentState.pendingSelectedText) {
    const tag = createTag();
    tag.appendChild(createLabel("Selection"));
    attachmentsPreview.appendChild(tag);
  }

  const getImageSrc = (image: ImageAttachment): string =>
    image.type === "base64"
      ? `data:${image.mimeType};base64,${image.data}`
      : image.data;

  attachmentState.pendingImages.forEach((image, index) => {
    const tag = createTag();
    tag.setAttribute("class", "pending-image-attachment");
    tag.appendChild(
      createElement(
        doc,
        "img",
        {
          flex: "0 0 auto",
          width: "32px",
          height: "32px",
          borderRadius: "4px",
          objectFit: "cover",
          background: theme.buttonBg,
        },
        {
          src: getImageSrc(image),
          alt: image.name || "Attached image",
          title: image.name || "Attached image",
        },
      ),
    );
    tag.appendChild(createLabel(image.name || "image"));
    if (actions.onRemoveImage) {
      tag.appendChild(
        createRemoveButton(`Remove ${image.name || "image"}`, () =>
          actions.onRemoveImage?.(index),
        ),
      );
    }
    attachmentsPreview.appendChild(tag);
  });

  for (const file of attachmentState.pendingFiles) {
    const tag = createTag();
    tag.appendChild(createLabel(file.name));
    attachmentsPreview.appendChild(tag);
  }

  const attachmentCount =
    attachmentState.pendingQuotedMessages.length +
    attachmentState.pendingImages.length +
    attachmentState.pendingFiles.length +
    (attachmentState.pendingSelectedText ? 1 : 0);
  attachmentsPreview.style.display = attachmentCount > 0 ? "flex" : "none";
}

function renderTurnQueue(container: HTMLElement, sessionId?: string): void {
  const queue = container.querySelector(
    "#chat-turn-queue",
  ) as HTMLElement | null;
  if (!queue) return;

  const turns = sessionId ? sessionTurnQueue.snapshot(sessionId).queued : [];
  queue.textContent = "";
  queue.style.display = turns.length ? "flex" : "none";

  const theme = getCurrentTheme();
  for (const turn of turns) {
    const row = createElement(queue.ownerDocument, "div", {
      display: "flex",
      alignItems: "center",
      minHeight: "20px",
      padding: "1px 0",
      gap: "4px",
      color: theme.textSecondary,
      fontSize: "11px",
    });
    const preview = createElement(queue.ownerDocument, "span", {
      flex: "1",
      minWidth: "0",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });
    preview.textContent = turn.content;
    preview.title = turn.content;
    row.appendChild(preview);

    for (const [action, label] of [
      ["edit", getString("chat-queue-edit")],
      ["guide", getString("chat-queue-guide")],
      ["delete", getString("chat-queue-delete")],
    ] as const) {
      const button = createElement(
        queue.ownerDocument,
        "button",
        {
          flex: "0 0 auto",
          padding: "1px 2px",
          border: "none",
          background: "transparent",
          color: theme.textSecondary,
          cursor: "pointer",
          fontSize: "11px",
        },
        {
          type: "button",
          title: label,
          "aria-label": label,
          "data-turn-id": turn.id,
          "data-queue-action": action,
        },
      );
      button.textContent = label;
      row.appendChild(button);
    }
    queue.appendChild(row);
  }
}

function updateSendButtonPresentation(
  sendButton: HTMLButtonElement,
  isRunning: boolean,
): void {
  const icon = sendButton.querySelector(
    "#chat-send-icon",
  ) as HTMLElement | null;
  sendButton.disabled = false;
  sendButton.style.opacity = "1";
  sendButton.style.cursor = "pointer";
  sendButton.title = isRunning
    ? getString("chat-stop-generating")
    : getString("chat-send");
  sendButton.setAttribute("aria-label", sendButton.title);

  if (!icon) {
    return;
  }

  if (icon.tagName.toLowerCase() === "img") {
    const imageIcon = icon as HTMLElement;
    if (isRunning) {
      imageIcon.removeAttribute("src");
      imageIcon.style.display = "flex";
      imageIcon.style.alignItems = "center";
      imageIcon.style.justifyContent = "center";
      imageIcon.style.width = "12px";
      imageIcon.style.height = "12px";
      imageIcon.style.background = "currentColor";
      imageIcon.style.borderRadius = "2px";
    } else {
      imageIcon.setAttribute(
        "src",
        `chrome://${config.addonRef}/content/icons/send.svg`,
      );
      imageIcon.style.display = "block";
      imageIcon.style.width = "16px";
      imageIcon.style.height = "16px";
      imageIcon.style.background = "";
      imageIcon.style.borderRadius = "";
    }
    return;
  }

  icon.textContent = isRunning ? "■" : "↑";
  icon.style.fontSize = isRunning ? "12px" : "16px";
  icon.style.fontWeight = "700";
}

export function syncSendButtonState(
  sendButton: HTMLButtonElement | null,
  chatManager: ChatPanelContext["chatManager"],
): void {
  if (!sendButton) return;
  const activeSession = chatManager.getActiveSession();
  const root = sendButton.closest(".chat-panel-root") as HTMLElement | null;
  const input = root?.querySelector(
    "#chat-message-input",
  ) as HTMLTextAreaElement | null;
  const isRunning = activeSession
    ? sessionTurnQueue.snapshot(activeSession.id).status === "running"
    : false;
  updateSendButtonPresentation(sendButton, isRunning && !input?.value.trim());
  if (root) renderTurnQueue(root, activeSession?.id);
}

function createTurnRunner(options: {
  manager: ChatPanelContext["chatManager"];
  resolveSession: () => ChatSession;
  send: (session: ChatSession) => Promise<boolean>;
}): () => Promise<TurnRunResult> {
  const run = async (retryErrorId?: string): Promise<TurnRunResult> => {
    const session = options.resolveSession();
    const previousErrorIds = new Set(
      session.messages
        .filter((message) => message.role === "error")
        .map((message) => message.id),
    );
    const accepted = retryErrorId
      ? await options.manager.retryFailedTurn(session.id, retryErrorId)
      : await options.send(session);
    if (!accepted) return { accepted: false };

    const error = [...options.resolveSession().messages]
      .reverse()
      .find(
        (message) =>
          message.role === "error" && !previousErrorIds.has(message.id),
      );
    return error
      ? {
          accepted: true,
          errorId: error.id,
          retry: () => run(error.id),
        }
      : { accepted: true };
  };
  return () => run();
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
  const { chatManager, authManager } = context;
  const chatHistory = context.container.querySelector(
    "#chat-history",
  ) as HTMLElement | null;
  const session = chatManager.getActiveSession();
  if (!session) return;

  try {
    const content = messageInput?.value?.trim();
    if (!content) return;

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
          try {
            await chatManager.showErrorMessage(
              getString("chat-error-session-expired"),
            );
          } catch (error) {
            context.appendError(
              error instanceof Error ? error.message : String(error),
            );
          }
          // Prompt login again
          const success = await showAuthDialog("login");
          if (!success) {
            return;
          }
          context.updateUserBar();
          // Check again after re-login
          if (!activeProvider?.isReady()) {
            try {
              await chatManager.showErrorMessage(
                getString("chat-error-no-provider"),
              );
            } catch (error) {
              context.appendError(
                error instanceof Error ? error.message : String(error),
              );
            }
            return;
          }
        }
      }
    } else if (!activeProvider?.isReady()) {
      ztoolkit.log("Provider not ready:", activeProviderId);
      throw new Error(getString("chat-error-no-provider"));
    }

    const attachmentState = context.getAttachmentState();
    const shouldAttachPdf = activeReaderItem !== null;
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
      quotedMessages:
        attachmentState.pendingQuotedMessages.length > 0
          ? attachmentState.pendingQuotedMessages
          : undefined,
    };

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

    let retainedSession = session;
    const resolveSession = () => {
      const current = chatManager.getActiveSession();
      if (current?.id === session.id) retainedSession = current;
      return retainedSession;
    };
    const run = createTurnRunner({
      manager: chatManager,
      resolveSession,
      send: async (targetSession) => {
        const accepted = await chatManager.sendMessage(content, {
          item: targetItem,
          attachPdf: shouldAttachPdf,
          targetSession,
          ...attachmentOptions,
        });
        if (accepted) {
          getReadingLoopService().handleChatMessageSent(content, targetItem);
        }
        return accepted;
      },
    });
    const turn: QueuedTurn = {
      id: `${Date.now()}-${++queuedTurnSequence}`,
      content,
      draft: { content, attachmentState },
      run,
      cancel: () => chatManager.cancelSessionTurn(session.id),
      onError: (error) => {
        if (chatManager.getActiveSession()?.id === session.id) {
          context.appendError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    };
    if (!sessionTurnQueue.enqueue(session.id, turn)) {
      const queueFullMessage = getString("chat-queue-full");
      const queueFullMessageExists = Array.from(
        context.container.querySelectorAll(
          ".error-message-wrapper .message-content",
        ),
      ).some((element) => element?.textContent === `⚠️ ${queueFullMessage}`);
      if (!queueFullMessageExists) {
        context.appendError(queueFullMessage);
      }
      return;
    }

    if (messageInput) {
      messageInput.value = "";
      resizeMessageInput(messageInput, chatHistory);
    }
    context.clearAttachments();
    context.updateAttachmentsPreview();
  } catch (error) {
    ztoolkit.log("Error in sendMessage:", error);
    context.appendError(error instanceof Error ? error.message : String(error));
  } finally {
    syncSendButtonState(sendButton, chatManager);
    focusTextarea(messageInput);
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
    getBalance(): { quota: number; usedQuota: number };
    formatBalance(): string;
    getSubscriptionUsageSummary(): SubscriptionUsageSummary | null;
  },
): void {
  const userBar = container.querySelector("#chat-user-bar") as HTMLElement;
  const userNameEl = container.querySelector("#chat-user-name") as HTMLElement;
  const userSubscriptionEl = container.querySelector(
    "#chat-user-subscription",
  ) as HTMLElement;
  const userSubscriptionTotalEl = container.querySelector(
    "#chat-user-subscription-total",
  ) as HTMLElement;
  const userSubscriptionProgressFillEl = container.querySelector(
    "#chat-user-subscription-progress-fill",
  ) as HTMLElement;
  const userBalanceEl = container.querySelector(
    "#chat-user-balance",
  ) as HTMLElement;
  const userActionBtn = container.querySelector(
    "#chat-user-action-btn",
  ) as HTMLButtonElement;
  const userBarSettingsBtn = container.querySelector(
    "#chat-user-bar-settings-btn",
  ) as HTMLButtonElement;
  const checkinBtn = container.querySelector(
    "#chat-checkin-btn",
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
    const isLowBalance =
      authManager.getBalance().quota < LOW_BALANCE_WARNING_THRESHOLD;
    const subscriptionUsage = authManager.getSubscriptionUsageSummary();
    const shouldHideTokenBalance =
      !!subscriptionUsage &&
      subscriptionUsage.amountRemaining > LOW_BALANCE_WARNING_THRESHOLD;
    userNameEl.textContent = user?.username || "";
    if (userSubscriptionEl) {
      if (
        subscriptionUsage &&
        userSubscriptionTotalEl &&
        userSubscriptionProgressFillEl
      ) {
        userSubscriptionTotalEl.textContent = getString(
          "user-panel-subscription",
          {
            args: { total: subscriptionUsage.amountTotalLabel },
          },
        );
        userSubscriptionProgressFillEl.style.width = `${subscriptionUsage.percentUsed}%`;
        const usageLabel = `${getString("user-panel-used")}: ${subscriptionUsage.amountUsedLabel} / ${subscriptionUsage.amountTotalLabel}`;
        userSubscriptionEl.title = usageLabel;
        userSubscriptionEl.setAttribute("aria-label", usageLabel);
        if (subscriptionUsage.percentUsed >= 99) {
          applySubscriptionLimitStyles(userSubscriptionEl);
        } else {
          resetSubscriptionLimitStyles(userSubscriptionEl);
        }
        userSubscriptionEl.style.display = "flex";
      } else {
        if (userSubscriptionTotalEl) {
          userSubscriptionTotalEl.textContent = "";
        }
        if (userSubscriptionProgressFillEl) {
          userSubscriptionProgressFillEl.style.width = "0%";
        }
        userSubscriptionEl.removeAttribute("title");
        userSubscriptionEl.removeAttribute("aria-label");
        resetSubscriptionLimitStyles(userSubscriptionEl);
        userSubscriptionEl.style.display = "none";
      }
    }
    if (shouldHideTokenBalance) {
      userBalanceEl.textContent = "";
      userBalanceEl.style.display = "none";
      resetUserBalanceLowBalanceStyles(userBalanceEl);
    } else {
      userBalanceEl.style.display = "inline";
      userBalanceEl.textContent = `${getString("user-panel-balance")}: ${authManager.formatBalance()}`;
    }
    if (!shouldHideTokenBalance && isLowBalance) {
      applyUserBalanceLowBalanceStyles(userBalanceEl);
    } else {
      resetUserBalanceLowBalanceStyles(userBalanceEl);
    }
    userActionBtn.textContent = getString("user-panel-logout-btn");
    // Hide settings button when logged in
    if (userBarSettingsBtn) {
      userBarSettingsBtn.style.display = "none";
    }
    // Check-in button visibility is owned by refreshCheckinDisplay (respects enabled flag).
    // Do NOT force-show it here — that would override the server's enabled:false response.
  } else {
    userNameEl.textContent = getString("user-panel-not-logged-in");
    if (userSubscriptionEl) {
      if (userSubscriptionTotalEl) {
        userSubscriptionTotalEl.textContent = "";
      }
      if (userSubscriptionProgressFillEl) {
        userSubscriptionProgressFillEl.style.width = "0%";
      }
      userSubscriptionEl.removeAttribute("title");
      userSubscriptionEl.removeAttribute("aria-label");
      resetSubscriptionLimitStyles(userSubscriptionEl);
      userSubscriptionEl.style.display = "none";
    }
    userBalanceEl.textContent = "";
    userBalanceEl.style.display = "inline";
    resetUserBalanceLowBalanceStyles(userBalanceEl);
    userActionBtn.textContent = getString("user-panel-login-btn");
    // Show settings button when not logged in
    if (userBarSettingsBtn) {
      userBarSettingsBtn.style.display = "flex";
    }
    // Hide check-in button when not logged in
    if (checkinBtn) {
      checkinBtn.style.display = "none";
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
  focusTextarea(messageInput);
}

/**
 * Update model selector display with current model
 */
export function updateModelSelectorDisplay(container: HTMLElement): void {
  const modelSelectorText = container.querySelector(
    "#chat-model-selector-text",
  ) as HTMLElement | null;
  if (!modelSelectorText) {
    return;
  }

  const providerManager = getProviderManager();
  const activeProvider = providerManager.getActiveProvider();
  if (!activeProvider) {
    modelSelectorText.textContent = getString("chat-select-model");
    return;
  }

  if (providerManager.getActiveProviderId() !== "paperchat") {
    const currentModel = getPref("model") as string;
    if (currentModel) {
      const modelShort = formatModelLabel(
        currentModel,
        providerManager.getActiveProviderId() || undefined,
      );
      modelSelectorText.textContent = `${activeProvider.getName()}: ${modelShort}`;
    } else {
      modelSelectorText.textContent = activeProvider.getName();
    }
    return;
  }

  const tierState = parseTierState(
    getPref("paperchatTierState") as string | undefined,
  );
  const session = getChatManager().getActiveSession();
  const paperchatConfig = providerManager.getProviderConfig(
    "paperchat",
  ) as PaperChatProviderConfig | null;
  const availableModels = paperchatConfig?.availableModels ?? [];
  const tierPools = deriveTierPools(
    availableModels,
    getModelRatios(),
    getModelRoutingMeta(),
  );
  const requestedTier = session?.selectedTier || tierState.selectedTier;
  const visibleTiers = getAvailablePaperChatTiers(tierPools);
  const tier = visibleTiers.includes(requestedTier)
    ? requestedTier
    : (visibleTiers[0] ?? requestedTier);
  const tierEntry = tierState.tiers[tier];
  // Mirror the availability check in paperchat-session-routing.ts so the
  // displayed model stays in sync with what the next request will actually use.
  const effectiveModel =
    tierEntry.mode === "manual" &&
    tierEntry.modelId &&
    availableModels.includes(tierEntry.modelId)
      ? tierEntry.modelId
      : session?.resolvedModelId;
  const tierLabel = getPaperChatTierLabel(tier);

  modelSelectorText.textContent = effectiveModel
    ? `PaperChat: ${tierLabel} · ${effectiveModel}`
    : `PaperChat: ${tierLabel}`;
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
  dropdown.style.overflowX = "hidden";
  dropdown.style.overflowY = "auto";

  const providerManager = getProviderManager();
  const providers = providerManager.getConfiguredProviders();
  const activeProviderId = providerManager.getActiveProviderId();

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

    if (config.id === "paperchat") {
      const tierState = parseTierState(
        getPref("paperchatTierState") as string | undefined,
      );
      const session = context.chatManager.getActiveSession();
      const selectedTier = session?.selectedTier || tierState.selectedTier;
      const tierPools = deriveTierPools(
        models,
        getModelRatios(),
        getModelRoutingMeta(),
      );
      type PaperChatSubmenuEntry = {
        submenu: HTMLElement;
        arrow: HTMLElement;
        arrowIcon: HTMLElement;
        tierItem: HTMLElement;
        isSelected: boolean;
      };
      const submenuEntries: PaperChatSubmenuEntry[] = [];

      const switchPaperChatSelection = async (
        tier: PaperChatTier,
        mode: "tier" | "auto" | "manual",
        modelId: string | null = null,
      ) => {
        const previousTierState = parseTierState(
          getPref("paperchatTierState") as string | undefined,
        );
        const previousActiveProviderId = providerManager.getActiveProviderId();
        const currentTier =
          previousActiveProviderId === "paperchat"
            ? context.chatManager.getActiveSession()?.selectedTier ||
              previousTierState.selectedTier
            : "paperchat-standard";
        const previousEntry = previousTierState.tiers[tier];
        const nextTierState = {
          ...previousTierState,
          selectedTier: tier,
          tiers: {
            ...previousTierState.tiers,
            [tier]:
              mode === "manual" && modelId
                ? { mode: "manual" as const, modelId }
                : mode === "auto"
                  ? { mode: "auto" as const, modelId: null }
                  : previousEntry,
          },
        };

        if (shouldWarnForPaperChatTierSwitch(currentTier, tier)) {
          const confirmed = await confirmHighConsumptionTierSwitch(doc, tier);
          if (!confirmed) {
            dropdown.style.display = "none";
            return;
          }
        }

        try {
          if (!isActiveProvider) {
            await context.chatManager.clearCurrentSessionPaperChatRetryableState();
            providerManager.setActiveProvider(config.id);
          }

          setPref("paperchatTierState", JSON.stringify(nextTierState));
          await context.chatManager.switchCurrentSessionPaperChatTier(
            tier,
            mode === "manual" ? modelId : mode === "auto" ? null : undefined,
          );

          const activeSession = context.chatManager.getActiveSession();
          if (activeSession) {
            context.renderMessages(activeSession.messages);
          }

          trackChatModelSwitched({
            source: mode === "tier" ? "tier_dropdown" : "tier_model_submenu",
            previous_provider: previousActiveProviderId || "unknown",
            provider: "paperchat",
            previous_tier: previousTierState.selectedTier,
            tier,
            selection_mode: mode,
            previous_model: previousEntry.modelId || "",
            model: modelId || "",
          });

          updateModelSelectorDisplay(container);
          dropdown.style.display = "none";
          context.updateUserBar();
        } catch (error) {
          setPref("paperchatTierState", JSON.stringify(previousTierState));
          if (
            previousActiveProviderId &&
            previousActiveProviderId !== config.id
          ) {
            providerManager.setActiveProvider(previousActiveProviderId);
          }
          updateModelSelectorDisplay(container);
          context.updateUserBar();
          context.appendError(
            error instanceof Error ? error.message : String(error),
          );
        }
      };

      const setPaperChatSubmenuExpanded = (
        entry: PaperChatSubmenuEntry,
        expanded: boolean,
      ) => {
        entry.submenu.style.display = expanded ? "block" : "none";
        entry.arrowIcon.style.transform = expanded
          ? "rotate(180deg)"
          : "rotate(0deg)";
        entry.tierItem.style.background =
          expanded || entry.isSelected
            ? theme.dropdownItemHoverBg
            : "transparent";
      };

      for (const tier of PAPERCHAT_TIERS) {
        const tierEntry = tierState.tiers[tier];
        const tierModels = tierPools[tier] || [];
        if (tierModels.length === 0) {
          continue;
        }
        const isSelectedTier = isActiveProvider && selectedTier === tier;
        const isManualSelection =
          tierEntry.mode === "manual" &&
          tierEntry.modelId !== null &&
          tierModels.includes(tierEntry.modelId);

        const tierGroup = createElement(doc, "div", {
          borderBottom: `1px solid ${theme.borderColor}`,
        });
        const tierRow = createElement(doc, "div", {
          display: "flex",
          alignItems: "stretch",
        });
        const tierItem = createElement(doc, "button", {
          padding: "8px 12px",
          fontSize: "12px",
          color: isSelectedTier
            ? theme.inputFocusBorderColor
            : theme.textPrimary,
          cursor: "pointer",
          background: isSelectedTier
            ? theme.dropdownItemHoverBg
            : "transparent",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          flex: "1",
          minWidth: "0",
          border: "none",
          textAlign: "left",
        });
        tierItem.setAttribute("type", "button");
        if (isSelectedTier) {
          const check = createElement(doc, "span", {
            color: theme.inputFocusBorderColor,
            fontWeight: "bold",
          });
          check.textContent = "✓";
          tierItem.appendChild(check);
        }
        const label = createElement(doc, "span", {
          flex: "1",
          minWidth: "0",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        });
        label.textContent = getPaperChatTierDropdownLabel(tier);
        tierItem.appendChild(label);
        const arrow = createElement(doc, "button", {
          fontSize: "10px",
          opacity: "0.6",
          color: theme.textSecondary,
          cursor: "pointer",
          background: isSelectedTier
            ? theme.dropdownItemHoverBg
            : "transparent",
          border: "none",
          width: "32px",
          flex: "0 0 32px",
          padding: "0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        });
        arrow.setAttribute("type", "button");
        arrow.setAttribute(
          "aria-label",
          getString("chat-tier-models", {
            args: { tier: getPaperChatTierLabel(tier) },
          }),
        );
        const arrowIcon = createElement(doc, "img", {
          width: "14px",
          height: "14px",
          display: "block",
          pointerEvents: "none",
          transition: "transform 0.12s ease",
        });
        arrowIcon.setAttribute(
          "src",
          `chrome://${addon.data.config.addonRef}/content/icons/down.svg`,
        );
        arrow.appendChild(arrowIcon);

        const submenu = createElement(doc, "div", {
          display: "none",
          maxHeight: "180px",
          overflowY: "auto",
          padding: "4px 0 6px 0",
          background: theme.dropdownBg,
          borderTop: `1px solid ${theme.borderColor}`,
        });

        const submenuEntry: PaperChatSubmenuEntry = {
          submenu,
          arrow,
          arrowIcon,
          tierItem,
          isSelected: isSelectedTier,
        };
        submenuEntries.push(submenuEntry);
        if (isSelectedTier) {
          setPaperChatSubmenuExpanded(submenuEntry, true);
        }

        arrow.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const shouldExpand = submenu.style.display === "none";
          for (const entry of submenuEntries) {
            setPaperChatSubmenuExpanded(entry, false);
          }
          setPaperChatSubmenuExpanded(submenuEntry, shouldExpand);
        });
        tierItem.addEventListener("focus", () => {
          tierItem.style.outline = `2px solid ${theme.inputFocusBorderColor}`;
          tierItem.style.outlineOffset = "-2px";
        });
        tierItem.addEventListener("blur", () => {
          tierItem.style.outline = "none";
          tierItem.style.outlineOffset = "0";
          if (!isSelectedTier) {
            tierItem.style.background = "transparent";
          }
        });
        tierItem.addEventListener("click", async () => {
          if (isSelectedTier) {
            dropdown.style.display = "none";
            return;
          }
          await switchPaperChatSelection(tier, "tier");
        });

        tierRow.appendChild(tierItem);
        tierRow.appendChild(arrow);
        tierGroup.appendChild(tierRow);

        const autoItem = createElement(doc, "button", {
          padding: "7px 12px 7px 28px",
          fontSize: "12px",
          color:
            isSelectedTier && !isManualSelection
              ? theme.inputFocusBorderColor
              : theme.textPrimary,
          cursor: "pointer",
          background:
            isSelectedTier && !isManualSelection
              ? theme.dropdownItemHoverBg
              : "transparent",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          width: "100%",
          border: "none",
          textAlign: "left",
        });
        autoItem.setAttribute("type", "button");
        if (isSelectedTier && !isManualSelection) {
          const check = createElement(doc, "span", {
            color: theme.inputFocusBorderColor,
            fontWeight: "bold",
          });
          check.textContent = "✓";
          autoItem.appendChild(check);
        }
        const autoLabel = createElement(doc, "span", {});
        autoLabel.textContent = getString("pref-paperchat-model-auto");
        autoItem.appendChild(autoLabel);
        autoItem.addEventListener("mouseenter", () => {
          if (!isSelectedTier || isManualSelection) {
            autoItem.style.background = theme.dropdownItemHoverBg;
          }
        });
        autoItem.addEventListener("mouseleave", () => {
          if (!isSelectedTier || isManualSelection) {
            autoItem.style.background = "transparent";
          }
        });
        autoItem.addEventListener("click", async () => {
          if (isSelectedTier && !isManualSelection) {
            dropdown.style.display = "none";
            return;
          }
          await switchPaperChatSelection(tier, "auto");
        });
        submenu.appendChild(autoItem);

        for (const model of tierModels) {
          const isCurrentModel =
            isSelectedTier &&
            tierEntry.mode === "manual" &&
            tierEntry.modelId === model;
          const modelItem = createElement(doc, "button", {
            padding: "7px 12px 7px 28px",
            fontSize: "12px",
            color: isCurrentModel
              ? theme.inputFocusBorderColor
              : theme.textPrimary,
            cursor: "pointer",
            background: isCurrentModel
              ? theme.dropdownItemHoverBg
              : "transparent",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            width: "100%",
            border: "none",
            textAlign: "left",
          });
          modelItem.setAttribute("type", "button");
          if (isCurrentModel) {
            const check = createElement(doc, "span", {
              color: theme.inputFocusBorderColor,
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
          modelItem.addEventListener("click", async () => {
            if (isCurrentModel) {
              dropdown.style.display = "none";
              return;
            }
            await switchPaperChatSelection(tier, "manual", model);
          });
          submenu.appendChild(modelItem);
        }

        tierGroup.appendChild(submenu);
        dropdown.appendChild(tierGroup);
      }
      continue;
    }

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
        const currentModel = getPref("model") as string;
        const isCurrentModel = isActiveProvider && model === currentModel;

        const modelItem = createElement(doc, "div", {
          padding: "8px 12px",
          fontSize: "12px",
          color: isCurrentModel
            ? theme.inputFocusBorderColor
            : theme.textPrimary,
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
            color: theme.inputFocusBorderColor,
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
        modelItem.addEventListener("click", async () => {
          const previousProviderId = providerManager.getActiveProviderId();
          const previousModel = getPref("model") as string | undefined;
          const leavingPaperChat =
            previousProviderId === "paperchat" && config.id !== "paperchat";

          try {
            if (leavingPaperChat) {
              await context.chatManager.clearCurrentSessionPaperChatRetryableState();
              const paperchatProvider =
                providerManager.getProvider("paperchat");
              paperchatProvider?.updateConfig({
                resolvedModelOverride: undefined,
              });
            }

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

            trackChatModelSwitched({
              source: "model_dropdown",
              previous_provider: previousProviderId || "unknown",
              provider: config.id,
              previous_model: previousModel || "",
              model,
            });

            // Update display and close dropdown
            updateModelSelectorDisplay(container);
            dropdown.style.display = "none";

            // Update user bar (provider might have changed)
            context.updateUserBar();

            ztoolkit.log(`Model switched to: ${config.id}/${model}`);
          } catch (error) {
            context.appendError(
              error instanceof Error ? error.message : String(error),
            );
          }
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
 * Selected resource will be inserted as @[title](key:XXX)
 */
function setupMentionSelector(context: ChatPanelContext): () => void {
  const { container } = context;
  const theme = getCurrentTheme();

  const messageInput = container.querySelector(
    "#chat-message-input",
  ) as HTMLTextAreaElement;
  const mentionPopup = container.querySelector(
    "#chat-mention-popup",
  ) as HTMLElement;

  if (!messageInput || !mentionPopup) {
    ztoolkit.log("[MentionSelector] Required elements not found");
    return () => {};
  }

  // Create and initialize the MentionSelector
  const mentionSelector = new MentionSelector(
    mentionPopup,
    theme,
    (resource: MentionResource) => {
      if (editingMentionRange) {
        // Replace existing mention
        replaceMentionInInput(messageInput, editingMentionRange, resource);
        editingMentionRange = null;
      } else {
        // Insert new mention
        insertMentionIntoInput(messageInput, resource);
      }
      ztoolkit.log(
        `[MentionSelector] Selected: ${resource.type}/${resource.key} - ${resource.title}`,
      );
    },
  );

  // Track the position where @ was typed
  let mentionStartPos = -1;
  // Track if we're editing an existing @[...] mention
  let editingMentionRange: { start: number; end: number } | null = null;
  // Track if we're in IME composition mode
  let isComposing = false;

  // Helper to close popup and reset state
  const closeMentionPopup = () => {
    mentionSelector.hide();
    mentionStartPos = -1;
    editingMentionRange = null;
  };

  // Check if cursor is inside an existing @[...] mention and reopen popup
  const checkCursorInMention = async () => {
    if (mentionSelector.isVisible()) return;
    const cursorPos = messageInput.selectionStart;
    const text = messageInput.value;
    const mention = findMentionAtCursor(text, cursorPos);
    if (!mention) return;

    editingMentionRange = { start: mention.start, end: mention.end };
    mentionStartPos = mention.start + 1;
    try {
      await mentionSelector.show();
      // Verify edit mode wasn't cancelled while loading resources
      if (editingMentionRange) {
        mentionSelector.filterImmediate(mention.title);
      }
    } catch {
      // Resource loading failed, reset state
      closeMentionPopup();
    }
  };

  // Helper function to update filter based on current input state
  const updateMentionFilter = (immediate: boolean = false) => {
    if (!mentionSelector.isVisible()) return;

    const cursorPos = messageInput.selectionStart;
    const text = messageInput.value;
    const beforeCursor = text.substring(0, cursorPos);
    const atPos = beforeCursor.lastIndexOf("@");

    // @ was deleted or cursor moved before @
    if (atPos === -1 || (mentionStartPos >= 0 && atPos < mentionStartPos - 1)) {
      closeMentionPopup();
      return;
    }

    // Extract query after @
    const query = beforeCursor.substring(atPos + 1);

    // If query contains space or newline, close popup (user finished mention)
    if (/[\s\n]/.test(query)) {
      closeMentionPopup();
      return;
    }

    // Update filter
    if (immediate) {
      mentionSelector.filterImmediate(query);
    } else {
      mentionSelector.filter(query);
    }
  };

  // Handle IME composition events (for Chinese/Japanese/Korean input)
  messageInput.addEventListener("compositionstart", () => {
    isComposing = true;
  });

  messageInput.addEventListener("compositionend", () => {
    isComposing = false;
    // After IME composition ends, update filter with the composed text
    if (mentionSelector.isVisible()) {
      updateMentionFilter(true); // immediate update for IME
    }
  });

  // Handle input events - detect @ typing
  messageInput.addEventListener("input", (e: Event) => {
    const inputEvent = e as InputEvent;
    const cursorPos = messageInput.selectionStart;

    // If editing an existing mention and user types, close popup
    if (editingMentionRange && mentionSelector.isVisible()) {
      closeMentionPopup();
      // Fall through to check if user typed a new @
    }

    // Skip filter updates during IME composition (wait for compositionend)
    if (isComposing) {
      // Only trigger popup for explicit @ input during composition, and only if not already visible
      if (!mentionSelector.isVisible() && inputEvent.data === "@") {
        mentionStartPos = cursorPos;
        mentionSelector.show();
      }
      return;
    }

    // Check if @ was just typed (and popup not already visible)
    if (inputEvent.data === "@" && !mentionSelector.isVisible()) {
      mentionStartPos = cursorPos;
      mentionSelector.show();
      return;
    }

    // If popup is visible, update the filter
    if (mentionSelector.isVisible()) {
      updateMentionFilter(false);
    }
  });

  // Handle keydown events for mention navigation and shortcuts
  messageInput.addEventListener("keydown", (e: KeyboardEvent) => {
    // Cmd+Backspace (Mac) or Ctrl+Backspace (Windows) to delete @[...] mention
    if (e.key === "Backspace" && (e.metaKey || e.ctrlKey)) {
      const cursorPos = messageInput.selectionStart;
      const text = messageInput.value;
      const mention = findMentionAtCursor(text, cursorPos);
      if (mention) {
        e.preventDefault();
        e.stopPropagation();
        // Close popup first to prevent input event side effects
        if (mentionSelector.isVisible()) {
          closeMentionPopup();
        }
        // Delete the mention and any trailing space
        let deleteEnd = mention.end;
        if (text[deleteEnd] === " ") deleteEnd++;
        const before = text.substring(0, mention.start);
        const after = text.substring(deleteEnd);
        messageInput.value = before + after;
        messageInput.setSelectionRange(mention.start, mention.start);
        // Trigger input event for auto-resize
        messageInput.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
    }

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
        editingMentionRange = null;
        break;

      case "Tab":
        e.preventDefault();
        e.stopPropagation();
        mentionSelector.selectCurrent();
        mentionStartPos = -1;
        editingMentionRange = null;
        break;

      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        closeMentionPopup();
        break;

      case "ArrowLeft":
      case "ArrowRight":
      case "Home":
      case "End":
        if (editingMentionRange) {
          // In edit mode: close popup if cursor leaves the mention
          setTimeout(() => {
            const pos = messageInput.selectionStart;
            const txt = messageInput.value;
            const m = findMentionAtCursor(txt, pos);
            if (!m) {
              closeMentionPopup();
            }
          }, 0);
        } else {
          // Normal mode: update filter after cursor moves
          setTimeout(() => updateMentionFilter(true), 0);
        }
        break;
    }
  });

  // Handle mouse clicks that might change cursor position
  messageInput.addEventListener("click", () => {
    if (mentionSelector.isVisible()) {
      setTimeout(() => {
        if (editingMentionRange) {
          // In edit mode: keep popup open if cursor is still in the mention
          const cursorPos = messageInput.selectionStart;
          const text = messageInput.value;
          const mention = findMentionAtCursor(text, cursorPos);
          if (!mention) {
            closeMentionPopup();
          }
        } else {
          updateMentionFilter(true);
        }
      }, 0);
    } else {
      // Check if cursor landed inside an existing mention
      setTimeout(() => checkCursorInMention(), 0);
    }
  });

  // Close popup when clicking outside
  const ownerDoc = container.ownerDocument;
  const closeMentionOnOutsideClick = (e: Event): void => {
    const target = e.target as HTMLElement;
    if (
      mentionSelector.isVisible() &&
      !mentionPopup.contains(target) &&
      target !== messageInput
    ) {
      closeMentionPopup();
    }
  };
  ownerDoc?.addEventListener("click", closeMentionOnOutsideClick);

  // Close popup when input loses focus (with small delay to allow popup clicks)
  messageInput.addEventListener("blur", () => {
    setTimeout(() => {
      if (mentionSelector.isVisible() && !mentionPopup.matches(":hover")) {
        closeMentionPopup();
      }
    }, 150);
  });

  // Detect cursor movement into existing mentions (via arrow keys)
  messageInput.addEventListener("keyup", (e: KeyboardEvent) => {
    if (mentionSelector.isVisible()) return;
    if (
      [
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "Backspace",
        "Delete",
      ].includes(e.key)
    ) {
      checkCursorInMention();
    }
  });

  ztoolkit.log("[MentionSelector] Setup complete");

  return () =>
    ownerDoc?.removeEventListener("click", closeMentionOnOutsideClick);
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

  // Build the mention text with key for AI
  const mentionText = `@[${resource.title}](key:${resource.key}) `;

  // Replace @query with @[title](key:xxx)
  const beforeAt = text.substring(0, atPos);
  const afterCursor = text.substring(cursorPos);

  input.value = beforeAt + mentionText + afterCursor;

  // Move cursor after the mention
  const newCursorPos = atPos + mentionText.length;
  input.setSelectionRange(newCursorPos, newCursorPos);
  focusTextarea(input);

  // Trigger input event for auto-resize
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Replace an existing @[...] mention in the input with a new resource
 */
function replaceMentionInInput(
  input: HTMLTextAreaElement,
  range: { start: number; end: number },
  resource: MentionResource,
): void {
  const text = input.value;
  const mentionText = `@[${resource.title}](key:${resource.key}) `;
  const before = text.substring(0, range.start);
  // Skip trailing space after the old mention if present
  let afterStart = range.end;
  if (text[afterStart] === " ") afterStart++;
  const after = text.substring(afterStart);

  input.value = before + mentionText + after;

  // Move cursor after the new mention
  const newCursorPos = range.start + mentionText.length;
  input.setSelectionRange(newCursorPos, newCursorPos);
  focusTextarea(input);

  // Trigger input event for auto-resize
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
