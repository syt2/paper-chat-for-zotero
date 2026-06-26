import type { ChatMessage, ChatSession } from "../../types/chat";
import type { AIProvider } from "../../types/provider";
import { getErrorMessage } from "../../utils/common";
import { getProviderManager } from "../providers";
import { createPaperChatLightweightProvider } from "../providers/PaperChatLightweightProvider";

const TITLE_SYSTEM_PROMPT =
  "Generate a concise title for this chat session. Return only the title, with no quotes, no markdown, and no trailing punctuation. Use the conversation language when obvious. Limit to 8 English words or 16 Chinese characters.";
const MAX_TITLE_INPUT_LENGTH = 8000;
const MAX_TITLE_LENGTH = 60;
const TITLE_MAX_TOKENS = 256;

function isTitleEligible(session: ChatSession): boolean {
  if (session.title?.trim()) {
    return false;
  }
  if (session.titleSource === "user") {
    return false;
  }
  const conversationalMessages = getConversationalMessages(session);
  return conversationalMessages.length >= 2;
}

function getConversationalMessages(session: ChatSession): ChatMessage[] {
  return session.messages.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      !message.apiOnly &&
      !message.isSystemNotice &&
      message.streamingState !== "interrupted" &&
      message.content.trim().length > 0,
  );
}

function buildConversationText(session: ChatSession): string {
  const messages = getConversationalMessages(session);
  const sampled =
    messages.length <= 12
      ? messages
      : [...messages.slice(0, 6), ...messages.slice(-6)];
  let text = "";

  for (const message of sampled) {
    const entry = `${message.role.toUpperCase()}: ${message.content.trim()}\n\n`;
    if (text.length + entry.length > MAX_TITLE_INPUT_LENGTH) {
      break;
    }
    text += entry;
  }

  return text.trim();
}

function sanitizeTitle(raw: string): string {
  return raw
    .replace(/^[\s"'`“”‘’#*-]+/, "")
    .replace(/[\s"'`“”‘’。.!！?？:：;；]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_LENGTH)
    .trim();
}

function createPaperChatTitleProvider(): AIProvider | null {
  return createPaperChatLightweightProvider({
    maxTokens: TITLE_MAX_TOKENS,
    temperature: 0.2,
    systemPrompt: "",
  });
}

function getTitleProvider(): AIProvider | null {
  const providerManager = getProviderManager();
  if (providerManager.getActiveProviderId() === "paperchat") {
    return createPaperChatTitleProvider();
  }
  return providerManager.getActiveProvider();
}

export class SessionTitleService {
  private inFlight = new Set<string>();

  isEligible(session: ChatSession): boolean {
    return isTitleEligible(session) && !this.inFlight.has(session.id);
  }

  async generateTitle(session: ChatSession): Promise<string | null> {
    if (!this.isEligible(session)) {
      return null;
    }

    const conversationText = buildConversationText(session);
    if (!conversationText) {
      return null;
    }

    const provider = getTitleProvider();
    if (!provider || !provider.isReady()) {
      return null;
    }

    this.inFlight.add(session.id);
    try {
      const response = await provider.chatCompletion([
        {
          id: "session-title-system",
          role: "system",
          content: TITLE_SYSTEM_PROMPT,
          timestamp: Date.now(),
        },
        {
          id: "session-title-user",
          role: "user",
          content: `Conversation:\n\n${conversationText}`,
          timestamp: Date.now(),
        },
      ]);
      const title = sanitizeTitle(response || "");
      return title || null;
    } catch (error) {
      ztoolkit.log(
        "[SessionTitleService] Failed to generate session title:",
        getErrorMessage(error),
      );
      return null;
    } finally {
      this.inFlight.delete(session.id);
    }
  }
}
