import { parsePages } from "../../chat/pdf-tools/paperParser";

const MIN_QUOTE_SEARCH_LENGTH = 12;
const MAX_QUOTE_SEARCH_LENGTH = 480;

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

async function findPdfAttachment(
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
      ...sentences.slice(0, 2),
    ]),
  ).filter((needle) => needle.length >= MIN_QUOTE_SEARCH_LENGTH);
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

async function openOrNavigateReader(
  pdfAttachment: Zotero.Item,
  pageIndex: number | null,
): Promise<void> {
  const activeReader = getActiveReader();
  const location =
    pageIndex === null
      ? undefined
      : ({
          pageIndex,
        } satisfies _ZoteroTypes.Reader.Location);

  if (activeReader?.itemID === pdfAttachment.id) {
    activeReader.focus?.();
    if (location) {
      await activeReader.navigate(location);
    }
    return;
  }

  await Zotero.Reader.open(pdfAttachment.id, location, {
    openInBackground: false,
    allowDuplicate: false,
  });
}

export async function navigateToPdfQuote(
  quoteText: string,
  currentItem: Zotero.Item | null,
): Promise<boolean> {
  const quote = quoteText.trim();
  if (quote.length < MIN_QUOTE_SEARCH_LENGTH) {
    return false;
  }

  try {
    const activeReader = getActiveReader();
    const readerItem = getReaderItem(activeReader);
    const pdfAttachment =
      (await findPdfAttachment(currentItem)) ||
      (await findPdfAttachment(readerItem));
    if (!pdfAttachment) {
      ztoolkit.log("[PdfQuoteNavigator] No PDF attachment available for quote");
      return false;
    }

    const pageIndex = await locateQuotePageIndex(pdfAttachment, quote);
    await openOrNavigateReader(pdfAttachment, pageIndex);
    return true;
  } catch (error) {
    ztoolkit.log("[PdfQuoteNavigator] Failed to navigate to quote:", error);
    return false;
  }
}
