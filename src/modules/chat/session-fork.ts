import type { ChatMessage } from "../../types/chat";

const ITEM_SWITCH_NOTICE_PREFIX = '--- Switched to paper: "';
const NO_PAPER_NOTICE = "--- No paper selected ---";

function findForkIndex(
  messages: ChatMessage[],
  assistantMessageId: string,
): number {
  const forkIndex = messages.findIndex(
    (message) => message.id === assistantMessageId,
  );
  if (forkIndex < 0) {
    throw new Error("The message to continue from no longer exists.");
  }

  const forkMessage = messages[forkIndex];
  if (
    forkMessage.role !== "assistant" ||
    forkMessage.apiOnly ||
    forkMessage.streamingState !== undefined
  ) {
    throw new Error(
      "Only a completed AI message can start a new conversation.",
    );
  }

  return forkIndex;
}

function isItemContextTransition(message: ChatMessage): boolean {
  return (
    message.role === "system" &&
    message.isSystemNotice === true &&
    (message.content.startsWith(ITEM_SWITCH_NOTICE_PREFIX) ||
      message.content === NO_PAPER_NOTICE)
  );
}

function cloneMessage(message: ChatMessage, id: string): ChatMessage {
  return {
    ...message,
    id,
    images: message.images?.map((image) => ({ ...image })),
    files: message.files?.map((file) => ({ ...file })),
    tool_calls: message.tool_calls?.map((toolCall) => ({
      ...toolCall,
      function: { ...toolCall.function },
    })),
    evidence: message.evidence?.map((record) => ({ ...record })),
    sourceItemKeys: message.sourceItemKeys
      ? [...message.sourceItemKeys]
      : undefined,
  };
}

/**
 * Clone the complete model context through a visible, completed assistant
 * message. Every message receives a new database-safe ID while tool-call IDs
 * remain unchanged so assistant/tool pairs still match in the fork.
 */
export function cloneHistoryThroughAssistantMessage(
  messages: ChatMessage[],
  assistantMessageId: string,
  createMessageId: () => string,
): ChatMessage[] {
  const forkIndex = findForkIndex(messages, assistantMessageId);

  return messages
    .slice(0, forkIndex + 1)
    .map((message) => cloneMessage(message, createMessageId()));
}

/**
 * Session item context is stored at session level, not per message. If a paper
 * switch happened after the selected message, carrying the source session's
 * current item would leak post-fork document context into the new conversation.
 * Clear it conservatively in that case.
 */
export function resolveForkItemKey(
  messages: ChatMessage[],
  assistantMessageId: string,
  currentItemKey: string | null,
): string | null {
  const forkIndex = findForkIndex(messages, assistantMessageId);
  return messages.slice(forkIndex + 1).some(isItemContextTransition)
    ? null
    : currentItemKey;
}

export function collectForkArtifactIds(messages: ChatMessage[]): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if (
      message.role !== "tool" ||
      !message.content.startsWith("[Tool result saved as session artifact]\n")
    ) {
      continue;
    }
    const artifactIdPattern = /(?:^|\n)Artifact id: ([A-Za-z0-9_.-]+)(?:\n|$)/g;
    for (const match of message.content.matchAll(artifactIdPattern)) {
      ids.add(match[1]);
    }
  }
  return Array.from(ids);
}
