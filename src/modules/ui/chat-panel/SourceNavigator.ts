import { findPdfAttachment, openOrNavigateReader } from "./PdfQuoteNavigator";
import { normalizeNoteSourceKey, openNoteSource } from "./NoteSourceNavigator";

interface ZoteroKeyTarget {
  key: string;
  libraryID?: number;
}

export type SourceTarget =
  | ({ type: "note" } & ZoteroKeyTarget)
  | ({ type: "item"; page?: number } & ZoteroKeyTarget)
  | ({ type: "annotation" } & ZoteroKeyTarget)
  | ({ type: "collection" } & ZoteroKeyTarget)
  | { type: "web"; url: string };

interface CollectionSelectingPane {
  selectCollection?: (collectionID: number) => unknown;
  collectionsView?: {
    selectCollection?: (collectionID: number) => unknown;
  };
}

type ActiveZoteroPane = NonNullable<
  ReturnType<typeof Zotero.getActiveZoteroPane>
>;

function getLibraryID(libraryID: number | undefined): number {
  return libraryID ?? Zotero.Libraries.userLibraryID;
}

function getNormalizedKey(key: string): string {
  const normalized = normalizeNoteSourceKey(key);
  if (!normalized) {
    throw new Error(`Invalid Zotero source key "${key}".`);
  }
  return normalized;
}

function getItem(target: ZoteroKeyTarget): Zotero.Item {
  const key = getNormalizedKey(target.key);
  const item = Zotero.Items.getByLibraryAndKey(
    getLibraryID(target.libraryID),
    key,
  );
  if (!item) {
    throw new Error(`Item with key "${key}" was not found.`);
  }
  return item;
}

function getPageIndex(page: number | undefined): number | null {
  if (page === undefined) {
    return null;
  }
  if (!Number.isInteger(page) || page < 1) {
    throw new Error(`Invalid source page "${page}".`);
  }
  return page - 1;
}

function getActivePane(): ActiveZoteroPane {
  const pane = Zotero.getActiveZoteroPane();
  if (!pane) {
    throw new Error("The Zotero library pane is not available.");
  }
  return pane;
}

function focusMainWindow(): void {
  Zotero.getMainWindow()?.focus?.();
}

async function selectItem(item: Zotero.Item): Promise<void> {
  await Promise.resolve(getActivePane().selectItem(item.id));
  focusMainWindow();
}

async function openItemSource(
  target: Extract<SourceTarget, { type: "item" }>,
): Promise<void> {
  const item = getItem(target);
  const pageIndex = getPageIndex(target.page);
  const pdfAttachment = await findPdfAttachment(item);
  if (!pdfAttachment) {
    await selectItem(item);
    return;
  }

  await openOrNavigateReader(pdfAttachment, pageIndex);
}

async function openAnnotationSource(
  target: Extract<SourceTarget, { type: "annotation" }>,
): Promise<void> {
  const annotation = getItem(target);
  if (!annotation.isAnnotation?.()) {
    throw new Error(`Item with key "${target.key}" is not an annotation.`);
  }

  const attachmentID = annotation.parentItemID;
  if (!attachmentID) {
    throw new Error(`Annotation with key "${target.key}" has no attachment.`);
  }
  const attachment = Zotero.Items.get(attachmentID) as Zotero.Item | false;
  const pdfAttachment = await findPdfAttachment(attachment || null);
  if (!pdfAttachment) {
    throw new Error(
      `The attachment for annotation "${target.key}" is not a PDF.`,
    );
  }

  await openOrNavigateReader(pdfAttachment, null, annotation.key);
}

async function openCollectionSource(
  target: Extract<SourceTarget, { type: "collection" }>,
): Promise<void> {
  const key = getNormalizedKey(target.key);
  const collection = Zotero.Collections.getByLibraryAndKey(
    getLibraryID(target.libraryID),
    key,
  );
  if (!collection) {
    throw new Error(`Collection with key "${key}" was not found.`);
  }

  const pane = getActivePane() as ActiveZoteroPane & CollectionSelectingPane;
  const selectCollection =
    typeof pane.selectCollection === "function"
      ? pane.selectCollection.bind(pane)
      : typeof pane.collectionsView?.selectCollection === "function"
        ? pane.collectionsView.selectCollection.bind(pane.collectionsView)
        : null;
  if (!selectCollection) {
    throw new Error("This Zotero version cannot select collections.");
  }

  await Promise.resolve(selectCollection(collection.id));
  focusMainWindow();
}

function openWebSource(url: string): void {
  const trimmedURL = url.trim();
  let parsedURL: URL;
  try {
    parsedURL = new URL(trimmedURL);
  } catch {
    throw new Error(`Invalid source URL "${url}".`);
  }
  if (parsedURL.protocol !== "http:" && parsedURL.protocol !== "https:") {
    throw new Error(`Unsupported source URL protocol "${parsedURL.protocol}".`);
  }
  Zotero.launchURL(trimmedURL);
}

export async function openSourceTarget(target: SourceTarget): Promise<void> {
  switch (target.type) {
    case "note":
      await openNoteSource(getNormalizedKey(target.key), target.libraryID);
      return;
    case "item":
      await openItemSource(target);
      return;
    case "annotation":
      await openAnnotationSource(target);
      return;
    case "collection":
      await openCollectionSource(target);
      return;
    case "web":
      openWebSource(target.url);
  }
}
