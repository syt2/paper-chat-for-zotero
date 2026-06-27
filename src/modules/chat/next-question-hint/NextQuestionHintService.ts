import type { ChatMessage, ChatSession } from "../../../types/chat";
import type { AIProvider } from "../../../types/provider";
import { getProviderManager } from "../../providers";
import { getPref } from "../../../utils/prefs";
import { createAbortController } from "../../../utils/abort";

export interface NextQuestionHint {
  id: string;
  text: string;
  sessionId: string;
  assistantMessageId: string;
  createdAt: number;
  expiresAt: number;
}

export type NextQuestionHintOutcome =
  | { status: "generated"; hint: NextQuestionHint }
  | { status: "skipped"; reason: string };

export interface NextQuestionHintReadingContext {
  itemKey?: string;
  title?: string;
  authors?: string[];
  year?: string;
  abstract?: string;
  tags?: string[];
  selectedText?: string;
  currentPage?: number;
  pageCount?: number;
}

export interface NextQuestionHintRequest {
  session: ChatSession | null;
  currentInputValue: string;
  readingContext?: NextQuestionHintReadingContext;
  signal?: AbortSignal;
}

const MIN_ASSISTANT_CONTENT_LENGTH = 80;
const MAX_ASSISTANT_CONTEXT_CHARS = 2400;
const MAX_USER_CONTEXT_CHARS = 900;
const MAX_RECENT_CONTEXT_CHARS = 1800;
const MAX_SESSION_SUMMARY_CHARS = 1200;
const MAX_READING_CONTEXT_CHARS = 2600;
const MAX_READING_ABSTRACT_CHARS = 1600;
const MAX_SELECTED_TEXT_CHARS = 1200;
const MAX_HINT_CHARS = 80;
const HINT_TTL_MS = 2 * 60 * 1000;
const GENERATION_TIMEOUT_MS = 15000;
const SESSION_IGNORED_LIMIT = 3;
const MAX_TRACKED_MESSAGE_IDS = 400;
const MAX_TRACKED_SESSIONS = 100;

class NextQuestionHintService {
  private requestedAssistantMessageIds = new Set<string>();
  private acceptedAssistantMessageIds = new Set<string>();
  private dismissedAssistantMessageIds = new Set<string>();
  private ignoredBySession = new Map<string, number>();

  async generateForCompletion(
    request: NextQuestionHintRequest,
  ): Promise<NextQuestionHintOutcome> {
    if (getPref("nextQuestionHintEnabled") === false) {
      return { status: "skipped", reason: "disabled" };
    }

    if (request.currentInputValue.trim()) {
      return { status: "skipped", reason: "input_not_empty" };
    }

    const session = request.session;
    if (!session) {
      return { status: "skipped", reason: "no_session" };
    }

    if ((this.ignoredBySession.get(session.id) || 0) >= SESSION_IGNORED_LIMIT) {
      return { status: "skipped", reason: "session_quieted" };
    }

    const turn = this.getLastCompletedTurn(session.messages);
    if (!turn) {
      return { status: "skipped", reason: "no_completed_turn" };
    }

    const { userMessage, assistantMessage } = turn;
    if (this.requestedAssistantMessageIds.has(assistantMessage.id)) {
      return { status: "skipped", reason: "already_requested" };
    }
    if (
      this.acceptedAssistantMessageIds.has(assistantMessage.id) ||
      this.dismissedAssistantMessageIds.has(assistantMessage.id)
    ) {
      return { status: "skipped", reason: "already_resolved" };
    }

    const assistantContent = this.cleanMessageContent(assistantMessage.content);
    if (assistantContent.length < MIN_ASSISTANT_CONTENT_LENGTH) {
      return { status: "skipped", reason: "assistant_reply_too_short" };
    }

    const provider = this.getHintProvider();
    if (!provider?.isReady()) {
      return { status: "skipped", reason: "provider_not_ready" };
    }

    rememberSetValue(this.requestedAssistantMessageIds, assistantMessage.id);

    const generationController = createAbortController();
    let abortedByRequest = false;
    let timedOut = false;
    const abortForwarder = () => {
      abortedByRequest = true;
      generationController.abort();
    };
    request.signal?.addEventListener("abort", abortForwarder, { once: true });

    try {
      const raw = await withTimeout(
        provider.chatCompletion(
          this.buildPromptMessages({
            userMessage,
            assistantMessage,
            session,
            readingContext: request.readingContext,
          }),
          generationController.signal,
        ),
        GENERATION_TIMEOUT_MS,
        () => {
          timedOut = true;
          generationController.abort();
        },
      );
      const text = normalizeHintText(raw);
      if (!text) {
        return { status: "skipped", reason: "invalid_hint" };
      }

      return {
        status: "generated",
        hint: this.createHint(session.id, assistantMessage.id, text),
      };
    } catch (error) {
      if (!timedOut && !abortedByRequest && !request.signal?.aborted) {
        ztoolkit.log("[NextQuestionHint] generation skipped:", error);
      }
      if (abortedByRequest || request.signal?.aborted) {
        this.requestedAssistantMessageIds.delete(assistantMessage.id);
        return { status: "skipped", reason: "generation_aborted" };
      }
      return {
        status: "skipped",
        reason: timedOut ? "generation_timeout" : "generation_failed",
      };
    } finally {
      request.signal?.removeEventListener("abort", abortForwarder);
    }
  }

