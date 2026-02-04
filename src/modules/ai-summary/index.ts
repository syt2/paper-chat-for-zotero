/**
 * AISummary Module - AI摘要模块导出
 */

export { AISummaryManager, getAISummaryManager, initAISummary } from "./AISummaryManager";
export { AISummaryProcessor } from "./AISummaryProcessor";
export { AISummaryStorage } from "./AISummaryStorage";
export { DEFAULT_TEMPLATES, getTemplateById, getAllTemplates } from "./defaultTemplates";
export {
  getAISummaryService,
  initAISummaryService,
  destroyAISummaryService,
  type AISummaryTask,
  type TaskStatus,
  type TaskQueueState,
} from "./AISummaryService";
export { openTaskWindow, closeTaskWindow } from "./AISummaryTaskWindow";
