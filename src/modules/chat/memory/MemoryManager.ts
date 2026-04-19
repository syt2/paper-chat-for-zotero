import type { ChatSession } from "../../../types/chat";
import { getErrorMessage } from "../../../utils/common";
import { SessionStorageService } from "../SessionStorageService";
import {
  getMemoryService,
  type MemoryService,
  type MemoryServiceFactory,
} from "./MemoryService";
import { MemoryOrchestrator } from "./MemoryOrchestrator";
import {
  getMemoryExtractor,
  type MemoryExtractor,
  type MemoryExtractorFactory,
} from "./MemoryExtractor";

const MIN_MEMORY_QUERY_CHARS = 5;

export class MemoryManager {
  private orchestrator: MemoryOrchestrator;
  private memoryService: MemoryService | null = null;
  private memoryExtractor: MemoryExtractor | null = null;

  constructor(
    sessionStorage: SessionStorageService,
    private createMemoryService: MemoryServiceFactory = getMemoryService,
    private createMemoryExtractor: MemoryExtractorFactory = getMemoryExtractor,
  ) {
    this.orchestrator = new MemoryOrchestrator(
      sessionStorage,
      () => this.getMemoryService(),
      () => this.getMemoryExtractor(),
    );
  }

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

  onSessionReady(session: ChatSession | null): void {
    if (!session) return;
    this.orchestrator.scheduleExtraction(session, {
      requireGrowth: true,
    });
  }

  onBeforeSessionSwitch(
    session: ChatSession | null,
    nextSessionId: string,
  ): void {
    if (!session || session.id === nextSessionId) return;
    this.orchestrator.scheduleExtraction(session);
  }

  async buildPromptContext(query?: string): Promise<string | undefined> {
    if (!query?.trim()) return undefined;
    if (shouldSkipMemoryPromptLookup(query)) return undefined;

    try {
      return await this.getMemoryService().buildPromptContext(query);
    } catch (err) {
      ztoolkit.log("[MemoryManager] Memory search failed:", getErrorMessage(err));
      return undefined;
    }
  }

  async flushOnDestroy(session: ChatSession | null): Promise<void> {
    const currentTask = session
      ? this.orchestrator.scheduleExtraction(session)
      : null;
    await this.orchestrator.awaitPendingTasks(currentTask);
  }

  clear(): void {
    this.orchestrator.clear();
  }
}

function shouldSkipMemoryPromptLookup(query: string): boolean {
  return Array.from(query.trim()).length < MIN_MEMORY_QUERY_CHARS;
}
