import type { ChatMessage } from "../../chat";
import type { NoteSummarySourceItem } from "../../chat/note-summary-destination";
import { normalizeSourceItemKeys } from "../../chat/note-source-provenance";

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

export function collectNoteSummarySourceItemKeys(
  messages: readonly ChatMessage[],
): string[] {
  return normalizeSourceItemKeys(
    messages.flatMap((message) => [
      ...(message.sourceItemKeys || []),
      ...(message.evidence || []).map((record) => record.itemKey),
    ]),
  );
}

export function resolveNoteSummarySourceItem(
  itemKey: string,
  getItemByKey: (key: string) => Zotero.Item | null,
  getItemById: (id: number) => Zotero.Item | null,
): NoteSummarySourceItem | null {
  const sourceItem = getItemByKey(itemKey);
  if (!sourceItem) {
    return null;
  }
  const noteTarget =
    (sourceItem.isAttachment?.() || sourceItem.isNote?.()) &&
    sourceItem.parentItemID
      ? getItemById(sourceItem.parentItemID) || sourceItem
      : sourceItem;
  return {
    itemKey: noteTarget.key,
    title: noteTarget.getDisplayTitle() || noteTarget.key,
  };
}

export function shouldResetSummaryButtonBusyState(
  busySessionId: string | null,
  currentSessionId?: string,
): boolean {
  return busySessionId !== null && busySessionId !== currentSessionId;
}
