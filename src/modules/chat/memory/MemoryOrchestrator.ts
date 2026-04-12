import type { ChatSession } from "../../../types/chat";
import { getProviderManager } from "../../providers";
import { getErrorMessage } from "../../../utils/common";
import {
  getMemoryService,
  type MemoryService,
  type MemoryServiceFactory,
} from "./MemoryService";
import { SessionStorageService } from "../SessionStorageService";
import {
  buildMemoryExtractionConversationText,
  buildMemoryExtractionPrompt,
} from "./MemoryExtractionPrompt";
import { parseMemoryExtractionResponse } from "./MemoryExtractionParser";

interface ExtractionOptions {
  requireGrowth?: boolean;
}

export class MemoryOrchestrator {
  private extractionTasks = new Map<string, Promise<void>>();
  private memoryService: MemoryService | null = null;

  constructor(
    private sessionStorage: SessionStorageService,
    private createMemoryService: MemoryServiceFactory = getMemoryService,
  ) {}

  private getMemoryService(): MemoryService {
    if (!this.memoryService) {
      this.memoryService = this.createMemoryService();
    }
    return this.memoryService;
  }

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

      const conversationText = buildMemoryExtractionConversationText(
        session.messages,
      );
      if (!conversationText.trim()) return;

      const messages = [
        {
          id: "mem-usr",
          role: "user" as const,
          content: buildMemoryExtractionPrompt(conversationText),
          timestamp: Date.now(),
        },
      ];

      ztoolkit.log(
        `[MemoryOrchestrator] Extracting memories from session ${session.id}...`,
      );
      const response = await provider.chatCompletion(messages);
      if (!response) return;

      const parsed = parseMemoryExtractionResponse(response);
      if (!parsed.ok) {
        if (parsed.reason === "no_json_array") {
          ztoolkit.log(
            "[MemoryOrchestrator] Memory extraction: no JSON array found in response",
          );
        } else if (parsed.reason === "invalid_json_array") {
          ztoolkit.log(
            "[MemoryOrchestrator] Memory extraction: failed to parse JSON from response",
          );
        }
        return;
      }

      let saved = 0;
      for (const entry of parsed.entries) {
        const result = await this.getMemoryService().save(
          entry.text,
          entry.category,
          entry.importance,
        );
        if (result.saved) saved++;
      }
      ztoolkit.log(
        `[MemoryOrchestrator] Memory extraction done: ${saved}/${parsed.entries.length} saved`,
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
