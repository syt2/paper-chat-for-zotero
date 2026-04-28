/**
 * Extracts PDF bookmarks from an open Zotero PDF reader. This is best-effort:
 * callers keep the text-derived outline when the reader or bookmarks are not
 * available.
 */

import type { NativeOutlineItem } from "../../../types/tool";
import { getErrorMessage } from "../../../utils/common";

const READER_INIT_TIMEOUT_MS = 1500;
const PDF_OPERATION_TIMEOUT_MS = 2000;
const OUTLINE_CONVERSION_TIMEOUT_MS = 4000;
const MAX_OUTLINE_NODES = 500;
const MAX_OUTLINE_DEPTH = 12;
const MAX_OUTLINE_TITLE_LENGTH = 300;

interface PdfDocumentLike {
  numPages?: number;
  getOutline(): Promise<unknown[]>;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

interface PdfApplicationLike {
  initializedPromise?: Promise<unknown>;
  pdfDocument?: PdfDocumentLike;
}

const outlineRequests = new WeakMap<PdfDocumentLike, Promise<unknown[]>>();

type PdfReaderWindow = Window & {
  PDFViewerApplication?: PdfApplicationLike;
  wrappedJSObject?: {
    PDFViewerApplication?: PdfApplicationLike;
  };
};

export interface NativeOutlineExtraction {
  outline: NativeOutlineItem[];
  pageCount?: number;
}

/**
 * Try to extract native bookmarks for an open PDF attachment.
 * `attachmentItemID` must identify the PDF attachment shown by the reader.
 */
export async function extractNativeOutline(
  attachmentItemID: number,
): Promise<NativeOutlineExtraction | null> {
  try {
    const reader = findReaderForAttachment(attachmentItemID);
    if (!reader) return null;

    await waitForReaderInitialization(reader);
    const pdfDocument = await findPdfDocument(reader);
    if (!pdfDocument) return null;

    const rawOutline = await resolveWithin(
      getOutlineRequest(pdfDocument),
      PDF_OPERATION_TIMEOUT_MS,
    );
    if (!Array.isArray(rawOutline) || rawOutline.length === 0) return null;

    const outline = await convertOutlineItems(rawOutline, pdfDocument, 0, {
      remainingNodes: MAX_OUTLINE_NODES,
      deadlineAt: Date.now() + OUTLINE_CONVERSION_TIMEOUT_MS,
    });
    if (outline.length === 0) return null;

    const pageCount = Number(pdfDocument.numPages);
    return {
      outline,
      ...(Number.isSafeInteger(pageCount) && pageCount > 0
        ? { pageCount }
        : {}),
    };
  } catch (error) {
    ztoolkit.log("[nativeOutlineExtractor] Error:", getErrorMessage(error));
    return null;
  }
}

function findReaderForAttachment(
  attachmentItemID: number,
): _ZoteroTypes.ReaderInstance | null {
  const mainWindow = Zotero.getMainWindow() as
    | (Window & { Zotero_Tabs?: { selectedID?: string } })
    | null;
  const activeTabID = mainWindow?.Zotero_Tabs?.selectedID;
  if (activeTabID) {
    const activeReader = Zotero.Reader?.getByTabID(activeTabID);
    if (readerItemMatches(activeReader, attachmentItemID)) {
      return activeReader;
    }
  }

  const readers = Object.values(Zotero.Reader?._readers || {});
  for (const reader of readers) {
    if (readerItemMatches(reader, attachmentItemID)) {
      return reader;
    }
  }
  return null;
}

function readerItemMatches(
  reader: _ZoteroTypes.ReaderInstance | null | undefined,
  attachmentItemID: number,
): reader is _ZoteroTypes.ReaderInstance {
  return reader?.itemID === attachmentItemID;
}

function getOutlineRequest(pdfDocument: PdfDocumentLike): Promise<unknown[]> {
  const pending = outlineRequests.get(pdfDocument);
  if (pending) return pending;

  const request = Promise.resolve().then(() => pdfDocument.getOutline());
  outlineRequests.set(pdfDocument, request);
  void request.catch(() => {
    if (outlineRequests.get(pdfDocument) === request) {
      outlineRequests.delete(pdfDocument);
    }
  });
  return request;
}

async function waitForReaderInitialization(
  reader: _ZoteroTypes.ReaderInstance,
): Promise<void> {
  if (reader._isReaderInitialized || !reader._initPromise) return;
  await resolveWithin(reader._initPromise, READER_INIT_TIMEOUT_MS);
}

async function resolveWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timeoutID: number | undefined;
  try {
    return await Promise.race([
      promise.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timeoutID = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutID !== undefined) clearTimeout(timeoutID);
  }
}

async function findPdfDocument(
  reader: _ZoteroTypes.ReaderInstance,
): Promise<PdfDocumentLike | null> {
  const internalView = reader._internalReader?._lastView as
    | { _iframeWindow?: PdfReaderWindow }
    | undefined;
  const windows = [
    internalView?._iframeWindow,
    reader._iframeWindow as PdfReaderWindow | undefined,
  ].filter((candidate): candidate is PdfReaderWindow => !!candidate);

  for (const readerWindow of Array.from(new Set(windows))) {
    const pdfApplication = getPdfApplication(readerWindow);
    if (!pdfApplication) continue;
    if (!pdfApplication.pdfDocument && pdfApplication.initializedPromise) {
      await resolveWithin(
        pdfApplication.initializedPromise,
        READER_INIT_TIMEOUT_MS,
      );
    }
    if (pdfApplication.pdfDocument) {
      return pdfApplication.pdfDocument;
    }
  }
  return null;
}

function getPdfApplication(
  readerWindow: PdfReaderWindow,
): PdfApplicationLike | null {
  try {
    if (readerWindow.PDFViewerApplication) {
      return readerWindow.PDFViewerApplication;
    }
  } catch {
    // Xray wrappers can reject direct property access.
  }
  try {
    return readerWindow.wrappedJSObject?.PDFViewerApplication || null;
  } catch {
    return null;
  }
}

async function convertOutlineItems(
  items: unknown[],
  pdfDocument: PdfDocumentLike,
  level: number,
  budget: { remainingNodes: number; deadlineAt: number },
): Promise<NativeOutlineItem[]> {
  if (
    level >= MAX_OUTLINE_DEPTH ||
    budget.remainingNodes <= 0 ||
    Date.now() >= budget.deadlineAt
  ) {
    return [];
  }

  const result: NativeOutlineItem[] = [];
  for (const rawItem of items) {
    if (budget.remainingNodes <= 0 || Date.now() >= budget.deadlineAt) break;
    budget.remainingNodes -= 1;
    if (!rawItem || typeof rawItem !== "object") continue;

    const item = rawItem as {
      title?: unknown;
      dest?: unknown;
      items?: unknown;
    };
    const title = normalizeOutlineTitle(item.title);
    if (!title) continue;

    const pageNumber = item.dest
      ? await resolveDestPage(item.dest, pdfDocument, budget.deadlineAt)
      : 0;
    const convertedItem: NativeOutlineItem = {
      title,
      pageNumber,
      children: [],
    };
    result.push(convertedItem);
    if (Date.now() >= budget.deadlineAt) break;

    if (Array.isArray(item.items)) {
      convertedItem.children = await convertOutlineItems(
        item.items,
        pdfDocument,
        level + 1,
        budget,
      );
    }
  }
  return result;
}

function normalizeOutlineTitle(title: unknown): string {
  if (typeof title !== "string") return "";
  return title.replace(/\s+/g, " ").trim().slice(0, MAX_OUTLINE_TITLE_LENGTH);
}

async function resolveDestPage(
  destination: unknown,
  pdfDocument: PdfDocumentLike,
  deadlineAt: number,
): Promise<number> {
  try {
    if (Date.now() >= deadlineAt) return 0;

    if (Array.isArray(destination)) {
      const pageRef = destination[0];
      if (typeof pageRef === "number") {
        return toPdfPageNumber(pageRef, pdfDocument.numPages);
      }
      if (pageRef && typeof pageRef === "object") {
        const timeoutMs = remainingOperationTime(deadlineAt);
        if (timeoutMs <= 0) return 0;
        const pageIndex = await resolveWithin(
          pdfDocument.getPageIndex(pageRef),
          timeoutMs,
        );
        return typeof pageIndex === "number"
          ? toPdfPageNumber(pageIndex, pdfDocument.numPages)
          : 0;
      }
      return 0;
    }

    if (typeof destination === "string") {
      const timeoutMs = remainingOperationTime(deadlineAt);
      if (timeoutMs <= 0) return 0;
      const resolved = await resolveWithin(
        pdfDocument.getDestination(destination),
        timeoutMs,
      );
      return resolved ? resolveDestPage(resolved, pdfDocument, deadlineAt) : 0;
    }
  } catch {
    // A broken bookmark should not discard the rest of the outline.
  }
  return 0;
}

function remainingOperationTime(deadlineAt: number): number {
  return Math.min(PDF_OPERATION_TIMEOUT_MS, deadlineAt - Date.now());
}

function toPdfPageNumber(pageIndex: number, pageCount?: number): number {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) return 0;
  const pageNumber = pageIndex + 1;
  const hasPageCount =
    typeof pageCount === "number" &&
    Number.isSafeInteger(pageCount) &&
    pageCount > 0;
  return hasPageCount && pageNumber > pageCount ? 0 : pageNumber;
}
