import type { ImageAttachment } from "../../types/chat";
import { getString } from "../../utils/locale";
import { getReaderWindows } from "./readerWindows";
import { MAX_PENDING_IMAGE_BYTES } from "./chat-panel/imageAttachmentPolicy";

export { getReaderWindows } from "./readerWindows";

const MIN_SELECTION_CSS_PIXELS = 8;
const MAX_CAPTURE_DIMENSION = 2048;
const MAX_CAPTURE_PIXELS = 1_000_000;
const MAX_CAPTURE_PNG_BYTES = MAX_PENDING_IMAGE_BYTES;
const MAX_CAPTURE_ENCODING_ATTEMPTS = 5;

type ReaderLike = _ZoteroTypes.ReaderInstance & {
  type?: string;
  _iframeWindow?: Window;
  focus?: () => void;
};

type Selection = {
  pointerId: number;
  startX: number;
  startY: number;
  page: HTMLElement;
  canvasBounds: RectLike;
};

type RectLike = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type CaptureRegion = {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  cssLeft: number;
  cssTop: number;
  cssWidth: number;
  cssHeight: number;
};

export type FigureSelectionSession = {
  cancel: () => void;
};

type BeginSelectionOptions = {
  promptText: string;
  onCapture: (image: ImageAttachment) => void | Promise<void>;
  onCaptureError?: (error?: unknown) => void;
  isContextActive?: () => boolean;
  mainWindow?: Window | null;
};

let activeSelectionCancel: (() => void) | null = null;
let captureEpoch = 0;
let pngEncodingQueueRunning = false;
const pendingPngEncodings: Array<{
  run: () => Promise<Blob | null> | Blob | null;
  resolve: (blob: Blob | null) => void;
  reject: (error: unknown) => void;
}> = [];

function logCaptureFailure(error: unknown): void {
  try {
    ztoolkit.log(
      "[ReaderFigureScreenshot] Failed to capture selection:",
      error,
    );
  } catch {
    // Unit tests and early shutdown can run without the toolkit global.
  }
}

function notifyCaptureFailure(
  onCaptureError: ((error?: unknown) => void) | undefined,
  error?: unknown,
): void {
  if (!onCaptureError) return;
  try {
    onCaptureError(error);
  } catch (callbackError) {
    logCaptureFailure(callbackError);
  }
}

function safelyGetDocument(readerWindow: Window): Document | null {
  try {
    return readerWindow.document || null;
  } catch {
    return null;
  }
}

function documentMatches(doc: Document, selector: string): boolean {
  try {
    return Boolean(doc.querySelector(selector));
  } catch {
    return false;
  }
}

export function resolveReaderDocument(
  reader: _ZoteroTypes.ReaderInstance,
): Document | null {
  const documents = getReaderWindows(reader)
    .map(safelyGetDocument)
    .filter((doc): doc is Document => Boolean(doc));

  const pageCanvasSelector =
    "[data-page-number] .canvasWrapper canvas, [data-page-number] canvas, .page .canvasWrapper canvas, .page canvas";
  return (
    documents.find((doc) => documentMatches(doc, pageCanvasSelector)) ||
    documents.find((doc) =>
      documentMatches(doc, "[data-page-number], .page"),
    ) ||
    documents.find((doc) =>
      documentMatches(doc, ".canvasWrapper canvas, canvas"),
    ) ||
    documents[0] ||
    null
  );
}

export function findPageElement(target: Element | null): HTMLElement | null {
  if (!target?.closest) return null;
  try {
    return target.closest("[data-page-number], .page") as HTMLElement | null;
  } catch {
    return null;
  }
}

export function getPageCanvases(page: HTMLElement): HTMLCanvasElement[] {
  try {
    const wrappedCanvases = Array.from(
      page.querySelectorAll(".canvasWrapper canvas"),
    ) as HTMLCanvasElement[];
    return wrappedCanvases.length
      ? wrappedCanvases
      : (Array.from(page.querySelectorAll("canvas")) as HTMLCanvasElement[]);
  } catch {
    return [];
  }
}

