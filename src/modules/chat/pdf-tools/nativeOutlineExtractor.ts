/**
 * Native PDF Outline Extractor
 *
 * Extracts the PDF's native outline/bookmarks by accessing the PDF.js viewer
 * through Zotero's Reader API. Falls back gracefully when no reader tab is
 * open for the requested item.
 *
 * This provides:
 * - Real PDF page numbers (not estimated via character count)
 * - Hierarchical structure (multi-level TOC)
 * - Accurate section names in any language (no heuristic matching)
 * - Page position mapping (via PDF destination coordinates)
 */

import type { NativeOutlineItem } from "../../../types/tool";
import { getErrorMessage } from "../../../utils/common";

/**
 * Try to extract native outline for a given item from the PDF.js viewer.
 * Returns null if the item is not open in any reader tab, or the PDF has no outline.
 */
export async function extractNativeOutline(
  itemKey: string,
): Promise<NativeOutlineItem[] | null> {
  try {
    const reader = findReaderForItem(itemKey);
    if (!reader) return null;

    const iframeWindow = (reader as any)._iframeWindow;
    if (!iframeWindow) return null;

    // Zotero 9 的 PDF.js viewer 被 Xray 包裹，需要 wrappedJSObject 绕过
    let pdfApp;
    try { pdfApp = iframeWindow.PDFViewerApplication; } catch (_) {}
    if (!pdfApp) {
      try { pdfApp = iframeWindow.wrappedJSObject?.PDFViewerApplication; } catch (_) {}
    }
    if (!pdfApp) return null;

    const pdfDocument = pdfApp.pdfDocument;
    if (!pdfDocument || typeof pdfDocument.getOutline !== "function") return null;

    const outline = await pdfDocument.getOutline();
    if (!outline || outline.length === 0) return null;

    return await convertOutlineItems(outline, pdfDocument, 0);
  } catch (error) {
    ztoolkit.log("[nativeOutlineExtractor] Error:", getErrorMessage(error));
    return null;
  }
}

/**
 * Find a reader tab that has the given itemKey open.
 * Checks the active tab first (fast path), then falls back to scanning all
 * open reader tabs.
 */
function findReaderForItem(itemKey: string): any | null {
  const mainWindow = Zotero.getMainWindow() as
    | (Window & { Zotero_Tabs?: Record<string, any> })
    | null;
  if (!mainWindow?.Zotero_Tabs) return null;

  const tabs = mainWindow.Zotero_Tabs;

  // Fast path: check the currently active tab
  const activeTabID = (tabs as any).selectedID;
  if (activeTabID) {
    const reader = Zotero.Reader?.getByTabID(activeTabID);
    if (reader && readerItemMatches(reader, itemKey)) return reader;
  }

  // Fallback: scan all tabs to find a reader tab for this item.
  // Zotero internally tracks readers; try its reader map if available.
  const readerMap: Record<string, any> | undefined =
    (Zotero.Reader as any)._readers;
  if (readerMap) {
    for (const reader of Object.values(readerMap)) {
      if (readerItemMatches(reader, itemKey)) return reader;
    }
  }

  return null;
}

function readerItemMatches(reader: any, itemKey: string): boolean {
  if (!reader || typeof reader.itemID !== "number") return false;
  const item = Zotero.Items.get(reader.itemID);
  return item?.key === itemKey;
}

/**
 * Recursively convert PDF.js outline items to our NativeOutlineItem format,
 * resolving each destination to a real PDF page number.
 */
async function convertOutlineItems(
  items: any[],
  pdfDocument: any,
  level: number,
): Promise<NativeOutlineItem[]> {
  const result: NativeOutlineItem[] = [];

  for (const item of items) {
    if (!item || !item.title) continue;

    const pageNumber = item.dest
      ? await resolveDestPage(item.dest, pdfDocument)
      : 0;

    const children = item.items
      ? await convertOutlineItems(item.items, pdfDocument, level + 1)
      : [];

    result.push({ title: item.title, level, pageNumber, children });
  }

  return result;
}

/**
 * Resolve a PDF.js destination to a 1-based page number.
 *
 * PDF.js destinations come in two forms:
 * - explicit: [pageRef, x, y, zoom]  (most common)
 * - named: string key looked up via pdfDocument.getDestination()
 */
async function resolveDestPage(
  dest: any,
  pdfDocument: any,
): Promise<number> {
  try {
    // Explicit destination array: [pageRef, x, y, zoom]
    if (Array.isArray(dest)) {
      const pageRef = dest[0];
      if (pageRef && typeof pageRef === "object" && "num" in pageRef) {
        const pageIndex = await pdfDocument.getPageIndex(pageRef);
        return pageIndex + 1;
      }
      // Some PDFs embed the (0-based) page index directly
      if (typeof pageRef === "number") {
        return pageRef + 1;
      }
      return 0;
    }

    // Named destination – look up the name, then recurse
    if (typeof dest === "string") {
      const resolved = await pdfDocument.getDestination(dest);
      if (resolved && Array.isArray(resolved)) {
        return resolveDestPage(resolved, pdfDocument);
      }
    }
  } catch {
    // Best-effort: page resolution failure is non-fatal
  }

  return 0;
}
