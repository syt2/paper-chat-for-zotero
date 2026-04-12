import type { Memory } from "./MemoryStore";

export function formatMemoriesForPrompt(memories: Memory[]): string {
  if (memories.length === 0) return "";

  const lines = memories.map((memory) => `- [${memory.category}] ${memory.text}`).join("\n");
  return `\n=== USER MEMORIES ===\nThe following facts and preferences have been remembered from previous conversations:\n${lines}\nUse these to personalise your responses.\n`;
}
