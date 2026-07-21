import type { ChatMessage } from "../../types/chat";

export interface ChatMessagePresentation {
  message: ChatMessage;
  attachedError?: ChatMessage;
  attachedNotices: ChatMessage[];
}

export function selectChatMessagePresentations(
  messages: ChatMessage[],
): ChatMessagePresentation[] {
  const attachedErrors = new Map<number, ChatMessage>();
  const attachedNotices = new Map<number, ChatMessage[]>();
  const hiddenMessageIds = new Set<string>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (
      message.apiOnly ||
      message.role !== "assistant" ||
      message.streamingState !== "interrupted"
    ) {
      continue;
    }
    const notices: ChatMessage[] = [];
    let nextIndex = index + 1;
    while (nextIndex < messages.length) {
      const next = messages[nextIndex];
      if (next.apiOnly) {
        nextIndex++;
        continue;
      }
      if (next.role === "system" && next.isSystemNotice) {
        notices.push(next);
        nextIndex++;
        continue;
      }
      break;
    }

    const error = messages[nextIndex];
    if (error?.role === "error" && !error.apiOnly) {
      attachedErrors.set(index, error);
      attachedNotices.set(index, notices);
      hiddenMessageIds.add(error.id);
      for (const notice of notices) {
        hiddenMessageIds.add(notice.id);
      }
    }
  }

  return messages
    .map((message, index) => ({ message, index }))
    .filter(
      ({ message }) => !message.apiOnly && !hiddenMessageIds.has(message.id),
    )
    .map(({ message, index }) => ({
      message,
      attachedError: attachedErrors.get(index),
      attachedNotices: attachedNotices.get(index) || [],
    }));
}
