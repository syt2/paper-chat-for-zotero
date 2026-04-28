import type { ChatMessage } from "../../types/chat";

function getToolCallIds(message: ChatMessage): string[] {
  return (message.tool_calls ?? [])
    .map((toolCall) => toolCall.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * OpenAI-compatible APIs require each assistant message with tool_calls to be
 * followed immediately by matching tool messages. Context truncation or old
 * interrupted sessions can break that sequence, so remove incomplete blocks
 * before sending provider requests.
 */
export function sanitizeOpenAIToolCallMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  const sanitized: ChatMessage[] = [];

  for (let index = 0; index < messages.length; ) {
    const message = messages[index];

    if (message.role === "tool") {
      index += 1;
      continue;
    }

    const toolCalls = message.role === "assistant" ? message.tool_calls : null;
    const toolCallIds = toolCalls ? getToolCallIds(message) : [];
    const requiredToolCallIds = toolCalls ? new Set(toolCallIds) : null;

    if (requiredToolCallIds && toolCalls && toolCalls.length > 0) {
      if (
        toolCallIds.length !== toolCalls.length ||
        requiredToolCallIds.size !== toolCalls.length
      ) {
        index += 1;
        continue;
      }

      const toolMessages: ChatMessage[] = [];
      let nextIndex = index + 1;

      while (
        nextIndex < messages.length &&
        messages[nextIndex].role === "tool"
      ) {
        const toolMessage = messages[nextIndex];
        const toolCallId = toolMessage.tool_call_id;

        if (toolCallId && requiredToolCallIds.has(toolCallId)) {
          toolMessages.push(toolMessage);
          requiredToolCallIds.delete(toolCallId);
        }

        nextIndex += 1;
      }

      if (requiredToolCallIds.size === 0) {
        sanitized.push(message, ...toolMessages);
      }

      index = nextIndex;
      continue;
    }

    sanitized.push(message);
    index += 1;
  }

  return sanitized;
}
