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
      (message.streamingState !== "interrupted" &&
        message.streamingState !== "in_progress")
    ) {
      continue;
    }
    const isInterrupted = message.streamingState === "interrupted";
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
      let followingIndex = nextIndex + 1;
      let sawRetryNotice = false;
      while (followingIndex < messages.length) {
        const following = messages[followingIndex];
        if (following.apiOnly) {
          followingIndex++;
          continue;
        }
        if (following.role === "system" && following.isSystemNotice) {
          sawRetryNotice = true;
          followingIndex++;
          continue;
        }
        break;
      }
      const supersededByRetry =
        messages[followingIndex]?.role === "assistant" &&
        (messages[followingIndex]?.streamingState === "in_progress" ||
          sawRetryNotice);
      if (isInterrupted && !supersededByRetry) {
        attachedErrors.set(index, error);
        attachedNotices.set(index, notices);
      }
      // A retry resets the failed assistant to in_progress before the old
      // error row is deleted. Keep that superseded error hidden until the
      // attempt reaches a terminal state again.
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