export function getPageCanvas(page: HTMLElement): HTMLCanvasElement | null {
  return getPageCanvases(page)[0] || null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getClampedCssSelection(
  bounds: RectLike,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
} | null {
  const values = [
    bounds.left,
    bounds.top,
    bounds.right,
    bounds.bottom,
    startX,
    startY,
    endX,
    endY,
  ];
  if (
    !values.every(Number.isFinite) ||
    bounds.right <= bounds.left ||
    bounds.bottom <= bounds.top
  ) {
    return null;
  }

  const left = clamp(Math.min(startX, endX), bounds.left, bounds.right);
  const top = clamp(Math.min(startY, endY), bounds.top, bounds.bottom);
  const right = clamp(Math.max(startX, endX), bounds.left, bounds.right);
  const bottom = clamp(Math.max(startY, endY), bounds.top, bounds.bottom);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function calculateBoundedOutputDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  const outputScale = Math.min(
    1,
    MAX_CAPTURE_DIMENSION / width,
    MAX_CAPTURE_DIMENSION / height,
    Math.sqrt(MAX_CAPTURE_PIXELS / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * outputScale)),
    height: Math.max(1, Math.floor(height * outputScale)),
  };
}

type SourceCaptureRegion = Pick<
  CaptureRegion,
  | "sourceX"
  | "sourceY"
  | "sourceWidth"
  | "sourceHeight"
  | "cssLeft"
  | "cssTop"
  | "cssWidth"
  | "cssHeight"
>;

/** Convert an already-clamped CSS rectangle into one canvas's source pixels. */
function calculateSourceRegion(
  bounds: RectLike,
  canvasWidth: number,
  canvasHeight: number,
  cssSelection: NonNullable<ReturnType<typeof getClampedCssSelection>>,
): SourceCaptureRegion | null {
  if (
    !Number.isFinite(canvasWidth) ||
    !Number.isFinite(canvasHeight) ||
    canvasWidth <= 0 ||
    canvasHeight <= 0
  ) {
    return null;
  }

  const cssCanvasWidth = bounds.right - bounds.left;
  const cssCanvasHeight = bounds.bottom - bounds.top;
  if (
    !Number.isFinite(cssCanvasWidth) ||
    !Number.isFinite(cssCanvasHeight) ||
    cssCanvasWidth <= 0 ||
    cssCanvasHeight <= 0
  ) {
    return null;
  }

  const scaleX = canvasWidth / cssCanvasWidth;
  const scaleY = canvasHeight / cssCanvasHeight;
  const sourceX = clamp(
    Math.floor((cssSelection.left - bounds.left) * scaleX),
    0,
    canvasWidth,
  );
  const sourceY = clamp(
    Math.floor((cssSelection.top - bounds.top) * scaleY),
    0,
    canvasHeight,
  );
  const sourceRight = clamp(
    Math.ceil((cssSelection.right - bounds.left) * scaleX),
    0,
    canvasWidth,
  );
  const sourceBottom = clamp(
    Math.ceil((cssSelection.bottom - bounds.top) * scaleY),
    0,
    canvasHeight,
  );
  const sourceWidth = sourceRight - sourceX;
  const sourceHeight = sourceBottom - sourceY;
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;

  return {
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    cssLeft: cssSelection.left,
    cssTop: cssSelection.top,
    cssWidth: cssSelection.width,
    cssHeight: cssSelection.height,
  };
}

/** Convert a CSS-pixel drag rectangle into bounded source/output pixels. */
export function calculateCaptureRegion(
  bounds: RectLike,
  canvasWidth: number,
  canvasHeight: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): CaptureRegion | null {
  const cssSelection = getClampedCssSelection(
    bounds,
    startX,
    startY,
    endX,
    endY,
  );
  if (
    !cssSelection ||
    cssSelection.width < MIN_SELECTION_CSS_PIXELS ||
    cssSelection.height < MIN_SELECTION_CSS_PIXELS
  ) {
    return null;
  }

  const source = calculateSourceRegion(
    bounds,
    canvasWidth,
    canvasHeight,
    cssSelection,
  );
  if (!source) return null;

  const output = calculateBoundedOutputDimensions(
    source.sourceWidth,
    source.sourceHeight,
  );

  return {
    ...source,
    outputWidth: output.width,
    outputHeight: output.height,
  };
}

