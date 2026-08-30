/**
 * ChatPanelManager - Main panel lifecycle and coordination
 */

import { config } from "../../../../package.json";
import { getString } from "../../../utils/locale";
import { ChatManager, type ChatMessage, type ChatSession } from "../../chat";
import { stopExistingSearchBackfillForShutdown } from "../../chat/search/SearchBackfillShutdown";
import type {
  ExecutionPlan,
  ImageAttachment,
  FileAttachment,
  QuotedMessageRef,
  ToolApprovalState,
} from "../../../types/chat";
import type {
  RequestUserInputResponse,
  ToolApprovalResolution,
} from "../../../types/tool";
import { getAuthManager } from "../../auth";
import { getProviderManager } from "../../providers";
import { providerSupportsToolCalling } from "../../providers/provider-capabilities";
import { isPaperChatQuotaError } from "../../providers/paperchat-errors";
import { getPref, setPref } from "../../../utils/prefs";
import {
  createNoteSummaryContext,
  type NoteSummarySourceItem,
} from "../../chat/note-summary-destination";
import { normalizeSourceItemKeys } from "../../chat/note-source-provenance";
import { isPathInsidePresentationRoot } from "../../presentation";
import {
  getSingleSelectedPresentationPaper,
  launchPresentationForItem,
  resolvePresentationPaperFromCandidates,
} from "../../presentation/PresentationEntry";
import {
  isPresentationSessionCompatibleWithPaper,
  presentationLaunchRequiresActiveSession,
  selectPresentationSession,
} from "../../presentation/PresentationSessionPolicy";
import { createPresentationLaunchAuthorization } from "../../presentation/PresentationLaunchAuthorization";
import type { PresentationLaunchSettings } from "../../presentation/PresentationLaunchSettings";

import { HTML_NS, type AttachmentState, type ChatPanelContext } from "./types";
import { chatColors } from "../../../utils/colors";
import {
  getCurrentTheme,
  updateCurrentTheme,
  applyThemeToContainer,
  setupThemeListener,
} from "./ChatPanelTheme";
import { createChatContainer } from "./ChatPanelBuilder";
import {
  ensureStreamingTypingIndicator,
  getMessageMarkdownRenderOptions,
  getStreamingContentSelector,
  getStreamingReasoningContainerSelector,
  getStreamingReasoningSelector,
  renderMessages as renderMessageElementsBase,
  scrollChatHistoryToBottom,
  scrollToAndHighlightMessage,
  shouldAutoScrollChatHistory,
  updateChatHistoryScrollBottomButton,
  updateExecutionPlanView,
  updateApprovalView,
  updateUserInputRequestView,
  type ApprovalViewTransitionState,
} from "./MessageRenderer";
import {
  type MarkdownRenderOptions,
  type SourceGroupActionContext,
  formatMarkdownForMessageCopy,
  renderMarkdownToElement,
  stripIncompleteTrailingToolCall,
} from "./MarkdownRenderer";
import { getDataPath } from "../../../utils/common";
import {
  buildReplyNoteSummaryPrompt,
  canSummarizeAssistantReply,
  collectNoteSummarySourceItemKeys,
  hasConversationMessages,
  resolveNoteSummarySourceItem,
} from "./NoteSummaryActions";
import {
  appendPendingQuotedMessage,
  canQuoteAssistantReply,
  createQuotedMessageRef,
} from "../../chat/quoted-messages";
import { navigateToPdfQuote } from "./PdfQuoteNavigator";
import { normalizeNoteSourceKey } from "./NoteSourceNavigator";
import { sessionTurnQueue } from "./SessionTurnQueue";
import { openSourceTarget, type SourceTarget } from "./SourceNavigator";
import {
  setupEventHandlers,
  updateAttachmentsPreviewDisplay,
  updateUserBarDisplay,
  updatePdfCheckboxVisibilityForItem,
  focusInput,
  setActiveReaderItemFn,
  setTogglePanelModeFn,
  updatePanelModeButtonIcon,
  updateModelSelectorDisplay,
  refreshCheckinDisplay,
  syncSendButtonState,
  syncSessionNavigationState,
  updateConversationNoteSummaryButton,
} from "./ChatPanelEvents";
import { loadCachedRatios } from "../../preferences/ModelsFetcher";
import { Guide } from "../Guide";
import { ANALYTICS_EVENTS, getAnalyticsService } from "../../analytics";
import { refreshPaperChatNotice } from "../../providers/PaperChatNoticeService";
import {
  getReadingLoopService,
  type ReadingLoopSnapshot,
  type ReadingLoopState,
  type ReadingSuggestion,
} from "../../reading-loop";
import { bindReadingLoopToolbarButtonEvents } from "./ReadingLoopToolbarEvents";
import {
  NextQuestionHintController,
  requestNextQuestionHintAfterRecentRender,
} from "./NextQuestionHintController";
import { cancelReaderFigureScreenshot } from "../ReaderFigureScreenshot";
import {
  getResolvedImageInputAvailability,
  MAX_PENDING_IMAGE_ATTACHMENTS,
  MAX_PENDING_IMAGE_BYTES,
  MAX_PENDING_IMAGE_DRAFT_BYTES,
  refreshImageInputAvailability,
} from "./imageAttachmentPolicy";

// Panel display mode: 'sidebar' or 'floating'
export type PanelMode = "sidebar" | "floating";
export type ChatPanelOpenSource =
  | "menu"
  | "toolbar"
  | "reader_selection"
  | "reader_annotation"
  | "library_scope"
  | "ai_summary"
  | "presentation_menu"
  | "presentation_button"
  | "unknown";

const APPROVAL_RESOLVED_ANIMATION_MS = 260;
const APPROVAL_ENTER_ANIMATION_MS = 220;
const STREAMING_TEXT_RENDER_INTERVAL_MS = 80;
const STREAMING_MARKDOWN_RENDER_INTERVAL_MS = 1200;
const STREAMING_TEXT_TAIL_ATTR = "data-streaming-text-tail";
type PendingApprovalRequest = ToolApprovalState["pendingRequests"][number];

type ApprovalPanelTransitionEntry = ApprovalViewTransitionState & {
  sessionId: string | null;
  timeoutId?: number;
};

const approvalPanelTransitions = new WeakMap<
  HTMLElement,
  ApprovalPanelTransitionEntry
>();

type StreamingTextRenderState = {
  messageId: string;
  pendingContent: string;
  lastRenderedContent: string;
  lastMarkdownContent: string;
  lastPresentationArtifactSignature: string;
  lastRenderAt: number;
  lastMarkdownRenderAt: number;
  timeoutId: ReturnType<typeof setTimeout> | null;
};

function getPresentationArtifactSignature(message: ChatMessage): string {
  return JSON.stringify(
    (message.presentationArtifacts || []).map((artifact) => ({
      toolCallId: artifact.toolCallId,
      localId: artifact.localId,
      path: artifact.path,
      previewPaths: artifact.previewPaths,
      attachmentItemID: artifact.attachmentItemID,
      isDraft: artifact.isDraft,
    })),
  );
}

const streamingTextRenderStates = new WeakMap<
  HTMLElement,
  StreamingTextRenderState
>();
const quotedMessageNavigationGenerations = new WeakMap<HTMLElement, number>();

function cancelPendingStreamingTextRender(container: HTMLElement): void {
  const state = streamingTextRenderStates.get(container);
  if (!state) return;
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
  }
  streamingTextRenderStates.delete(container);
}

function shouldForceStreamingMarkdownRender(
  content: string,
  state: StreamingTextRenderState,
): boolean {
  if (!content.includes("<tool-call")) {
    return false;
  }

  if (stripIncompleteTrailingToolCall(content) !== content) {
    return true;
  }

  if (!state.lastMarkdownContent) {
    return true;
  }

  const incrementalContent = content.startsWith(state.lastMarkdownContent)
    ? content.slice(state.lastMarkdownContent.length)
    : content;

  return (
    incrementalContent.includes("<tool-call") ||
    incrementalContent.includes("</tool-call>")
  );
}

function renderStreamingTextNow(
  container: HTMLElement,
  manager: ChatManager,
  state: StreamingTextRenderState,
  content: string,
  messageId: string,
  markdownOptions: MarkdownRenderOptions,
): boolean {
  const activeMessage = manager
    .getActiveSession()
    ?.messages.find((message) => message.id === messageId);
  if (
    !activeMessage ||
    activeMessage.role !== "assistant" ||
    activeMessage.streamingState !== "in_progress"
  ) {
    return false;
  }

  const streamingEl = container.querySelector(
    getStreamingContentSelector(messageId),
  ) as HTMLElement | null;
  if (!streamingEl) {
    return false;
  }

  const contentReplacedAfterMarkdownRender =
    Boolean(state.lastMarkdownContent) &&
    !content.startsWith(state.lastMarkdownContent);
  if (contentReplacedAfterMarkdownRender) {
    state.lastMarkdownContent = "";
  }

  const now = Date.now();
  const presentationArtifactSignature =
    getPresentationArtifactSignature(activeMessage);
  const shouldRenderMarkdown =
    contentReplacedAfterMarkdownRender ||
    presentationArtifactSignature !== state.lastPresentationArtifactSignature ||
    shouldForceStreamingMarkdownRender(content, state) ||
    now - state.lastMarkdownRenderAt >= STREAMING_MARKDOWN_RENDER_INTERVAL_MS;

  if (shouldRenderMarkdown) {
    const activeMarkdownOptions =
      getMessageMarkdownRenderOptions(
        markdownOptions,
        activeMessage.streamingState,
        activeMessage.evidence,
        activeMessage.presentationArtifacts,
      ) || markdownOptions;
    renderMarkdownToElement(
      streamingEl,
      content,
      messageId,
      activeMarkdownOptions,
    );
    const tail = streamingEl.ownerDocument.createElement("span");
    tail.setAttribute(STREAMING_TEXT_TAIL_ATTR, "true");
    streamingEl.appendChild(tail);
    state.lastMarkdownContent = content;
    state.lastPresentationArtifactSignature = presentationArtifactSignature;
    state.lastMarkdownRenderAt = now;
  } else if (state.lastMarkdownContent) {
    let tail = streamingEl.querySelector(
      `[${STREAMING_TEXT_TAIL_ATTR}]`,
    ) as HTMLElement | null;
    if (!tail) {
      tail = streamingEl.ownerDocument.createElement("span");
      tail.setAttribute(STREAMING_TEXT_TAIL_ATTR, "true");
      streamingEl.appendChild(tail);
    }
    tail.textContent = content.slice(state.lastMarkdownContent.length);
  } else if (streamingEl.textContent !== content) {
    streamingEl.textContent = content;
  }

  ensureStreamingTypingIndicator(streamingEl, getCurrentTheme());

  if (state.lastRenderedContent !== content) {
    const chatHistory = container.querySelector(
      "#chat-history",
    ) as HTMLElement | null;
    if (chatHistory && shouldAutoScrollChatHistory(chatHistory)) {
      scrollChatHistoryToBottom(chatHistory);
    } else if (chatHistory) {
      updateChatHistoryScrollBottomButton(chatHistory);
    }
  }
  state.lastRenderedContent = content;
  return true;
}

function scheduleStreamingTextRender(
  container: HTMLElement,
  manager: ChatManager,
  content: string,
  messageId: string,
  markdownOptions: MarkdownRenderOptions,
): void {
  let state = streamingTextRenderStates.get(container);
  if (!state || state.messageId !== messageId) {
    cancelPendingStreamingTextRender(container);
    state = {
      messageId,
      pendingContent: content,
      lastRenderedContent: "",
      lastMarkdownContent: "",
      lastPresentationArtifactSignature: "",
      lastRenderAt: 0,
      lastMarkdownRenderAt: 0,
      timeoutId: null,
    };
    streamingTextRenderStates.set(container, state);
  }

  state.pendingContent = content;
  const activeMessage = manager
    .getActiveSession()
    ?.messages.find((message) => message.id === messageId);
  const presentationArtifactChanged =
    activeMessage?.role === "assistant" &&
    getPresentationArtifactSignature(activeMessage) !==
      state.lastPresentationArtifactSignature;
  if (
    state.pendingContent === state.lastRenderedContent &&
    !presentationArtifactChanged
  ) {
    return;
  }

  const render = () => {
    const latestState = streamingTextRenderStates.get(container);
    if (!latestState || latestState.messageId !== messageId) {
      return;
    }
    latestState.timeoutId = null;
    const nextContent = latestState.pendingContent;
    if (
      !renderStreamingTextNow(
        container,
        manager,
        latestState,
        nextContent,
        messageId,
        markdownOptions,
      )
    ) {
      streamingTextRenderStates.delete(container);
      return;
    }
    latestState.lastRenderAt = Date.now();
  };

  const elapsed = Date.now() - state.lastRenderAt;
  if (elapsed >= STREAMING_TEXT_RENDER_INTERVAL_MS) {
    if (state.timeoutId) {
      clearTimeout(state.timeoutId);
      state.timeoutId = null;
    }
    render();
    return;
  }

  if (!state.timeoutId) {
    state.timeoutId = setTimeout(
      render,
      STREAMING_TEXT_RENDER_INTERVAL_MS - elapsed,
    );
  }
}

interface ChatMarkdownActionContext {
  getCurrentItem: () => Zotero.Item | null;
  appendError?: (message: string) => void;
  enableSourceActions?: boolean;
}

function getSourceTarget(group: SourceGroupActionContext): SourceTarget | null {
  const type = group.type.trim().toLowerCase();
  if (type === "web") {
    return group.url?.trim() ? { type: "web", url: group.url } : null;
  }

  const key = normalizeNoteSourceKey(group.key);
  if (!key) {
    return null;
  }

  switch (type) {
    case "paper":
    case "item":
      return { type: "item", key, page: group.page };
    case "note":
      return { type: "note", key };
    case "annotation":
      return { type: "annotation", key };
    case "collection":
      return { type: "collection", key };
    default:
      return null;
  }
}

