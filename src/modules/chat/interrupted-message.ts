import type { ChatMessage } from "../../types/chat";

/**
 * An unclosed calling card is only removed when everything after its opening
 * tag is card-internal structure (tool-name/args/status/result elements). Real
 * cards are appended atomically, so a dangling fragment like this can only be
 * a card cut off exactly at its structural boundary; anything followed by
 * prose (e.g. a literal `<tool-call` mention or a documentation example) is
 * ordinary text and must never be truncated. Removal is destructive: this
 * also runs in permanent DB rewrite paths.
 */
const INCOMPLETE_CALLING_CARD_TAIL =
  /\n?<tool-call\s+status="calling">\s*(?:<tool-(?:name|args|status|result)>[^<]*(?:<\/tool-(?:name|args|status|result)>)?\s*)+$/i;

export function stripPendingAndIncompleteToolCallContent(
  content: string,
): string {
  return content
    .replace(
      /\n?<tool-call\s+status="calling">[\s\S]*?<\/tool-call>\n?/gi,
      "\n",
    )
    .replace(INCOMPLETE_CALLING_CARD_TAIL, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