  markAccepted(hint: NextQuestionHint): void {
    rememberSetValue(this.acceptedAssistantMessageIds, hint.assistantMessageId);
    this.ignoredBySession.delete(hint.sessionId);
  }

  markDismissed(hint: NextQuestionHint): void {
    rememberSetValue(
      this.dismissedAssistantMessageIds,
      hint.assistantMessageId,
    );
    this.ignoredBySession.set(
      hint.sessionId,
      (this.ignoredBySession.get(hint.sessionId) || 0) + 1,
    );
    pruneMap(this.ignoredBySession, MAX_TRACKED_SESSIONS);
  }

  private getLastCompletedTurn(
    messages: ChatMessage[],
  ): { userMessage: ChatMessage; assistantMessage: ChatMessage } | null {
    for (let index = messages.length - 1; index >= 0; index--) {
      const assistantMessage = messages[index];
      if (
        assistantMessage.role !== "assistant" ||
        assistantMessage.apiOnly ||
        assistantMessage.streamingState ||
        assistantMessage.isSystemNotice
      ) {
        continue;
      }

      for (let prev = index - 1; prev >= 0; prev--) {
        const userMessage = messages[prev];
        if (userMessage.role === "user" && !userMessage.apiOnly) {
          return { userMessage, assistantMessage };
        }
      }
      return null;
    }
    return null;
  }

  private buildPromptMessages(input: {
    session: ChatSession;
    userMessage: ChatMessage;
    assistantMessage: ChatMessage;
    readingContext?: NextQuestionHintReadingContext;
  }): ChatMessage[] {
    const { session, userMessage, assistantMessage, readingContext } = input;
    const title = session.title?.trim();
    const paperContext = title ? `\nCurrent paper/session title: ${title}` : "";
    const readingContextText = buildReadingContextText(readingContext);
    const recentConversationText = this.buildRecentConversationContext(
      session.messages,
      userMessage.id,
    );
    const sessionSummaryText = session.contextSummary?.content
      ? truncate(
          this.cleanMessageContent(session.contextSummary.content),
          MAX_SESSION_SUMMARY_CHARS,
        )
      : "";
    const selectedText = truncate(
      readingContext?.selectedText || userMessage.selectedText || "",
      MAX_SELECTED_TEXT_CHARS,
    );
    const userText = truncate(
      this.cleanMessageContent(userMessage.content),
      MAX_USER_CONTEXT_CHARS,
    );
    const assistantText = truncate(
      this.cleanMessageContent(assistantMessage.content),
      MAX_ASSISTANT_CONTEXT_CHARS,
    );

    return [
      {
        id: "next-question-hint-system",
        role: "system",
        content: [
          "You generate one lightweight follow-up question for an academic reading chat.",
          "Return plain text only.",
          "Do not answer the question.",
          "Do not include quotes, numbering, bullets, markdown, or multiple options.",
          "Use the same language as the user's last message.",
          "Keep it concise: Chinese <= 35 characters; English <= 14 words.",
        ].join("\n"),
        timestamp: Date.now(),
        apiOnly: true,
      },
      {
        id: "next-question-hint-user",
        role: "user",
        content: [
          "Based on the last user question and assistant answer, propose exactly one natural next question the reader may ask.",
          paperContext,
          readingContextText
            ? `\nCurrent reading context:\n${readingContextText}`
            : "",
          sessionSummaryText
            ? `\nPrevious conversation summary:\n${sessionSummaryText}`
            : "",
          recentConversationText
            ? `\nRecent conversation before the last turn:\n${recentConversationText}`
            : "",
          selectedText
            ? `\nPDF text selected or referenced by the reader:\n${selectedText}`
            : "",
          "\nLast user question:",
          userText,
          "\nAssistant answer:",
          assistantText,
        ].join("\n"),
        timestamp: Date.now(),
        apiOnly: true,
      },
    ];
  }