function createChatMarkdownRenderOptions(
  context: ChatMarkdownActionContext,
): MarkdownRenderOptions {
  return {
    isTrustedPresentationPreviewPath,
    presentationArtifactAction: {
      openLabel: getString("chat-presentation-open"),
      draftLabel: getString("chat-presentation-open-draft"),
      onOpen: async (artifact) => {
        let filePath = artifact.path || "";
        if (artifact.attachmentItemID) {
          const attachment = await Zotero.Items.getAsync(
            artifact.attachmentItemID,
          );
          const attachmentPath = await attachment?.getFilePathAsync?.();
          if (attachmentPath) filePath = attachmentPath;
        }
        if (!isTrustedPresentationPath(filePath)) {
          throw new Error("PaperChat rejected an untrusted PPTX path.");
        }
        if (!(await IOUtils.exists(filePath))) {
          throw new Error("The generated PPTX is no longer available.");
        }
        Zotero.launchFile(filePath);
      },
      onError: (error) => {
        ztoolkit.log("[ChatPanel] Failed to open presentation:", error);
        context.appendError?.(
          `${getString("chat-presentation-open-failed")}: ${error.message}`,
        );
      },
    },
    blockquoteAction: {
      label: getString("chat-jump-to-quote"),
      title: getString("chat-jump-to-quote-title"),
      onClick: async (quoteText, sourceGroup) => {
        try {
          const sourceTarget = sourceGroup
            ? getSourceTarget(sourceGroup)
            : null;
          if (sourceTarget?.type === "annotation") {
            await openSourceTarget(sourceTarget);
            return;
          }

          const sourceItem =
            sourceTarget?.type === "item"
              ? getItemByLibraryKey(sourceTarget.key)
              : null;
          if (sourceTarget?.type === "item" && !sourceItem) {
            await openSourceTarget(sourceTarget);
            return;
          }

          const navigated = await navigateToPdfQuote(
            quoteText,
            sourceItem || context.getCurrentItem(),
            {
              allowActiveReaderFallback: sourceTarget?.type !== "item",
              fallbackPageIndex:
                sourceTarget?.type === "item" && sourceTarget.page
                  ? sourceTarget.page - 1
                  : undefined,
            },
          );
          if (!navigated && sourceTarget?.type === "item") {
            await openSourceTarget(sourceTarget);
          }
        } catch (error) {
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          ztoolkit.log("[ChatPanel] Failed to open quoted source:", normalized);
          context.appendError?.(
            `${getString("chat-open-source-failed")}: ${normalized.message}`,
          );
        }
      },
    },
    evidenceAction: {
      citationTitle: getString("chat-evidence-citation-title"),
      viewSourceLabel: getString("chat-evidence-view-source"),
      onClick: async (record) => {
        const target: SourceTarget = {
          type: "item",
          key: record.itemKey,
          libraryID: record.libraryID,
          page: record.page,
        };
        const sourceItem = getItemByLibraryKey(
          record.itemKey,
          record.libraryID,
        );
        if (!sourceItem) {
          await openSourceTarget(target);
          return;
        }
        const navigated = await navigateToPdfQuote(record.quote, sourceItem, {
          allowActiveReaderFallback: false,
          fallbackPageIndex: record.page ? record.page - 1 : undefined,
        });
        if (!navigated) {
          await openSourceTarget(target);
        }
      },
      onError: (error) => {
        ztoolkit.log("[ChatPanel] Failed to open evidence source:", error);
        context.appendError?.(
          `${getString("chat-open-source-failed")}: ${error.message}`,
        );
      },
    },
    sourceGroupAction:
      context.enableSourceActions === false
        ? undefined
        : {
            getTitle: (group) => {
              const target = getSourceTarget(group);
              if (!target) {
                return null;
              }
              return target.type === "note"
                ? getString("chat-open-note")
                : getString("chat-open-source");
            },
            onClick: async (group) => {
              const target = getSourceTarget(group);
              if (!target) {
                throw new Error("This source does not have a valid target.");
              }
              await openSourceTarget(target);
            },
            onError: (error) => {
              ztoolkit.log("[ChatPanel] Failed to open source:", error);
              context.appendError?.(
                `${getString("chat-open-source-failed")}: ${error.message}`,
              );
            },
          },
  };
}

function isTrustedPresentationPath(filePath: string): boolean {
  if (
    !filePath ||
    !PathUtils.isAbsolute(filePath) ||
    !/\.pptx$/i.test(filePath)
  ) {
    return false;
  }
  const roots = [
    getDataPath("presentations"),
    PathUtils.join(Zotero.DataDirectory.dir, "storage"),
  ];
  return roots.some((root) => isPathInsidePresentationRoot(filePath, root));
}

function isTrustedPresentationPreviewPath(filePath: string): boolean {
  return (
    Boolean(filePath) &&
    PathUtils.isAbsolute(filePath) &&
    /\.png$/iu.test(filePath) &&
    isPathInsidePresentationRoot(filePath, getDataPath("presentations"))
  );
}

function getItemByLibraryKey(
  itemKey: string | null | undefined,
  libraryID?: number,
): Zotero.Item | null {
  if (!itemKey) {
    return null;
  }
  const resolvedLibraryID = libraryID ?? Zotero.Libraries?.userLibraryID;
  if (!Number.isSafeInteger(resolvedLibraryID)) {
    return null;
  }
  return (
    (Zotero.Items.getByLibraryAndKey(resolvedLibraryID, itemKey) as
      | Zotero.Item
      | false) || null
  );
}

function getQuoteNavigationItem(
  session: ChatSession | null | undefined,
  currentItem: Zotero.Item | null,
): Zotero.Item | null {
  return (
    getItemByLibraryKey(
      session?.lastActiveItemKey,
      session?.lastActiveItemLibraryID,
    ) ||
    currentItem ||
    getActiveReaderItem()
  );
}

/** Resolve the paper that owns a specific assistant presentation task. */
function getPresentationItemForMessage(
  message: ChatMessage | null | undefined,
  session: ChatSession | null | undefined,
): Zotero.Item | null {
  if (!message) return null;

  for (const artifact of message.presentationArtifacts || []) {
    const item = getItemByLibraryKey(
      artifact.sourceItemKey,
      artifact.sourceLibraryID ?? session?.lastActiveItemLibraryID,
    );
    const paper = resolvePresentationPaperFromCandidates(item);
    if (paper) return paper;
  }

  // Older messages predate source metadata on presentation artifacts. The
  // assistant message still records the trusted source key, so use it before
  // falling back to whatever paper is currently selected in Zotero.
  for (const itemKey of message.sourceItemKeys || []) {
    const item = getItemByLibraryKey(itemKey, session?.lastActiveItemLibraryID);
    const paper = resolvePresentationPaperFromCandidates(item);
    if (paper) return paper;
  }
  return null;
}

interface ChatMessageRenderCallbacks {
  retryableErrorMessageId?: string;
  onRetry?: () => void | Promise<void>;
  onRetryError?: (error: Error) => void;
  onReroll?: () => void | Promise<void>;
  onRerollError?: (error: Error) => void;
  onFork?: (assistantMessageId: string) => void | Promise<void>;
  onForkError?: (error: Error) => void;
  onQuoteReply?: (assistantMessageId: string) => void;
  onNavigateToQuotedMessage?: (quote: QuotedMessageRef) => void | Promise<void>;
  onSummarizeReply?: (assistantMessageId: string) => void | Promise<void>;
  onSummarizeReplyError?: (error: Error) => void;
  onResumePresentation?: (
    assistantMessageId: string,
  ) => void | boolean | Promise<void | boolean>;
  onResumePresentationError?: (error: Error) => void;
  onCancelPresentation?: (
    assistantMessageId: string,
  ) => void | boolean | Promise<void | boolean>;
  onCancelPresentationError?: (error: Error) => void;
  onMarkdownError?: (message: string) => void;
  onRenderComplete?: () => void;
}

function renderMessageElementsWithMarkdownActions(
  chatHistory: HTMLElement,
  emptyState: HTMLElement | null,
  messages: ChatMessage[],
  getNavigationItem: () => Zotero.Item | null,
  callbacks: ChatMessageRenderCallbacks = {},
): void {
  const markdown = createChatMarkdownRenderOptions({
    getCurrentItem: getNavigationItem,
    appendError: callbacks.onMarkdownError,
  });
  if (callbacks.onResumePresentation) {
    markdown.presentationResumeAction = {
      label: getString("chat-presentation-progress-resume"),
      busyLabel: getString("chat-presentation-progress-resuming"),
      onResume: () => callbacks.onResumePresentation?.(""),
      onError: callbacks.onResumePresentationError,
    };
  }
  if (callbacks.onCancelPresentation) {
    markdown.presentationCancelAction = {
      label: getString("chat-presentation-progress-cancel"),
      busyLabel: getString("chat-presentation-progress-cancelling"),
      onCancel: () => callbacks.onCancelPresentation?.(""),
      onError: callbacks.onCancelPresentationError,
    };
  }
  renderMessageElementsBase(
    chatHistory,
    emptyState,
    messages,
    getCurrentTheme(),
    callbacks.retryableErrorMessageId,
    callbacks.onReroll,
    callbacks.onRerollError,
    {
      markdown,
      onResumePresentation: callbacks.onResumePresentation,
      onResumePresentationError: callbacks.onResumePresentationError,
      onCancelPresentation: callbacks.onCancelPresentation,
      onCancelPresentationError: callbacks.onCancelPresentationError,
      onRetry: callbacks.onRetry,
      onRetryError: callbacks.onRetryError,
      onFork: callbacks.onFork,
      onForkError: callbacks.onForkError,
      onQuoteReply: callbacks.onQuoteReply,
      onNavigateToQuotedMessage: callbacks.onNavigateToQuotedMessage,
      onSummarizeReply: callbacks.onSummarizeReply,
      onSummarizeReplyError: callbacks.onSummarizeReplyError,
      onRenderComplete: callbacks.onRenderComplete,
    },
  );
}

async function sendNoteSummaryPrompt(
  context: ChatPanelContext,
  session: ChatSession,
  prompt: string,
  modelRequestContent?: string,
  sourceItemKeys: readonly string[] = [],
): Promise<void> {
  if (context.chatManager.getActiveSession() !== session) {
    throw new Error(getString("chat-note-summary-unavailable"));
  }
  if (!providerSupportsToolCalling(getProviderManager().getActiveProvider())) {
    throw new Error(getString("chat-note-summary-tools-unavailable"));
  }
  const item = getQuoteNavigationItem(session, context.getCurrentItem());
  const normalizedSourceItemKeys = normalizeSourceItemKeys(sourceItemKeys);
  const sourceItems: NoteSummarySourceItem[] = normalizedSourceItemKeys.flatMap(
    (itemKey) => {
      const sourceItem = resolveNoteSummarySourceItem(
        itemKey,
        (key) => getItemByLibraryKey(key),
        (id) => (Zotero.Items.get(id) as Zotero.Item | false) || null,
      );
      return sourceItem ? [sourceItem] : [];
    },
  );
  const noteSummaryContext = createNoteSummaryContext(sourceItems);
  await context.chatManager.sendMessage(prompt, {
    item,
    attachPdf: false,
    targetSession: session,
    requireTargetSessionActive: true,
    allowedToolNames:
      noteSummaryContext.sourceItems.length > 1
        ? ["request_user_input", "create_note"]
        : ["create_note"],
    modelRequestContent,
    allowPaperChatRetry: false,
    trustedSourceItemKeys: normalizedSourceItemKeys,
    noteSummaryContext,
  });
}

async function summarizeConversationToNote(
  context: ChatPanelContext,
): Promise<void> {
  const session = context.chatManager.getActiveSession();
  if (!session || !hasConversationMessages(session.messages)) {
    throw new Error(getString("chat-note-summary-unavailable"));
  }
  await sendNoteSummaryPrompt(
    context,
    session,
    getString("chat-summarize-conversation-note-prompt"),
    undefined,
    collectNoteSummarySourceItemKeys(session.messages),
  );
}

async function summarizeReplyToNote(
  context: ChatPanelContext,
  assistantMessageId: string,
): Promise<void> {
  const session = context.chatManager.getActiveSession();
  const message = session?.messages.find(
    (candidate) => candidate.id === assistantMessageId,
  );
  if (!session || !message || !canSummarizeAssistantReply(message)) {
    throw new Error(getString("chat-note-summary-unavailable"));
  }
  const replyContent = formatMarkdownForMessageCopy(message.content, {
    evidenceRecords: message.evidence,
  });
  const prompt = buildReplyNoteSummaryPrompt(
    getString("chat-summarize-reply-note-prompt"),
    replyContent || message.content,
  );
  await sendNoteSummaryPrompt(
    context,
    session,
    getString("chat-summarize-reply-note"),
    prompt,
    collectNoteSummarySourceItemKeys([message]),
  );
}

function buildApprovalActionsForContainer(
  manager: ChatManager,
  container: HTMLElement,
): {
  onResolveApproval: (
    requestId: string,
    resolution: ToolApprovalResolution,
  ) => void;
} {
  return {
    onResolveApproval: (requestId, resolution) => {
      const currentRequest = getPendingApprovalRequestSnapshot(
        container,
        manager,
        requestId,
      );
      const decision = manager.resolveToolApprovalRequest(
        requestId,
        resolution,
      );
      if (decision && currentRequest) {
        startApprovalTransition(
          container,
          manager,
          currentRequest,
          resolution,
          requestId,
        );
        continueApprovalTransition(container, manager, requestId);
      }
    },
  };
}

function buildUserInputActionsForContainer(manager: ChatManager): {
  onResolveUserInput: (
    requestId: string,
    response: RequestUserInputResponse,
  ) => void;
} {
  return {
    onResolveUserInput: (requestId, response) => {
      manager.resolveUserInputRequest(requestId, response);
    },
  };
}

function updateExecutionInsetsForContainer(
  container: HTMLElement,
  manager: ChatManager,
  executionPlan?: ExecutionPlan,
): void {
  const theme = getCurrentTheme();
  const activeSession = manager.getActiveSession();
  const activeSessionId = activeSession?.id || null;
  const toolApprovalState = activeSession?.toolApprovalState;
  const userInputRequestState = activeSession?.userInputRequestState;
  const approvalActions = buildApprovalActionsForContainer(manager, container);
  const userInputActions = buildUserInputActionsForContainer(manager);
  const planPanel = container.querySelector(
    "#chat-execution-plan-panel",
  ) as HTMLElement | null;
  const approvalPanel = container.querySelector(
    "#chat-execution-approval-panel",
  ) as HTMLElement | null;
  const transitionState = approvalPanel
    ? approvalPanelTransitions.get(approvalPanel)
    : undefined;

  if (
    approvalPanel &&
    transitionState &&
    transitionState.sessionId !== activeSessionId
  ) {
    clearApprovalTransition(approvalPanel);
  }

  if (planPanel) {
    updateExecutionPlanView(planPanel, theme, executionPlan, toolApprovalState);
  }
  if (approvalPanel) {
    if (toolApprovalState?.pendingRequests.length || transitionState) {
      updateApprovalView(
        approvalPanel,
        theme,
        executionPlan,
        toolApprovalState,
        approvalActions,
        approvalPanelTransitions.get(approvalPanel),
      );
    } else {
      updateUserInputRequestView(
        approvalPanel,
        theme,
        userInputRequestState,
        userInputActions,
      );
    }
  }
}

