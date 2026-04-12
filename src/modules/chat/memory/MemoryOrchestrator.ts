import type { ChatSession } from "../../../types/chat";
import { getErrorMessage } from "../../../utils/common";
import {
  getMemoryService,
  type MemoryService,
  type MemoryServiceFactory,
} from "./MemoryService";
import { SessionStorageService } from "../SessionStorageService";
import {
  getMemoryExtractor,
  type MemoryExtractor,
  type MemoryExtractorFactory,
} from "./MemoryExtractor";

interface ExtractionOptions {
  requireGrowth?: boolean;
}

export class MemoryOrchestrator {
  private extractionTasks = new Map<string, Promise<void>>();
  private memoryService: MemoryService | null = null;
  private memoryExtractor: MemoryExtractor | null = null;

  constructor(
    private sessionStorage: SessionStorageService,
    private createMemoryService: MemoryServiceFactory = getMemoryService,
    private createMemoryExtractor: MemoryExtractorFactory = getMemoryExtractor,
  ) {}

  private getMemoryService(): MemoryService {
    if (!this.memoryService) {
      this.memoryService = this.createMemoryService();
    }
    return this.memoryService;
  }

  private getMemoryExtractor(): MemoryExtractor {
    if (!this.memoryExtractor) {
      this.memoryExtractor = this.createMemoryExtractor();
    }
    return this.memoryExtractor;
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
      const extracted = await this.getMemoryExtractor().extract(session.messages);
      if (!extracted.ok) {
        if (extracted.reason === "no_json_array") {
          ztoolkit.log(
            "[MemoryOrchestrator] Memory extraction: no JSON array found in response",
          );
        } else if (extracted.reason === "invalid_json_array") {
          ztoolkit.log(
            "[MemoryOrchestrator] Memory extraction: failed to parse JSON from response",
          );
        }
        return;
      }

      let saved = 0;
      for (const entry of extracted.entries) {
        const result = await this.getMemoryService().save(
          entry.text,
          entry.category,
          entry.importance,
        );
        if (result.saved) saved++;
      }
      ztoolkit.log(
        `[MemoryOrchestrator] Memory extraction done: ${saved}/${extracted.entries.length} saved`,
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