function getPageNumber(page: HTMLElement): string {
  const raw =
    page.getAttribute("data-page-number") || page.dataset.pageNumber || "1";
  const pageNumber = Number.parseInt(raw, 10);
  return Number.isSafeInteger(pageNumber) && pageNumber > 0
    ? String(pageNumber)
    : "1";
}

type CanvasLayer = {
  canvas: HTMLCanvasElement;
  bounds: RectLike;
};

function getCanvasLayers(
  page: HTMLElement,
  selection: NonNullable<ReturnType<typeof getClampedCssSelection>>,
): CanvasLayer[] {
  const layers: CanvasLayer[] = [];
  for (const canvas of getPageCanvases(page)) {
    try {
      const bounds = canvas.getBoundingClientRect();
      const cssWidth = bounds.right - bounds.left;
      const cssHeight = bounds.bottom - bounds.top;
      if (
        canvas.width <= 0 ||
        canvas.height <= 0 ||
        !Number.isFinite(cssWidth) ||
        !Number.isFinite(cssHeight) ||
        cssWidth <= 0 ||
        cssHeight <= 0 ||
        bounds.right <= selection.left ||
        bounds.left >= selection.right ||
        bounds.bottom <= selection.top ||
        bounds.top >= selection.bottom
      ) {
        continue;
      }
      layers.push({ canvas, bounds });
    } catch {
      // A stale detail canvas can disappear while PDF.js changes zoom level.
    }
  }
  return layers;
}

function drawCanvasLayers(
  context: CanvasRenderingContext2D,
  layers: CanvasLayer[],
  selection: NonNullable<ReturnType<typeof getClampedCssSelection>>,
  outputWidth: number,
  outputHeight: number,
): void {
  for (const { canvas, bounds } of layers) {
    const left = Math.max(selection.left, bounds.left);
    const top = Math.max(selection.top, bounds.top);
    const right = Math.min(selection.right, bounds.right);
    const bottom = Math.min(selection.bottom, bounds.bottom);
    if (right <= left || bottom <= top) continue;

    const source = calculateSourceRegion(bounds, canvas.width, canvas.height, {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    });
    if (!source) continue;
    const destinationX = Math.floor(
      ((source.cssLeft - selection.left) / selection.width) * outputWidth,
    );
    const destinationY = Math.floor(
      ((source.cssTop - selection.top) / selection.height) * outputHeight,
    );
    const destinationRight = Math.ceil(
      ((source.cssLeft + source.cssWidth - selection.left) / selection.width) *
        outputWidth,
    );
    const destinationBottom = Math.ceil(
      ((source.cssTop + source.cssHeight - selection.top) / selection.height) *
        outputHeight,
    );
    const sourceWidth = source.sourceWidth;
    const sourceHeight = source.sourceHeight;
    const destinationWidth = destinationRight - destinationX;
    const destinationHeight = destinationBottom - destinationY;
    if (
      sourceWidth <= 0 ||
      sourceHeight <= 0 ||
      destinationWidth <= 0 ||
      destinationHeight <= 0
    ) {
      continue;
    }
    context.drawImage(
      canvas,
      source.sourceX,
      source.sourceY,
      sourceWidth,
      sourceHeight,
      destinationX,
      destinationY,
      destinationWidth,
      destinationHeight,
    );
  }
}

function canvasToPngBlob(
  canvas: HTMLCanvasElement,
  isActive?: () => boolean,
): Promise<Blob | null> {
  const run = (): Promise<Blob | null> | Blob | null => {
    if (isActive && !isCaptureActive(isActive)) return null;
    if (typeof canvas.toBlob !== "function") return null;
    return new Promise<Blob | null>((resolve, reject) => {
      try {
        canvas.toBlob(resolve, "image/png");
      } catch (error) {
        reject(error);
      }
    });
  };

  const operation = new Promise<Blob | null>((resolve, reject) => {
    pendingPngEncodings.push({ run, resolve, reject });
  });
  drainPngEncodingQueue();
  return operation;
}

