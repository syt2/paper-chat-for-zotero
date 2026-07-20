import { parsePages } from "../../chat/pdf-tools/paperParser";

const MIN_QUOTE_SEARCH_LENGTH = 12;
const MAX_QUOTE_SEARCH_LENGTH = 480;
const MAX_OVERLAY_HIGHLIGHT_LENGTH = 180;
const READER_OPEN_TIMEOUT_MS = 2500;
const READER_POLL_MS = 40;
const SCROLL_SETTLE_MS = 120;
const HIGHLIGHT_ON_MS = 600;
const HIGHLIGHT_OFF_MS = 160;
const OVERLAY_ATTRIBUTE = "data-paperchat-pdf-quote-overlay";

type PdfReaderWindow = Window & {
  PDFViewerApplication?: {
    initializedPromise?: Promise<unknown>;
  };
};

type PdfReaderView = {
  initializedPromise?: Promise<unknown>;
  _iframeWindow?: PdfReaderWindow;
};

type DomTextOffset = {
  node: Text;
  startOffset: number;
  endOffset: number;
};

type NormalizedDomText = {
  text: string;
  offsets: DomTextOffset[];
};

type QuoteDomMatch = {
  normalized: NormalizedDomText;
  startIndex: number;
  length: number;
};

type QuoteRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type ActiveOverlay = {
  root: HTMLElement;
  page: HTMLElement;
  originalPagePosition: string | null;
};

let highlightGeneration = 0;
let highlightTimers: Array<ReturnType<typeof setTimeout>> = [];
let activeOverlay: ActiveOverlay | null = null;
let readerNavigationQueue: Promise<void> = Promise.resolve();

function clearHighlightTimers(): void {
  for (const timer of highlightTimers) {
    clearTimeout(timer);
  }
  highlightTimers = [];
}

function removeActiveOverlay(): void {
  const overlay = activeOverlay;
  activeOverlay = null;
  if (!overlay) return;

  overlay.root.remove();
  if (overlay.originalPagePosition !== null) {
    overlay.page.style.position = overlay.originalPagePosition;
  }
}

export function clearPdfQuoteHighlight(): void {
  highlightGeneration += 1;
  clearHighlightTimers();
  removeActiveOverlay();
}

function beginPdfQuoteHighlight(): number {
  clearPdfQuoteHighlight();
  return highlightGeneration;
}

function isCurrentHighlight(generation: number): boolean {
  return generation === highlightGeneration;
}

function getActiveReader(): _ZoteroTypes.ReaderInstance | null {
  try {
    const mainWindow = Zotero.getMainWindow() as
      | (Window & {
          Zotero_Tabs?: { selectedID?: string };
        })
      | null;
    const selectedID = mainWindow?.Zotero_Tabs?.selectedID;
    if (!selectedID) {
      return null;
    }
    return Zotero.Reader?.getByTabID(selectedID) || null;
  } catch (error) {
    ztoolkit.log("[PdfQuoteNavigator] Failed to get active reader:", error);
    return null;
  }
}

function getReaderItem(
  reader: _ZoteroTypes.ReaderInstance | null,
): Zotero.Item | null {
  if (!reader?.itemID) {
    return null;
  }
  return (Zotero.Items.get(reader.itemID) as Zotero.Item | false) || null;
}

export async function findPdfAttachment(
  item: Zotero.Item | null,
): Promise<Zotero.Item | null> {
  if (!item) {
    return null;
  }

  if (item.isAttachment?.()) {
    return item.isPDFAttachment?.() ||
      item.attachmentContentType === "application/pdf"
      ? item
      : null;
  }

  if (item.isNote?.()) {
    return null;
  }

  const attachmentIDs = item.getAttachments?.() || [];
  for (const attachmentID of attachmentIDs) {
    const attachment = await Zotero.Items.getAsync(attachmentID);
    if (
      attachment &&
      (attachment.isPDFAttachment?.() ||
        attachment.attachmentContentType === "application/pdf")
    ) {
      return attachment;
    }
  }

  return null;
}

