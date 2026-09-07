import type { ChatMessage } from "../../types/chat";

/** Only the latest user turn can resume; hidden tool messages are context. */
export function getResumableTurn(messages: readonly ChatMessage[]): {
  userMessage: ChatMessage;
  assistantMessage?: ChatMessage;
  errorMessage?: ChatMessage;
  targetMessageId: string;
} | null {
  const visible = messages.filter(
    (message) =>
      !message.apiOnly &&
      !message.isSystemNotice &&
      ["user", "assistant", "error"].includes(message.role),
  );
  const last = visible[visible.length - 1];
  if (
    !last ||
    (last.role === "assistant" && last.streamingState !== "interrupted")
  )
    return null;
  let assistantMessage: ChatMessage | undefined;
  let errorMessage: ChatMessage | undefined;
  for (let index = visible.length - 1; index >= 0; index--) {
    const message = visible[index];
    if (message.role === "error") errorMessage ??= message;
    if (message.role === "assistant") {
      if (message.streamingState === "in_progress") return null;
      if (message.streamingState === "interrupted")
        assistantMessage ??= message;
    }
    if (message.role === "user") {
      return {
        userMessage: message,
        assistantMessage,
        errorMessage,
        targetMessageId: last.id,
      };
    }
  }
  return null;
}
