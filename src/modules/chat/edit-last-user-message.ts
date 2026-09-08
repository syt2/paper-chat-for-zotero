import type { ChatMessage, ChatSession } from "../../types/chat";

export function getLastEditableUserMessage(messages: ChatMessage[]) {
  return [...messages].reverse().find((m) => m.role === "user" && !m.apiOnly);
}

function promptOffset(message: ChatMessage): number {
  // Legacy messages store extracted attachment text before the question.
  if (!message.pdfContext && !message.files?.length && !message.selectedText)
    return 0;
  // Tool-enabled PDF turns can have pdfContext=true while content is only
  // the user's prompt. Do not treat their literal question markers as metadata.
  if (
    !/^\[(?:PDF Content|File: [^\n]*|Selection \d+|Selected Text)\]:?/.test(
      message.content,
    )
  )
    return 0;
  const marker = "[Question]:\n";
  const index = message.content.lastIndexOf(marker);
  return index < 0 ? 0 : index + marker.length;
}

export function getEditableUserPrompt(message: ChatMessage): string {
  return message.content.slice(promptOffset(message));
}

/** Build a replacement without mutating the live session before persistence. */
export function buildEditedLastTurn(
  session: ChatSession,
  messageId: string,
  prompt: string,
): ChatSession | null {
  const user = getLastEditableUserMessage(session.messages);
  const trimmed = prompt.trim();
  if (
    !user ||
    user.id !== messageId ||
    !trimmed ||
    trimmed === getEditableUserPrompt(user).trim()
  )
    return null;
  const index = session.messages.indexOf(user);
  const affected = new Set(session.messages.slice(index).map((m) => m.id));
  const covered = session.contextSummary?.coveredMessageIds;
  const invalidateSummary =
    !!session.contextSummary &&
    (!Array.isArray(covered) ||
      !covered.length ||
      covered.some((id) => affected.has(id)));
  return {
    ...session,
    messages: [
      ...session.messages.slice(0, index),
      {
        ...user,
        content: user.content.slice(0, promptOffset(user)) + trimmed,
      },
    ],
    contextSummary: invalidateSummary ? undefined : session.contextSummary,
    contextState: invalidateSummary ? undefined : session.contextState,
    executionPlan: undefined,
    toolExecutionState: undefined,
    toolApprovalState: undefined,
    userInputRequestState: undefined,
    lastRetryableUserMessageId: undefined,
    lastRetryableErrorMessageId: undefined,
    lastRetryableFailedModelId: undefined,
  };
}