function normalizeForSearch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getSearchNeedles(quoteText: string): string[] {
  const normalized = normalizeForSearch(quoteText);
  if (normalized.length < MIN_QUOTE_SEARCH_LENGTH) {
    return [];
  }

  const truncated = normalized.slice(0, MAX_QUOTE_SEARCH_LENGTH);
  const sentences = truncated
    .split(/[.!?。！？]\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= MIN_QUOTE_SEARCH_LENGTH);

  return Array.from(
    new Set([
      truncated,
      truncated.slice(0, 240).trim(),
      truncated.slice(0, 120).trim(),
      truncated.slice(0, 72).trim(),
      ...sentences.slice(0, 2),
    ]),
  )
    .filter((needle) => needle.length >= MIN_QUOTE_SEARCH_LENGTH)
    .sort((left, right) => right.length - left.length);
}

function normalizeLooseText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getLooseSearchNeedles(quoteText: string): string[] {
  const words = normalizeLooseText(quoteText).split(" ").filter(Boolean);
  const windowSize = 12;
  const stride = 4;
  const needles: string[] = [];

  for (let start = 0; start < words.length; start += stride) {
    const needle = words.slice(start, start + windowSize).join(" ");
    if (needle.length >= 24 && needle.split(" ").length >= 8) {
      needles.push(needle);
    }
    if (start + windowSize >= words.length) {
      break;
    }
  }
  if (words.length > windowSize) {
    needles.push(words.slice(-windowSize).join(" "));
  }
  return Array.from(new Set(needles));
}

async function locateQuotePageIndex(
  pdfAttachment: Zotero.Item,
  quoteText: string,
): Promise<number | null> {
  const pdfText = await pdfAttachment.attachmentText;
  if (!pdfText) {
    return null;
  }

  const needles = getSearchNeedles(quoteText);
  if (needles.length === 0) {
    return null;
  }

  const pages = parsePages(pdfText);
  for (const page of pages) {
    const pageText = normalizeForSearch(page.content);
    if (needles.some((needle) => pageText.includes(needle))) {
      return Math.max(0, page.pageNumber - 1);
    }
  }

  return null;
}

type ReaderNavigationLocation = _ZoteroTypes.Reader.Location & {
  annotationID?: string;
};

export async function openOrNavigateReader(
  pdfAttachment: Zotero.Item,
  pageIndex: number | null,
  annotationID?: string,
): Promise<_ZoteroTypes.ReaderInstance | null> {
  const activeReader = getActiveReader();
  const location =
    pageIndex === null && !annotationID
      ? undefined
      : ({
          ...(pageIndex === null ? {} : { pageIndex }),
          ...(annotationID ? { annotationID } : {}),
        } satisfies ReaderNavigationLocation);

  if (activeReader?.itemID === pdfAttachment.id) {
    activeReader.focus?.();
    if (location) {
      await activeReader.navigate(location);
    }
    return activeReader;
  }

  const openedReader = await Zotero.Reader.open(pdfAttachment.id, location, {
    openInBackground: false,
    allowDuplicate: false,
  });
  return openedReader || getActiveReader();
}

