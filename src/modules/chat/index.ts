/**
 * Chat Module Exports
 */

export { ChatManager } from "./ChatManager";
export { StorageService } from "./StorageService";
export { SessionStorageService } from "./SessionStorageService";
export { PdfExtractor } from "./PdfExtractor";
export { getContextManager } from "./ContextManager";
export {
  getPdfToolManager,
  PdfToolManager,
  generatePaperContextPrompt,
} from "./pdf-tools";
export { checkAndMigrate } from "./migration/migrateV1Sessions";
export { checkAndMigrateToV3 } from "./migration/migrateToSQLite";
export {
  getStorageDatabase,
  destroyStorageDatabase,
  StorageDatabase,
} from "./db/StorageDatabase";

// Re-export types
export type {
  ChatMessage,
  ChatSession,
  ImageAttachment,
  FileAttachment,
  SendMessageOptions,
  StreamCallbacks,
  ContextSummary,
  ContextState,
  SessionIndex,
  SessionMeta,
} from "../../types/chat";

export type { FilteredMessagesResult } from "./ContextManager";

export type {
  ToolDefinition,
  ToolCall,
  PaperStructure,
  PaperSection,
  PaperMetadata,
  PageInfo,
  PaperStructureExtended,
} from "../../types/tool";
