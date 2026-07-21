import type { ChatMessage } from "../../types/chat";

export function stripPendingAndIncompleteToolCallContent(
  content: string,
): string {
  let sanitized = content.replace(
    /\n?<tool-call\s+status="calling">[\s\S]*?<\/tool-call>\n?/gi,
    "\n",
  );
  const lastOpen = sanitized.toLowerCase().lastIndexOf("<tool-call");
  const lastClose = sanitized.toLowerCase().lastIndexOf("</tool-call>");
  if (
    lastOpen > lastClose &&
    isDanglingToolCallCardStart(sanitized.slice(lastOpen))
  ) {
    sanitized = sanitized.slice(0, lastOpen);
  }
  return sanitized.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Truncation is destructive (it also runs in permanent DB rewrite paths), so
 * only treat the unmatched `<tool-call` as an interrupted card when it is a
 * real card opening (status attribute) or the stream stopped mid-tag. A bare
 * literal mention (e.g. inside a code example) must not truncate the message.
 */
function isDanglingToolCallCardStart(tail: string): boolean {
  if (!tail.includes(">")) {
    return /^<tool-call[\w\s="'-]{0,160}$/i.test(tail);
  }
  return /^<tool-call[^>]*\bstatus\s*=\s*"/i.test(tail);
}

export function sanitizeInterruptedAssistantContent(content: string): string {
  return stripPendingAndIncompleteToolCallContent(content)
    .replace(/\n?<tool-call\b[^>]*>[\s\S]*?<\/tool-call>\n?/gi, "\n")
    .replace(/<\/?tool-call\b[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Create the model-facing form of a persisted interrupted assistant message.
 * The stored message remains unchanged for UI and history rendering.
 */
export function createInterruptedAssistantContextMessage(
  message: ChatMessage,
): ChatMessage | null {
  if (
    message.role !== "assistant" ||
    message.streamingState !== "interrupted" ||
    message.apiOnly
  ) {
    return null;
  }

  const content = sanitizeInterruptedAssistantContent(message.content);
  if (!content) {
    return null;
  }

  const projected: ChatMessage = { ...message, content };
  delete projected.streamingState;
  delete projected.reasoning;
  delete projected.tool_calls;
  return projected;
}
