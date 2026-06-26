import type { ChatMessage, ChatSession } from "../../../types/chat";
import type { AIProvider } from "../../../types/provider";
import { getProviderManager } from "../../providers";
import { createPaperChatLightweightProvider } from "../../providers/PaperChatLightweightProvider";
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

export interface NextQuestionHintRequest {
  session: ChatSession | null;
  currentInputValue: string;
  signal?: AbortSignal;
}

const MIN_ASSISTANT_CONTENT_LENGTH = 80;
const MAX_ASSISTANT_CONTEXT_CHARS = 2400;
const MAX_USER_CONTEXT_CHARS = 900;
const MAX_HINT_CHARS = 80;
const HINT_MAX_TOKENS = 128;
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
      const fallback = buildFallbackHint(
        this.cleanMessageContent(userMessage.content),
        assistantContent,
      );
      if (fallback) {
        rememberSetValue(
          this.requestedAssistantMessageIds,
          assistantMessage.id,
        );
        return {
          status: "generated",
          hint: this.createHint(session.id, assistantMessage.id, fallback),
        };
      }
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
        const fallback = buildFallbackHint(
          this.cleanMessageContent(userMessage.content),
          assistantContent,
        );
        if (!fallback) {
          this.requestedAssistantMessageIds.delete(assistantMessage.id);
          return { status: "skipped", reason: "invalid_hint" };
        }
        return {
          status: "generated",
          hint: this.createHint(session.id, assistantMessage.id, fallback),
        };
      }

      return {
        status: "generated",
        hint: this.createHint(session.id, assistantMessage.id, text),
      };
    } catch (error) {
      if (!timedOut && !abortedByRequest && !request.signal?.aborted) {
        ztoolkit.log("[NextQuestionHint] generation skipped:", error);
      }
      if (!abortedByRequest && !request.signal?.aborted) {
        const fallback = buildFallbackHint(
          this.cleanMessageContent(userMessage.content),
          assistantContent,
        );
        if (fallback) {
          return {
            status: "generated",
            hint: this.createHint(session.id, assistantMessage.id, fallback),
          };
        }
      }
      this.requestedAssistantMessageIds.delete(assistantMessage.id);
      return { status: "skipped", reason: "generation_failed" };
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
  }): ChatMessage[] {
    const { session, userMessage, assistantMessage } = input;
    const title = session.title?.trim();
    const paperContext = title ? `\nCurrent paper/session title: ${title}` : "";
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
    const providerManager = getProviderManager();
    if (providerManager.getActiveProviderId() === "paperchat") {
      return (
        createPaperChatLightweightProvider({
          maxTokens: HINT_MAX_TOKENS,
          temperature: 0.2,
          systemPrompt: "",
        }) || providerManager.getActiveProvider()
      );
    }
    return providerManager.getActiveProvider();
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

function buildFallbackHint(
  userText: string,
  assistantText: string,
): string | null {
  const isChinese = /[\u4e00-\u9fff]/.test(userText);
  const text = assistantText.toLowerCase();

  if (text.includes("one-sentence") || text.includes("一句话")) {
    return isChinese
      ? "可以用一句话直觉解释吗？"
      : "Can you give a one-sentence intuition?";
  }
  if (
    text.includes("step-by-step") ||
    text.includes("mathematically") ||
    text.includes("math") ||
    text.includes("公式")
  ) {
    return isChinese
      ? "可以按步骤解释公式吗？"
      : "Can you walk through the math step by step?";
  }
  if (
    text.includes("experiment") ||
    text.includes("results") ||
    text.includes("performance") ||
    text.includes("实验") ||
    text.includes("结果")
  ) {
    return isChinese
      ? "实验结果如何支撑这个结论？"
      : "How do the experiments support this?";
  }
  if (
    text.includes("advantage") ||
    text.includes("benefit") ||
    text.includes("优点") ||
    text.includes("优势")
  ) {
    return isChinese ? "它的主要优势是什么？" : "What are its main advantages?";
  }
  if (
    text.includes("method") ||
    text.includes("module") ||
    text.includes("architecture") ||
    text.includes("mechanism") ||
    text.includes("方法") ||
    text.includes("模块")
  ) {
    return isChinese
      ? "可以分步骤讲机制吗？"
      : "Can you break down the mechanism step by step?";
  }

  return isChinese ? "这部分最关键的结论是什么？" : "What is the key takeaway?";
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