async function runReaderNavigation(
  generation: number,
  operation: () => Promise<_ZoteroTypes.ReaderInstance | null>,
): Promise<_ZoteroTypes.ReaderInstance | null> {
  const queued = readerNavigationQueue
    .catch(() => undefined)
    .then(async () => {
      if (!isCurrentHighlight(generation)) {
        return null;
      }
      return operation();
    });
  readerNavigationQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getReaderWindows(
  reader: _ZoteroTypes.ReaderInstance | null,
): PdfReaderWindow[] {
  if (!reader) return [];
  const internalView = reader._internalReader?._lastView as
    | PdfReaderView
    | undefined;
  const windows = [
    internalView?._iframeWindow,
    reader._iframeWindow as PdfReaderWindow | undefined,
  ].filter((candidate): candidate is PdfReaderWindow => !!candidate);
  return Array.from(new Set(windows));
}

async function waitForTextLayer(
  reader: _ZoteroTypes.ReaderInstance | null,
  pageIndex: number,
  generation: number,
): Promise<HTMLElement | null> {
  const deadline = Date.now() + READER_OPEN_TIMEOUT_MS;
  const selector = `[data-page-number="${pageIndex + 1}"] .textLayer`;

  while (isCurrentHighlight(generation) && Date.now() < deadline) {
    for (const readerWindow of getReaderWindows(reader)) {
      try {
        const layer =
          readerWindow.document.querySelector<HTMLElement>(selector);
        if (layer?.textContent?.trim()) {
          return layer;
        }
      } catch {
        // Reader internals may be replaced while the PDF view initializes.
      }
    }
    await delay(READER_POLL_MS);
  }
  return null;
}

function buildNormalizedDomText(
  root: HTMLElement,
  insertNodeSpaces: boolean,
): NormalizedDomText {
  let text = "";
  const offsets: DomTextOffset[] = [];
  const win = root.ownerDocument.defaultView;
  if (!win) {
    return { text, offsets };
  }

  const walker = root.ownerDocument.createTreeWalker(
    root,
    win.NodeFilter.SHOW_TEXT,
  );
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    if (insertNodeSpaces && node.data && text && !text.endsWith(" ")) {
      text += " ";
      offsets.push({ node, startOffset: 0, endOffset: 0 });
    }
    for (let offset = 0; offset < node.data.length; ) {
      const codePoint = node.data.codePointAt(offset);
      if (codePoint === undefined) break;
      const source = String.fromCodePoint(codePoint);
      const sourceLength = source.length;
      const normalized = source
        .normalize("NFKC")
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .toLowerCase();

      for (const character of normalized) {
        if (/\s/u.test(character)) {
          if (!text.endsWith(" ")) {
            text += " ";
            offsets.push({
              node,
              startOffset: offset,
              endOffset: offset + sourceLength,
            });
          }
        } else {
          text += character;
          for (let index = 0; index < character.length; index += 1) {
            offsets.push({
              node,
              startOffset: offset,
              endOffset: offset + sourceLength,
            });
          }
        }
      }
      offset += sourceLength;
    }
    current = walker.nextNode();
  }
  return { text, offsets };
}

function buildLooseDomText(root: HTMLElement): NormalizedDomText {
  const normalized = buildNormalizedDomText(root, true);
  let text = "";
  const offsets: DomTextOffset[] = [];

  for (let index = 0; index < normalized.text.length; ) {
    const codePoint = normalized.text.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const sourceOffset = normalized.offsets[index];
    if (!sourceOffset) {
      index += character.length;
      continue;
    }
    if (/^[\p{L}\p{N}]$/u.test(character)) {
      text += character;
      for (let offset = 0; offset < character.length; offset += 1) {
        offsets.push(sourceOffset);
      }
    } else if (!text.endsWith(" ")) {
      text += " ";
      offsets.push(sourceOffset);
    }
    index += character.length;
  }
  return { text, offsets };
}

function findMatchInNormalizedText(
  normalized: NormalizedDomText,
  needle: string,
): QuoteDomMatch | null {
  const startIndex = normalized.text.indexOf(needle);
  if (startIndex === -1) return null;
  return {
    normalized,
    startIndex,
    length: Math.min(needle.length, MAX_OVERLAY_HIGHLIGHT_LENGTH),
  };
}

function findQuoteDomMatch(
  layer: HTMLElement,
  quoteText: string,
): QuoteDomMatch | null {
  const exactRepresentations = [
    buildNormalizedDomText(layer, true),
    buildNormalizedDomText(layer, false),
  ];
  for (const needle of getSearchNeedles(quoteText)) {
    for (const normalized of exactRepresentations) {
      const match = findMatchInNormalizedText(normalized, needle);
      if (match) return match;
    }
  }

  const loose = buildLooseDomText(layer);
  let repeatedFallback: QuoteDomMatch | null = null;
  for (const needle of getLooseSearchNeedles(quoteText)) {
    const match = findMatchInNormalizedText(loose, needle);
    if (!match) continue;
    const repeatedAt = loose.text.indexOf(needle, match.startIndex + 1);
    if (repeatedAt === -1) {
      return match;
    }
    repeatedFallback ||= match;
  }
  return repeatedFallback;
}