function drainPngEncodingQueue(): void {
  if (pngEncodingQueueRunning) return;
  const next = pendingPngEncodings.shift();
  if (!next) return;
  pngEncodingQueueRunning = true;
  let result: Promise<Blob | null> | Blob | null;
  try {
    // Start the first toBlob call synchronously. Besides reducing latency, this
    // makes cancellation/replacement deterministic before the next capture is
    // queued behind it.
    result = next.run();
  } catch (error) {
    next.reject(error);
    pngEncodingQueueRunning = false;
    drainPngEncodingQueue();
    return;
  }
  Promise.resolve(result)
    .then(
      (blob) => next.resolve(blob),
      (error) => next.reject(error),
    )
    .finally(() => {
      pngEncodingQueueRunning = false;
      drainPngEncodingQueue();
    });
}

function isCaptureActive(predicate?: () => boolean): boolean {
  if (!predicate) return true;
  try {
    return predicate() !== false;
  } catch {
    return false;
  }
}

async function blobToBase64(
  blob: Blob,
  doc: Document,
  isActive?: () => boolean,
): Promise<string | null> {
  if (!isCaptureActive(isActive)) return null;
  const view = doc.defaultView;
  const encode = view?.btoa?.bind(view) || globalThis.btoa;
  if (!encode) return null;
  // A PDF.js canvas belongs to the reader iframe's content realm.  Firefox
  // exposes its ArrayBuffer through an Xray wrapper; reading it with the
  // privileged window's TypedArray makes element access fail with a security
  // exception.  Construct the view and the string in the owner realm before
  // passing the final base64 string back to chrome.
  const ByteArray = view?.Uint8Array || Uint8Array;
  const fromCharCode = view?.String?.fromCharCode || String.fromCharCode;
  const bytes = new ByteArray(await blob.arrayBuffer());
  if (!isCaptureActive(isActive)) return null;
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return encode(chunks.join(""));
}

/** Capture and asynchronously encode the visible PDF.js canvas stack. */
export async function capturePageSelection(
  page: HTMLElement,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  isActive?: () => boolean,
): Promise<ImageAttachment | null> {
  if (!isCaptureActive(isActive)) return null;
  const pageCanvas = getPageCanvas(page);
  if (!pageCanvas) return null;
  const pageBounds = pageCanvas.getBoundingClientRect();
  const selection = getClampedCssSelection(
    pageBounds,
    startX,
    startY,
    endX,
    endY,
  );
  if (
    !selection ||
    selection.width < MIN_SELECTION_CSS_PIXELS ||
    selection.height < MIN_SELECTION_CSS_PIXELS
  ) {
    return null;
  }

  const layers = getCanvasLayers(page, selection);
  if (!layers.length) return null;
  const pixelScaleX = Math.max(
    ...layers.map(
      ({ canvas, bounds }) => canvas.width / (bounds.right - bounds.left),
    ),
  );
  const pixelScaleY = Math.max(
    ...layers.map(
      ({ canvas, bounds }) => canvas.height / (bounds.bottom - bounds.top),
    ),
  );
  let outputDimensions = calculateBoundedOutputDimensions(
    Math.ceil(selection.width * pixelScaleX),
    Math.ceil(selection.height * pixelScaleY),
  );

  const output = page.ownerDocument.createElement("canvas");
  try {
    for (let attempt = 0; attempt < MAX_CAPTURE_ENCODING_ATTEMPTS; attempt++) {
      if (!isCaptureActive(isActive)) return null;
      output.width = outputDimensions.width;
      output.height = outputDimensions.height;
      const context = output.getContext("2d");
      if (!context) return null;
      drawCanvasLayers(context, layers, selection, output.width, output.height);
      const blob = await canvasToPngBlob(output, isActive);
      if (!isCaptureActive(isActive)) return null;
      if (!blob) return null;
      if (blob.size <= MAX_CAPTURE_PNG_BYTES) {
        const data = await blobToBase64(blob, page.ownerDocument, isActive);
        if (!isCaptureActive(isActive)) return null;
        if (!data) return null;
        return {
          type: "base64",
          data,
          mimeType: "image/png",
          name: `figure-screenshot-page-${getPageNumber(page)}.png`,
        };
      }

      const shrinkScale = Math.min(
        0.8,
        Math.sqrt(MAX_CAPTURE_PNG_BYTES / blob.size) * 0.92,
      );
      const nextWidth = Math.max(
        1,
        Math.floor(outputDimensions.width * shrinkScale),
      );
      const nextHeight = Math.max(
        1,
        Math.floor(outputDimensions.height * shrinkScale),
      );
      if (
        nextWidth === outputDimensions.width &&
        nextHeight === outputDimensions.height
      ) {
        return null;
      }
      if (!isCaptureActive(isActive)) return null;
      outputDimensions = { width: nextWidth, height: nextHeight };
    }
    return null;
  } finally {
    // Release the bounded scratch bitmap after asynchronous PNG encoding.
    output.width = 0;
    output.height = 0;
  }
}