function getPendingApprovalRequestSnapshot(
  container: HTMLElement,
  manager: ChatManager,
  requestId: string,
): PendingApprovalRequest | undefined {
  const session = manager.getActiveSession();
  if (!session?.toolApprovalState?.pendingRequests.length) {
    return undefined;
  }

  const request = session.toolApprovalState.pendingRequests.find(
    (entry) => entry.id === requestId,
  );
  if (!request) {
    return undefined;
  }

  return clonePendingApprovalRequest(request, container.ownerDocument);
}

function clonePendingApprovalRequest(
  request: PendingApprovalRequest,
  doc: Document,
): PendingApprovalRequest {
  return (
    structuredCloneIfAvailable(request, doc.defaultView) || {
      ...request,
      descriptor: { ...request.descriptor },
      request: {
        ...request.request,
        toolCall: {
          ...request.request.toolCall,
          function: { ...request.request.toolCall.function },
        },
        args: { ...request.request.args },
      },
    }
  );
}

function structuredCloneIfAvailable<T>(
  value: T,
  view?: Window | null,
): T | null {
  const clone = view?.structuredClone || globalThis.structuredClone;
  if (typeof clone !== "function") {
    return null;
  }
  try {
    return clone(value);
  } catch {
    return null;
  }
}

function getApprovalPanel(container: HTMLElement): HTMLElement | null {
  return container.querySelector(
    "#chat-execution-approval-panel",
  ) as HTMLElement | null;
}

function clearApprovalTransition(panel: HTMLElement | null): void {
  if (!panel) {
    return;
  }

  const existing = approvalPanelTransitions.get(panel);
  if (typeof existing?.timeoutId === "number") {
    const view = panel.ownerDocument?.defaultView;
    (view || window).clearTimeout(existing.timeoutId);
  }
  approvalPanelTransitions.delete(panel);
}

function rerenderApprovalPanel(
  container: HTMLElement,
  manager: ChatManager,
): void {
  updateExecutionInsetsForContainer(
    container,
    manager,
    manager.getActiveSession()?.executionPlan,
  );
}

function startApprovalTransition(
  container: HTMLElement,
  manager: ChatManager,
  request: PendingApprovalRequest,
  resolution: ToolApprovalResolution,
  requestId: string,
): void {
  const panel = getApprovalPanel(container);
  if (!panel || request.id !== requestId) {
    return;
  }

  clearApprovalTransition(panel);
  approvalPanelTransitions.set(panel, {
    phase: "resolved",
    request,
    resolution,
    sessionId: manager.getActiveSession()?.id || null,
    nextPendingCount: 0,
  });
  rerenderApprovalPanel(container, manager);
}

function continueApprovalTransition(
  container: HTMLElement,
  manager: ChatManager,
  requestId: string,
): void {
  const panel = getApprovalPanel(container);
  const state = panel ? approvalPanelTransitions.get(panel) : undefined;
  if (!panel || !state || state.request.id !== requestId) {
    return;
  }

  const nextPendingCount =
    manager.getActiveSession()?.toolApprovalState?.pendingRequests.length || 0;
  const view = panel.ownerDocument?.defaultView || window;

  const timeoutId = view.setTimeout(() => {
    const current = approvalPanelTransitions.get(panel);
    if (!current || current.request.id !== requestId) {
      return;
    }

    if (nextPendingCount > 0) {
      approvalPanelTransitions.set(panel, {
        ...current,
        phase: "entering",
        nextPendingCount,
      });
      rerenderApprovalPanel(container, manager);

      const settleTimeoutId = view.setTimeout(() => {
        const latest = approvalPanelTransitions.get(panel);
        if (!latest || latest.request.id !== requestId) {
          return;
        }
        clearApprovalTransition(panel);
        rerenderApprovalPanel(container, manager);
      }, APPROVAL_ENTER_ANIMATION_MS);

      approvalPanelTransitions.set(panel, {
        ...(approvalPanelTransitions.get(panel) || current),
        timeoutId: settleTimeoutId,
      });
      return;
    }

    clearApprovalTransition(panel);
    rerenderApprovalPanel(container, manager);
  }, APPROVAL_RESOLVED_ANIMATION_MS);

  approvalPanelTransitions.set(panel, {
    ...state,
    nextPendingCount,
    timeoutId,
  });
}

// Floating window default size
const FLOATING_WIDTH = 420;
const FLOATING_HEIGHT = 600;

// Initialize the events module with the getActiveReaderItem function reference
// This is done immediately to avoid issues with early calls
let eventsInitialized = false;

/**
 * Get current active Zotero item from reader
 */
export function getActiveReaderItem(): Zotero.Item | null {
  const mainWindow = Zotero.getMainWindow() as Window & {
    Zotero_Tabs?: { selectedID: string };
  };
  const tabs = mainWindow.Zotero_Tabs;
  if (!tabs) return null;

  const reader = Zotero.Reader.getByTabID(tabs.selectedID);
  if (reader) {
    const itemID = reader.itemID;
    if (itemID) {
      return Zotero.Items.get(itemID) as Zotero.Item;
    }
  }
  return null;
}

// Singleton state
let chatManager: ChatManager | null = null;
let chatContainer: HTMLElement | null = null;
let resizeHandler: (() => void) | null = null;
let sidebarObserver: MutationObserver | null = null;
let tabNotifierID: string | null = null;
let globalTabNotifierID: string | null = null; // Persistent notifier for sidebar sync
let contentInitialized = false;
let moduleCurrentItem: Zotero.Item | null = null;
let pendingPanelItem: Zotero.Item | null = null;
let pendingPanelReadyAction: (() => void | Promise<void>) | null = null;
let themeCleanup: (() => void) | null = null;

// Panel mode state
let currentPanelMode: PanelMode = "sidebar";

// Floating window reference
let floatingWindow: Window | null = null;
let floatingContainer: HTMLElement | null = null;
let floatingContentInitialized = false;
let floatingTabNotifierID: string | null = null;
let panelVisibleSince: number | null = null;
let panelOpenSource: ChatPanelOpenSource = "unknown";
let suppressFloatingUnloadTracking = false;
const readingLoopPanelSubscriptions = new WeakMap<HTMLElement, () => void>();
const eventHandlerDisposers = new WeakMap<HTMLElement, () => void>();
const readyPanelContainers = new WeakSet<HTMLElement>();
let readingLoopExecutorOwner: HTMLElement | null = null;
let readingLoopToolbarUnsubscribe: (() => void) | null = null;
let readingLoopLatestSnapshot: ReadingLoopSnapshot | null = null;
let readingLoopPopoverHideTimer: number | null = null;
const readingLoopToolbarBoundButtons = new WeakSet<HTMLElement>();

function removeStaleSidebarContainers(doc: Document): void {
  const containers = Array.from(
    doc.querySelectorAll(`#${config.addonRef}-chat-container`),
  ) as HTMLElement[];
  for (const container of containers) {
    if (container !== chatContainer) {
      cleanupPanelIntegrations(container);
      container.remove();
    }
  }
}

// Attachment state
let pendingImages: ImageAttachment[] = [];
let pendingFiles: FileAttachment[] = [];
let pinnedSelectedTexts: string[] = [];
let pendingSelectedText: string | null = null;
let pendingQuotedMessages: QuotedMessageRef[] = [];

/**
 * Get current panel mode
 */
export function getPanelMode(): PanelMode {
  return currentPanelMode;
}

/**
 * Set panel mode and update display
 */
export function setPanelMode(mode: PanelMode): void {
  if (currentPanelMode === mode) return;

  const wasShown = isPanelShown();
  const previousMode = currentPanelMode;

  currentPanelMode = mode;
  setPref("panelMode", mode);

  if (wasShown) {
    // Close the previous mode's panel
    if (previousMode === "sidebar") {
      hideSidebarPanel();
    } else {
      closeFloatingWindow();
    }

    // Open the new mode's panel
    if (mode === "sidebar") {
      showSidebarPanel();
    } else {
      openFloatingWindow();
    }
  }

  ztoolkit.log(`Panel mode changed to: ${mode}`);
}

/**
 * Toggle panel mode between sidebar and floating
 */
export function togglePanelMode(): void {
  const newMode = currentPanelMode === "sidebar" ? "floating" : "sidebar";
  setPanelMode(newMode);
}

/**
 * Load panel mode from preferences
 */
function loadPanelMode(): void {
  const savedMode = getPref("panelMode") as PanelMode | undefined;
  if (savedMode === "sidebar" || savedMode === "floating") {
    currentPanelMode = savedMode;
  }
}

/**
 * Initialize the events module with function references
 */
function initializeEventsModule(): void {
  if (!eventsInitialized) {
    setActiveReaderItemFn(getActiveReaderItem);
    setTogglePanelModeFn(togglePanelMode);
    eventsInitialized = true;
  }
}

/**
 * Get or create the ChatManager instance
 */
export function getChatManager(): ChatManager {
  if (!chatManager) {
    chatManager = new ChatManager();
  }
  initializeEventsModule();
  return chatManager;
}

/** Stop background search work without creating a ChatManager during shutdown. */
export async function stopChatSearchBackfillForShutdown(): Promise<void> {
  await stopExistingSearchBackfillForShutdown(chatManager);
}

/**
 * Get the current sidebar element based on active tab
 * Tab types: 'library', 'reader', 'note'
 * - reader and note tabs use #zotero-context-pane
 * - library tab uses #zotero-item-pane
 */
function getSidebar(): HTMLElement | null {
  const mainWindow = Zotero.getMainWindow() as Window & {
    Zotero_Tabs?: { selectedType: string };
  };
  const currentTab = mainWindow.Zotero_Tabs?.selectedType;
  // Both 'reader' and 'note' tabs use context pane
  const useContextPane = currentTab === "reader" || currentTab === "note";
  const paneName = useContextPane
    ? "#zotero-context-pane"
    : "#zotero-item-pane";
  return mainWindow.document.querySelector(paneName) as HTMLElement | null;
}

/**
 * Get the splitter element
 * Tab types: 'library', 'reader', 'note'
 * - reader and note tabs use #zotero-context-splitter
 * - library tab uses #zotero-items-splitter
 */
function getSplitter(): HTMLElement | null {
  const mainWindow = Zotero.getMainWindow() as Window & {
    Zotero_Tabs?: { selectedType: string };
  };
  const currentTab = mainWindow.Zotero_Tabs?.selectedType;
  // Both 'reader' and 'note' tabs use context splitter
  const useContextSplitter = currentTab === "reader" || currentTab === "note";
  const splitterName = useContextSplitter
    ? "#zotero-context-splitter"
    : "#zotero-items-splitter";
  return mainWindow.document.querySelector(splitterName) as HTMLElement | null;
}

/**
 * Expand the sidebar (set collapsed to false)
 */
function expandSidebar(): void {
  const sidebar = getSidebar();
  if (sidebar?.getAttribute("collapsed") === "true") {
    sidebar.setAttribute("collapsed", "false");
    const splitter = getSplitter();
    if (splitter) {
      splitter.setAttribute("state", "");
    }
  }
}

/**
 * Collapse the sidebar (set collapsed to true)
 */
function collapseSidebar(): void {
  const sidebar = getSidebar();
  if (sidebar && sidebar.getAttribute("collapsed") !== "true") {
    sidebar.setAttribute("collapsed", "true");
    const splitter = getSplitter();
    if (splitter) {
      splitter.setAttribute("state", "collapsed");
    }
  }
}

/**
 * Update sidebar container position
 */
function updateSidebarContainerPosition(): void {
  if (!chatContainer) return;

  const sidebar = getSidebar();
  if (!sidebar) return;

  // Ensure sidebar is visible FIRST before getting dimensions
  expandSidebar();

  // Hide drag bar in sidebar mode
  const dragBar = chatContainer.querySelector("#chat-drag-bar") as HTMLElement;
  if (dragBar) {
    dragBar.style.display = "none";
  }

  // Use requestAnimationFrame to ensure layout is updated after expanding
  const win = Zotero.getMainWindow();
  win.requestAnimationFrame(() => {
    if (!chatContainer || !sidebar) return;

    const rect = sidebar.getBoundingClientRect();
    chatContainer.style.width = `${rect.width}px`;
    chatContainer.style.height = `${rect.height}px`;
    chatContainer.style.left = `${rect.x}px`;
    chatContainer.style.top = `${rect.y}px`;
    chatContainer.style.right = "auto";
    chatContainer.style.bottom = "auto";
    chatContainer.style.borderRadius = "0";
    chatContainer.style.boxShadow = "none";
    chatContainer.style.border = "none";
    chatContainer.style.borderLeft = "1px solid var(--fill-quinary)";
  });
}

/**
 * Update container size based on current panel mode
 */
function updateContainerSize(): void {
  if (currentPanelMode === "sidebar") {
    updateSidebarContainerPosition();
  }
}

/**
 * Open floating window
 */
