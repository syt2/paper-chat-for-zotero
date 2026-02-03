/**
 * PDF Tools - 导出入口
 */

// 导出类和类型
export { PdfToolManager } from "./PdfToolManager";

// 导出解析函数（供外部使用）
export {
  parsePaperStructure,
  parsePages,
  parsePageRange,
  extractMetadata,
  matchSectionHeader,
} from "./paperParser";

// 导出提示生成函数
export { generatePaperContextPrompt } from "./promptGenerator";

// 导出常量（如需要）
export {
  SECTION_PATTERNS,
  SECTION_ALIASES,
  PAGE_BREAK_PATTERNS,
  ESTIMATED_CHARS_PER_PAGE,
} from "./constants";

// 导出 Zotero 库工具执行函数
export {
  executeListAllItems,
  executeGetItemMetadata,
  executeGetItemNotes,
  executeGetNoteContent,
} from "./zoteroExecutors";

// 导出新增的高级 Zotero 库工具执行函数
export {
  executeGetAnnotations,
  executeSearchItems,
  executeGetCollections,
  executeGetCollectionItems,
  executeGetTags,
  executeSearchByTag,
  executeGetRecent,
  executeSearchNotes,
  executeCreateNote,
  executeBatchUpdateTags,
} from "./libraryExecutors";

// 单例管理
import { PdfToolManager } from "./PdfToolManager";

let pdfToolManager: PdfToolManager | null = null;
let isPdfToolManagerDestroyed = false;

export function getPdfToolManager(): PdfToolManager {
  if (isPdfToolManagerDestroyed) {
    ztoolkit.log(
      "[PdfToolManager] Warning: Accessing destroyed PdfToolManager, recreating...",
    );
    isPdfToolManagerDestroyed = false;
  }
  if (!pdfToolManager) {
    pdfToolManager = new PdfToolManager();
  }
  return pdfToolManager;
}

export function destroyPdfToolManager(): void {
  if (pdfToolManager) {
    pdfToolManager.clearCache();
    pdfToolManager = null;
  }
  isPdfToolManagerDestroyed = true;
}