function removeAllRanges(doc: Document): void {
  try {
    doc.getSelection()?.removeAllRanges();
  } catch {
    // The PDF document may be unloading while cleanup runs.
  }
}

function isPointInside(bounds: RectLike, x: number, y: number): boolean {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= bounds.left &&
    x <= bounds.right &&
    y >= bounds.top &&
    y <= bounds.bottom
  );
}

/** Start the reader overlay. Exported separately so lifecycle behavior is testable. */
export function beginReaderFigureSelection(
  doc: Document,
  options: BeginSelectionOptions,
): FigureSelectionSession | null {
  cancelReaderFigureScreenshot();
  if (
    !doc.body ||
    !doc.documentElement ||
    typeof doc.elementFromPoint !== "function"
  ) {
    return null;
  }

  let selection: Selection | null = null;
  let interactionCleaned = false;
  let captureCleaned = false;
  const sessionEpoch = ++captureEpoch;
  const body = doc.body;
  const styleHost = doc.head || body;
  let readerWindow: Window | null = null;
  try {
    readerWindow = doc.defaultView;
  } catch {
    // A dead reader wrapper can throw while Zotero is closing a tab.
  }

  const blockStyle = doc.createElement("style");
  blockStyle.setAttribute("data-paperchat-figure-screenshot", "true");
  blockStyle.textContent = `
    html, body, #viewerContainer, #viewer, .page {
      cursor: crosshair !important;
      user-select: none !important;
    }
    .textLayer, .annotationLayer, .annotationEditorLayer {
      pointer-events: none !important;
      user-select: none !important;
    }
  `;

  const overlay = doc.createElement("div");
  overlay.setAttribute("data-paperchat-figure-screenshot-overlay", "true");
  overlay.setAttribute("role", "application");
  overlay.setAttribute("aria-label", options.promptText);
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(0, 0, 0, 0.22)",
    cursor: "crosshair",
    pointerEvents: "auto",
    touchAction: "none",
    zIndex: "2147483646",
  });
  overlay.tabIndex = 0;

  const marquee = doc.createElement("div");
  marquee.setAttribute("data-paperchat-figure-screenshot-marquee", "true");
  Object.assign(marquee.style, {
    position: "fixed",
    display: "none",
    pointerEvents: "none",
    border: "1px solid #ffffff",
    background: "rgba(255, 255, 255, 0.24)",
    boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.72)",
    boxSizing: "border-box",
    zIndex: "2147483647",
  });

  const prompt = doc.createElement("div");
  prompt.setAttribute("data-paperchat-figure-screenshot-prompt", "true");
  prompt.textContent = options.promptText;
  Object.assign(prompt.style, {
    position: "fixed",
    top: "20px",
    left: "50%",
    transform: "translateX(-50%)",
    maxWidth: "calc(100vw - 32px)",
    padding: "10px 18px",
    borderRadius: "8px",
    background: "rgba(0, 0, 0, 0.78)",
    color: "white",
    fontSize: "14px",
    fontWeight: "600",
    textAlign: "center",
    pointerEvents: "none",
    zIndex: "2147483647",
  });

  const keyTargets = new Set<EventTarget>([
    doc,
    ...(readerWindow ? [readerWindow] : []),
    ...(options.mainWindow ? [options.mainWindow] : []),
  ]);

  const preventDefaultEvent = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  const resolveTargetUnderOverlay = (
    clientX: number,
    clientY: number,
  ): Element | null => {
    const previousPointerEvents = overlay.style.pointerEvents;
    overlay.style.pointerEvents = "none";
    try {
      return doc.elementFromPoint(clientX, clientY);
    } finally {
      overlay.style.pointerEvents = previousPointerEvents;
    }
  };

  const updateMarquee = (clientX: number, clientY: number): void => {
    if (!selection) return;
    const rect = getClampedCssSelection(
      selection.canvasBounds,
      selection.startX,
      selection.startY,
      clientX,
      clientY,
    );
    if (!rect) return;
    marquee.style.left = `${rect.left}px`;
    marquee.style.top = `${rect.top}px`;
    marquee.style.width = `${rect.width}px`;
    marquee.style.height = `${rect.height}px`;
    marquee.style.display = "block";
  };

  const runCleanupStep = (step: () => void): void => {
    try {
      step();
    } catch {
      // Continue cleanup when any stale DOM/window wrapper rejects access.
    }
  };

  const cleanupInteraction = (): void => {
    if (interactionCleaned) return;
    interactionCleaned = true;
    selection = null;
    runCleanupStep(() =>
      overlay.removeEventListener("pointerdown", begin, true),
    );
    runCleanupStep(() =>
      overlay.removeEventListener("pointermove", move, true),
    );
    runCleanupStep(() =>
      overlay.removeEventListener("pointerup", finish, true),
    );
    runCleanupStep(() =>
      overlay.removeEventListener("pointercancel", cancelPointer, true),
    );
    runCleanupStep(() =>
      overlay.removeEventListener("wheel", preventDefaultEvent, true),
    );
    runCleanupStep(() =>
      overlay.removeEventListener("contextmenu", preventDefaultEvent, true),
    );
    for (const target of keyTargets) {
      runCleanupStep(() =>
        target.removeEventListener("keydown", cancelFromKeyboard, true),
      );
    }
    runCleanupStep(() => removeAllRanges(doc));
    runCleanupStep(() => blockStyle.remove());
    runCleanupStep(() => overlay.remove());
    runCleanupStep(() => marquee.remove());
    runCleanupStep(() => prompt.remove());
  };

  const cleanupCapture = (): void => {
    if (captureCleaned) return;
    captureCleaned = true;
    if (activeSelectionCancel === cancel) activeSelectionCancel = null;
    runCleanupStep(() =>
      readerWindow?.removeEventListener("pagehide", cancelFromLifecycle, true),
    );
    runCleanupStep(() =>
      readerWindow?.removeEventListener("unload", cancelFromLifecycle, true),
    );
    runCleanupStep(() =>
      doc.removeEventListener("visibilitychange", cancelWhenHidden, true),
    );
  };

  const cancel = (): void => {
    if (captureEpoch === sessionEpoch) captureEpoch += 1;
    cleanupInteraction();
    cleanupCapture();
  };

  const begin = (event: PointerEvent): void => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const page = findPageElement(
      resolveTargetUnderOverlay(event.clientX, event.clientY),
    );
    const canvas = page ? getPageCanvas(page) : null;
    if (!page || !canvas) return;
    const canvasBounds = canvas.getBoundingClientRect();
    if (!isPointInside(canvasBounds, event.clientX, event.clientY)) return;

    preventDefaultEvent(event);
    removeAllRanges(doc);
    selection = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      page,
      canvasBounds,
    };
    try {
      overlay.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail if the PDF window starts unloading.
    }
  };

  const move = (event: PointerEvent): void => {
    if (!selection || event.pointerId !== selection.pointerId) return;
    preventDefaultEvent(event);
    updateMarquee(event.clientX, event.clientY);
  };

  const finish = (event: PointerEvent): void => {
    const completedSelection = selection;
    if (!completedSelection || event.pointerId !== completedSelection.pointerId)
      return;
    preventDefaultEvent(event);
    const endX = clamp(
      event.clientX,
      completedSelection.canvasBounds.left,
      completedSelection.canvasBounds.right,
    );
    const endY = clamp(
      event.clientY,
      completedSelection.canvasBounds.top,
      completedSelection.canvasBounds.bottom,
    );
    cleanupInteraction();
    void (async () => {
      try {
        let image: ImageAttachment | null = null;
        try {
          image = await capturePageSelection(
            completedSelection.page,
            completedSelection.startX,
            completedSelection.startY,
            endX,
            endY,
            () => captureEpoch === sessionEpoch,
          );
        } catch (error) {
          logCaptureFailure(error);
          if (captureEpoch === sessionEpoch) {
            notifyCaptureFailure(options.onCaptureError, error);
          }
          return;
        }
        if (!image) {
          if (captureEpoch === sessionEpoch) {
            notifyCaptureFailure(options.onCaptureError);
          }
          return;
        }
        if (captureEpoch !== sessionEpoch) return;
        try {
          if (options.isContextActive?.() === false) return;
        } catch {
          return;
        }
        try {
          await options.onCapture(image);
        } catch (error) {
          logCaptureFailure(error);
        }
      } catch (error) {
        logCaptureFailure(error);
      } finally {
        cleanupCapture();
      }
    })();
  };

  const cancelPointer = (event: PointerEvent): void => {
    if (!selection || event.pointerId === selection.pointerId) cancel();
  };

  const cancelFromKeyboard = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== "Escape") return;
    preventDefaultEvent(event);
    cancel();
  };

  const cancelWhenHidden = (): void => {
    try {
      if (doc.visibilityState === "hidden") cancel();
    } catch {
      cancel();
    }
  };

  const cancelFromLifecycle = (): void => cancel();

  try {
    styleHost.appendChild(blockStyle);
    body.appendChild(overlay);
    body.appendChild(marquee);
    body.appendChild(prompt);
    overlay.addEventListener("pointerdown", begin, true);
    overlay.addEventListener("pointermove", move, true);
    overlay.addEventListener("pointerup", finish, true);
    overlay.addEventListener("pointercancel", cancelPointer, true);
    overlay.addEventListener("wheel", preventDefaultEvent, {
      capture: true,
      passive: false,
    });
    overlay.addEventListener("contextmenu", preventDefaultEvent, true);
    for (const target of keyTargets) {
      target.addEventListener("keydown", cancelFromKeyboard, true);
    }
    readerWindow?.addEventListener("pagehide", cancelFromLifecycle, true);
    readerWindow?.addEventListener("unload", cancelFromLifecycle, true);
    doc.addEventListener("visibilitychange", cancelWhenHidden, true);
    activeSelectionCancel = cancel;
    try {
      overlay.focus({ preventScroll: true });
    } catch {
      overlay.focus();
    }
    return { cancel };
  } catch (error) {
    cancel();
    logCaptureFailure(error);
    return null;
  }
}