function openFloatingWindow(): boolean {
  // Close existing floating window if any
  if (floatingWindow && !floatingWindow.closed) {
    floatingWindow.focus();
    return true;
  }

  // Reset state before opening new window
  floatingWindow = null;
  floatingContainer = null;
  floatingContentInitialized = false;

  const mainWindow = Zotero.getMainWindow();

  // Calculate position (center on main window)
  const width = FLOATING_WIDTH;
  const height = FLOATING_HEIGHT;
  const left = mainWindow.screenX + (mainWindow.outerWidth - width) / 2;
  const top = mainWindow.screenY + (mainWindow.outerHeight - height) / 2;

  // Open new window using openDialog for better control
  floatingWindow = (
    mainWindow as Window & { openDialog: (...args: unknown[]) => Window }
  ).openDialog(
    `chrome://${config.addonRef}/content/chatWindow.xhtml`,
    "paperchat-chat-window",
    `chrome,dialog=no,resizable=yes,centerscreen,width=${width},height=${height},left=${left},top=${top}`,
  );

  if (!floatingWindow) {
    ztoolkit.log("Failed to open floating window");
    return false;
  }

  // Wait for window to load, then initialize content
  floatingWindow.addEventListener("load", () => {
    ztoolkit.log("Floating window load event fired");
    initializeFloatingWindowContent();

    // Handle window close - only after content is loaded
    floatingWindow?.addEventListener("unload", () => {
      ztoolkit.log("Floating window unload event");
      // A screenshot selection lives in the PDF reader realm, so closing the
      // floating panel must invalidate it before any late capture callback can
      // reopen the panel or attach an image to a disposed container.
      cancelReaderFigureScreenshot();
      if (!suppressFloatingUnloadTracking) {
        trackChatPanelClosed();
      }
      suppressFloatingUnloadTracking = false;
      cleanupPanelIntegrations(floatingContainer);
      // Immediately reset state
      floatingWindow = null;
      floatingContainer = null;
      floatingContentInitialized = false;
      pendingPanelReadyAction = null;
      updateToolbarButtonState(false);
    });
  });

  ztoolkit.log("Floating window opened");
  return true;
}

/**
 * Initialize floating window content
 */
function initializeFloatingWindowContent(): void {
  if (!floatingWindow || floatingContentInitialized) {
    return;
  }

  const doc = floatingWindow.document;
  const root = doc.getElementById("chat-window-root");

  if (!root) {
    ztoolkit.log("Chat window root not found");
    return;
  }

  // Initialize theme
  updateCurrentTheme();

  // Create chat container in floating window
  floatingContainer = createChatContainer(doc, getCurrentTheme());

  // Move container into the root (it was appended to documentElement by createChatContainer)
  if (floatingContainer.parentElement) {
    floatingContainer.parentElement.removeChild(floatingContainer);
  }
  root.appendChild(floatingContainer);

  // Style adjustments for floating window
  floatingContainer.style.display = "block";
  floatingContainer.style.position = "relative";
  floatingContainer.style.width = "100%";
  floatingContainer.style.height = "100%";
  floatingContainer.style.borderLeft = "none";
  floatingContainer.style.border = "none";

  // Hide drag bar (window has its own title bar)
  const dragBar = floatingContainer.querySelector(
    "#chat-drag-bar",
  ) as HTMLElement;
  if (dragBar) {
    dragBar.style.display = "none";
  }

  // Update mode button icon for floating mode
  updatePanelModeButtonIcon(floatingContainer, currentPanelMode);

  // Initialize chat content
  initializeFloatingChatContent();
  floatingContentInitialized = true;
}

/**
 * Common initialization logic for chat content (shared between sidebar and floating)
 */
async function initializeChatContentCommon(
  container: HTMLElement,
): Promise<void> {
  readyPanelContainers.delete(container);
  const authManager = getAuthManager();
  const context = createContext(container);
  const requestedItem = pendingPanelItem;
  pendingPanelItem = null;

  // Load cached model ratios for PaperChat
  loadCachedRatios();

  // Initialize auth
  await authManager.initialize();
  context.updateUserBar();

  // Set auth callbacks
  authManager.addListener({
    onBalanceUpdate: () => context.updateUserBar(),
    onLoginStatusChange: () => {
      context.updateUserBar();
      // Re-fetch check-in status on login status change (e.g. auto-relogin after session expiry)
      if (authManager.isLoggedIn()) {
        refreshCheckinDisplay(container, authManager);
      }
    },
  });

  // Set provider change callback
  const providerManager = getProviderManager();
  providerManager.setOnProviderChange(() => {
    context.updateUserBar();
    updateModelSelectorDisplay(container);
    const activeSession = manager.getActiveSession();
    if (activeSession) {
      context.renderMessages(activeSession.messages);
    }
  });

  // Setup event handlers
  eventHandlerDisposers.get(container)?.();
  eventHandlerDisposers.set(container, setupEventHandlers(context));
  NextQuestionHintController.attach(context);

  // Set up chat manager callbacks
  const manager = getChatManager();
  setupChatManagerCallbacks(manager, context, container);
  setupReadingLoopIntegration(container, context);

  // Initialize ChatManager (handles migration and session loading)
  await manager.init();
  await refreshImageInputAvailability(container, manager);

  // Get current item from reader
  const activeItem = requestedItem || getActiveReaderItem();
  if (activeItem) {
    moduleCurrentItem = activeItem;
    manager.setCurrentItemKey(activeItem.key, activeItem.libraryID);
    getReadingLoopService().setCurrentItem(activeItem);
  } else {
    moduleCurrentItem = null;
    manager.setCurrentItemKey(null);
    getReadingLoopService().setCurrentItem(null);
  }

  // Update PDF checkbox visibility
  await context.updatePdfCheckboxVisibility(moduleCurrentItem);

  // Load active session and render
  const session = manager.getActiveSession();
  if (session) {
    context.renderMessages(session.messages);
    context.renderExecutionPlan(session.executionPlan);
  }
  updateModelSelectorDisplay(container);
  context.updateAttachmentsPreview();

  focusInput(container);
  readyPanelContainers.add(container);
  await flushPendingPanelReadyAction();
}

function setupReadingLoopIntegration(
  container: HTMLElement,
  context: ChatPanelContext,
): void {
  const service = getReadingLoopService();
  readingLoopExecutorOwner = container;
  service.setExecutor(async ({ suggestion, currentItem }) => {
    if (!container.isConnected) {
      throw new Error("PaperChat panel is not available.");
    }
    const targetItem =
      currentItem ||
      getActiveReaderItem() ||
      context.getCurrentItem() ||
      getItemByLibraryKey(suggestion.itemKey);
    if (targetItem) {
      context.setCurrentItem(targetItem);
    }

    const selectedText =
      typeof suggestion.payload?.selectedText === "string"
        ? suggestion.payload.selectedText
        : undefined;
    const content = buildReadingLoopPrompt(suggestion);
    const didSend = await context.chatManager.sendMessage(content, {
      item: targetItem,
      attachPdf: !!targetItem,
      selectedText,
    });
    if (!didSend) {
      throw new Error(getString("chat-error-no-provider"));
    }
    return {
      title: "已发送到 PaperChat",
    };
  });

  const existingUnsubscribe = readingLoopPanelSubscriptions.get(container);
  existingUnsubscribe?.();
  const unsubscribe = service.subscribe((snapshot) => {
    if (!container.isConnected) {
      return;
    }
    renderReadingLoopSuggestionStrip(container, snapshot);
    updateReadingLoopEntryIndicator(snapshot);
  });
  readingLoopPanelSubscriptions.set(container, unsubscribe);
}

function cleanupReadingLoopIntegration(container: HTMLElement | null): void {
  if (!container) {
    return;
  }

  const unsubscribe = readingLoopPanelSubscriptions.get(container);
  unsubscribe?.();
  readingLoopPanelSubscriptions.delete(container);

  const strip = container.querySelector(
    "#reading-loop-suggestion-strip",
  ) as HTMLElement | null;
  if (strip) {
    strip.style.display = "none";
    strip.replaceChildren();
  }

  if (readingLoopExecutorOwner === container) {
    readingLoopExecutorOwner = null;
    getReadingLoopService().setExecutor(null);
  }
}

function cleanupPanelIntegrations(
  container: HTMLElement | null,
  disposeEventHandlers: boolean = true,
): void {
  if (!container) {
    return;
  }
  if (disposeEventHandlers) {
    readyPanelContainers.delete(container);
    eventHandlerDisposers.get(container)?.();
    eventHandlerDisposers.delete(container);
  }
  NextQuestionHintController.detach(container);
  cleanupReadingLoopIntegration(container);
}

function buildReadingLoopPrompt(suggestion: ReadingSuggestion): string {
  switch (suggestion.kind) {
    case "highlight_digest":
      return [
        "请读取当前论文的高亮和批注，将这些标注整理成一份简洁的阅读笔记。",
        "要求：",
        "1. 提炼 3-6 条关键观点或证据。",
        "2. 保留必要的页码或原文线索。",
        "3. 将结果追加到这篇论文的 PaperChat Notes 子笔记中。",
        "4. 完成后简要告诉我写入结果。",
      ].join("\n");
    case "save_selection_note":
      return [
        "请将当前选中的文本整理成一条简洁阅读笔记，并追加到这篇论文的 PaperChat Notes 子笔记中。",
        "请先概括要点，再保留必要的原文线索。",
      ].join("\n");
    case "explain_visual_context":
      return [
        "请解释当前选中的图表、图片或算法线索，并结合论文上下文说明它支撑了什么结论。",
        "如果需要，请优先读取附近页面、图注、表注或相关段落。",
      ].join("\n");
    case "explain_formula":
      return [
        "请解释当前选中的公式或数学符号。",
        "要求说明每个关键变量的含义、公式在论文方法中的作用，以及它和实验/结论的关系。",
      ].join("\n");
    case "trace_reference":
      return [
        "请追踪当前选中的引用或参考文献线索。",
        "要求说明这条引用在当前论文中的作用，并尽量结合参考文献信息或上下文解释它为什么重要。",
      ].join("\n");
    case "section_checkpoint":
      return [
        "请基于当前论文的阅读位置附近内容，生成一个非常简洁的段落 checkpoint。",
        "包括：这一段在解决什么问题、已有结论、下一步阅读时要注意什么。",
      ].join("\n");
    case "reading_checkpoint":
      return [
        "请基于当前论文、已有标注和最近对话，生成本次阅读 checkpoint。",
        "包括：当前已理解的主线、仍未解决的问题、接下来最值得读的部分。",
      ].join("\n");
    case "followup_questions":
      return [
        "我刚才围绕这篇论文连续提出了一些问题。请把这些问题整理成一条清晰的阅读路线。",
        "要求区分：概念澄清、方法细节、证据/实验、下一步需要查的内容。",
      ].join("\n");
    case "explain_selection":
    default:
      return "解释当前选中的文本，并结合这篇论文的上下文说明它为什么重要。";
  }
}

function renderReadingLoopSuggestionStrip(
  container: HTMLElement,
  snapshot: ReadingLoopSnapshot,
): void {
  const strip = container.querySelector(
    "#reading-loop-suggestion-strip",
  ) as HTMLElement | null;
  if (!strip) {
    return;
  }

  const suggestion = snapshot.activeSuggestion;
  if (!snapshot.enabled || !suggestion || snapshot.state === "idle") {
    strip.style.display = "none";
    strip.textContent = "";
    return;
  }

  const theme = getCurrentTheme();
  strip.textContent = "";
  strip.style.display = "flex";
  strip.style.background = theme.toolbarBg;
  strip.style.borderBottomColor = theme.borderColor;
  strip.style.color = theme.textPrimary;

  const dot = strip.ownerDocument.createElementNS(HTML_NS, "span");
  Object.assign(dot.style, {
    width: "7px",
    height: "7px",
    borderRadius: "999px",
    background: getReadingLoopAccent(snapshot.state),
    flexShrink: "0",
  } satisfies Partial<CSSStyleDeclaration>);

  const title = strip.ownerDocument.createElementNS(HTML_NS, "span");
  title.textContent = suggestion.title;
  Object.assign(title.style, {
    flex: "1",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "12px",
    lineHeight: "18px",
  } satisfies Partial<CSSStyleDeclaration>);

  const primary = strip.ownerDocument.createElementNS(
    HTML_NS,
    "button",
  ) as HTMLButtonElement;
  primary.type = "button";
  primary.textContent = getReadingLoopPrimaryActionLabel(snapshot.state);
  primary.disabled = snapshot.state === "running";
  Object.assign(primary.style, {
    border: "none",
    background: "transparent",
    color: getReadingLoopAccent(snapshot.state),
    cursor: snapshot.state === "running" ? "default" : "pointer",
    padding: "2px 4px",
    fontSize: "12px",
    fontWeight: "600",
    flexShrink: "0",
    opacity: snapshot.state === "running" ? "0.75" : "1",
  } satisfies Partial<CSSStyleDeclaration>);
  primary.addEventListener("click", () => {
    if (snapshot.state === "running") {
      return;
    }
    if (snapshot.state === "completed") {
      getReadingLoopService().viewResult(suggestion.id);
      return;
    }
    void getReadingLoopService().acceptSuggestion(suggestion.id);
  });

  const close = strip.ownerDocument.createElementNS(
    HTML_NS,
    "button",
  ) as HTMLButtonElement;
  close.type = "button";
  close.textContent = "×";
  close.title = getString("reading-loop-dismiss");
  Object.assign(close.style, {
    border: "none",
    background: "transparent",
    color: theme.textMuted,
    cursor: "pointer",
    padding: "2px 3px",
    fontSize: "14px",
    lineHeight: "16px",
    flexShrink: "0",
  } satisfies Partial<CSSStyleDeclaration>);
  close.addEventListener("click", () => {
    getReadingLoopService().dismissSuggestion(suggestion.id);
  });

  strip.appendChild(dot);
  strip.appendChild(title);
  strip.appendChild(primary);
  if (snapshot.state !== "running") {
    strip.appendChild(close);
  }
}

function getReadingLoopPrimaryActionLabel(state: ReadingLoopState): string {
  switch (state) {
    case "completed":
      return getString("reading-loop-view");
    case "attention":
      return getString("reading-loop-retry");
    case "running":
      return getString("reading-loop-processing");
    case "suggested":
    default:
      return getString("reading-loop-execute");
  }
}

function getReadingLoopAccent(state: ReadingLoopState): string {
  switch (state) {
    case "completed":
      return "#16a34a";
    case "attention":
      return "#f97316";
    case "running":
    case "suggested":
    default:
      return "#2563eb";
  }
}

/**
 * Refresh chat for current item (works for both sidebar and floating)
 * Note: This updates the current item tracking but does NOT switch sessions
 */
