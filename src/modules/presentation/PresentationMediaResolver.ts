import type {
  PresentationFigure,
  PresentationRequest,
  RenderablePresentationRequest,
  RenderablePresentationSlide,
  ResolvedPresentationFigure,
} from "./PresentationSchema";
import {
  extractPaintedImageBounds,
  refineFigureCropFromPixels,
  selectRasterFigureCrop,
  type PdfOperatorListLike,
  type PixelCrop,
} from "./PresentationFigureCropper";
import { formatPresentationAuthors } from "./PresentationMetadata";

const READER_INIT_TIMEOUT_MS = 8_000;
const PDF_RENDER_TIMEOUT_MS = 20_000;
const TARGET_LONG_EDGE = 1_900;
const MAX_SHARED_STANDALONE_PAGE_CACHE_ENTRIES = 8;
const MIN_CROP_PIXELS = 80;
const MIN_RENDERED_PAGE_INK_RATIO = 0.0005;
const MIN_RENDERED_FIGURE_INK_RATIO = 0.001;

interface PdfViewportLike {
  width: number;
  height: number;
  transform?: unknown;
  viewBox?: unknown;
  userUnit?: unknown;
  scale?: unknown;
  rotation?: unknown;
  offsetX?: unknown;
  offsetY?: unknown;
  dontFlip?: unknown;
  convertToViewportPoint?: (x: number, y: number) => [number, number];
}

interface PdfTextItemLike {
  str?: unknown;
  width?: unknown;
  height?: unknown;
  transform?: unknown;
}

interface PdfPageLike {
  view?: unknown;
  getViewport(options: { scale: number }): PdfViewportLike;
  getTextContent?: () => Promise<{ items?: PdfTextItemLike[] }>;
  getOperatorList?: () => Promise<PdfOperatorListLike>;
  render(options: {
    canvas?: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewportLike;
  }): { promise?: Promise<unknown> } | Promise<unknown>;
}

interface PdfDocumentLike {
  numPages?: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

type PdfReaderWindow = Window & {
  Function?: FunctionConstructor;
  PDFViewerApplication?: {
    initializedPromise?: Promise<unknown>;
    pdfDocument?: PdfDocumentLike;
  };
  wrappedJSObject?: {
    Function?: FunctionConstructor;
    PDFViewerApplication?: {
      initializedPromise?: Promise<unknown>;
      pdfDocument?: PdfDocumentLike;
    };
  };
};

interface ReaderRealmRenderResult {
  data: string;
  width: number;
  height: number;
  scale: number;
  transform: number[];
  inkRatio: number;
  sampledPixels: number;
}

type StandalonePdfPageRenderer = (
  attachment: Zotero.Item,
  pageNumber: number,
) => Promise<ReaderRealmRenderResult | null>;

interface PresentationMediaResolutionContext {
  standalonePageCache: Map<string, Promise<ReaderRealmRenderResult | null>>;
  sourceItemKey?: string;
  sourceLibraryID?: number;
}

// Visual repair may call the presentation tool several times in one turn.
// Re-rendering the same PDF pages on every outer attempt is expensive and can
// leave timed-out PDF.js tasks competing with the next attempt. Retain a small
// process-local cache of successful page renders so repair attempts reuse the
// pixels that already made it through Zotero's PDF.js runtime.
const sharedStandalonePageCache = new Map<
  string,
  Promise<ReaderRealmRenderResult | null>
>();

export class PresentationResolvedMediaDuplicateError extends Error {
  readonly issues: string[];
  readonly resolvedRequest?: RenderablePresentationRequest;

  constructor(
    issues: string[],
    resolvedRequest?: RenderablePresentationRequest,
  ) {
    super(issues.join("; "));
    this.name = "PresentationResolvedMediaDuplicateError";
    this.issues = issues;
    this.resolvedRequest = resolvedRequest;
  }
}

let standalonePdfPageRendererForTests: StandalonePdfPageRenderer | null = null;

export function __setStandalonePdfPageRendererForTests(
  renderer: StandalonePdfPageRenderer | null,
): void {
  standalonePdfPageRendererForTests = renderer;
  sharedStandalonePageCache.clear();
}

interface ResolvedFigurePlacement {
  figure: ResolvedPresentationFigure;
  path: string;
  region: string;
}

function sameResolvedPresentationImage(
  left: ResolvedPresentationFigure,
  right: ResolvedPresentationFigure,
): boolean {
  return (
    left.pixelWidth === right.pixelWidth &&
    left.pixelHeight === right.pixelHeight &&
    left.data === right.data
  );
}

function uniqueResolvedPlacements(
  placements: readonly ResolvedFigurePlacement[],
): ResolvedFigurePlacement[] {
  return placements.filter(
    (placement, index) =>
      placements.findIndex((candidate) =>
        sameResolvedPresentationImage(candidate.figure, placement.figure),
      ) === index,
  );
}

/**
 * Caption anchors can differ while Zotero's PDF cropper still resolves both
 * requests to the same raster image. Detect that after rendering, where the
 * actual pixels are authoritative, so duplicate galleries never reach PPTX.
 */
export function validateResolvedPresentationMedia(
  request: RenderablePresentationRequest,
): string[] {
  const issues: string[] = [];
  const coverFigurePlacements: ResolvedFigurePlacement[] = [
    ...(request.coverFigure
      ? [
          {
            figure: request.coverFigure,
            path: "/coverFigure",
            region: "cover",
          },
        ]
      : []),
    ...(request.coverFigures || []).map((figure, index) => ({
      figure,
      path: `/coverFigures/${index}`,
      region: "cover",
    })),
  ];

  const explicitCoverFigures = coverFigurePlacements.filter((placement) =>
    placement.path.startsWith("/coverFigures/"),
  );
  for (
    let leftIndex = 0;
    leftIndex < explicitCoverFigures.length;
    leftIndex++
  ) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < explicitCoverFigures.length;
      rightIndex++
    ) {
      const left = explicitCoverFigures[leftIndex];
      const right = explicitCoverFigures[rightIndex];
      if (sameResolvedPresentationImage(left.figure, right.figure)) {
        issues.push(
          `${right.path}: resolved to the same cropped image as ${left.path}. Replace it with a genuinely different cover visual instead of repeating one crop in the collage.`,
        );
      }
    }
  }

  const regions: ResolvedFigurePlacement[][] = [
    uniqueResolvedPlacements(coverFigurePlacements),
  ];
  for (const [slideIndex, slide] of request.slides.entries()) {
    const placements: ResolvedFigurePlacement[] = [
      ...(slide.figure
        ? [
            {
              figure: slide.figure,
              path: `/slides/${slideIndex}/figure`,
              region: `slide-${slideIndex + 2}`,
            },
          ]
        : []),
      ...(slide.figures || []).map((figure, figureIndex) => ({
        figure,
        path: `/slides/${slideIndex}/figures/${figureIndex}`,
        region: `slide-${slideIndex + 2}`,
      })),
    ];
    for (let leftIndex = 0; leftIndex < placements.length; leftIndex++) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < placements.length;
        rightIndex++
      ) {
        const left = placements[leftIndex];
        const right = placements[rightIndex];
        if (sameResolvedPresentationImage(left.figure, right.figure)) {
          issues.push(
            `${right.path}: resolved to the same cropped image as ${left.path}. A gallery must use different anchored Figure/Table evidence, not two caption variants that collapse to one crop.`,
          );
        }
      }
    }
    regions.push(uniqueResolvedPlacements(placements));
  }

  for (
    let leftRegionIndex = 0;
    leftRegionIndex < regions.length;
    leftRegionIndex++
  ) {
    for (
      let rightRegionIndex = leftRegionIndex + 1;
      rightRegionIndex < regions.length;
      rightRegionIndex++
    ) {
      for (const left of regions[leftRegionIndex]) {
        for (const right of regions[rightRegionIndex]) {
          if (sameResolvedPresentationImage(left.figure, right.figure)) {
            issues.push(
              `${right.path}: resolved to the same cropped image as ${left.path}. Use different paper evidence across the cover and content slides or across separate content slides.`,
            );
          }
        }
      }
    }
  }

  return [...new Set(issues)];
}

interface ZoteroRegionRendererLike {
  renderRegionCrops(
    pageIndex: number,
    rects: number[][],
  ): Promise<unknown> | unknown;
}

interface ReaderRealmCaptionSnapshot {
  viewportWidth: number;
  viewportHeight: number;
  items: CaptionLine[];
}

interface CaptionLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AnchoredCaptionLocation {
  pageNumber: number;
  caption: CaptionLine;
  lines: CaptionLine[];
  viewportWidth: number;
  viewportHeight: number;
  captionSource: "reader-realm" | "cross-realm";
  captionFallbackReason?: string;
}

export function normalizePresentationViewportPoint(
  value: unknown,
  fallbackX: number,
  fallbackY: number,
): [number, number] {
  const point = value as { 0?: unknown; 1?: unknown } | null | undefined;
  const x = Number(point?.[0]);
  const y = Number(point?.[1]);
  return [
    Number.isFinite(x) ? x : fallbackX,
    Number.isFinite(y) ? y : fallbackY,
  ];
}

export function convertPresentationPdfPoint(
  viewport: PdfViewportLike,
  x: number,
  y: number,
): [number, number] {
  const transform = resolvePresentationViewportTransform(viewport);
  if (transform) {
    return [
      x * transform[0] + y * transform[2] + transform[4],
      x * transform[1] + y * transform[3] + transform[5],
    ];
  }
  try {
    return normalizePresentationViewportPoint(
      viewport.convertToViewportPoint?.(x, y),
      x,
      y,
    );
  } catch {
    return [x, y];
  }
}

function readPresentationNumericTuple(
  value: unknown,
  length: number,
): number[] | null {
  const source = value as
    | { length?: unknown; [index: number]: unknown }
    | null
    | undefined;
  if (!source) return null;
  const values = Array.from({ length }, (_, index) => Number(source[index]));
  return values.every(Number.isFinite) ? values : null;
}

/**
 * Returns a plain PDF.js viewport matrix even when Firefox Xray wrappers hide
 * Array iteration or the convertToViewportPoint method. The live Zotero reader
 * can expose numeric matrix entries without an iterable length; treating that
 * object as an empty array leaves caption Y coordinates in bottom-left PDF
 * space and makes figure crops land in the body text below the caption.
 */
