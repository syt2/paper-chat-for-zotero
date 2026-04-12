import type { ChatSession } from "../../../types/chat";
import { getProviderManager } from "../../providers";
import { getErrorMessage } from "../../../utils/common";
import { getMemoryStore, type MemoryCategory } from "./MemoryStore";
import { SessionStorageService } from "../SessionStorageService";

interface ExtractionOptions {
  requireGrowth?: boolean;
}

export class MemoryOrchestrator {
  private extractionTasks = new Map<string, Promise<void>>();

  constructor(private sessionStorage: SessionStorageService) {}

  scheduleExtraction(
    session: ChatSession,
    options: ExtractionOptions = {},
  ): Promise<void> | null {
    const conversational = session.messages.filter(
      (message) => message.role === "user" || message.role === "assistant",
    );
    const count = conversational.length;
    if (count < 8) return null;

    const existingTask = this.extractionTasks.get(session.id);
    if (existingTask) {
      return existingTask;
    }

    const lastCount = session.memoryExtractedMsgCount ?? 0;
    const hasPreviousExtraction = session.memoryExtractedAt != null;
    const grewEnough = hasPreviousExtraction && count >= lastCount + 10;

    if (options.requireGrowth && !grewEnough) return null;
    if (hasPreviousExtraction && !grewEnough) return null;

    const task = this.extractMemoriesAsync(session, count)
      .catch((err) => {
        ztoolkit.log(
          "[MemoryOrchestrator] extractMemoriesAsync failed:",
          getErrorMessage(err),
        );
      })
      .finally(() => {
        this.extractionTasks.delete(session.id);
      });

    this.extractionTasks.set(session.id, task);
    return task;
  }

  async awaitPendingTasks(extraTask?: Promise<void> | null): Promise<void> {
    const pendingTasks = new Set<Promise<void>>(this.extractionTasks.values());
    if (extraTask) {
      pendingTasks.add(extraTask);
    }
    if (pendingTasks.size > 0) {
      await Promise.allSettled([...pendingTasks]);
    }
  }

  clear(): void {
    this.extractionTasks.clear();
  }

  private async extractMemoriesAsync(
    session: ChatSession,
    conversationalCount: number,
  ): Promise<void> {
    try {
      const provider = getProviderManager().getActiveProvider();
      if (!provider || !provider.isReady()) return;

      const turns = session.messages.filter(
        (message) => message.role === "user" || message.role === "assistant",
      );

      const MAX_INPUT_CHARS = 20000;
      const lines: string[] = [];
      let totalChars = 0;
      for (const message of [...turns].reverse()) {
        const line = `${message.role === "user" ? "USER" : "ASSISTANT"}: ${message.content}\n\n`;
        if (totalChars + line.length > MAX_INPUT_CHARS) break;
        lines.unshift(line);
        totalChars += line.length;
      }
      const conversationText = lines.join("");
      if (!conversationText.trim()) return;

      const extractionInstructions =
        `You are a memory extraction assistant. Review the conversation below and extract 2-5 ` +
        `memorable facts about the USER (not the assistant). Focus on:\n` +
        `- Stated preferences (response style, language, format)\n` +
        `- Research context (field, topic, specific papers or projects)\n` +
        `- Decisions made during the conversation\n` +
        `- Important entities (tools, methods, authors) they mentioned\n\n` +
        `Output ONLY a valid JSON array — no explanation, no markdown fences:\n` +
        `[{"text":"...","category":"preference|decision|entity|fact|other","importance":0.0-1.0}]\n` +
        `Return [] if there is nothing worth remembering.\n\nConversation:\n\n${conversationText}`;

      const messages = [
        {
          id: "mem-usr",
          role: "user" as const,
          content: extractionInstructions,
          timestamp: Date.now(),
        },
      ];

      ztoolkit.log(
        `[MemoryOrchestrator] Extracting memories from session ${session.id}...`,
      );
      const response = await provider.chatCompletion(messages);
      if (!response) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.trim());
      } catch {
        const match = response.match(/\[[\s\S]*?\]/);
        if (!match) {
          ztoolkit.log(
            "[MemoryOrchestrator] Memory extraction: no JSON array found in response",
          );
          return;
        }
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          ztoolkit.log(
            "[MemoryOrchestrator] Memory extraction: failed to parse JSON from response",
          );
          return;
        }
      }
      if (!Array.isArray(parsed)) return;

      const entries = parsed as Array<{
        text: string;
        category?: string;
        importance?: number;
      }>;

      const store = getMemoryStore();
      let saved = 0;
      for (const entry of entries) {
        if (typeof entry.text !== "string" || !entry.text.trim()) continue;
        const validCategories: MemoryCategory[] = [
          "preference",
          "decision",
          "entity",
          "fact",
          "other",
        ];
        const category = validCategories.includes(
          (entry.category ?? "other") as MemoryCategory,
        )
          ? ((entry.category ?? "other") as MemoryCategory)
          : "other";
        const importance =
          typeof entry.importance === "number"
            ? Math.max(0, Math.min(1, entry.importance))
            : 0.6;
        const result = await store.save(entry.text, category, importance);
        if (result.saved) saved++;
      }
      ztoolkit.log(
        `[MemoryOrchestrator] Memory extraction done: ${saved}/${entries.length} saved`,
      );

      const now = Date.now();
      session.memoryExtractedAt = now;
      session.memoryExtractedMsgCount = conversationalCount;
      await this.sessionStorage.updateMemoryExtractionState(
        session.id,
        now,
        conversationalCount,
      );
    } catch (err) {
      ztoolkit.log(
        "[MemoryOrchestrator] Memory extraction failed:",
        getErrorMessage(err),
      );
    }
  }
}