  private getHintProvider(): AIProvider | null {
    return getProviderManager().getActiveProvider();
  }

  private buildRecentConversationContext(
    messages: ChatMessage[],
    beforeMessageId: string,
  ): string {
    const beforeIndex = messages.findIndex(
      (message) => message.id === beforeMessageId,
    );
    if (beforeIndex <= 0) {
      return "";
    }

    const recentMessages = messages
      .slice(0, beforeIndex)
      .filter(isConversationalContextMessage)
      .slice(-6);
    let text = "";
    for (const message of recentMessages) {
      const role = message.role === "assistant" ? "Assistant" : "User";
      const entry = `${role}: ${truncate(
        this.cleanMessageContent(message.content),
        600,
      )}\n`;
      if (text.length + entry.length > MAX_RECENT_CONTEXT_CHARS) {
        break;
      }
      text += entry;
    }
    return text.trim();
  }

  private createHint(
    sessionId: string,
    assistantMessageId: string,
    text: string,
  ): NextQuestionHint {
    const now = Date.now();
    return {
      id: `${sessionId}:${assistantMessageId}`,
      text,
      sessionId,
      assistantMessageId,
      createdAt: now,
      expiresAt: now + HINT_TTL_MS,
    };
  }

  private cleanMessageContent(content: string): string {
    return content
      .replace(/<tool-call[\s\S]*?<\/tool-call>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}

function isConversationalContextMessage(message: ChatMessage): boolean {
  return (
    (message.role === "user" || message.role === "assistant") &&
    !message.apiOnly &&
    !message.isSystemNotice &&
    !message.streamingState &&
    message.content.trim().length > 0
  );
}

function buildReadingContextText(
  context?: NextQuestionHintReadingContext,
): string {
  if (!context) {
    return "";
  }

  const parts: string[] = [];
  if (context.title) {
    parts.push(`Paper title: ${context.title}`);
  }
  if (context.authors?.length) {
    parts.push(`Authors: ${context.authors.slice(0, 6).join(", ")}`);
  }
  if (context.year) {
    parts.push(`Year: ${context.year}`);
  }
  if (context.itemKey) {
    parts.push(`Zotero item key: ${context.itemKey}`);
  }
  if (context.currentPage) {
    const pageText = context.pageCount
      ? `${context.currentPage} of ${context.pageCount}`
      : `${context.currentPage}`;
    parts.push(`Current reader page: ${pageText}`);
  }
  if (context.tags?.length) {
    parts.push(`Tags: ${context.tags.slice(0, 8).join(", ")}`);
  }
  if (context.abstract) {
    parts.push(
      `Abstract: ${truncate(context.abstract, MAX_READING_ABSTRACT_CHARS)}`,
    );
  }

  return truncate(parts.join("\n"), MAX_READING_CONTEXT_CHARS);
}

function normalizeHintText(raw: string): string | null {
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return null;
  }

  const text = firstLine
    .replace(/^[-*•\d.)、\s]+/, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || text.length > MAX_HINT_CHARS || text.includes("\n")) {
    return null;
  }
  if (/[。.!?？]$/.test(text)) {
    return text;
  }
  return /[\u4e00-\u9fff]/.test(text) ? `${text}？` : `${text}?`;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars).trim()}...`;
}

function rememberSetValue(set: Set<string>, value: string): void {
  set.add(value);
  while (set.size > MAX_TRACKED_MESSAGE_IDS) {
    const oldest = set.values().next().value;
    if (!oldest) {
      break;
    }
    set.delete(oldest);
  }
}

function pruneMap<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout();
      reject(new Error("next_question_hint_timeout"));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

const nextQuestionHintService = new NextQuestionHintService();

export function getNextQuestionHintService(): NextQuestionHintService {
  return nextQuestionHintService;
}
