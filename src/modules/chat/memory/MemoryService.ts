import { formatMemoriesForPrompt } from "./MemoryPrompt";
import { getMemoryStore, MemoryStore } from "./MemoryStore";
import type { Memory, MemoryCategory } from "./MemoryTypes";

export type MemoryServiceFactory = (libraryId?: number) => MemoryService;

export class MemoryService {
  constructor(private store: MemoryStore) {}

  async save(
    text: string,
    category?: MemoryCategory,
    importance?: number,
  ): Promise<{ saved: boolean; reason?: string }> {
    return this.store.save(text, category, importance);
  }

  async search(query: string): Promise<Memory[]> {
    return this.store.search(query);
  }

  async buildPromptContext(query: string): Promise<string | undefined> {
    if (!query.trim()) return undefined;

    const memories = await this.search(query);
    return formatMemoriesForPrompt(memories) || undefined;
  }
}

export function getMemoryService(libraryId?: number): MemoryService {
  return new MemoryService(getMemoryStore(libraryId));
}
