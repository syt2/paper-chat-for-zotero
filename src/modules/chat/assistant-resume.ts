import type { ChatMessage } from "../../types/chat";

/** Keep one snapshot, independent of provider protocol and tool execution state. */
export function checkpointAssistantPhase(
  message: ChatMessage,
  content: string = message.content,
): void {
  message.resumeCheckpoint = { content, reasoning: message.reasoning };
}

export function parseAssistantResumeCheckpoint(
  value: string | null | undefined,
): ChatMessage["resumeCheckpoint"] {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed.content !== "string") return undefined;
    return {
      content: parsed.content,
      reasoning:
        typeof parsed.reasoning === "string" ? parsed.reasoning : undefined,
    };
  } catch {
    return undefined;
  }
}

export function getAssistantResumeCheckpoint(
  message: ChatMessage,
): NonNullable<ChatMessage["resumeCheckpoint"]> {
  if (message.resumeCheckpoint) return message.resumeCheckpoint;
  // Old replies have no phase boundary. Preserve tool history, discard the
  // trailing unfinished prose; do not infer stages from Markdown paragraphs.
  let end = 0;
  for (const match of message.content.matchAll(
    /<tool-call\b[^>]*>[\s\S]*?<\/tool-call>/g,
  )) {
    if (!/\bstatus="calling"/.test(match[0].split(">")[0])) {
      end = match.index! + match[0].length;
    }
  }
  return { content: message.content.slice(0, end) };
}