async function refreshChatForContainer(container: HTMLElement): Promise<void> {
  const activeItem = pendingPanelItem || getActiveReaderItem();
  pendingPanelItem = null;
  const manager = getChatManager();

  // Update current item tracking (session remains the same)
  if (activeItem) {
    moduleCurrentItem = activeItem;
    manager.setCurrentItemKey(activeItem.key, activeItem.libraryID);
    getReadingLoopService().setCurrentItem(activeItem);
  } else {
    moduleCurrentItem = null;
    manager.setCurrentItemKey(null);
    getReadingLoopService().setCurrentItem(null);
  }

  // Update PDF checkbox visibility
  await updatePdfCheckboxVisibilityForItem(
    container,
    moduleCurrentItem,
    manager,
  );

  // Render current session messages (session doesn't change on tab switch)
  const session = manager.getActiveSession();
  const chatHistory = container.querySelector("#chat-history") as HTMLElement;
  const emptyState = container.querySelector(
    "#chat-empty-state",
  ) as HTMLElement;
  if (chatHistory && session) {
    const refreshContext = createContext(container);
    const supportsToolCalling = providerSupportsToolCalling(
      getProviderManager().getActiveProvider(),
    );
    renderMessageElementsWithMarkdownActions(
      chatHistory,
      emptyState,
      session.messages,
      () => getQuoteNavigationItem(session, moduleCurrentItem),
      {
        onFork: (assistantMessageId) =>
          continueInNewChatFromMessage(refreshContext, assistantMessageId),
        onQuoteReply: (assistantMessageId) =>
          addAssistantReplyQuote(refreshContext, assistantMessageId),
        onNavigateToQuotedMessage: (quote) =>
          navigateToQuotedMessage(refreshContext, quote),
        onSummarizeReply: supportsToolCalling
          ? (assistantMessageId) =>
              summarizeReplyToNote(refreshContext, assistantMessageId)
          : undefined,
        onSummarizeReplyError: (error) => {
          refreshContext.appendError(error.message);
        },
        onResumePresentation: (assistantMessageId) =>
          refreshContext.launchPresentation(assistantMessageId),
        onCancelPresentation: () =>
          session ? manager.cancelSessionTurn(session.id) : false,
        onCancelPresentationError: (error) => {
          refreshContext.appendError(error.message);
        },
        onMarkdownError: refreshContext.appendError,
      },
    );
    updateConversationNoteSummaryButton(
      container,
      session.messages,
      session.id,
      supportsToolCalling,
    );
    updateExecutionInsetsForContainer(
      container,
      manager,
      session.executionPlan,
    );
  }

  focusInput(container);
}

/**
 * Initialize chat content for floating window
 */
async function initializeFloatingChatContent(): Promise<void> {
  if (!floatingContainer) return;

  // Add tab notifier for floating window
  if (!floatingTabNotifierID) {
    floatingTabNotifierID = Zotero.Notifier.registerObserver(
      {
        notify: async () => {
          if (floatingContainer) {
            await refreshChatForContainer(floatingContainer);
          }
        },
      },
      ["tab"],
      `${config.addonRef}-floating-tab-notifier`,
    );
  }

  await initializeChatContentCommon(floatingContainer);
}

/**
 * Close floating window
 */
function closeFloatingWindow(): void {
  cancelReaderFigureScreenshot();

  // Unregister tab notifier
  if (floatingTabNotifierID) {
    Zotero.Notifier.unregisterObserver(floatingTabNotifierID);
    floatingTabNotifierID = null;
  }

  if (floatingContainer) {
    cancelPendingStreamingTextRender(floatingContainer);
    cleanupPanelIntegrations(floatingContainer);
  }

  if (floatingWindow && !floatingWindow.closed) {
    suppressFloatingUnloadTracking = true;
    floatingWindow.close();
  } else {
    suppressFloatingUnloadTracking = false;
  }
  floatingWindow = null;
  floatingContainer = null;
  floatingContentInitialized = false;
  pendingPanelReadyAction = null;
}

/**
 * Show sidebar panel
 */
function showSidebarPanel(): boolean {
  const doc = Zotero.getMainWindow().document;
  const win = Zotero.getMainWindow();
  const manager = getChatManager();

  removeStaleSidebarContainers(doc);

  // Create container if not exists
  if (!chatContainer || !chatContainer.isConnected) {
    if (chatContainer) {
      chatContainer = null;
    }
    chatContainer = createChatContainer(doc, getCurrentTheme());
    contentInitialized = false;
  }

  // Update position
  updateSidebarContainerPosition();

  // Update mode button icon
  updatePanelModeButtonIcon(chatContainer, currentPanelMode);

  // Add resize listener
  if (!resizeHandler) {
    resizeHandler = () => updateContainerSize();
    win.addEventListener("resize", resizeHandler);
  }

  // Add theme change listener
  if (!themeCleanup) {
    themeCleanup = setupThemeListener(() => {
      if (chatContainer) {
        applyThemeToContainer(chatContainer);
        const session = manager.getActiveSession();
        if (session) {
          createContext(chatContainer).renderExecutionPlan(
            session.executionPlan,
          );
        }
      }
      if (floatingContainer) {
        applyThemeToContainer(floatingContainer);
        const session = manager.getActiveSession();
        if (session) {
          createContext(floatingContainer).renderExecutionPlan(
            session.executionPlan,
          );
        }
      }
    });

    // 启动时延迟检测主题，因为窗口可能还没完全应用暗黑模式
    // 使用 requestAnimationFrame + setTimeout 确保在 DOM 完全渲染后检测
    // MutationObserver 会处理后续的动态变化
    const reapplyTheme = () => {
      updateCurrentTheme();
      if (chatContainer) {
        applyThemeToContainer(chatContainer);
        const session = manager.getActiveSession();
        if (session) {
          createContext(chatContainer).renderExecutionPlan(
            session.executionPlan,
          );
        }
      }
      if (floatingContainer) {
        applyThemeToContainer(floatingContainer);
        const session = manager.getActiveSession();
        if (session) {
          createContext(floatingContainer).renderExecutionPlan(
            session.executionPlan,
          );
        }
      }
    };
    // 立即检测一次
    win.requestAnimationFrame(reapplyTheme);
    // 延迟 100ms 再检测一次，确保暗黑模式已应用
    setTimeout(reapplyTheme, 100);
  }

  // Add sidebar observer
  const mainWin = win as unknown as {
    MutationObserver?: typeof MutationObserver;
  };
  const MutationObserverClass = mainWin.MutationObserver;
  const sidebar = getSidebar();
  if (!sidebarObserver && MutationObserverClass && sidebar) {
    sidebarObserver = new MutationObserverClass(() => updateContainerSize());
    sidebarObserver.observe(sidebar, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  }

  // Add tab notifier
  if (!tabNotifierID) {
    tabNotifierID = Zotero.Notifier.registerObserver(
      {
        notify: () => {
          updateContainerSize();
          if (chatContainer?.style.display !== "none") {
            refreshChatForCurrentItem();
          }
        },
      },
      ["tab"],
      `${config.addonRef}-chat-panel-tab-notifier`,
    );
  }

  chatContainer.style.display = "block";

  // Update toolbar button state
  updateToolbarButtonState(true);

  // Initialize chat content only once
  if (!contentInitialized) {
    initializeChatContent();
    contentInitialized = true;
  } else {
    // Re-bind callbacks to point to the sidebar container
    // (they may have been redirected to a floating window container)
    const manager = getChatManager();
    const context = createContext(chatContainer);
    NextQuestionHintController.attach(context);
    setupChatManagerCallbacks(manager, context, chatContainer);
    setupReadingLoopIntegration(chatContainer, context);
    refreshChatForCurrentItem();
  }

  ztoolkit.log("Sidebar panel shown");
  return true;
}

/**
 * Hide sidebar panel
 */
function hideSidebarPanel(): void {
  cancelReaderFigureScreenshot();

  if (chatContainer) {
    // The sidebar DOM and its event listeners are reused when shown again.
    cleanupPanelIntegrations(chatContainer, false);
    chatContainer.style.display = "none";
  }

  collapseSidebar();

  // Clean up listeners
  if (resizeHandler) {
    Zotero.getMainWindow().removeEventListener("resize", resizeHandler);
    resizeHandler = null;
  }

  if (sidebarObserver) {
    sidebarObserver.disconnect();
    sidebarObserver = null;
  }

  if (tabNotifierID) {
    Zotero.Notifier.unregisterObserver(tabNotifierID);
    tabNotifierID = null;
  }

  ztoolkit.log("Sidebar panel hidden");
}

/**
 * Setup chat manager callbacks
 */
function setupChatManagerCallbacks(
  manager: ChatManager,
  context: ChatPanelContext,
  container: HTMLElement,
): void {
  const authManager = getAuthManager();

  manager.setCallbacks({
    onMessageUpdate: (messages) => {
      ztoolkit.log(
        "onMessageUpdate callback fired, messages:",
        messages.length,
      );
      cancelPendingStreamingTextRender(container);
      context.renderMessages(messages);
      updateModelSelectorDisplay(container);
    },
    onStreamingUpdate: (content, messageId) => {
      if (container) {
        const streamingMarkdown = createChatMarkdownRenderOptions({
          getCurrentItem: () =>
            getQuoteNavigationItem(
              manager.getActiveSession(),
              moduleCurrentItem,
            ),
          appendError: context.appendError,
          enableSourceActions: false,
        });
        streamingMarkdown.presentationCancelAction = {
          label: getString("chat-presentation-progress-cancel"),
          busyLabel: getString("chat-presentation-progress-cancelling"),
          onCancel: () => {
            const session = manager.getActiveSession();
            return session ? manager.cancelSessionTurn(session.id) : false;
          },
          onError: (error) => context.appendError(error.message),
        };
        scheduleStreamingTextRender(
          container,
          manager,
          content,
          messageId,
          streamingMarkdown,
        );
      }
    },
    onReasoningUpdate: (reasoning, messageId) => {
      if (container) {
        const activeMessage = manager
          .getActiveSession()
          ?.messages.find((message) => message.id === messageId);
        if (
          !activeMessage ||
          activeMessage.role !== "assistant" ||
          activeMessage.streamingState !== "in_progress"
        ) {
          return;
        }
        const reasoningEl = container.querySelector(
          getStreamingReasoningSelector(messageId),
        );
        if (reasoningEl) {
          reasoningEl.textContent = reasoning;
          // Show the reasoning container when content arrives
          const reasoningContainer = container.querySelector(
            getStreamingReasoningContainerSelector(messageId),
          ) as HTMLElement;
          if (reasoningContainer && reasoning) {
            reasoningContainer.style.display = "block";
          }
        }
      }
    },
    onExecutionPlanUpdate: (plan) => {
      context.renderExecutionPlan(plan);
    },
    onRuntimeEvent: (event) => {
      if (manager.getActiveSession()?.id !== event.sessionId) {
        return;
      }
      if (
        event.type === "approval_requested" ||
        event.type === "approval_resolved" ||
        event.type === "user_input_requested" ||
        event.type === "user_input_resolved"
      ) {
        context.renderExecutionPlan(manager.getActiveSession()?.executionPlan);
      }
    },
    onError: (error) => {
      ztoolkit.log("[ChatPanel] API Error:", error.message);
      context.appendError(error.message);
      if (isPaperChatQuotaError(error)) {
        void (async () => {
          try {
            ztoolkit.log("[Balance] Refreshing balance after quota error");
            await authManager.refreshUserInfo();
            context.updateUserBar();
          } catch (refreshError) {
            ztoolkit.log(
              "[Balance] Failed to refresh balance after quota error:",
              refreshError,
            );
          }
        })();
      }
    },
    onPdfAttached: () => {
      if (container) {
        const attachPdfCheckbox = container.querySelector(
          "#chat-attach-pdf",
        ) as HTMLInputElement;
        if (attachPdfCheckbox) {
          attachPdfCheckbox.checked = false;
          ztoolkit.log(
            "[PDF Attach] Checkbox unchecked after successful attachment",
          );
        }
      }
    },
    onMessageComplete: async () => {
      const providerManager = getProviderManager();
      if (providerManager.getActiveProviderId() === "paperchat") {
        try {
          ztoolkit.log("[Balance] Refreshing balance after message completion");
          await authManager.refreshUserInfo();
          context.updateUserBar();
        } catch (error) {
          ztoolkit.log("[Balance] Failed to refresh after completion:", error);
        }
      }
      void NextQuestionHintController.get(container)
        ?.requestForLatestCompletion()
        .catch((error) => {
          ztoolkit.log("[NextQuestionHint] request failed:", error);
        });
    },
  });
}

/**
 * Check if panel is shown (either sidebar or floating)
 */
export function isPanelShown(): boolean {
  if (currentPanelMode === "sidebar") {
    return chatContainer?.style.display === "block";
  } else {
    return floatingWindow !== null && !floatingWindow.closed;
  }
}

function trackChatPanelClosed(): void {
  if (panelVisibleSince == null) {
    return;
  }

  getAnalyticsService().track(ANALYTICS_EVENTS.chatPanelClosed, {
    panel_mode: currentPanelMode,
    open_source: panelOpenSource,
    visible_duration_ms: Math.max(0, Date.now() - panelVisibleSince),
  });
  panelVisibleSince = null;
  panelOpenSource = "unknown";
}

/**
 * Show the chat panel
 */
export function showPanel(source: ChatPanelOpenSource = "unknown"): void {
  // Initialize events module
  initializeEventsModule();

  // Load saved panel mode
  loadPanelMode();

  const didOpen =
    currentPanelMode === "sidebar" ? showSidebarPanel() : openFloatingWindow();
  if (!didOpen) {
    updateToolbarButtonState(false);
    return;
  } else {
    updateToolbarButtonState(true);
  }

  if (getProviderManager().getActiveProviderId() === "paperchat") {
    void refreshPaperChatNotice();
  }

  panelVisibleSince = Date.now();
  panelOpenSource = source;
  getAnalyticsService().track(ANALYTICS_EVENTS.chatPanelOpened, {
    panel_mode: currentPanelMode,
    open_source: source,
  });
}

/**
 * Open PaperChat with one PDF selection attached after the panel has finished
 * its asynchronous initialization.
 */
export function showPanelWithSelectedText(
  text: string,
  source: ChatPanelOpenSource = "reader_selection",
): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  const previousSelectedText = pendingSelectedText;
  addSelectedTextAttachment(trimmed);
  try {
    showPanel(source);
  } catch (error) {
    pendingSelectedText = previousSelectedText;
    syncPendingAttachmentsPreviews();
    throw error;
  }
  if (!isPanelShown()) {
    pendingSelectedText = previousSelectedText;
    syncPendingAttachmentsPreviews();
    return;
  }

  // A freshly created panel already has its attachment-preview DOM even while
  // auth, storage, and the active session are still initializing. Render the
  // selection immediately instead of making the first click wait for the full
  // async initialization chain. initializeChatContentCommon() will sync the
  // same source-of-truth state again when initialization finishes.
  syncPendingAttachmentsPreviews();
}