export function cancelReaderFigureScreenshot(): void {
  captureEpoch += 1;
  const cancel = activeSelectionCancel;
  activeSelectionCancel = null;
  try {
    cancel?.();
  } catch (error) {
    logCaptureFailure(error);
  }
}

function getActivePdfReader(): _ZoteroTypes.ReaderInstance | null {
  try {
    const mainWindow = Zotero.getMainWindow() as Window & {
      Zotero_Tabs?: { selectedID?: string };
    };
    const tabID = mainWindow.Zotero_Tabs?.selectedID;
    const reader = tabID ? Zotero.Reader?.getByTabID(tabID) : null;
    if (!reader || (reader as ReaderLike).type !== "pdf") return null;
    return reader;
  } catch {
    return null;
  }
}

export function startReaderFigureScreenshot(
  onCapture: (image: ImageAttachment) => void,
  onCaptureError?: (error?: unknown) => void,
): boolean {
  cancelReaderFigureScreenshot();
  const reader = getActivePdfReader();
  if (!reader) return false;

  try {
    // Reader wrappers are backed by private Zotero fields and can become
    // invalid between the active-tab lookup and document resolution. Keep all
    // of that access inside the guarded entry point so a stale wrapper simply
    // reports that capture could not start.
    const doc = resolveReaderDocument(reader);
    if (
      !doc?.body ||
      !documentMatches(
        doc,
        "[data-page-number] .canvasWrapper canvas, [data-page-number] canvas, .page canvas",
      )
    ) {
      return false;
    }
    (reader as ReaderLike).focus?.();
    const session = beginReaderFigureSelection(doc, {
      promptText: getString("chat-reader-figure-screenshot-prompt"),
      mainWindow: Zotero.getMainWindow(),
      isContextActive: () => {
        const activeReader = getActivePdfReader();
        return Boolean(
          activeReader && resolveReaderDocument(activeReader) === doc,
        );
      },
      onCapture,
      onCaptureError,
    });
    return Boolean(session);
  } catch (error) {
    cancelReaderFigureScreenshot();
    logCaptureFailure(error);
    return false;
  }
}
