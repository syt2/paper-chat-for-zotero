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
export { getToolPermissionManager, ToolPermissionManager } from "./tool-permissions";
export { getTaskManager, TaskManager } from "./task-manager";
export { getToolScheduler, ToolScheduler } from "./tool-scheduler";
export {
  getToolRuntimeMetadata,
  listToolRuntimeMetadata,
} from "./tool-scheduler";
export {
  getStorageDatabase,
  destroyStorageDatabase,
  StorageDatabase,
} from "./db/StorageDatabase";

export type {
  ToolApprovalHandler,
  ToolApprovalObserver,
  ToolPermissionDecider,
} from "./tool-permissions";

// Re-export types
export type {
  AgentRuntimeEvent,
  AgentRuntimeEventType,
  ChatMessage,
  ChatSession,
  ImageAttachment,
  FileAttachment,
  SendMessageOptions,
  StreamCallbacks,
  ExecutionPlan,
  ExecutionPlanStep,
  ExecutionPlanStatus,
  ExecutionPlanStepStatus,
  ContextSummary,
  ContextState,
  SessionIndex,
  SessionMeta,
  TaskEvent,
  TaskEventType,
  TaskProgress,
  TaskRecord,
  TaskStatus,
  TaskType,
  ToolExecutionState,
  ToolApprovalState,
} from "../../types/chat";

export type { FilteredMessagesResult } from "./ContextManager";

export type {
  ToolDefinition,
  ToolCall,
  ToolApprovalRequest,
  ToolApprovalResolution,
  ToolConcurrencyMode,
  ToolExecutionClass,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutionStatus,
  ToolPermissionDecision,
  ToolPermissionDescriptor,
  ToolPermissionMode,
  ToolPermissionPolicyEntry,
  ToolPermissionRequest,
  ToolPermissionRiskLevel,
  ToolPermissionScope,
  ToolRuntimeMetadata,
  ToolTargetScope,
  PaperStructure,
  PaperSection,
  PaperMetadata,
  PageInfo,
  PaperStructureExtended,
} from "../../types/tool";