/**
 * Open PaperChat with one bounded image attachment. Attachment state is
 * restored if the panel cannot actually become visible.
 */
export function showPanelWithImageAttachment(
  image: ImageAttachment,
  source: ChatPanelOpenSource = "reader_selection",
): boolean {
  if (getResolvedImageInputAvailability(getChatManager()) === "unsupported") {
    return false;
  }
  const previousImages = pendingImages;
  if (!addImageAttachment(image)) return false;

  let panelShown = false;
  try {
    showPanel(source);
    panelShown = isPanelShown();
  } catch (error) {
    pendingImages = previousImages;
    syncPendingAttachmentsPreviews();
    try {
      ztoolkit.log(
        "[ChatPanel] Failed to show panel for image attachment:",
        error,
      );
    } catch {
      // Shutdown can tear down the toolkit before the reader callback settles.
    }
    return false;
  }
  if (!panelShown) {
    pendingImages = previousImages;
    syncPendingAttachmentsPreviews();
    return false;
  }

  syncPendingAttachmentsPreviews();
  return true;
}

function getVisibleChatContainer(): HTMLElement | null {
  return currentPanelMode === "floating" ? floatingContainer : chatContainer;
}

async function flushPendingPanelReadyAction(): Promise<void> {
  const container = getVisibleChatContainer();
  if (!container?.isConnected || !readyPanelContainers.has(container)) return;
  const action = pendingPanelReadyAction;
  if (!action) return;
  pendingPanelReadyAction = null;
  try {
    await action();
  } catch (error) {
    ztoolkit.log("[ChatPanel] Deferred panel action failed:", error);
  }
}

function runWhenPanelReady(action: () => void | Promise<void>): void {
  // Only the latest navigation request should win if the user clicks two task
  // cards while a floating window is still loading.
  pendingPanelReadyAction = action;
  void flushPendingPanelReadyAction();
}

async function syncPanelSessionForItem(options: {
  manager: ChatManager;
  item: Zotero.Item;
  session?: ChatSession | null;
  expectedSessionId?: string;
  clearAttachments?: boolean;
  syncNavigationState?: boolean;
  afterRender?: (container: HTMLElement) => void;
}): Promise<boolean> {
  const container = getVisibleChatContainer();
  if (!container?.isConnected || !readyPanelContainers.has(container)) {
    return false;
  }
  if (
    options.expectedSessionId &&
    options.manager.getActiveSession()?.id !== options.expectedSessionId
  ) {
    return false;
  }

  const context = createContext(container);
  context.setCurrentItem(options.item);
  await context.updatePdfCheckboxVisibility(options.item);
  if (
    options.expectedSessionId &&
    options.manager.getActiveSession()?.id !== options.expectedSessionId
  ) {
    return false;
  }

  if (options.syncNavigationState) {
    syncSessionNavigationState(
      context,
      container.querySelector("#chat-send-button") as HTMLButtonElement | null,
      options.manager,
    );
  }

  const session = options.session ?? options.manager.getActiveSession();
  if (session) {
    context.renderMessages(session.messages, () =>
      options.afterRender?.(container),
    );
    context.renderExecutionPlan(session.executionPlan);
  }
  if (options.clearAttachments) {
    context.clearAttachments();
    context.updateAttachmentsPreview();
  }
  updateModelSelectorDisplay(container);
  return true;
}

/**
 * Open the panel and bind its follow-up-message context to a specific paper.
 * The deferred refresh also covers a newly created floating window.
 */
export function showPanelForItem(
  item: Zotero.Item,
  source: ChatPanelOpenSource = "unknown",
): void {
  pendingPanelItem = item;
  moduleCurrentItem = item;
  const manager = getChatManager();
  manager.setCurrentItemKey(item.key, item.libraryID);
  getReadingLoopService().setCurrentItem(item);
  showPanel(source);

  if (!isPanelShown()) {
    if (pendingPanelItem === item) pendingPanelItem = null;
    return;
  }

  const syncContainer = async () => {
    moduleCurrentItem = item;
    manager.setCurrentItemKey(item.key, item.libraryID);
    if (await syncPanelSessionForItem({ manager, item })) {
      if (pendingPanelItem === item) pendingPanelItem = null;
    }
  };

  runWhenPanelReady(syncContainer);
}

async function focusRunningPresentationTaskUnsafe(
  item: Zotero.Item,
  source: Extract<
    ChatPanelOpenSource,
    "presentation_menu" | "presentation_button"
  >,
  sessionId: string,
  assistantMessageId: string,
): Promise<void> {
  const manager = getChatManager();
  const session = await manager.switchSession(sessionId);
  if (!session || manager.getActiveSession()?.id !== sessionId) return;

  moduleCurrentItem = item;
  manager.setCurrentItemKey(item.key, item.libraryID);
  getReadingLoopService().setCurrentItem(item);
  pendingPanelItem = item;
  showPanel(source);
  if (!isPanelShown()) {
    if (pendingPanelItem === item) pendingPanelItem = null;
    return;
  }

  const syncAndLocate = async (): Promise<void> => {
    await syncPanelSessionForItem({
      manager,
      item,
      session,
      expectedSessionId: sessionId,
      syncNavigationState: true,
      afterRender: (container) => {
        if (pendingPanelItem === item) pendingPanelItem = null;
        const chatHistory = container.querySelector(
          "#chat-history",
        ) as HTMLElement | null;
        if (chatHistory) {
          const messageElement = scrollToAndHighlightMessage(
            chatHistory,
            assistantMessageId,
          );
          if (messageElement) {
            messageElement.setAttribute("tabindex", "-1");
            messageElement.focus({ preventScroll: true });
          }
        }
      },
    });
  };

  runWhenPanelReady(syncAndLocate);
}

/** Best-effort UI navigation must never surface as an unhandled rejection. */
export async function focusRunningPresentationTask(
  item: Zotero.Item,
  source: Extract<
    ChatPanelOpenSource,
    "presentation_menu" | "presentation_button"
  >,
  sessionId: string,
  assistantMessageId: string,
): Promise<void> {
  try {
    await focusRunningPresentationTaskUnsafe(
      item,
      source,
      sessionId,
      assistantMessageId,
    );
  } catch (error) {
    ztoolkit.log("[ChatPanel] Failed to focus presentation task:", error);
  }
}

/**
 * Bind the chat to one paper and start the dedicated presentation turn. This
 * is the only cross-module surface used by the library and panel PPT entries.
 */
export async function openPresentationForItem(
  item: Zotero.Item,
  prompt: string,
  source: Extract<
    ChatPanelOpenSource,
    "presentation_menu" | "presentation_button"
  >,
  settings: PresentationLaunchSettings,
  onTaskReady?: (focusTask: () => void) => void,
  expectedActiveSession: ChatSession | null = null,
): Promise<boolean> {
  const manager = getChatManager();
  await manager.init();
  if (getProviderManager().getActiveProviderId() !== "paperchat") {
    return false;
  }
  const selection = await selectPresentationSession(
    manager,
    source,
    expectedActiveSession,
    {
      itemKey: item.key,
      title: String(item.getField?.("title") || "PaperChat PPT"),
      libraryID: item.libraryID,
    },
  );
  if (!selection) {
    return false;
  }
  const { session } = selection;
  if (
    source === "presentation_button" &&
    !isPresentationSessionCompatibleWithPaper(
      session,
      { itemKey: item.key, libraryID: item.libraryID },
      Zotero.Libraries.userLibraryID,
    )
  ) {
    Services.prompt.alert(
      Zotero.getMainWindow() as unknown as mozIDOMWindowProxy,
      getString("presentation-chat-context-mismatch-title"),
      getString("presentation-chat-context-mismatch-message"),
    );
    return false;
  }

  const targetSessionIsActive = () =>
    manager.getActiveSession()?.id === session.id;
  if (targetSessionIsActive()) {
    moduleCurrentItem = item;
    manager.setCurrentItemKey(item.key, item.libraryID);
    getReadingLoopService().setCurrentItem(item);
    pendingPanelItem = item;
    showPanel(source);

    if (isPanelShown()) {
      runWhenPanelReady(async () => {
        if (
          await syncPanelSessionForItem({
            manager,
            item,
            session,
            expectedSessionId: session.id,
            clearAttachments: true,
          })
        ) {
          if (pendingPanelItem === item) pendingPanelItem = null;
        }
      });
    } else if (pendingPanelItem === item) {
      pendingPanelItem = null;
    }
  }

  if (getProviderManager().getActiveProviderId() !== "paperchat") {
    return false;
  }

  return manager.sendMessage(prompt, {
    item,
    attachPdf: true,
    targetSession: session,
    // A library-menu launch owns a fresh item session and may continue in the
    // background when another paper is opened. The in-chat button still
    // belongs to the conversation that was active when its settings opened.
    requireTargetSessionActive: presentationLaunchRequiresActiveSession(source),
    allowedToolNames: ["presentation"],
    allowPaperChatRetry: true,
    requiredProviderId: "paperchat",
    presentationAuthorization: createPresentationLaunchAuthorization(
      {
        itemKey: item.key,
        libraryID: item.libraryID,
      },
      settings,
    ),
    onAssistantMessageCreated: ({ sessionId, assistantMessageId }) => {
      onTaskReady?.(() => {
        void focusRunningPresentationTask(
          item,
          source,
          sessionId,
          assistantMessageId,
        );
      });
    },
  });
}

/**
 * Hide the chat panel
 */
export function hidePanel(): void {
  trackChatPanelClosed();
  if (currentPanelMode === "sidebar") {
    hideSidebarPanel();
  } else {
    closeFloatingWindow();
  }

  // Update toolbar button pressed state
  updateToolbarButtonState(false);
}

/**
 * Update toolbar button pressed state
 */
function updateToolbarButtonState(pressed: boolean): void {
  const doc = Zotero.getMainWindow().document;
  const button = doc.getElementById(
    `${config.addonRef}-toolbar-button`,
  ) as HTMLElement;
  if (button) {
    if (pressed) {
      button.style.backgroundColor = "var(--fill-quinary)";
      button.style.boxShadow = "inset 0 1px 3px rgba(0,0,0,0.2)";
    } else {
      button.style.backgroundColor = "transparent";
      button.style.boxShadow = "none";
    }
  }
}

function updateReadingLoopEntryIndicator(snapshot: ReadingLoopSnapshot): void {
  readingLoopLatestSnapshot = snapshot;
  const doc = Zotero.getMainWindow().document;
  const button = doc.getElementById(
    `${config.addonRef}-toolbar-button`,
  ) as HTMLElement | null;
  if (!button) {
    return;
  }

  let indicator = button.querySelector(
    "#paperchat-reading-loop-indicator",
  ) as HTMLElement | null;
  if (
    !snapshot.enabled ||
    snapshot.state === "idle" ||
    !snapshot.activeSuggestion
  ) {
    indicator?.remove();
    hideReadingLoopPopover(doc, 0);
    button.setAttribute(
      "title",
      getString(
        "chat-toolbar-button-tooltip" as Parameters<typeof getString>[0],
      ),
    );
    return;
  }

  ensureReadingLoopIndicatorStyles(doc);

  const visiblePopover = doc.getElementById(
    "paperchat-reading-loop-popover",
  ) as HTMLElement | null;
  if (visiblePopover?.style.display === "block") {
    showReadingLoopPopover(button);
  }

  if (!indicator) {
    indicator = doc.createElementNS(HTML_NS, "span");
    indicator.id = "paperchat-reading-loop-indicator";
    button.appendChild(indicator);
  }
  indicator.setAttribute("data-reading-loop-state", snapshot.state);

  button.setAttribute(
    "title",
    getString("reading-loop-tooltip", {
      args: { title: snapshot.activeSuggestion.title },
    }),
  );

  Object.assign(indicator.style, {
    position: "absolute",
    pointerEvents: "none",
    boxSizing: "border-box",
  } satisfies Partial<CSSStyleDeclaration>);

  if (snapshot.state === "running") {
    Object.assign(indicator.style, {
      top: "2px",
      right: "2px",
      left: "auto",
      bottom: "auto",
      minWidth: "0",
      width: "12px",
      height: "12px",
      borderRadius: "999px",
      border: "2px solid rgba(37, 99, 235, 0.95)",
      borderTopColor: "rgba(37, 99, 235, 0.18)",
      background: "transparent",
      color: "transparent",
      display: "block",
      fontSize: "0",
      lineHeight: "0",
    } satisfies Partial<CSSStyleDeclaration>);
    indicator.textContent = "";
    return;
  }

  Object.assign(indicator.style, {
    top: "3px",
    right: "3px",
    left: "auto",
    bottom: "auto",
    minWidth: "0",
    width: snapshot.state === "completed" ? "12px" : "7px",
    height: snapshot.state === "completed" ? "12px" : "7px",
    borderRadius: "999px",
    border: "1px solid var(--material-background, #fff)",
    background: getReadingLoopAccent(snapshot.state),
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "9px",
    lineHeight: "12px",
    fontWeight: "700",
  } satisfies Partial<CSSStyleDeclaration>);
  indicator.textContent = snapshot.state === "completed" ? "✓" : "";
}

function ensureReadingLoopIndicatorStyles(doc: Document): void {
  if (doc.getElementById("paperchat-reading-loop-indicator-style")) {
    return;
  }

  const style = doc.createElementNS(HTML_NS, "style") as HTMLStyleElement;
  style.id = "paperchat-reading-loop-indicator-style";
  style.textContent = `
    #paperchat-reading-loop-indicator[data-reading-loop-state="suggested"] {
      animation: paperchat-reading-loop-pulse 1.6s ease-in-out infinite;
    }

    #paperchat-reading-loop-indicator[data-reading-loop-state="running"] {
      animation: paperchat-reading-loop-spin 0.85s linear infinite;
    }

    @keyframes paperchat-reading-loop-pulse {
      0%, 100% {
        transform: scale(1);
        box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.38);
      }
      50% {
        transform: scale(1.14);
        box-shadow: 0 0 0 5px rgba(37, 99, 235, 0);
      }
    }

    @keyframes paperchat-reading-loop-spin {
      to {
        transform: rotate(360deg);
      }
    }
  `;
  doc.documentElement.appendChild(style);
}

