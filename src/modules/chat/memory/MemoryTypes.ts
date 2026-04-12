export type MemoryCategory =
  | "preference"
  | "decision"
  | "entity"
  | "fact"
  | "other";

export interface Memory {
  id: string;
  libraryId: number;
  text: string;
  category: MemoryCategory;
  importance: number;
  createdAt: number;
  accessCount: number;
  lastAccessedAt: number;
  embedding?: number[];
  embeddingModel?: string;
}
