import type { ChatMessage } from "../../chat";

export function hasConversationMessages(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      !message.apiOnly &&
      (message.role === "user" || message.role === "assistant"),
  );
}

export function canSummarizeAssistantReply(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    !message.apiOnly &&
    message.streamingState !== "in_progress" &&
    message.content.trim().length > 0
  );
}

export function buildReplyNoteSummaryPrompt(
  instruction: string,
  replyContent: string,
): string {
  return `${instruction}\n\n---\n${replyContent}\n---`;
}

export function shouldResetSummaryButtonBusyState(
  busySessionId: string | null,
  currentSessionId?: string,
): boolean {
  return busySessionId !== null && busySessionId !== currentSessionId;
}
