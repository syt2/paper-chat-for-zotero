import type { ChatMessage } from "../../../types/chat";

const DEFAULT_MAX_INPUT_CHARS = 20000;

export function buildMemoryExtractionConversationText(
  messages: ChatMessage[],
  maxInputChars: number = DEFAULT_MAX_INPUT_CHARS,
): string {
  const turns = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );

  const lines: string[] = [];
  let totalChars = 0;
  for (const message of [...turns].reverse()) {
    const line = `${message.role === "user" ? "USER" : "ASSISTANT"}: ${message.content}\n\n`;
    if (totalChars + line.length > maxInputChars) break;
    lines.unshift(line);
    totalChars += line.length;
  }

  return lines.join("");
}

export function buildMemoryExtractionPrompt(conversationText: string): string {
  return (
    `You are a memory extraction assistant. Review the conversation below and extract 2-5 ` +
    `memorable facts about the USER (not the assistant). Focus on:\n` +
    `- Stated preferences (response style, language, format)\n` +
    `- Research context (field, topic, specific papers or projects)\n` +
    `- Decisions made during the conversation\n` +
    `- Important entities (tools, methods, authors) they mentioned\n\n` +
    `Output ONLY a valid JSON array — no explanation, no markdown fences:\n` +
    `[{"text":"...","category":"preference|decision|entity|fact|other","importance":0.0-1.0}]\n` +
    `Return [] if there is nothing worth remembering.\n\nConversation:\n\n${conversationText}`
  );
}