export function resolvePresentationViewportTransform(
  viewport: PdfViewportLike,
): number[] | null {
  const explicit = readPresentationNumericTuple(viewport.transform, 6);
  if (explicit) return explicit;

  const width = Number(viewport.width);
  const height = Number(viewport.height);
  const rawScale = Number(viewport.scale);
  const userUnit = Number(viewport.userUnit);
  const scale =
    (Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1) *
    (Number.isFinite(userUnit) && userUnit > 0 ? userUnit : 1);
  const rotationValue = Number(viewport.rotation);
  const rotation =
    (((Number.isFinite(rotationValue) ? rotationValue : 0) % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(rotation)) return null;
  const offsetX = Number(viewport.offsetX) || 0;
  const offsetY = Number(viewport.offsetY) || 0;
  const dontFlip = Boolean(viewport.dontFlip);
  const inferredViewBox =
    rotation % 180 === 0
      ? [0, 0, width / scale, height / scale]
      : [0, 0, height / scale, width / scale];
  const viewBox =
    readPresentationNumericTuple(viewport.viewBox, 4) || inferredViewBox;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    !viewBox.every(Number.isFinite)
  ) {
    return null;
  }

  const centerX = (viewBox[2] + viewBox[0]) / 2;
  const centerY = (viewBox[3] + viewBox[1]) / 2;
  let rotateA = 1;
  let rotateB = 0;
  let rotateC = 0;
  let rotateD = -1;
  if (rotation === 90) {
    rotateA = 0;
    rotateB = 1;
    rotateC = 1;
    rotateD = 0;
  } else if (rotation === 180) {
    rotateA = -1;
    rotateD = 1;
  } else if (rotation === 270) {
    rotateA = 0;
    rotateB = -1;
    rotateC = -1;
    rotateD = 0;
  }
  if (dontFlip) {
    rotateC = -rotateC;
    rotateD = -rotateD;
  }
  const offsetCanvasX =
    (rotateA === 0
      ? Math.abs(centerY - viewBox[1])
      : Math.abs(centerX - viewBox[0])) *
      scale +
    offsetX;
  const offsetCanvasY =
    (rotateA === 0
      ? Math.abs(centerX - viewBox[0])
      : Math.abs(centerY - viewBox[1])) *
      scale +
    offsetY;
  return [
    rotateA * scale,
    rotateB * scale,
    rotateC * scale,
    rotateD * scale,
    offsetCanvasX - rotateA * scale * centerX - rotateC * scale * centerY,
    offsetCanvasY - rotateB * scale * centerX - rotateD * scale * centerY,
  ];
}