function ensureReadingLoopToolbarSubscription(): void {
  readingLoopToolbarUnsubscribe?.();
  readingLoopToolbarUnsubscribe = getReadingLoopService().subscribe(
    updateReadingLoopEntryIndicator,
  );
}

function bindReadingLoopToolbarEvents(button: HTMLElement): void {
  if (readingLoopToolbarBoundButtons.has(button)) {
    return;
  }

  readingLoopToolbarBoundButtons.add(button);
  bindReadingLoopToolbarButtonEvents(button, {
    togglePanel: () => togglePanel("toolbar"),
    isPanelShown,
    showPopover: showReadingLoopPopover,
    hidePopover: hideReadingLoopPopover,
  });
}

function getReadingLoopPopover(doc: Document): HTMLElement {
  let popover = doc.getElementById(
    "paperchat-reading-loop-popover",
  ) as HTMLElement | null;
  if (popover) {
    return popover;
  }

  popover = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  popover.id = "paperchat-reading-loop-popover";
  Object.assign(popover.style, {
    position: "fixed",
    zIndex: "10004",
    display: "none",
    minWidth: "180px",
    maxWidth: "260px",
    padding: "8px 10px",
    borderRadius: "6px",
    boxSizing: "border-box",
    boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  doc.documentElement.appendChild(popover);
  return popover;
}

function showReadingLoopPopover(anchor: HTMLElement): void {
  const win = anchor.ownerDocument.defaultView;
  if (!win) {
    return;
  }
  if (readingLoopPopoverHideTimer != null) {
    win.clearTimeout(readingLoopPopoverHideTimer);
    readingLoopPopoverHideTimer = null;
  }

  const snapshot = readingLoopLatestSnapshot;
  const suggestion = snapshot?.activeSuggestion;
  if (!snapshot?.enabled || !suggestion || snapshot.state === "idle") {
    hideReadingLoopPopover(anchor.ownerDocument, 0);
    return;
  }

  const doc = anchor.ownerDocument;
  const theme = getCurrentTheme();
  const popover = getReadingLoopPopover(doc);
  popover.replaceChildren();

  const title = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  title.textContent = suggestion.title;
  Object.assign(title.style, {
    color: theme.textPrimary,
    fontSize: "12px",
    fontWeight: "600",
    lineHeight: "16px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  } satisfies Partial<CSSStyleDeclaration>);

  const meta = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  meta.textContent =
    snapshot.state === "running"
      ? getString("reading-loop-processing")
      : suggestion.reason ||
        getString("reading-loop-tooltip", {
          args: { title: suggestion.title },
        });
  Object.assign(meta.style, {
    color: theme.textMuted,
    fontSize: "11px",
    lineHeight: "15px",
    marginTop: "2px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  } satisfies Partial<CSSStyleDeclaration>);

  popover.appendChild(title);
  popover.appendChild(meta);
  Object.assign(popover.style, {
    display: "block",
    background: theme.dropdownBg,
    border: `1px solid ${theme.borderColor}`,
  } satisfies Partial<CSSStyleDeclaration>);

  const anchorRect = anchor.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const viewportWidth = doc.defaultView?.innerWidth || anchorRect.right + 260;
  const left = Math.max(
    8,
    Math.min(
      anchorRect.right - popoverRect.width,
      viewportWidth - popoverRect.width - 8,
    ),
  );
  const top = anchorRect.bottom + 6;
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function hideReadingLoopPopover(doc: Document, delayMs = 120): void {
  const win = doc.defaultView;
  if (!win) {
    return;
  }
  if (readingLoopPopoverHideTimer != null) {
    win.clearTimeout(readingLoopPopoverHideTimer);
  }
  readingLoopPopoverHideTimer = win.setTimeout(() => {
    const popover = doc.getElementById("paperchat-reading-loop-popover");
    if (popover) {
      (popover as HTMLElement).style.display = "none";
    }
    readingLoopPopoverHideTimer = null;
  }, delayMs);
}

/**
 * Sync sidebar state based on panel visibility and mode
 */
function syncSidebarState(): void {
  if (isPanelShown() && currentPanelMode === "sidebar") {
    // Sidebar panel is open - update position
    updateSidebarContainerPosition();
    refreshChatForCurrentItem();
  } else if (!isPanelShown() && currentPanelMode === "sidebar") {
    // Sidebar panel is closed - collapse sidebar
    collapseSidebar();
  }
}

/**
 * Register global tab notifier for sidebar sync
 */
function registerGlobalTabNotifier(): void {
  if (globalTabNotifierID) return;

  globalTabNotifierID = Zotero.Notifier.registerObserver(
    {
      notify: () => {
        // Sync sidebar state when switching tabs
        syncSidebarState();
      },
    },
    ["tab"],
    `${config.addonRef}-global-tab-notifier`,
  );
  ztoolkit.log("Global tab notifier registered");
}

/**
 * Unregister global tab notifier
 */
function unregisterGlobalTabNotifier(): void {
  if (globalTabNotifierID) {
    Zotero.Notifier.unregisterObserver(globalTabNotifierID);
    globalTabNotifierID = null;
    ztoolkit.log("Global tab notifier unregistered");
  }
}

/**
 * Toggle the chat panel
 */
export function togglePanel(source: ChatPanelOpenSource = "unknown"): void {
  if (isPanelShown()) {
    hidePanel();
  } else {
    showPanel(source);
  }
}

/**
 * Register toolbar button
 */
export function registerToolbarButton(): void {
  const doc = Zotero.getMainWindow().document;

  const existingButton = doc.getElementById(
    `${config.addonRef}-toolbar-button`,
  ) as HTMLElement | null;
  if (existingButton) {
    existingButton.style.position = "relative";
    ensureReadingLoopToolbarSubscription();
    bindReadingLoopToolbarEvents(existingButton);
    return;
  }

  const anchor = doc.querySelector(
    "#zotero-tabs-toolbar > .zotero-tb-separator",
  );
  if (!anchor) {
    ztoolkit.log("Tabs toolbar separator not found");
    return;
  }

  const button = ztoolkit.UI.insertElementBefore(
    {
      tag: "div",
      namespace: "html",
      id: `${config.addonRef}-toolbar-button`,
      attributes: {
        title: getString(
          "chat-toolbar-button-tooltip" as Parameters<typeof getString>[0],
        ),
      },
      styles: {
        backgroundImage: `url(chrome://${config.addonRef}/content/icons/favicon.svg)`,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "center",
        backgroundSize: "18px",
        display: "flex",
        position: "relative",
        width: "28px",
        height: "28px",
        alignItems: "center",
        borderRadius: "5px",
        cursor: "pointer",
      },
    },
    anchor.nextElementSibling as Element,
  ) as HTMLElement;

  ensureReadingLoopToolbarSubscription();
  bindReadingLoopToolbarEvents(button);

  // Register global tab notifier for sidebar sync across tabs
  registerGlobalTabNotifier();

  // Initialize guide prefs and show guide if needed
  Guide.initPrefs();
  setTimeout(() => {
    Guide.showToolbarGuideIfNeed(Zotero.getMainWindow());
  }, 500);

  ztoolkit.log("Toolbar button registered", button);
}

/**
 * Unregister toolbar button
 */
export function unregisterToolbarButton(): void {
  readingLoopToolbarUnsubscribe?.();
  readingLoopToolbarUnsubscribe = null;

  const doc = Zotero.getMainWindow().document;
  const button = doc.getElementById(`${config.addonRef}-toolbar-button`);
  if (button) {
    button.remove();
  }
  doc.getElementById("paperchat-reading-loop-popover")?.remove();
  doc.getElementById("paperchat-reading-loop-indicator-style")?.remove();

  // Unregister global tab notifier
  unregisterGlobalTabNotifier();
}

/**
 * Create context for event handlers
 */
function clearPendingQuotedMessages(context: ChatPanelContext): void {
  if (pendingQuotedMessages.length === 0) return;
  pendingQuotedMessages = [];
  context.updateAttachmentsPreview();
}

async function navigateToQuotedMessage(
  context: ChatPanelContext,
  quote: QuotedMessageRef,
): Promise<void> {
  const navigationGeneration =
    (quotedMessageNavigationGenerations.get(context.container) || 0) + 1;
  quotedMessageNavigationGenerations.set(
    context.container,
    navigationGeneration,
  );
  const isLatestNavigation = () =>
    quotedMessageNavigationGenerations.get(context.container) ===
    navigationGeneration;
  const manager = context.chatManager;
  const currentSession = manager.getActiveSession();
  const chatHistory = context.container.querySelector(
    "#chat-history",
  ) as HTMLElement | null;
  const targetInCurrentSession = currentSession?.messages.some(
    (message) => message.id === quote.messageId,
  );

  if (targetInCurrentSession && chatHistory) {
    if (scrollToAndHighlightMessage(chatHistory, quote.messageId)) return;
    context.renderMessages(currentSession!.messages, () => {
      if (!isLatestNavigation()) return;
      if (manager.getActiveSession()?.id !== currentSession!.id) return;
      if (!scrollToAndHighlightMessage(chatHistory, quote.messageId)) {
        context.appendError(getString("chat-quoted-reply-unavailable"));
      }
    });
    return;
  }

  if (currentSession?.id === quote.sessionId) {
    context.appendError(getString("chat-quoted-reply-unavailable"));
    return;
  }

  const sourceSession = await manager.switchSession(quote.sessionId);
  if (!isLatestNavigation()) return;
  if (!sourceSession) {
    if (manager.getActiveSession()?.id === currentSession?.id) {
      context.appendError(getString("chat-quoted-reply-unavailable"));
    }
    return;
  }
  if (manager.getActiveSession()?.id !== quote.sessionId) return;

  clearPendingQuotedMessages(context);
  const item = getItemByLibraryKey(
    sourceSession.lastActiveItemKey,
    sourceSession.lastActiveItemLibraryID,
  );
  context.setCurrentItem(item);
  await context.updatePdfCheckboxVisibility(item);
  if (!isLatestNavigation()) return;
  if (manager.getActiveSession()?.id !== sourceSession.id) return;
  context.renderMessages(sourceSession.messages, () => {
    if (!isLatestNavigation()) return;
    if (manager.getActiveSession()?.id !== sourceSession.id) return;
    const sourceHistory = context.container.querySelector(
      "#chat-history",
    ) as HTMLElement | null;
    if (
      !sourceHistory ||
      !scrollToAndHighlightMessage(sourceHistory, quote.messageId)
    ) {
      context.appendError(getString("chat-quoted-reply-unavailable"));
    }
  });
  context.renderExecutionPlan(sourceSession.executionPlan);
  updateModelSelectorDisplay(context.container);
  syncSendButtonState(
    context.container.querySelector(
      "#chat-send-button",
    ) as HTMLButtonElement | null,
    manager,
  );
}

function addAssistantReplyQuote(
  context: ChatPanelContext,
  assistantMessageId: string,
): void {
  const session = context.chatManager.getActiveSession();
  const message = session?.messages.find(
    (candidate) => candidate.id === assistantMessageId,
  );
  if (!session || !message || !canQuoteAssistantReply(message)) {
    context.appendError(getString("chat-quoted-reply-unavailable"));
    return;
  }

  const visibleContent = formatMarkdownForMessageCopy(message.content, {
    evidenceRecords: message.evidence,
  });
  if (!canQuoteAssistantReply(message, visibleContent)) {
    context.appendError(getString("chat-quoted-reply-unavailable"));
    return;
  }

  pendingQuotedMessages = appendPendingQuotedMessage(
    pendingQuotedMessages,
    createQuotedMessageRef(session.id, message, visibleContent),
  );
  syncPendingAttachmentsPreviews(context.container);
  focusInput(context.container);
}

function cloneAttachmentState(state: AttachmentState): AttachmentState {
  return {
    pendingImages: state.pendingImages.map((image) => ({ ...image })),
    pendingFiles: [...state.pendingFiles],
    pinnedSelectedTexts: [...(state.pinnedSelectedTexts || [])],
    pendingSelectedText: state.pendingSelectedText,
    pendingQuotedMessages: [...state.pendingQuotedMessages],
  };
}

function renderPendingAttachmentsPreview(container: HTMLElement): void {
  updateAttachmentsPreviewDisplay(
    container,
    {
      pendingImages,
      pendingFiles,
      pinnedSelectedTexts,
      pendingSelectedText,
      pendingQuotedMessages,
    },
    {
      onRemoveImage: (index) => {
        if (index < 0 || index >= pendingImages.length) return;
        pendingImages = pendingImages.filter(
          (_image, imageIndex) => imageIndex !== index,
        );
        syncPendingAttachmentsPreviews(container);
      },
      onRemoveQuote: (index) => {
        if (index < 0 || index >= pendingQuotedMessages.length) return;
        pendingQuotedMessages = pendingQuotedMessages.filter(
          (_quote, quoteIndex) => quoteIndex !== index,
        );
        syncPendingAttachmentsPreviews(container);
      },
      onRemoveSelectedText: () => {
        pendingSelectedText = null;
        syncPendingAttachmentsPreviews(container);
      },
      onPinSelectedText: () => {
        if (!pendingSelectedText) return;
        pinnedSelectedTexts = [...pinnedSelectedTexts, pendingSelectedText];
        pendingSelectedText = null;
        syncPendingAttachmentsPreviews(container);
      },
      onRemovePinnedSelectedText: (index) => {
        if (index < 0 || index >= pinnedSelectedTexts.length) return;
        pinnedSelectedTexts = pinnedSelectedTexts.filter(
          (_text, textIndex) => textIndex !== index,
        );
        syncPendingAttachmentsPreviews(container);
      },
      onNavigateQuote: (quote) =>
        navigateToQuotedMessage(createContext(container), quote),
    },
  );
}

function syncPendingAttachmentsPreviews(extraContainer?: HTMLElement): void {
  const containers = new Set<HTMLElement>();
  if (chatContainer) containers.add(chatContainer);
  if (floatingContainer) containers.add(floatingContainer);
  if (extraContainer) containers.add(extraContainer);
  for (const container of containers) {
    if (container.isConnected) renderPendingAttachmentsPreview(container);
  }
}

async function continueInNewChatFromMessage(
  context: ChatPanelContext,
  assistantMessageId: string,
): Promise<void> {
  try {
    const forkedSession =
      await context.chatManager.forkCurrentSessionAtMessage(assistantMessageId);
    const item = getItemByLibraryKey(
      forkedSession.lastActiveItemKey,
      forkedSession.lastActiveItemLibraryID,
    );
    context.setCurrentItem(item);

    context.clearAttachments();
    context.updateAttachmentsPreview();
    context.renderMessages(forkedSession.messages);
    context.renderExecutionPlan(forkedSession.executionPlan);
    updateModelSelectorDisplay(context.container);
    syncSendButtonState(
      context.container.querySelector(
        "#chat-send-button",
      ) as HTMLButtonElement | null,
      context.chatManager,
    );
    await context.updatePdfCheckboxVisibility(item);
    focusInput(context.container);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.appendError(
      `${getString("chat-continue-in-new-chat-failed")}: ${message}`,
    );
    throw error;
  }
}

function createContext(container: HTMLElement): ChatPanelContext {
  const manager = getChatManager();
  const authManager = getAuthManager();

  const context: ChatPanelContext = {
    container: container,
    chatManager: manager,
    authManager,
    getCurrentItem: () => {
      if (!moduleCurrentItem) {
        moduleCurrentItem = getActiveReaderItem();
        if (moduleCurrentItem && container) {
          updatePdfCheckboxVisibilityForItem(
            container,
            moduleCurrentItem,
            manager,
          );
        }
      }
      return moduleCurrentItem;
    },
    setCurrentItem: (item: Zotero.Item | null) => {
      moduleCurrentItem = item;
    },
    getTheme: getCurrentTheme,
    getAttachmentState: () =>
      cloneAttachmentState({
        pendingImages,
        pendingFiles,
        pinnedSelectedTexts,
        pendingSelectedText,
        pendingQuotedMessages,
      }),
    setAttachmentState: (state) => {
      const nextState = cloneAttachmentState(state);
      if (!isImageAttachmentDraftWithinLimits(nextState.pendingImages)) return;
      pendingImages = nextState.pendingImages;
      pendingFiles = nextState.pendingFiles;
      pinnedSelectedTexts = nextState.pinnedSelectedTexts;
      pendingSelectedText = nextState.pendingSelectedText;
      pendingQuotedMessages = nextState.pendingQuotedMessages;
    },
    clearAttachments: () => {
      pendingImages = [];
      pendingFiles = [];
      pinnedSelectedTexts = [];
      pendingSelectedText = null;
      pendingQuotedMessages = [];
    },
    updateAttachmentsPreview: () => {
      if (container) {
        syncPendingAttachmentsPreviews(container);
      }
    },
    updateUserBar: () => {
      if (container) {
        updateUserBarDisplay(container, authManager);
      }
    },
    updatePdfCheckboxVisibility: async (item: Zotero.Item | null) => {
      if (container) {
        await updatePdfCheckboxVisibilityForItem(container, item, manager);
      }
    },
    summarizeConversationToNote: () => summarizeConversationToNote(context),
    launchPresentation: async (assistantMessageId?: string) => {
      const session = manager.getActiveSession();
      const taskMessage = assistantMessageId
        ? session?.messages.find(
            (message) =>
              message.id === assistantMessageId && message.role === "assistant",
          )
        : undefined;
      const sessionItem = session?.lastActiveItemKey
        ? getItemByLibraryKey(
            session.lastActiveItemKey,
            session.lastActiveItemLibraryID,
          )
        : null;
      const item = assistantMessageId
        ? getPresentationItemForMessage(taskMessage, session)
        : resolvePresentationPaperFromCandidates(
            sessionItem,
            moduleCurrentItem,
            getActiveReaderItem(),
            getSingleSelectedPresentationPaper(),
          );
      if (!item) {
        Services.prompt.alert(
          Zotero.getMainWindow() as unknown as mozIDOMWindowProxy,
          getString("presentation-source-unavailable-title"),
          getString("presentation-source-unavailable-message"),
        );
        return false;
      }
      return launchPresentationForItem(
        item,
        "chat_button",
        (launchItem, prompt, source, settings, onTaskReady) =>
          openPresentationForItem(
            launchItem,
            prompt,
            source,
            settings,
            onTaskReady,
            session,
          ),
        container.ownerDocument.defaultView || undefined,
      );
    },
    renderMessages: (
      messages: ChatMessage[],
      onRenderComplete?: () => void,
    ) => {
      if (container) {
        cancelPendingStreamingTextRender(container);
        const chatHistory = container.querySelector(
          "#chat-history",
        ) as HTMLElement;
        const planPanel = container.querySelector(
          "#chat-execution-plan-panel",
        ) as HTMLElement;
        const emptyState = container.querySelector(
          "#chat-empty-state",
        ) as HTMLElement;
        const session = manager.getActiveSession();
        const supportsToolCalling = providerSupportsToolCalling(
          getProviderManager().getActiveProvider(),
        );
        const queueFailureErrorId = session
          ? sessionTurnQueue.snapshot(session.id).failureErrorId
          : undefined;
        const retryableErrorMessageId =
          queueFailureErrorId ||
          (getProviderManager().getActiveProviderId() === "paperchat"
            ? session?.lastRetryableErrorMessageId
            : undefined);
        if (chatHistory) {
          renderMessageElementsWithMarkdownActions(
            chatHistory,
            emptyState,
            messages,
            () => getQuoteNavigationItem(session, moduleCurrentItem),
            {
              retryableErrorMessageId,
              onRetry: async () => {
                if (
                  session &&
                  retryableErrorMessageId &&
                  (await sessionTurnQueue.retry(
                    session.id,
                    retryableErrorMessageId,
                  ))
                ) {
                  return;
                }
                const retried = await manager.retryCurrentPaperChatFailure();
                if (!retried) {
                  throw new Error(getString("chat-retry-unavailable"));
                }
              },
              onRetryError: (error) => {
                context.appendError(error.message);
              },
              onReroll: async () => {
                await context.rerollPaperChatTierForCurrentSession();
              },
              onRerollError: (error) => {
                context.appendError(error.message);
              },
              onFork: (assistantMessageId) =>
                continueInNewChatFromMessage(context, assistantMessageId),
              onQuoteReply: (assistantMessageId) =>
                addAssistantReplyQuote(context, assistantMessageId),
              onNavigateToQuotedMessage: (quote) =>
                navigateToQuotedMessage(context, quote),
              onSummarizeReply: supportsToolCalling
                ? (assistantMessageId) =>
                    summarizeReplyToNote(context, assistantMessageId)
                : undefined,
              onSummarizeReplyError: (error) => {
                context.appendError(error.message);
              },
              onResumePresentation: (assistantMessageId) =>
                context.launchPresentation(assistantMessageId),
              onResumePresentationError: (error) => {
                ztoolkit.log(
                  "[ChatPanel] Failed to resume presentation:",
                  error,
                );
                context.appendError(
                  `${getString("chat-presentation-progress-resume-failed")}: ${error.message}`,
                );
              },
              onCancelPresentation: () =>
                session ? manager.cancelSessionTurn(session.id) : false,
              onCancelPresentationError: (error) => {
                ztoolkit.log(
                  "[ChatPanel] Failed to cancel presentation:",
                  error,
                );
                context.appendError(error.message);
              },
              onMarkdownError: context.appendError,
              onRenderComplete,
            },
          );
        }
        updateConversationNoteSummaryButton(
          container,
          messages,
          session?.id,
          supportsToolCalling,
        );
        if (planPanel) {
          updateExecutionInsetsForContainer(
            container,
            manager,
            manager.getActiveSession()?.executionPlan,
          );
        }
        if (!NextQuestionHintController.get(container)) {
          NextQuestionHintController.attach(context);
        }
        requestNextQuestionHintAfterRecentRender(container);
      }
    },
    renderExecutionPlan: (plan?: ExecutionPlan) => {
      if (!container) return;
      updateExecutionInsetsForContainer(container, manager, plan);
    },
    appendError: (errorMessage: string) => {
      ztoolkit.log(
        "[ChatPanel] appendError called:",
        errorMessage.substring(0, 100),
      );
      ztoolkit.log("[ChatPanel] container:", container ? "exists" : "null");

      if (container) {
        const chatHistory = container.querySelector(
          "#chat-history",
        ) as HTMLElement;
        const doc = container.ownerDocument;
        ztoolkit.log(
          "[ChatPanel] chatHistory:",
          chatHistory ? "exists" : "null",
        );
        ztoolkit.log("[ChatPanel] doc:", doc ? "exists" : "null");

        if (chatHistory && doc) {
          const wrapper = doc.createElement("div");
          wrapper.className = "message-wrapper error-message-wrapper";

          const bubble = doc.createElement("div");
          bubble.className = "message-bubble error-bubble";
          bubble.style.cssText = `background: ${chatColors.errorBubbleBg}; border: 1px solid ${chatColors.errorBubbleBorder}; color: ${chatColors.errorBubbleText}; padding: 12px; border-radius: 8px; margin: 8px 0;`;

          const content = doc.createElement("div");
          content.className = "message-content";
          content.textContent = `⚠️ ${errorMessage}`;

          bubble.appendChild(content);
          wrapper.appendChild(bubble);
          chatHistory.appendChild(wrapper);
          if (shouldAutoScrollChatHistory(chatHistory)) {
            scrollChatHistoryToBottom(chatHistory);
          } else {
            updateChatHistoryScrollBottomButton(chatHistory);
          }
          ztoolkit.log("[ChatPanel] Error message appended to chat history");
        }
      }
    },
    rerollPaperChatTierForCurrentSession: async () => {
      const reroute = await manager.rerollCurrentPaperChatFailureAndRetry();
      if (!reroute) {
        throw new Error(getString("chat-reroll-unavailable"));
      }
      updateModelSelectorDisplay(container);
      return reroute;
    },
  };

  return context;
}

/**
 * Initialize chat content and event handlers (for sidebar)
 */
async function initializeChatContent(): Promise<void> {
  if (!chatContainer) return;
  await initializeChatContentCommon(chatContainer);
}

/**
 * Refresh chat content for current item (for sidebar)
 */
async function refreshChatForCurrentItem(): Promise<void> {
  if (!chatContainer) return;
  await refreshChatForContainer(chatContainer);
}

/**
 * Unregister all and clean up
 */
export async function unregisterAll(): Promise<void> {
  // Close floating window
  closeFloatingWindow();

  // Remove container
  if (chatContainer) {
    cancelPendingStreamingTextRender(chatContainer);
    cleanupPanelIntegrations(chatContainer);
    chatContainer.remove();
    chatContainer = null;
  }

  // Reset initialization flags
  contentInitialized = false;
  floatingContentInitialized = false;

  // Remove toolbar button
  unregisterToolbarButton();

  // Clean up listeners
  if (resizeHandler) {
    Zotero.getMainWindow().removeEventListener("resize", resizeHandler);
    resizeHandler = null;
  }

  if (sidebarObserver) {
    sidebarObserver.disconnect();
    sidebarObserver = null;
  }

  if (tabNotifierID) {
    Zotero.Notifier.unregisterObserver(tabNotifierID);
    tabNotifierID = null;
  }

  // Clean up theme listener
  if (themeCleanup) {
    themeCleanup();
    themeCleanup = null;
  }

  // Destroy chat manager — await so DB writes complete before StorageDatabase is torn down
  if (chatManager) {
    sessionTurnQueue.clearAll();
    await chatManager.destroy();
    chatManager = null;
  }

  // Clear attachment state
  pendingImages = [];
  pendingFiles = [];
  pinnedSelectedTexts = [];
  pendingSelectedText = null;
  pendingQuotedMessages = [];
  moduleCurrentItem = null;
  pendingPanelItem = null;
}

/**
 * Add selected text as attachment
 */
export function addSelectedTextAttachment(text: string): void {
  // A reader selection is a single context source: replacing it keeps the
  // outbound request unambiguous and prevents stale passages from accumulating.
  const trimmed = text.trim();
  if (!trimmed) return;
  pendingSelectedText = trimmed;
  syncPendingAttachmentsPreviews();
}

function getImageAttachmentByteLength(image: ImageAttachment): number | null {
  if (image.type !== "base64") return null;
  if (
    image.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
  ) {
    return null;
  }
  const padding = image.data.endsWith("==")
    ? 2
    : image.data.endsWith("=")
      ? 1
      : 0;
  return Math.floor((image.data.length * 3) / 4) - padding;
}

/** Validate every image before it is restored, queued, or sent. */
export function isImageAttachmentDraftWithinLimits(
  images: readonly ImageAttachment[],
): boolean {
  if (!Array.isArray(images) || images.length > MAX_PENDING_IMAGE_ATTACHMENTS) {
    return false;
  }

  let draftBytes = 0;
  for (const image of images) {
    if (
      !image ||
      image.type !== "base64" ||
      typeof image.data !== "string" ||
      !image.data ||
      typeof image.mimeType !== "string" ||
      !image.mimeType.startsWith("image/")
    ) {
      return false;
    }

    const imageBytes = getImageAttachmentByteLength(image);
    if (imageBytes === null || imageBytes > MAX_PENDING_IMAGE_BYTES) {
      return false;
    }
    draftBytes += imageBytes;
    if (draftBytes > MAX_PENDING_IMAGE_DRAFT_BYTES) return false;
  }
  return true;
}

/** Return whether an image can be added without exceeding draft limits. */
export function canAddImageAttachmentToDraft(
  images: readonly ImageAttachment[],
  image: ImageAttachment,
): boolean {
  if (
    !Array.isArray(images) ||
    images.length >= MAX_PENDING_IMAGE_ATTACHMENTS
  ) {
    return false;
  }
  return isImageAttachmentDraftWithinLimits([...images, image]);
}

/** Add an image to the existing pending-attachment preview/send pipeline. */
export function addImageAttachment(image: ImageAttachment): boolean {
  if (!canAddImageAttachmentToDraft(pendingImages, image)) return false;

  pendingImages = [
    ...pendingImages,
    {
      type: image.type,
      data: image.data,
      mimeType: image.mimeType,
      ...(image.name ? { name: image.name } : {}),
    },
  ];
  syncPendingAttachmentsPreviews();
  return true;
}