function createRangeFromMatch(match: QuoteDomMatch): Range | null {
  const start = match.normalized.offsets[match.startIndex];
  const end = match.normalized.offsets[match.startIndex + match.length - 1];
  if (!start || !end) return null;

  try {
    const range = start.node.ownerDocument.createRange();
    range.setStart(start.node, start.startOffset);
    range.setEnd(end.node, end.endOffset);
    return range;
  } catch {
    return null;
  }
}

function getVisibleRangeRects(range: Range): QuoteRect[] {
  return Array.from(range.getClientRects() || []).filter(
    (rect) =>
      Number.isFinite(rect.left) &&
      Number.isFinite(rect.top) &&
      rect.width > 0 &&
      rect.height > 0,
  );
}

function mergeRangeRects(rects: QuoteRect[]): QuoteRect[] {
  const merged: QuoteRect[] = [];
  const sorted = [...rects].sort(
    (left, right) => left.top - right.top || left.left - right.left,
  );

  for (const rect of sorted) {
    const previous = merged.at(-1);
    const sameLine =
      previous &&
      Math.abs(previous.top - rect.top) <= Math.max(2, rect.height * 0.25) &&
      Math.abs(previous.bottom - rect.bottom) <=
        Math.max(2, rect.height * 0.25);
    const closeEnough = previous && rect.left - previous.right <= 4;
    if (previous && sameLine && closeEnough) {
      const left = Math.min(previous.left, rect.left);
      const top = Math.min(previous.top, rect.top);
      const right = Math.max(previous.right, rect.right);
      const bottom = Math.max(previous.bottom, rect.bottom);
      merged[merged.length - 1] = {
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
      };
    } else {
      merged.push(rect);
    }
  }
  return merged.slice(0, 80);
}

function createQuoteOverlay(
  layer: HTMLElement,
  rects: QuoteRect[],
  generation: number,
): HTMLElement | null {
  const doc = layer.ownerDocument;
  const win = doc.defaultView;
  const page = layer.closest<HTMLElement>("[data-page-number]");
  if (!win || !page || rects.length === 0 || !isCurrentHighlight(generation)) {
    return null;
  }

  const readerWindow = win;
  const pageElement = page;
  removeActiveOverlay();
  const computedPosition =
    readerWindow.getComputedStyle(pageElement)?.position || "static";
  const originalPagePosition =
    computedPosition === "static" ? pageElement.style.position : null;
  if (originalPagePosition !== null) {
    pageElement.style.position = "relative";
  }

  const root = doc.createElement("div");
  root.setAttribute(OVERLAY_ATTRIBUTE, String(generation));
  root.style.position = "absolute";
  root.style.inset = "0";
  root.style.zIndex = "20";
  root.style.pointerEvents = "none";
  root.style.opacity = "0";
  root.style.transition = "opacity 90ms ease-out";

  const pageRect = pageElement.getBoundingClientRect();
  const scaleX =
    pageElement.offsetWidth > 0 ? pageRect.width / pageElement.offsetWidth : 1;
  const scaleY =
    pageElement.offsetHeight > 0
      ? pageRect.height / pageElement.offsetHeight
      : 1;
  for (const rect of mergeRangeRects(rects)) {
    const highlight = doc.createElement("div");
    highlight.style.position = "absolute";
    highlight.style.left = `${(rect.left - pageRect.left) / scaleX}px`;
    highlight.style.top = `${(rect.top - pageRect.top) / scaleY}px`;
    highlight.style.width = `${rect.width / scaleX}px`;
    highlight.style.height = `${rect.height / scaleY}px`;
    highlight.style.borderRadius = "2px";
    highlight.style.background = "rgba(59, 130, 246, 0.38)";
    highlight.style.boxShadow = "0 0 0 1px rgba(37, 99, 235, 0.12)";
    root.appendChild(highlight);
  }

  pageElement.appendChild(root);
  activeOverlay = { root, page: pageElement, originalPagePosition };
  void root.offsetWidth;
  root.style.opacity = "1";
  return root;
}