export function resolveWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void | Promise<void>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeoutID = setTimeout(async () => {
      if (settled) return;
      settled = true;
      try {
        await onTimeout?.();
      } catch {
        // Preserve the timeout as the actionable failure. Cancellation is
        // best-effort because PDF.js may already be unwinding the task.
      }
      reject(new Error(`PDF rendering timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutID);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutID);
        reject(error);
      },
    );
  });
}

function waitForReaderTick(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function getItemByKey(itemKey: string, libraryID?: number): Zotero.Item | null {
  if (Number.isSafeInteger(libraryID)) {
    return Zotero.Items.getByLibraryAndKey(libraryID!, itemKey) || null;
  }
  const libraryIDs = [
    Zotero.Libraries.userLibraryID,
    ...(Zotero.Libraries.getAll?.() || []).map((library) => library.libraryID),
  ].filter((libraryID, index, values) => values.indexOf(libraryID) === index);
  for (const libraryID of libraryIDs) {
    const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
    if (item) return item;
  }
  return null;
}

function resolvePresentationSourceItem(
  itemKey: string | undefined,
  libraryID?: number,
): Zotero.Item | null {
  if (!itemKey || typeof Zotero === "undefined") return null;
  const item = getItemByKey(itemKey, libraryID);
  if (!item) return null;
  return (item.isAttachment?.() || item.isNote?.()) && item.parentItemID
    ? Zotero.Items.get(item.parentItemID) || item
    : item;
}

export function resolvePresentationSourceYear(
  itemKey: string | undefined,
  libraryID?: number,
): string | undefined {
  const sourceItem = resolvePresentationSourceItem(itemKey, libraryID);
  if (!sourceItem) return undefined;
  const rawYear =
    sourceItem.getField?.("year") || sourceItem.getField?.("date") || "";
  return String(rawYear).match(/\b(?:19|20)\d{2}\b/)?.[0];
}

export function resolvePresentationSourceAuthor(
  itemKey: string | undefined,
  language: string | undefined,
  libraryID?: number,
): string | undefined {
  const sourceItem = resolvePresentationSourceItem(itemKey, libraryID);
  if (!sourceItem) return undefined;
  const creators = sourceItem.getCreators?.() || [];
  const names = creators.map(
    (creator: { name?: string; firstName?: string; lastName?: string }) =>
      creator.name?.trim() ||
      `${creator.firstName || ""} ${creator.lastName || ""}`.trim(),
  );
  return formatPresentationAuthors(names, language);
}

async function resolvePdfAttachment(
  itemKey: string,
  libraryID?: number,
): Promise<Zotero.Item> {
  const item = getItemByKey(itemKey, libraryID);
  if (!item) {
    throw new Error(`No Zotero item was found for key "${itemKey}".`);
  }
  if (item.isPDFAttachment?.()) {
    return item;
  }
  if (item.isAttachment?.() || item.isNote?.()) {
    throw new Error(
      `Zotero item "${itemKey}" is not a PDF attachment or paper.`,
    );
  }
  for (const attachmentID of item.getAttachments?.() || []) {
    const attachment = await Zotero.Items.getAsync(attachmentID);
    if (attachment?.isPDFAttachment?.()) {
      return attachment;
    }
  }
  throw new Error(`Zotero item "${itemKey}" has no PDF attachment.`);
}

function readerMatches(
  reader: _ZoteroTypes.ReaderInstance | null | undefined,
  attachmentID: number,
): reader is _ZoteroTypes.ReaderInstance {
  return reader?.itemID === attachmentID;
}

function findOpenReader(
  attachmentID: number,
): _ZoteroTypes.ReaderInstance | null {
  const mainWindow = Zotero.getMainWindow() as
    | (Window & { Zotero_Tabs?: { selectedID?: string } })
    | null;
  const selectedID = mainWindow?.Zotero_Tabs?.selectedID;
  if (selectedID) {
    const activeReader = Zotero.Reader?.getByTabID(selectedID);
    if (readerMatches(activeReader, attachmentID)) {
      return activeReader;
    }
  }
  for (const reader of Object.values(Zotero.Reader?._readers || {})) {
    if (readerMatches(reader, attachmentID)) {
      return reader;
    }
  }
  return null;
}

async function resolveReader(
  attachment: Zotero.Item,
  pageNumber: number,
): Promise<_ZoteroTypes.ReaderInstance> {
  const existing = findOpenReader(attachment.id);
  if (existing) return existing;

  const opened = await Zotero.Reader.open(
    attachment.id,
    { pageIndex: pageNumber - 1 },
    { openInBackground: true, allowDuplicate: false },
  );
  const reader = opened || findOpenReader(attachment.id);
  if (!reader) {
    throw new Error(
      `PaperChat could not open the PDF reader for item "${attachment.key}".`,
    );
  }
  return reader;
}

async function waitForReader(
  reader: _ZoteroTypes.ReaderInstance,
): Promise<void> {
  if (reader._isReaderInitialized || !reader._initPromise) return;
  await resolveWithin(reader._initPromise, READER_INIT_TIMEOUT_MS);
}

function readerWindows(reader: _ZoteroTypes.ReaderInstance): PdfReaderWindow[] {
  const internalView = reader._internalReader?._lastView as
    | { _iframeWindow?: PdfReaderWindow }
    | undefined;
  return Array.from(
    new Set(
      [internalView?._iframeWindow, reader._iframeWindow as PdfReaderWindow]
        .filter(Boolean)
        .map((value) => value as PdfReaderWindow),
    ),
  );
}

function getPdfApplication(readerWindow: PdfReaderWindow):
  | {
      initializedPromise?: Promise<unknown>;
      pdfDocument?: PdfDocumentLike;
    }
  | undefined {
  try {
    const unwrapped = readerWindow.wrappedJSObject?.PDFViewerApplication;
    if (unwrapped) {
      return unwrapped;
    }
  } catch {
    // Fall through to the Xray-visible application below.
  }
  try {
    return readerWindow.PDFViewerApplication;
  } catch {
    return undefined;
  }
}

function unwrapPdfPage(page: PdfPageLike): PdfPageLike {
  const wrapped = page as PdfPageLike & { wrappedJSObject?: PdfPageLike };
  return wrapped.wrappedJSObject || page;
}

async function resolvePdfDocument(
  reader: _ZoteroTypes.ReaderInstance,
): Promise<{
  document: PdfDocumentLike;
  ownerDocument: Document;
  ownerWindow: PdfReaderWindow;
}> {
  await waitForReader(reader);
  const deadline = Date.now() + READER_INIT_TIMEOUT_MS;
  let observedWindowCount = 0;
  let observedApplication = false;
  do {
    const windows = readerWindows(reader);
    observedWindowCount = Math.max(observedWindowCount, windows.length);
    for (const readerWindow of windows) {
      const application = getPdfApplication(readerWindow);
      if (!application) continue;
      observedApplication = true;
      if (application.pdfDocument) {
        return {
          document: application.pdfDocument,
          ownerDocument: readerWindow.document,
          ownerWindow: readerWindow,
        };
      }
      if (application.initializedPromise) {
        await Promise.race([
          Promise.resolve(application.initializedPromise).catch(
            () => undefined,
          ),
          waitForReaderTick(Math.min(100, Math.max(1, deadline - Date.now()))),
        ]);
      }
      if (application.pdfDocument) {
        return {
          document: application.pdfDocument,
          ownerDocument: readerWindow.document,
          ownerWindow: readerWindow,
        };
      }
    }
    if (Date.now() >= deadline) break;
    await waitForReaderTick(50);
  } while (Date.now() < deadline);
  throw new Error(
    `The Zotero PDF reader did not expose a loaded PDF document after ${READER_INIT_TIMEOUT_MS}ms (windows=${observedWindowCount}, application=${observedApplication ? "yes" : "no"}).`,
  );
}

function unwrapCompartmentValue<T>(value: T): T {
  const wrapped = value as T & { wrappedJSObject?: T };
  return wrapped?.wrappedJSObject || value;
}

function waiveCompartmentValue<T>(value: T): T {
  const runtime = globalThis as unknown as {
    Cu?: { waiveXrays?: (input: unknown) => unknown };
    Components?: {
      utils?: { waiveXrays?: (input: unknown) => unknown };
    };
  };
  const waiveXrays =
    runtime.Cu?.waiveXrays || runtime.Components?.utils?.waiveXrays;
  if (waiveXrays) {
    try {
      return (waiveXrays(value) as T) || value;
    } catch {
      // Same-compartment values do not need an Xray waiver.
    }
  }
  return unwrapCompartmentValue(value);
}

function createPdfRenderOptions(
  ownerWindow: PdfReaderWindow,
  canvas: HTMLCanvasElement,
  canvasContext: CanvasRenderingContext2D,
  viewport: PdfViewportLike,
): {
  canvas: HTMLCanvasElement;
  canvasContext: CanvasRenderingContext2D;
  viewport: PdfViewportLike;
} {
  const targetWindow =
    ownerWindow.wrappedJSObject || (ownerWindow as PdfReaderWindow);
  const runtime = globalThis as unknown as {
    Components?: {
      utils?: {
        cloneInto?: (
          value: unknown,
          target: unknown,
          options?: { wrapReflectors?: boolean },
        ) => unknown;
      };
    };
  };
  const cloneInto = runtime.Components?.utils?.cloneInto;
  if (cloneInto) {
    const viewportSnapshot = {
      width: viewport.width,
      height: viewport.height,
      transform: Array.isArray(viewport.transform)
        ? viewport.transform.map(Number)
        : viewport.transform,
      scale: viewport.scale,
      rotation: viewport.rotation,
      offsetX: viewport.offsetX,
      offsetY: viewport.offsetY,
      dontFlip: viewport.dontFlip,
    };
    const options = waiveCompartmentValue(
      cloneInto({ viewport: viewportSnapshot }, targetWindow),
    ) as {
      canvas: HTMLCanvasElement;
      canvasContext: CanvasRenderingContext2D;
      viewport: PdfViewportLike;
    };
    options.canvas = waiveCompartmentValue(canvas);
    options.canvasContext = waiveCompartmentValue(canvasContext);
    return options;
  }
  let options: Record<string, unknown> = {};
  try {
    const ObjectConstructor = (
      targetWindow as unknown as {
        Object?: new () => Record<string, unknown>;
      }
    ).Object;
    if (ObjectConstructor) options = new ObjectConstructor();
  } catch {
    // The plain-object fallback remains valid in same-compartment runtimes.
  }
  options = waiveCompartmentValue(options);
  options.canvas = waiveCompartmentValue(canvas);
  options.canvasContext = waiveCompartmentValue(canvasContext);
  options.viewport = waiveCompartmentValue(viewport);
  return options as {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewportLike;
  };
}

function createCanvas(
  ownerDocument: Document,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = waiveCompartmentValue(
    ownerDocument.createElement("canvas"),
  ) as HTMLCanvasElement;
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/**
 * Measures how much of a rendered canvas contains visible information instead
 * of the white page background. Sampling keeps the live Zotero check cheap
 * even when PDF.js renders a 1900 px page.
 */
export function measureCanvasInkRatio(
  canvas: Pick<HTMLCanvasElement, "width" | "height" | "getContext">,
): number | null {
  const context = canvas.getContext("2d");
  if (!context?.getImageData || canvas.width <= 0 || canvas.height <= 0) {
    return null;
  }
  const step = Math.max(
    1,
    Math.floor(Math.sqrt((canvas.width * canvas.height) / 60_000)),
  );
  let pixels: Uint8ClampedArray;
  try {
    pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    return null;
  }
  let sampled = 0;
  let ink = 0;
  for (let y = 0; y < canvas.height; y += step) {
    for (let x = 0; x < canvas.width; x += step) {
      const offset = (y * canvas.width + x) * 4;
      const alpha = pixels[offset + 3] ?? 0;
      if (alpha > 8) {
        const red = pixels[offset] ?? 255;
        const green = pixels[offset + 1] ?? 255;
        const blue = pixels[offset + 2] ?? 255;
        if (red < 246 || green < 246 || blue < 246) ink += 1;
      }
      sampled += 1;
    }
  }
  return sampled > 0 ? ink / sampled : 0;
}

/**
 * PDF.js lives in the reader iframe's compartment. Creating the canvas and
 * invoking page.render in that same realm avoids Firefox Xray wrappers that
 * can otherwise yield a fulfilled render task backed by an untouched canvas.
 */
async function renderPageInReaderRealm(
  ownerWindow: PdfReaderWindow,
  pageNumber: number,
): Promise<ReaderRealmRenderResult | null> {
  const targetWindow =
    ownerWindow.wrappedJSObject || (ownerWindow as PdfReaderWindow);
  const FunctionConstructor = targetWindow.Function;
  if (typeof FunctionConstructor !== "function") return null;

  const createRenderer = FunctionConstructor(`
    "use strict";
    return async function renderPaperChatPdfPage(pageNumber, timeoutMs) {
      let stage = "document";
      let canvas;
      let viewportDimensions = "no-viewport";
      let renderTask;
      let timeoutID;
      const work = (async function() {
        try {
          const application = globalThis.PDFViewerApplication;
          if (!application || !application.pdfDocument) {
            throw new Error("PDFViewerApplication.pdfDocument is unavailable.");
          }
          const page = await application.pdfDocument.getPage(pageNumber);
          stage = "viewport";
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = Math.max(1, Math.min(3, ${TARGET_LONG_EDGE} / Math.max(baseViewport.width, baseViewport.height)));
          const viewport = page.getViewport({ scale: scale });
          viewportDimensions = String(viewport.width) + "x" + String(viewport.height);
          stage = "canvas";
          canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(viewport.width));
          canvas.height = Math.max(1, Math.round(viewport.height));
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw new Error("PaperChat could not create a reader-realm canvas context.");
          context.fillStyle = "#FFFFFF";
          context.fillRect(0, 0, canvas.width, canvas.height);
          stage = "pdfjs-render";
          renderTask = page.render({ canvas: canvas, canvasContext: context, viewport: viewport });
          await (renderTask && renderTask.promise ? renderTask.promise : renderTask);

          stage = "pixel-inspection";
          const pixelData = context.getImageData(0, 0, canvas.width, canvas.height).data;
          const step = Math.max(1, Math.floor(Math.sqrt((canvas.width * canvas.height) / 60000)));
          let sampledPixels = 0;
          let inkPixels = 0;
          for (let y = 0; y < canvas.height; y += step) {
            for (let x = 0; x < canvas.width; x += step) {
              const offset = (y * canvas.width + x) * 4;
              if (pixelData[offset + 3] > 8 &&
                  (pixelData[offset] < 246 || pixelData[offset + 1] < 246 || pixelData[offset + 2] < 246)) {
                inkPixels += 1;
              }
              sampledPixels += 1;
            }
          }
          stage = "encode";
          return {
            data: canvas.toDataURL("image/png"),
            width: canvas.width,
            height: canvas.height,
            scale: scale,
            transform: Array.from(viewport.transform || []),
            inkRatio: sampledPixels ? inkPixels / sampledPixels : 0,
            sampledPixels: sampledPixels
          };
        } catch (error) {
          const dimensions = canvas ? canvas.width + "x" + canvas.height : "no-canvas";
          const visibleCanvases = Array.from(document.querySelectorAll("canvas"))
            .map(function(existing) {
              return existing.width + "x" + existing.height + ":" + String(existing.className || "");
            })
            .filter(function(summary) { return !summary.startsWith("0x0:"); })
            .slice(0, 8)
            .join(",");
          throw new Error("PaperChat reader-realm render failed at " + stage + " (viewport=" + viewportDimensions + ", canvas=" + dimensions + ", existing=" + visibleCanvases + "): " + String(error));
        }
      })();
      const timeout = new Promise(function(_resolve, reject) {
        timeoutID = setTimeout(function() {
          try {
            if (renderTask && typeof renderTask.cancel === "function") renderTask.cancel();
          } catch (_) {}
          reject(new Error("PDF rendering timed out after " + timeoutMs + "ms."));
        }, timeoutMs);
      });
      try {
        return await Promise.race([work, timeout]);
      } finally {
        if (timeoutID) clearTimeout(timeoutID);
      }
    };
  `) as () => (
    pageNumber: number,
    timeoutMs: number,
  ) => Promise<ReaderRealmRenderResult>;
  const render = createRenderer();
  const rawResult = await resolveWithin(
    Promise.resolve(render(pageNumber, PDF_RENDER_TIMEOUT_MS)),
    PDF_RENDER_TIMEOUT_MS + READER_INIT_TIMEOUT_MS,
  );
  const result = unwrapCompartmentValue(rawResult);
  return {
    data: String(result.data || ""),
    width: Number(result.width) || 0,
    height: Number(result.height) || 0,
    scale: Number(result.scale) || 1,
    transform: Array.from(result.transform || [], Number),
    inkRatio: Number(result.inkRatio) || 0,
    sampledPixels: Number(result.sampledPixels) || 0,
  };
}

async function renderPageWithStandalonePdfJs(
  attachment: Zotero.Item,
  pageNumber: number,
): Promise<ReaderRealmRenderResult | null> {
  if (standalonePdfPageRendererForTests) {
    return standalonePdfPageRendererForTests(attachment, pageNumber);
  }
  const pdfPath = await attachment.getFilePathAsync?.();
  const mainWindow = Zotero.getMainWindow();
  if (!pdfPath || !mainWindow) return null;
  const targetWindow = waiveCompartmentValue(mainWindow) as Window & {
    Function?: FunctionConstructor;
  };
  const FunctionConstructor = targetWindow.Function;
  if (typeof FunctionConstructor !== "function") return null;
  const createRenderer = FunctionConstructor(`
    "use strict";
    return async function renderPaperChatStandalonePdfPage(pdfPath, pageNumber, targetLongEdge, timeoutMs) {
      let stage = "import PDF.js";
      let loadingTask;
      let renderTask;
      let timeoutID;
      const work = (async function() {
        try {
          const pdfjs = await import("resource://zotero/reader/pdf/build/pdf.mjs");
          pdfjs.GlobalWorkerOptions.workerSrc = "resource://zotero/reader/pdf/build/pdf.worker.mjs";
          stage = "read PDF";
          const bytes = await IOUtils.read(pdfPath);
          stage = "load document";
          loadingTask = pdfjs.getDocument({
            data: bytes,
            ownerDocument: document,
            isOffscreenCanvasSupported: false,
            isImageDecoderSupported: false,
            useWorkerFetch: false
          });
          const pdfDocument = await loadingTask.promise;
          stage = "load page";
          const page = await pdfDocument.getPage(pageNumber);
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = Math.max(1, Math.min(3, targetLongEdge / Math.max(baseViewport.width, baseViewport.height)));
          const viewport = page.getViewport({ scale: scale });
          stage = "render page";
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(viewport.width));
          canvas.height = Math.max(1, Math.round(viewport.height));
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw new Error("Canvas 2D context is unavailable.");
          context.fillStyle = "#FFFFFF";
          context.fillRect(0, 0, canvas.width, canvas.height);
          renderTask = page.render({ canvasContext: context, viewport: viewport });
          await (renderTask && renderTask.promise ? renderTask.promise : renderTask);
          stage = "inspect pixels";
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          const step = Math.max(1, Math.floor(Math.sqrt((canvas.width * canvas.height) / 60000)));
          let sampledPixels = 0;
          let inkPixels = 0;
          for (let y = 0; y < canvas.height; y += step) {
            for (let x = 0; x < canvas.width; x += step) {
              const offset = (y * canvas.width + x) * 4;
              if (pixels[offset + 3] > 8 &&
                  (pixels[offset] < 246 || pixels[offset + 1] < 246 || pixels[offset + 2] < 246)) {
                inkPixels += 1;
              }
              sampledPixels += 1;
            }
          }
          stage = "encode page";
          return JSON.stringify({
            data: canvas.toDataURL("image/png"),
            width: canvas.width,
            height: canvas.height,
            scale: scale,
            transform: Array.from(viewport.transform || []),
            inkRatio: sampledPixels ? inkPixels / sampledPixels : 0,
            sampledPixels: sampledPixels
          });
        } catch (error) {
          throw new Error("Standalone PDF.js render failed at " + stage + ": " + String(error));
        }
      })();
      const timeout = new Promise(function(_resolve, reject) {
        timeoutID = setTimeout(function() {
          try {
            if (renderTask && typeof renderTask.cancel === "function") renderTask.cancel();
          } catch (_) {}
          reject(new Error("PDF rendering timed out after " + timeoutMs + "ms."));
        }, timeoutMs);
      });
      try {
        return await Promise.race([work, timeout]);
      } finally {
        if (timeoutID) clearTimeout(timeoutID);
        if (loadingTask && loadingTask.destroy) {
          try { await loadingTask.destroy(); } catch (_) {}
        }
      }
    };
  `) as () => (
    path: string,
    page: number,
    targetLongEdge: number,
    timeoutMs: number,
  ) => Promise<string>;
  const render = createRenderer();
  const encoded = await resolveWithin(
    Promise.resolve(
      render(pdfPath, pageNumber, TARGET_LONG_EDGE, PDF_RENDER_TIMEOUT_MS),
    ),
    PDF_RENDER_TIMEOUT_MS + READER_INIT_TIMEOUT_MS,
  );
  const parsed = JSON.parse(
    String(unwrapCompartmentValue(encoded)),
  ) as Partial<ReaderRealmRenderResult>;
  return {
    data: String(parsed.data || ""),
    width: Number(parsed.width) || 0,
    height: Number(parsed.height) || 0,
    scale: Number(parsed.scale) || 1,
    transform: Array.from(parsed.transform || [], Number),
    inkRatio: Number(parsed.inkRatio) || 0,
    sampledPixels: Number(parsed.sampledPixels) || 0,
  };
}

async function getStandalonePdfPage(
  context: PresentationMediaResolutionContext,
  attachment: Zotero.Item,
  pageNumber: number,
): Promise<ReaderRealmRenderResult | null> {
  const key = `${attachment.libraryID || 0}:${attachment.key}:${pageNumber}`;
  let pending = context.standalonePageCache.get(key);
  if (!pending) {
    if (
      context.standalonePageCache.size >=
      MAX_SHARED_STANDALONE_PAGE_CACHE_ENTRIES
    ) {
      const oldestKey = context.standalonePageCache.keys().next().value;
      if (oldestKey) context.standalonePageCache.delete(oldestKey);
    }
    pending = renderPageWithStandalonePdfJs(attachment, pageNumber);
    context.standalonePageCache.set(key, pending);
  }
  try {
    const result = await pending;
    if (!result && context.standalonePageCache.get(key) === pending) {
      context.standalonePageCache.delete(key);
    }
    return result;
  } catch (error) {
    if (context.standalonePageCache.get(key) === pending) {
      context.standalonePageCache.delete(key);
    }
    throw error;
  }
}

function resolvePdfPageBounds(page: PdfPageLike): number[] | null {
  const raw = page.view as
    | { 0?: unknown; 1?: unknown; 2?: unknown; 3?: unknown }
    | null
    | undefined;
  const bounds = [raw?.[0], raw?.[1], raw?.[2], raw?.[3]].map(Number);
  return bounds.length === 4 && bounds.every(Number.isFinite) ? bounds : null;
}

/**
 * Zotero's reader already owns a PDFRenderer that renders annotation and
 * reading-mode crops entirely inside the reader compartment. Reusing that
 * path avoids waiting on a cross-compartment PDFRenderTask promise, which can
 * remain pending indefinitely in Zotero 10 even after page.render starts.
 */
async function renderPageWithZoteroRegionRenderer(
  reader: _ZoteroTypes.ReaderInstance,
  page: PdfPageLike,
  pageNumber: number,
): Promise<string | null> {
  const bounds = resolvePdfPageBounds(page);
  if (!bounds) return null;
  const internalReader = waiveCompartmentValue(
    (
      reader as _ZoteroTypes.ReaderInstance & {
        _internalReader?: {
          _primaryView?: { _pdfRenderer?: ZoteroRegionRendererLike };
          _lastView?: { _pdfRenderer?: ZoteroRegionRendererLike };
        };
      }
    )._internalReader,
  );
  const renderers = Array.from(
    new Set(
      [
        internalReader?._primaryView?._pdfRenderer,
        internalReader?._lastView?._pdfRenderer,
      ]
        .filter(Boolean)
        .map((renderer) =>
          waiveCompartmentValue(renderer as ZoteroRegionRendererLike),
        ),
    ),
  );
  (globalThis as unknown as { debug?: (message: string) => void }).debug?.(
    `[presentation-media] Zotero region renderers for page ${pageNumber}: ${renderers.length}`,
  );
  let lastError: unknown;
  for (const renderer of renderers) {
    try {
      const rawImages = await resolveWithin(
        Promise.resolve(renderer.renderRegionCrops(pageNumber - 1, [bounds])),
        PDF_RENDER_TIMEOUT_MS,
      );
      const images = waiveCompartmentValue(rawImages) as {
        0?: unknown;
      };
      const data = String(images?.[0] || "");
      (globalThis as unknown as { debug?: (message: string) => void }).debug?.(
        `[presentation-media] Zotero region renderer page ${pageNumber}: data=${data.slice(0, 32)}, length=${data.length}`,
      );
      if (data.startsWith("data:image/") && data !== "data:,") {
        return data;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function decodeImageDataToCanvas(
  data: string,
  width: number,
  height: number,
  ownerDocument: Document,
): Promise<HTMLCanvasElement> {
  const ImageConstructor = waiveCompartmentValue(
    ownerDocument.defaultView,
  )?.Image;
  if (!ImageConstructor || !data.startsWith("data:image/")) {
    throw new Error("Zotero could not decode the rendered PDF page image.");
  }
  const image = new ImageConstructor();
  await resolveWithin(
    new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(new Error("Zotero failed to load the rendered PDF page image."));
      image.src = data;
    }),
    PDF_RENDER_TIMEOUT_MS,
  );
  const decodedWidth =
    Number((image as HTMLImageElement).naturalWidth) ||
    Number((image as HTMLImageElement).width) ||
    width;
  const decodedHeight =
    Number((image as HTMLImageElement).naturalHeight) ||
    Number((image as HTMLImageElement).height) ||
    height;
  const canvas = createCanvas(ownerDocument, decodedWidth, decodedHeight);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("Zotero could not create a decoded PDF page canvas.");
  }
  context.fillStyle = "#FFFFFF";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function viewportFromReaderRealm(
  render: ReaderRealmRenderResult,
): PdfViewportLike {
  const transform = render.transform;
  return {
    width: render.width,
    height: render.height,
    scale: render.scale,
    transform,
    convertToViewportPoint: (x: number, y: number) => {
      if (transform.length < 6) return [x * render.scale, y * render.scale];
      return [
        x * transform[0] + y * transform[2] + transform[4],
        x * transform[1] + y * transform[3] + transform[5],
      ];
    },
  };
}

function normalizeCaption(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .slice(0, 100);
}

interface CaptionLabel {
  kind: "figure" | "table";
  number: string;
}

interface LocatedCaptionLabel extends CaptionLabel {
  index: number;
  punctuation: ":" | ".";
}

function extractCaptionLabel(value: string): CaptionLabel | null {
  const match = value
    .normalize("NFKC")
    .match(/^\s*(fig(?:ure)?|table)\s*\.?\s*([0-9]+[a-z]?)\b/i);
  if (!match) return null;
  return {
    kind: match[1].toLocaleLowerCase().startsWith("fig") ? "figure" : "table",
    number: match[2].toLocaleLowerCase(),
  };
}

function extractFormalCaptionLabel(value: string): CaptionLabel | null {
  const match = value
    .normalize("NFKC")
    .match(/^\s*(fig(?:ure)?|table)\s*\.?\s*([0-9]+[a-z]?)\s*[:.]/i);
  if (!match) return null;
  return {
    kind: match[1].toLocaleLowerCase().startsWith("fig") ? "figure" : "table",
    number: match[2].toLocaleLowerCase(),
  };
}

function locateFormalCaptionLabel(value: string): LocatedCaptionLabel | null {
  const normalized = value.normalize("NFKC");
  const match = normalized.match(
    /(?:^|\s)(fig(?:ure)?|table)\s*\.?\s*([0-9]+[a-z]?)\s*([:.])/i,
  );
  if (!match || match.index === undefined) return null;
  const leadingWhitespace = /^\s/.test(match[0]) ? 1 : 0;
  return {
    kind: match[1].toLocaleLowerCase().startsWith("fig") ? "figure" : "table",
    number: match[2].toLocaleLowerCase(),
    index: match.index + leadingWhitespace,
    punctuation: match[3] as ":" | ".",
  };
}

function projectEmbeddedCaptionLine(
  line: CaptionLine,
  location: LocatedCaptionLabel,
): CaptionLine {
  const characterCount = Math.max(1, Array.from(line.text).length);
  const prefixCount = Array.from(line.text.slice(0, location.index)).length;
  const prefixRatio = Math.min(0.92, Math.max(0, prefixCount / characterCount));
  const x = line.x + line.width * prefixRatio;
  return {
    ...line,
    text: line.text.slice(location.index).trim(),
    x,
    width: Math.max(1, line.x + line.width - x),
  };
}

async function extractCaptionLines(
  page: PdfPageLike,
  viewport: PdfViewportLike,
): Promise<CaptionLine[]> {
  if (!page.getTextContent) return [];
  const textContent = await page.getTextContent();
  const rawItems = Array.isArray(textContent.items) ? textContent.items : [];
  const items: CaptionLine[] = [];
  for (const rawItem of rawItems) {
    const transform = readPresentationNumericTuple(rawItem.transform, 6);
    const text = typeof rawItem.str === "string" ? rawItem.str.trim() : "";
    if (!text || !transform) continue;
    const pdfX = transform[4];
    const pdfY = transform[5];
    const point = convertPresentationPdfPoint(viewport, pdfX, pdfY);
    const rawWidth = Number(rawItem.width) || text.length * 5;
    const rawHeight = Number(rawItem.height) || Math.abs(transform[3]);
    const rightPoint = convertPresentationPdfPoint(
      viewport,
      pdfX + rawWidth,
      pdfY,
    );
    const topPoint = convertPresentationPdfPoint(
      viewport,
      pdfX,
      pdfY + rawHeight,
    );
    const width = Math.max(1, Math.abs(rightPoint[0] - point[0]) || rawWidth);
    const height = Math.max(1, Math.abs(topPoint[1] - point[1]) || rawHeight);
    items.push({ text, x: point[0], y: point[1], width, height });
  }

  return mergeCaptionItems(items, viewport.width);
}

function mergeCaptionItems(
  items: CaptionLine[],
  viewportWidth: number,
): CaptionLine[] {
  items.sort((left, right) => left.y - right.y || left.x - right.x);
  const lines: CaptionLine[] = [];
  for (const item of items) {
    const maximumHorizontalGap = Math.max(
      18,
      viewportWidth * 0.035,
      item.height * 5,
    );
    if (extractFormalCaptionLabel(item.text)) {
      lines.push({ ...item });
      continue;
    }
    const existing = lines
      .map((line) => {
        if (Math.abs(line.y - item.y) > Math.max(4, item.height * 0.65)) {
          return null;
        }
        const horizontalGap = Math.max(
          0,
          Math.max(line.x, item.x) -
            Math.min(line.x + line.width, item.x + item.width),
        );
        return horizontalGap <= maximumHorizontalGap
          ? { line, horizontalGap }
          : null;
      })
      .filter(
        (
          candidate,
        ): candidate is { line: CaptionLine; horizontalGap: number } =>
          Boolean(candidate),
      )
      .sort((left, right) => {
        if (left.horizontalGap !== right.horizontalGap) {
          return left.horizontalGap - right.horizontalGap;
        }
        return (
          Number(Boolean(extractFormalCaptionLabel(right.line.text))) -
          Number(Boolean(extractFormalCaptionLabel(left.line.text)))
        );
      })[0]?.line;
    if (!existing) {
      lines.push({ ...item });
      continue;
    }
    const ordered = existing.x <= item.x;
    existing.text = ordered
      ? `${existing.text} ${item.text}`
      : `${item.text} ${existing.text}`;
    const left = Math.min(existing.x, item.x);
    const right = Math.max(existing.x + existing.width, item.x + item.width);
    existing.x = left;
    existing.width = right - left;
    existing.height = Math.max(existing.height, item.height);
  }
  return lines;
}

/**
 * Extracts already-converted text geometry inside the PDF reader's own realm.
 * Returning JSON keeps Firefox Xray wrappers away from PDF.js viewport and
 * text-item arrays, whose hidden iteration semantics can otherwise leave Y
 * coordinates in bottom-left PDF space in the live Zotero reader.
 */
export async function extractPresentationCaptionSnapshotInReaderRealm(
  ownerWindow: PdfReaderWindow,
  pageNumber: number,
): Promise<ReaderRealmCaptionSnapshot | null> {
  const targetWindow =
    ownerWindow.wrappedJSObject || (ownerWindow as PdfReaderWindow);
  const FunctionConstructor = targetWindow.Function;
  if (typeof FunctionConstructor !== "function") return null;

  const createExtractor = FunctionConstructor(`
    "use strict";
    return async function extractPaperChatCaptionGeometry(pageNumber) {
      const application = globalThis.PDFViewerApplication;
      if (!application || !application.pdfDocument) {
        throw new Error("PDFViewerApplication.pdfDocument is unavailable.");
      }
      const page = await application.pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const items = [];
      for (const rawItem of Array.from(textContent.items || [])) {
        const text = typeof rawItem.str === "string" ? rawItem.str.trim() : "";
        const transform = rawItem.transform;
        if (!text || !transform) continue;
        const pdfX = Number(transform[4]);
        const pdfY = Number(transform[5]);
        if (!Number.isFinite(pdfX) || !Number.isFinite(pdfY)) continue;
        const rawWidth = Number(rawItem.width) || text.length * 5;
        const rawHeight = Number(rawItem.height) || Math.abs(Number(transform[3])) || 1;
        const point = viewport.convertToViewportPoint(pdfX, pdfY);
        const rightPoint = viewport.convertToViewportPoint(pdfX + rawWidth, pdfY);
        const topPoint = viewport.convertToViewportPoint(pdfX, pdfY + rawHeight);
        const x = Number(point && point[0]);
        const y = Number(point && point[1]);
        const width = Math.max(1, Math.abs(Number(rightPoint && rightPoint[0]) - x) || rawWidth);
        const height = Math.max(1, Math.abs(Number(topPoint && topPoint[1]) - y) || rawHeight);
        if (![x, y, width, height].every(Number.isFinite)) continue;
        items.push({ text, x, y, width, height });
      }
      return JSON.stringify({
        viewportWidth: Number(viewport.width),
        viewportHeight: Number(viewport.height),
        items
      });
    };
  `) as () => (pageNumber: number) => Promise<string>;
  const extract = createExtractor();
  const encoded = await resolveWithin(
    Promise.resolve(extract(pageNumber)),
    PDF_RENDER_TIMEOUT_MS,
  );
  const parsed = JSON.parse(String(unwrapCompartmentValue(encoded))) as {
    viewportWidth?: unknown;
    viewportHeight?: unknown;
    items?: unknown;
  };
  const viewportWidth = Number(parsed.viewportWidth);
  const viewportHeight = Number(parsed.viewportHeight);
  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    throw new Error(
      "Reader-realm caption geometry returned invalid viewport dimensions.",
    );
  }
  const items = rawItems
    .map((rawItem) => {
      const item = rawItem as Partial<CaptionLine>;
      return {
        text: typeof item.text === "string" ? item.text : "",
        x: Number(item.x),
        y: Number(item.y),
        width: Number(item.width),
        height: Number(item.height),
      };
    })
    .filter(
      (item) =>
        item.text &&
        [item.x, item.y, item.width, item.height].every(Number.isFinite),
    );
  return { viewportWidth, viewportHeight, items };
}

function findCaptionLine(
  lines: CaptionLine[],
  captionHint: string,
): CaptionLine | undefined {
  const target = normalizeCaption(captionHint);
  if (!target) return undefined;
  const targetLabel = extractCaptionLabel(captionHint);
  if (targetLabel) {
    const anchored = lines.filter((line) => {
      const candidateLabel = extractCaptionLabel(line.text);
      return (
        candidateLabel?.kind === targetLabel.kind &&
        candidateLabel.number === targetLabel.number
      );
    });
    if (anchored.length) {
      const formalMatch = anchored.find((line) => {
        const formalLabel = extractFormalCaptionLabel(line.text);
        return (
          formalLabel?.kind === targetLabel.kind &&
          formalLabel.number === targetLabel.number
        );
      });
      if (formalMatch) return formalMatch;
      const distinctivePrefix = target.slice(0, Math.min(36, target.length));
      const distinctiveMatch = anchored.find((line) =>
        normalizeCaption(line.text).includes(distinctivePrefix),
      );
      if (distinctiveMatch) return distinctiveMatch;
    }

    const targetPrefix = target.slice(0, Math.min(36, target.length));
    const embedded = lines
      .map((line) => {
        const location = locateFormalCaptionLabel(line.text);
        if (
          !location ||
          location.index <= 0 ||
          location.kind !== targetLabel.kind ||
          location.number !== targetLabel.number
        ) {
          return null;
        }
        const projected = projectEmbeddedCaptionLine(line, location);
        const candidate = normalizeCaption(projected.text);
        const resemblesTarget =
          candidate.includes(targetPrefix) ||
          target.includes(candidate.slice(0, Math.min(24, candidate.length)));
        if (!resemblesTarget && location.punctuation !== ":") return null;
        return { projected, resemblesTarget };
      })
      .filter(
        (
          candidate,
        ): candidate is {
          projected: CaptionLine;
          resemblesTarget: boolean;
        } => Boolean(candidate),
      )
      .sort(
        (left, right) =>
          Number(right.resemblesTarget) - Number(left.resemblesTarget),
      )[0]?.projected;
    if (embedded) return embedded;
    return undefined;
  }
  const distinctivePrefix = target.slice(0, Math.min(36, target.length));
  const direct = lines.find((line) => {
    const candidate = normalizeCaption(line.text);
    return (
      candidate.includes(distinctivePrefix) ||
      target.includes(candidate.slice(0, Math.min(24, candidate.length)))
    );
  });
  if (direct) return direct;

  const targetPairs = new Set(
    Array.from({ length: Math.max(0, target.length - 1) }, (_, index) =>
      target.slice(index, index + 2),
    ),
  );
  let best: { line: CaptionLine; score: number } | undefined;
  for (const line of lines) {
    const candidate = normalizeCaption(line.text);
    if (candidate.length < 8) continue;
    const candidatePairs = new Set(
      Array.from({ length: Math.max(0, candidate.length - 1) }, (_, index) =>
        candidate.slice(index, index + 2),
      ),
    );
    let shared = 0;
    for (const pair of targetPairs) {
      if (candidatePairs.has(pair)) shared += 1;
    }
    const score =
      shared / Math.max(1, Math.min(targetPairs.size, candidatePairs.size));
    if (!best || score > best.score) best = { line, score };
  }
  return best && best.score >= 0.42 ? best.line : undefined;
}

function neighboringPageCandidates(
  requestedPage: number,
  pageCount: number | undefined,
): number[] {
  const candidates = [
    requestedPage,
    requestedPage - 1,
    requestedPage + 1,
    requestedPage - 2,
    requestedPage + 2,
  ];
  return Array.from(
    new Set(
      candidates.filter(
        (page) => page >= 1 && (!pageCount || page <= pageCount),
      ),
    ),
  );
}

async function findAnchoredCaption(
  pdfDocument: PdfDocumentLike,
  ownerWindow: PdfReaderWindow,
  requestedPage: number,
  pageCount: number | undefined,
  captionHint: string,
): Promise<AnchoredCaptionLocation | undefined> {
  for (const pageNumber of neighboringPageCandidates(
    requestedPage,
    pageCount,
  )) {
    const page = unwrapPdfPage(
      await resolveWithin(
        pdfDocument.getPage(pageNumber),
        PDF_RENDER_TIMEOUT_MS,
      ),
    );
    let snapshot: ReaderRealmCaptionSnapshot | null = null;
    let captionFallbackReason: string | undefined;
    try {
      snapshot = await extractPresentationCaptionSnapshotInReaderRealm(
        ownerWindow,
        pageNumber,
      );
    } catch (error) {
      captionFallbackReason = String(error);
      logPresentationWarning(
        `Could not extract caption geometry in the PDF reader realm on page ${pageNumber}; using the cross-realm fallback (${String(error)}).`,
      );
    }
    const viewport = snapshot ? null : page.getViewport({ scale: 1 });
    const lines = snapshot
      ? mergeCaptionItems(snapshot.items, snapshot.viewportWidth)
      : await extractCaptionLines(page, viewport as PdfViewportLike);
    // PDF.js commonly emits a formal label such as "Figure 2:" as one text
    // item and the rest of the caption as adjacent items. Prefer the merged
    // line geometry so a full-width scientific figure is not misclassified as
    // a narrow column figure from the label token alone. The raw snapshot is
    // still a fallback for captions that cannot be merged safely.
    const caption = snapshot
      ? findCaptionLine(lines, captionHint) ||
        findCaptionLine(snapshot.items, captionHint)
      : findCaptionLine(lines, captionHint);
    if (caption) {
      return {
        pageNumber,
        caption,
        lines,
        viewportWidth: snapshot?.viewportWidth || viewport!.width,
        viewportHeight: snapshot?.viewportHeight || viewport!.height,
        captionSource: snapshot ? "reader-realm" : "cross-realm",
        ...(captionFallbackReason ? { captionFallbackReason } : {}),
      };
    }
  }
  return undefined;
}

function scaleCaptionLine(
  caption: CaptionLine,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  fallbackScale?: number,
): CaptionLine {
  const [scaleX, scaleY] = resolvePresentationViewportScale(
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
    fallbackScale,
  );
  return {
    text: caption.text,
    x: caption.x * scaleX,
    y: caption.y * scaleY,
    width: caption.width * scaleX,
    height: caption.height * scaleY,
  };
}

export function resolvePresentationViewportScale(
  sourceWidth: unknown,
  sourceHeight: unknown,
  targetWidth: number,
  targetHeight: number,
  fallbackScale?: unknown,
): [number, number] {
  const width = Number(sourceWidth);
  const height = Number(sourceHeight);
  const fallback = Number(fallbackScale);
  const widthScale =
    Number.isFinite(width) && width > 0 ? targetWidth / width : null;
  const heightScale =
    Number.isFinite(height) && height > 0 ? targetHeight / height : null;
  const safeFallback = Number.isFinite(fallback) && fallback > 0 ? fallback : 1;
  const scaleX = widthScale || heightScale || safeFallback;
  const scaleY = heightScale || widthScale || safeFallback;
  return [scaleX, scaleY];
}

function fallbackVisualCrop(
  canvasWidth: number,
  canvasHeight: number,
): PixelCrop {
  return {
    x: canvasWidth * 0.045,
    y: canvasHeight * 0.055,
    width: canvasWidth * 0.91,
    height: canvasHeight * 0.66,
  };
}

function logPresentationWarning(message: string): void {
  if (typeof ztoolkit !== "undefined") {
    ztoolkit.log(`[presentation] ${message}`);
  }
}

export function derivePresentationCaptionCrop(
  caption: CaptionLine,
  canvasWidth: number,
  canvasHeight: number,
): PixelCrop {
  // A wrapped full-width caption is often exposed by PDF.js as only its first
  // text line. Treating every line below two thirds of the page as a column
  // caption clipped wide scientific figures such as AlexNet Figure 2 to the
  // left half of the page before pixel refinement could inspect them. Real
  // two-column captions stay close to one half-page or narrower, so reserve
  // the column heuristic for that geometry and let wider lines open a
  // full-width candidate region.
  const narrowCaption = caption.width < canvasWidth * 0.54;
  const isLeftColumn = narrowCaption && caption.x < canvasWidth * 0.46;
  const isRightColumn = narrowCaption && caption.x >= canvasWidth * 0.46;
  const pageMargin = canvasWidth * 0.045;
  const columnPadding = canvasWidth * 0.018;
  let x = pageMargin;
  let width = canvasWidth * 0.91;
  if (isLeftColumn) {
    x = Math.max(pageMargin, caption.x - columnPadding);
    width = Math.max(
      canvasWidth * 0.28,
      Math.min(canvasWidth * 0.47, canvasWidth * 0.505 - x),
    );
  } else if (isRightColumn) {
    // Research captions are commonly inset from the actual column edge. A
    // fixed 50% split includes the final lines of the left column in the crop,
    // which is especially visible on dark PDF pages. Anchor the crop to the
    // printed caption instead and keep only a small amount of breathing room.
    x = Math.max(canvasWidth * 0.5, caption.x - columnPadding * 0.5);
    width = Math.max(
      canvasWidth * 0.28,
      Math.min(canvasWidth * 0.47, canvasWidth - pageMargin - x),
    );
  }
  const bottom = Math.max(
    canvasHeight * 0.18,
    caption.y - caption.height * 1.1,
  );
  const preferredHeight = narrowCaption
    ? canvasHeight * 0.24
    : canvasHeight * 0.38;
  const y = Math.max(canvasHeight * 0.055, bottom - preferredHeight);
  return { x, y, width, height: bottom - y };
}

export function applyPresentationCropWidthHint(
  candidate: PixelCrop,
  explicitCrop: PixelCrop | null,
  canvasWidth: number,
): PixelCrop {
  if (
    !isFinitePixelCrop(explicitCrop) ||
    explicitCrop.width < canvasWidth * 0.75 ||
    candidate.width >= canvasWidth * 0.58 ||
    candidate.x > canvasWidth * 0.25
  ) {
    return candidate;
  }
  return {
    x: explicitCrop.x,
    y: candidate.y,
    width: explicitCrop.width,
    height: candidate.height,
  };
}

function cropIntersectionRatio(
  subject: PixelCrop,
  reference: PixelCrop,
): number {
  const width = Math.max(
    0,
    Math.min(subject.x + subject.width, reference.x + reference.width) -
      Math.max(subject.x, reference.x),
  );
  const height = Math.max(
    0,
    Math.min(subject.y + subject.height, reference.y + reference.height) -
      Math.max(subject.y, reference.y),
  );
  return (width * height) / Math.max(1, subject.width * subject.height);
}

function isPlausibleFigureCrop(
  crop: PixelCrop,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  if (!isFinitePixelCrop(crop)) return false;
  const width = Number(crop.width);
  const height = Number(crop.height);
  return (
    width >= Math.max(MIN_CROP_PIXELS, canvasWidth * 0.12) &&
    height >= Math.max(MIN_CROP_PIXELS, canvasHeight * 0.04) &&
    width / Math.max(1, height) <= 10 &&
    (width * height) / Math.max(1, canvasWidth * canvasHeight) >= 0.006
  );
}

export function selectCaptionAnchoredCrop(
  refinedCrop: PixelCrop,
  candidateCrop: PixelCrop,
  explicitCrop: PixelCrop | null,
  canvasWidth: number,
  canvasHeight: number,
): PixelCrop {
  if (isPlausibleFigureCrop(refinedCrop, canvasWidth, canvasHeight)) {
    return refinedCrop;
  }
  if (isFinitePixelCrop(candidateCrop)) {
    return candidateCrop;
  }
  return isFinitePixelCrop(explicitCrop) ? explicitCrop : candidateCrop;
}

async function refineCaptionCrop(
  page: PdfPageLike,
  viewport: PdfViewportLike,
  pageCanvas: HTMLCanvasElement,
  caption: CaptionLine,
  candidate: PixelCrop,
  textLines: CaptionLine[],
  preferNonText: boolean,
): Promise<PixelCrop> {
  if (page.getOperatorList) {
    try {
      const operatorList = await resolveWithin(
        page.getOperatorList(),
        PDF_RENDER_TIMEOUT_MS,
      );
      const rasterCrop = selectRasterFigureCrop(
        extractPaintedImageBounds(operatorList, viewport),
        candidate,
        caption,
        pageCanvas.width,
        pageCanvas.height,
        { textRegions: textLines, preferNonText },
      );
      if (rasterCrop) return rasterCrop;
    } catch (error) {
      logPresentationWarning(
        `Could not inspect PDF image objects; falling back to rendered-page analysis (${String(error)}).`,
      );
    }
  }
  return (
    refineFigureCropFromPixels(pageCanvas, candidate, {
      textRegions: textLines,
      preferNonText,
    }) || candidate
  );
}

function normalizedCrop(
  figure: PresentationFigure,
  canvasWidth: number,
  canvasHeight: number,
): PixelCrop | null {
  if (!figure.crop) return null;
  return {
    x: figure.crop.x * canvasWidth,
    y: figure.crop.y * canvasHeight,
    width: figure.crop.width * canvasWidth,
    height: figure.crop.height * canvasHeight,
  };
}

function isFinitePixelCrop(
  crop: PixelCrop | null | undefined,
): crop is PixelCrop {
  return Boolean(
    crop &&
    Number.isFinite(Number(crop.x)) &&
    Number.isFinite(Number(crop.y)) &&
    Number.isFinite(Number(crop.width)) &&
    Number.isFinite(Number(crop.height)) &&
    Number(crop.width) > 0 &&
    Number(crop.height) > 0,
  );
}

export function clampPresentationCrop(
  crop: PixelCrop,
  canvasWidth: number,
  canvasHeight: number,
  fallbackCrop?: PixelCrop | null,
): PixelCrop {
  const safeCanvasWidth = Math.max(
    MIN_CROP_PIXELS,
    Number(canvasWidth) || MIN_CROP_PIXELS,
  );
  const safeCanvasHeight = Math.max(
    MIN_CROP_PIXELS,
    Number(canvasHeight) || MIN_CROP_PIXELS,
  );
  const requested = isFinitePixelCrop(crop)
    ? crop
    : isFinitePixelCrop(fallbackCrop)
      ? fallbackCrop
      : fallbackVisualCrop(safeCanvasWidth, safeCanvasHeight);
  const x = Math.max(
    0,
    Math.min(safeCanvasWidth - MIN_CROP_PIXELS, Number(requested.x)),
  );
  const y = Math.max(
    0,
    Math.min(safeCanvasHeight - MIN_CROP_PIXELS, Number(requested.y)),
  );
  const width = Math.max(
    MIN_CROP_PIXELS,
    Math.min(safeCanvasWidth - x, Number(requested.width)),
  );
  const height = Math.max(
    MIN_CROP_PIXELS,
    Math.min(safeCanvasHeight - y, Number(requested.height)),
  );
  return { x, y, width, height };
}

function cropCanvas(
  source: HTMLCanvasElement,
  ownerDocument: Document,
  crop: PixelCrop,
  fallbackCrop?: PixelCrop | null,
): HTMLCanvasElement {
  const safe = clampPresentationCrop(
    crop,
    source.width,
    source.height,
    fallbackCrop,
  );
  const output = createCanvas(ownerDocument, safe.width, safe.height);
  const context = output.getContext("2d");
  if (!context) {
    throw new Error("Zotero could not create a canvas for the paper figure.");
  }
  context.fillStyle = "#FFFFFF";
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(
    source,
    safe.x,
    safe.y,
    safe.width,
    safe.height,
    0,
    0,
    output.width,
    output.height,
  );
  return output;
}

async function renderPaperFigure(
  figure: PresentationFigure,
  defaultItemKey?: string,
  context: PresentationMediaResolutionContext = {
    standalonePageCache: sharedStandalonePageCache,
  },
): Promise<ResolvedPresentationFigure> {
  const itemKey = figure.itemKey || defaultItemKey;
  if (!itemKey) {
    throw new Error(
      `Paper figure on page ${figure.page} is missing itemKey/sourceItemKey.`,
    );
  }
  const sourceLibraryID =
    itemKey === context.sourceItemKey ? context.sourceLibraryID : undefined;
  const attachment = await resolvePdfAttachment(itemKey, sourceLibraryID);
  const reader = await resolveReader(attachment, figure.page);
  const {
    document: pdfDocument,
    ownerDocument,
    ownerWindow,
  } = await resolvePdfDocument(reader);
  // PDFPageProxy belongs to the reader iframe. Keep every fallback canvas in
  // that same DOM realm so PDF.js never has to call getContext across a
  // Firefox compartment boundary. Plugin-side canvas access is waived by
  // createCanvas(), while the page renderer receives its native reflector.
  const canvasDocument = ownerDocument;
  const pageCount = Number(pdfDocument.numPages);
  if (
    Number.isSafeInteger(pageCount) &&
    pageCount > 0 &&
    figure.page > pageCount
  ) {
    throw new Error(
      `Paper figure page ${figure.page} exceeds the PDF page count (${pageCount}).`,
    );
  }

  const explicitCaptionLabel = figure.captionHint
    ? extractCaptionLabel(figure.captionHint)
    : null;
  const cropTrace = [
    explicitCaptionLabel
      ? `label=${explicitCaptionLabel.kind}${explicitCaptionLabel.number}`
      : "label=none",
  ];
  let resolvedPageNumber = figure.page;
  let anchoredCaption: AnchoredCaptionLocation | undefined;
  if (
    (figure.mode || "figure") === "figure" &&
    figure.captionHint &&
    explicitCaptionLabel
  ) {
    anchoredCaption = await findAnchoredCaption(
      pdfDocument,
      ownerWindow,
      figure.page,
      Number.isSafeInteger(pageCount) && pageCount > 0 ? pageCount : undefined,
      figure.captionHint,
    );
    if (!anchoredCaption) {
      logPresentationWarning(
        `Caption "${figure.captionHint}" was not found as an anchored figure/table caption on PDF page ${figure.page} or its neighboring pages; rendering the requested page and deferring the crop decision to the visual reviewer.`,
      );
    }
    resolvedPageNumber = anchoredCaption?.pageNumber || figure.page;
    if (anchoredCaption && resolvedPageNumber !== figure.page) {
      logPresentationWarning(
        `Requested ${explicitCaptionLabel.kind} ${explicitCaptionLabel.number} on PDF page ${figure.page}; anchored caption found on page ${resolvedPageNumber}.`,
      );
    }
  }

  const page = unwrapPdfPage(
    await resolveWithin(
      pdfDocument.getPage(resolvedPageNumber),
      PDF_RENDER_TIMEOUT_MS,
    ),
  );
  let standaloneRender: ReaderRealmRenderResult | null = null;
  try {
    standaloneRender = await getStandalonePdfPage(
      context,
      attachment,
      resolvedPageNumber,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    cropTrace.push(`standalone-pdfjs-fallback=${reason}`);
    logPresentationWarning(
      `Standalone Zotero PDF.js rendering failed for page ${resolvedPageNumber}; retrying through the live reader (${reason}).`,
    );
  }
  let zoteroRegionRenderData: string | null = null;
  if (!standaloneRender) {
    try {
      zoteroRegionRenderData = await renderPageWithZoteroRegionRenderer(
        reader,
        page,
        resolvedPageNumber,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      cropTrace.push(`zotero-region-fallback=${reason}`);
      logPresentationWarning(
        `Zotero's native PDF region renderer failed for page ${resolvedPageNumber}; retrying through the reader-realm renderer (${reason}).`,
      );
    }
  }
  let readerRealmRender: ReaderRealmRenderResult | null = null;
  if (!standaloneRender && !zoteroRegionRenderData) {
    try {
      readerRealmRender = await renderPageInReaderRealm(
        ownerWindow,
        resolvedPageNumber,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      cropTrace.push(`reader-realm-fallback=${reason}`);
      logPresentationWarning(
        `Reader-realm rendering failed for PDF page ${resolvedPageNumber}; retrying through the direct PDF.js page renderer (${reason}).`,
      );
    }
  }
  let viewport: PdfViewportLike;
  let pageCanvas: HTMLCanvasElement;
  let pageInkRatio: number | null;
  if (standaloneRender) {
    viewport = viewportFromReaderRealm(standaloneRender);
    pageCanvas = await decodeImageDataToCanvas(
      standaloneRender.data,
      standaloneRender.width,
      standaloneRender.height,
      canvasDocument,
    );
    pageInkRatio = standaloneRender.inkRatio;
    cropTrace.push("render=standalone-zotero-pdfjs");
  } else if (zoteroRegionRenderData) {
    pageCanvas = await decodeImageDataToCanvas(
      zoteroRegionRenderData,
      0,
      0,
      canvasDocument,
    );
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.max(
      0.01,
      pageCanvas.width / Math.max(1, Number(baseViewport.width) || 1),
    );
    viewport = page.getViewport({ scale });
    pageInkRatio = measureCanvasInkRatio(pageCanvas);
    cropTrace.push("render=zotero-region-renderer");
  } else if (readerRealmRender) {
    viewport = viewportFromReaderRealm(readerRealmRender);
    pageCanvas = await decodeImageDataToCanvas(
      readerRealmRender.data,
      readerRealmRender.width,
      readerRealmRender.height,
      canvasDocument,
    );
    pageInkRatio = readerRealmRender.inkRatio;
  } else {
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.max(
      1,
      Math.min(
        3,
        TARGET_LONG_EDGE / Math.max(baseViewport.width, baseViewport.height),
      ),
    );
    viewport = page.getViewport({ scale });
    pageCanvas = createCanvas(canvasDocument, viewport.width, viewport.height);
    const context = pageCanvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("Zotero could not create a PDF rendering canvas.");
    }
    context.fillStyle = "#FFFFFF";
    context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    const rawRenderTask = page.render(
      createPdfRenderOptions(
        ownerWindow,
        pageCanvas,
        context as CanvasRenderingContext2D,
        viewport,
      ),
    );
    const renderTask = unwrapCompartmentValue(rawRenderTask);
    const renderPromise =
      renderTask && typeof renderTask === "object" && "promise" in renderTask
        ? unwrapCompartmentValue(renderTask.promise) || Promise.resolve()
        : Promise.resolve(renderTask);
    try {
      await resolveWithin(renderPromise, PDF_RENDER_TIMEOUT_MS, () => {
        const cancel = (renderTask as { cancel?: () => void } | null)?.cancel;
        cancel?.call(renderTask);
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Direct PDF.js rendering failed for page ${resolvedPageNumber}: ${reason}; ${cropTrace.join("; ")}`,
      );
    }
    pageInkRatio = measureCanvasInkRatio(pageCanvas);
  }
  if (pageInkRatio !== null && pageInkRatio < MIN_RENDERED_PAGE_INK_RATIO) {
    throw new Error(
      `PDF page ${figure.page} rendered as a blank image (${(pageInkRatio * 100).toFixed(3)}% visible pixels).`,
    );
  }

  let outputCanvas = pageCanvas;
  if ((figure.mode || "figure") === "figure") {
    const explicitCrop = normalizedCrop(
      figure,
      pageCanvas.width,
      pageCanvas.height,
    );
    if (explicitCrop) {
      cropTrace.push(
        `explicit=${Math.round(explicitCrop.width)}x${Math.round(explicitCrop.height)}`,
      );
    }
    let crop = explicitCaptionLabel ? null : explicitCrop;
    if (crop) cropTrace.push("selected=explicit-initial");
    if (!crop && figure.captionHint) {
      const caption = anchoredCaption
        ? scaleCaptionLine(
            anchoredCaption.caption,
            anchoredCaption.viewportWidth,
            anchoredCaption.viewportHeight,
            pageCanvas.width,
            pageCanvas.height,
            (standaloneRender || readerRealmRender)?.scale,
          )
        : findCaptionLine(
            await extractCaptionLines(page, viewport),
            figure.captionHint,
          );
      if (!caption) {
        logPresentationWarning(
          explicitCaptionLabel
            ? `Caption "${figure.captionHint}" could not be mapped onto PDF page ${resolvedPageNumber}; using a conservative page-region fallback for visual review.`
            : `Caption was not located on PDF page ${figure.page}; using a conservative page-region fallback.`,
        );
        cropTrace.push("selected=caption-missing-fallback");
        crop = fallbackVisualCrop(pageCanvas.width, pageCanvas.height);
      } else {
        cropTrace.push(
          `caption=${Math.round(caption.x)},${Math.round(caption.y)},${Math.round(caption.width)}x${Math.round(caption.height)}`,
          `captionText=${normalizeCaption(caption.text).slice(0, 48)}`,
          `canvas=${pageCanvas.width}x${pageCanvas.height}`,
        );
        if (anchoredCaption) {
          cropTrace.push(
            `captionSource=${anchoredCaption.captionSource}`,
            `anchor=${Math.round(anchoredCaption.caption.x)},${Math.round(anchoredCaption.caption.y)},${Math.round(anchoredCaption.caption.width)}x${Math.round(anchoredCaption.caption.height)}@${Math.round(anchoredCaption.viewportWidth)}x${Math.round(anchoredCaption.viewportHeight)}`,
          );
          if (anchoredCaption.captionFallbackReason) {
            cropTrace.push(
              `captionFallback=${anchoredCaption.captionFallbackReason.slice(0, 160)}`,
            );
          }
        }
        const pageTextLines = anchoredCaption
          ? anchoredCaption.lines.map((line) =>
              scaleCaptionLine(
                line,
                anchoredCaption.viewportWidth,
                anchoredCaption.viewportHeight,
                pageCanvas.width,
                pageCanvas.height,
                (standaloneRender || readerRealmRender)?.scale,
              ),
            )
          : await extractCaptionLines(page, viewport);
        const candidate = applyPresentationCropWidthHint(
          derivePresentationCaptionCrop(
            caption,
            pageCanvas.width,
            pageCanvas.height,
          ),
          explicitCrop,
          pageCanvas.width,
        );
        cropTrace.push(
          `candidate=${Math.round(candidate.width)}x${Math.round(candidate.height)}`,
        );
        const refinedCrop = await refineCaptionCrop(
          page,
          viewport,
          pageCanvas,
          caption,
          candidate,
          pageTextLines,
          explicitCaptionLabel?.kind !== "table",
        );
        cropTrace.push(
          `refined=${Math.round(refinedCrop.width)}x${Math.round(refinedCrop.height)}`,
        );
        crop = selectCaptionAnchoredCrop(
          refinedCrop,
          candidate,
          explicitCrop,
          pageCanvas.width,
          pageCanvas.height,
        );
        cropTrace.push(
          crop === refinedCrop
            ? "selected=caption-refined"
            : crop === candidate
              ? "selected=caption-candidate"
              : "selected=explicit-fallback",
        );
        if (explicitCaptionLabel?.kind !== "table" && crop !== refinedCrop) {
          logPresentationWarning(
            `Rejected an implausible refined crop for ${figure.captionHint} (${Math.round(refinedCrop.width)}×${Math.round(refinedCrop.height)}); using the caption-anchored region instead.`,
          );
        }
        const explicitArea = explicitCrop
          ? explicitCrop.width * explicitCrop.height
          : 0;
        const anchoredArea = crop.width * crop.height;
        if (
          !explicitCaptionLabel &&
          explicitCrop &&
          cropIntersectionRatio(explicitCrop, crop) >= 0.75 &&
          explicitArea <= anchoredArea * 1.5
        ) {
          crop = explicitCrop;
          cropTrace.push("selected=explicit-aligned");
        } else if (explicitCrop && !explicitCaptionLabel) {
          logPresentationWarning(
            `Ignored an explicit crop for ${figure.captionHint} because it did not align with the caption-anchored figure region.`,
          );
        }
      }
    }
    crop ||= explicitCrop;
    if (
      crop === explicitCrop &&
      !cropTrace.some((part) => part.startsWith("selected="))
    ) {
      cropTrace.push("selected=explicit-final");
    }
    if (!crop) {
      logPresentationWarning(
        `PDF page ${figure.page} did not include crop guidance; using a conservative page-region fallback.`,
      );
      crop = fallbackVisualCrop(pageCanvas.width, pageCanvas.height);
    }
    outputCanvas = cropCanvas(pageCanvas, canvasDocument, crop, explicitCrop);
  }

  const outputInkRatio = measureCanvasInkRatio(outputCanvas);
  if (
    outputInkRatio !== null &&
    outputInkRatio < MIN_RENDERED_FIGURE_INK_RATIO
  ) {
    throw new Error(
      `PDF figure on page ${figure.page} resolved to an empty or invalid crop (${(outputInkRatio * 100).toFixed(3)}% visible pixels).`,
    );
  }

  if (
    !Number.isFinite(outputCanvas.width) ||
    !Number.isFinite(outputCanvas.height) ||
    outputCanvas.width < 2 ||
    outputCanvas.height < 2
  ) {
    throw new Error(
      `PDF figure on page ${resolvedPageNumber} produced an invalid output canvas (${String(outputCanvas.width)}×${String(outputCanvas.height)} pixels).`,
    );
  }
  let data: string;
  try {
    data = String(outputCanvas.toDataURL("image/png"));
  } catch (error) {
    throw new Error(
      `PDF figure on page ${resolvedPageNumber} could not be encoded from a ${outputCanvas.width}×${outputCanvas.height} canvas: ${String(error)}`,
    );
  }
  if (!/^data:image\/png(?:;[^,]+)?,[^,]+$/i.test(data) || data === "data:,") {
    throw new Error(
      `Presentation renderer received invalid figure data on PDF page ${resolvedPageNumber}: type=${typeof data}, tag=${Object.prototype.toString.call(data)}, prefix=${data.slice(0, 32)}, length=${data.length}, canvas=${outputCanvas.width}×${outputCanvas.height}.`,
    );
  }
  if (figure.captionHint) {
    logPresentationWarning(
      `Resolved ${figure.captionHint} to ${outputCanvas.width}×${outputCanvas.height}; ${cropTrace.join(";")}`,
    );
  }
  return {
    ...figure,
    page: resolvedPageNumber,
    itemKey,
    data,
    pixelWidth: outputCanvas.width,
    pixelHeight: outputCanvas.height,
    cropTrace: cropTrace.join(";"),
  };
}

export async function resolvePresentationMedia(
  request: PresentationRequest,
  sourceLibraryID?: number,
): Promise<RenderablePresentationRequest> {
  const context: PresentationMediaResolutionContext = {
    standalonePageCache: sharedStandalonePageCache,
    sourceItemKey: request.sourceItemKey,
    sourceLibraryID,
  };
  const {
    author: requestedAuthor,
    year: requestedYear,
    coverFigure: requestedCoverFigure,
    coverFigures: requestedCoverFigures,
    slides: requestedSlides,
    ...rest
  } = request;
  const sourceItemKey =
    request.sourceItemKey ||
    requestedCoverFigure?.itemKey ||
    requestedCoverFigures?.find((figure) => figure.itemKey)?.itemKey ||
    requestedSlides
      .flatMap((slide) => [slide.figure, ...(slide.figures || [])])
      .find((figure) => figure?.itemKey)?.itemKey;
  // The public presentation intent does not expose a year override. Treat the
  // Zotero item's bibliographic year as authoritative so a planner cannot
  // mistake a dataset year or benchmark name for the paper's publication year.
  const year =
    resolvePresentationSourceYear(sourceItemKey, sourceLibraryID) ||
    requestedYear;
  const author =
    requestedAuthor?.trim() ||
    resolvePresentationSourceAuthor(
      sourceItemKey,
      request.language,
      sourceLibraryID,
    );
  const coverFigure = requestedCoverFigure
    ? await renderPaperFigure(
        requestedCoverFigure,
        request.sourceItemKey,
        context,
      )
    : undefined;
  const coverFigures = requestedCoverFigures
    ? await Promise.all(
        requestedCoverFigures.map((figure) =>
          renderPaperFigure(figure, request.sourceItemKey, context),
        ),
      )
    : undefined;
  const slides: RenderablePresentationSlide[] = [];
  for (const slide of requestedSlides) {
    const { figure, figures, ...slideWithoutFigures } = slide;
    slides.push({
      ...slideWithoutFigures,
      ...(figure
        ? {
            figure: await renderPaperFigure(
              figure,
              request.sourceItemKey,
              context,
            ),
          }
        : {}),
      ...(figures
        ? {
            figures: await Promise.all(
              figures.map((item) =>
                renderPaperFigure(item, request.sourceItemKey, context),
              ),
            ),
          }
        : {}),
    });
  }
  const resolved: RenderablePresentationRequest = {
    ...rest,
    ...(author ? { author } : {}),
    ...(year ? { year } : {}),
    ...(coverFigure ? { coverFigure } : {}),
    ...(coverFigures ? { coverFigures } : {}),
    slides,
  };
  const duplicateIssues = validateResolvedPresentationMedia(resolved);
  if (duplicateIssues.length > 0) {
    throw new PresentationResolvedMediaDuplicateError(
      duplicateIssues,
      resolved,
    );
  }
  return resolved;
}