function scheduleOverlayFlash(root: HTMLElement, generation: number): void {
  const schedule = (callback: () => void, delayMs: number): void => {
    highlightTimers.push(setTimeout(callback, delayMs));
  };

  schedule(() => {
    if (isCurrentHighlight(generation) && activeOverlay?.root === root) {
      root.style.opacity = "0";
    }
  }, HIGHLIGHT_ON_MS);
  schedule(() => {
    if (isCurrentHighlight(generation) && activeOverlay?.root === root) {
      root.style.opacity = "1";
    }
  }, HIGHLIGHT_ON_MS + HIGHLIGHT_OFF_MS);
  schedule(
    () => {
      if (isCurrentHighlight(generation) && activeOverlay?.root === root) {
        clearHighlightTimers();
        removeActiveOverlay();
      }
    },
    HIGHLIGHT_ON_MS * 2 + HIGHLIGHT_OFF_MS,
  );
}

async function highlightPdfQuoteWithOverlay(
  reader: _ZoteroTypes.ReaderInstance | null,
  quoteText: string,
  pageIndex: number,
  generation: number,
): Promise<boolean> {
  if (!reader || reader.type !== "pdf") return false;
  const layer = await waitForTextLayer(reader, pageIndex, generation);
  if (!layer || !isCurrentHighlight(generation)) return false;

  const initialMatch = findQuoteDomMatch(layer, quoteText);
  const initialRange = initialMatch ? createRangeFromMatch(initialMatch) : null;
  if (!initialRange || getVisibleRangeRects(initialRange).length === 0) {
    return false;
  }

  const start = initialMatch?.normalized.offsets[initialMatch.startIndex];
  start?.node.parentElement?.scrollIntoView({
    block: "center",
    inline: "nearest",
  });
  await delay(SCROLL_SETTLE_MS);
  if (!isCurrentHighlight(generation)) return false;

  const freshLayer = await waitForTextLayer(reader, pageIndex, generation);
  if (!freshLayer || !isCurrentHighlight(generation)) return false;
  const freshMatch = findQuoteDomMatch(freshLayer, quoteText);
  const freshRange = freshMatch ? createRangeFromMatch(freshMatch) : null;
  if (!freshRange) return false;
  const rects = getVisibleRangeRects(freshRange);
  const root = createQuoteOverlay(freshLayer, rects, generation);
  if (!root) return false;

  scheduleOverlayFlash(root, generation);
  return true;
}

export async function navigateToPdfQuote(
  quoteText: string,
  currentItem: Zotero.Item | null,
  options: {
    allowActiveReaderFallback?: boolean;
    fallbackPageIndex?: number;
  } = {},
): Promise<boolean> {
  const quote = quoteText.trim();
  if (quote.length < MIN_QUOTE_SEARCH_LENGTH) {
    return false;
  }

  const generation = beginPdfQuoteHighlight();
  try {
    const activeReader = getActiveReader();
    const readerItem = getReaderItem(activeReader);
    const pdfAttachment =
      (await findPdfAttachment(currentItem)) ||
      (options.allowActiveReaderFallback === false
        ? null
        : await findPdfAttachment(readerItem));
    if (!isCurrentHighlight(generation)) {
      return true;
    }
    if (!pdfAttachment) {
      ztoolkit.log("[PdfQuoteNavigator] No PDF attachment available for quote");
      return false;
    }

    const pageIndex =
      (await locateQuotePageIndex(pdfAttachment, quote)) ??
      options.fallbackPageIndex ??
      null;
    if (!isCurrentHighlight(generation)) {
      return true;
    }

    const reader = await runReaderNavigation(generation, () =>
      openOrNavigateReader(pdfAttachment, pageIndex),
    );
    if (!isCurrentHighlight(generation)) {
      return true;
    }
    if (!reader || pageIndex === null) {
      return true;
    }

    const highlighted = await highlightPdfQuoteWithOverlay(
      reader,
      quote,
      pageIndex,
      generation,
    );
    if (isCurrentHighlight(generation) && !highlighted) {
      ztoolkit.log(
        "[PdfQuoteNavigator] Opened PDF page but could not locate quote overlay",
      );
    }
    return true;
  } catch (error) {
    if (isCurrentHighlight(generation)) {
      ztoolkit.log("[PdfQuoteNavigator] Failed to navigate to quote:", error);
      return false;
    }
    return true;
  }
}
