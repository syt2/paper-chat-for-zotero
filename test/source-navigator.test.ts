import { assert } from "chai";
import { openSourceTarget } from "../src/modules/ui/chat-panel/SourceNavigator.ts";
import {
  clearPdfQuoteHighlight,
  navigateToPdfQuote,
} from "../src/modules/ui/chat-panel/PdfQuoteNavigator.ts";

interface ZoteroMock {
  Libraries: { userLibraryID: number };
  Items: {
    getByLibraryAndKey: (libraryID: number, key: string) => unknown;
    get: (itemID: number) => unknown;
    getAsync: (itemID: number) => Promise<unknown>;
  };
  Collections?: {
    getByLibraryAndKey: (libraryID: number, key: string) => unknown;
  };
  Reader?: {
    getByTabID?: (tabID: string) => unknown;
    open: (
      itemID: number,
      location?: unknown,
      options?: unknown,
    ) => Promise<void | unknown>;
  };
  getActiveZoteroPane: () => unknown;
  getMainWindow: () => unknown;
  launchURL?: (url: string) => void;
}

function setZoteroMock(mock: ZoteroMock): void {
  (globalThis as { Zotero?: unknown }).Zotero = mock;
}

function createPdfAttachment(id: number): object {
  return {
    id,
    key: "PDFABCDE",
    isAttachment: () => true,
    isPDFAttachment: () => true,
  };
}

function createOverlayReaderDocument(text: string): {
  document: Document;
  page: {
    children: Array<{ getAttribute: (name: string) => string | null }>;
  };
} {
  class FakeElement {
    ownerDocument: FakeDocument;
    parentElement: FakeElement | null = null;
    children: FakeElement[] = [];
    textNodes: FakeText[] = [];
    textContent = "";
    style: Record<string, string> = {};
    attributes = new Map<string, string>();
    offsetWidth = 600;
    offsetHeight = 800;

    constructor(ownerDocument: FakeDocument) {
      this.ownerDocument = ownerDocument;
    }

    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
    }

    getAttribute(name: string): string | null {
      return this.attributes.get(name) ?? null;
    }

    appendChild(child: FakeElement): FakeElement {
      child.parentElement = this;
      this.children.push(child);
      return child;
    }

    remove(): void {
      if (!this.parentElement) return;
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
      this.parentElement = null;
    }

    closest(selector: string): FakeElement | null {
      if (
        selector === "[data-page-number]" &&
        this.getAttribute("data-page-number")
      ) {
        return this;
      }
      return this.parentElement?.closest(selector) || null;
    }

    getBoundingClientRect(): object {
      return {
        left: 0,
        top: 0,
        right: 600,
        bottom: 800,
        width: 600,
        height: 800,
      };
    }

    scrollIntoView(): void {}
  }

  class FakeText {
    constructor(
      readonly data: string,
      readonly ownerDocument: FakeDocument,
      readonly parentElement: FakeElement,
    ) {}
  }

  class FakeRange {
    setStart(): void {}
    setEnd(): void {}
    getClientRects(): object[] {
      return [
        {
          left: 40,
          top: 100,
          right: 340,
          bottom: 118,
          width: 300,
          height: 18,
        },
      ];
    }
  }

  class FakeDocument {
    layer!: FakeElement;
    defaultView = {
      NodeFilter: { SHOW_TEXT: 4 },
      getComputedStyle: () => ({ position: "relative" }),
    };

    querySelector(): FakeElement | null {
      return this.layer;
    }

    createTreeWalker(root: FakeElement): { nextNode: () => FakeText | null } {
      let index = 0;
      return {
        nextNode: () => root.textNodes[index++] || null,
      };
    }

    createRange(): FakeRange {
      return new FakeRange();
    }

    createElement(): FakeElement {
      return new FakeElement(this);
    }

    getSelection(): never {
      throw new Error("The overlay highlighter must not access Selection");
    }
  }

  const document = new FakeDocument();
  const page = new FakeElement(document);
  page.setAttribute("data-page-number", "1");
  const layer = new FakeElement(document);
  layer.textContent = text;
  page.appendChild(layer);
  const textNode = new FakeText(text, document, layer);
  layer.textNodes.push(textNode);
  document.layer = layer;
  return {
    document: document as unknown as Document,
    page,
  };
}

describe("typed source navigation", function () {
  let originalZotero: unknown;
  let originalZtoolkit: unknown;

  beforeEach(function () {
    originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
    originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
  });

  afterEach(function () {
    clearPdfQuoteHighlight();
    (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
  });

  it("normalizes and selects a note target in its source library", async function () {
    let lookup: { libraryID: number; key: string } | undefined;
    let selectedItemID: number | undefined;
    setZoteroMock({
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: (libraryID, key) => {
          lookup = { libraryID, key };
          return { id: 9, isNote: () => true };
        },
        get: () => false,
        getAsync: async () => false,
      },
      getActiveZoteroPane: () => ({
        selectItem: (itemID: number) => {
          selectedItemID = itemID;
        },
      }),
      getMainWindow: () => ({}),
    });

    await openSourceTarget({ type: "note", key: "noteabcd", libraryID: 3 });

    assert.deepEqual(lookup, { libraryID: 3, key: "NOTEABCD" });
    assert.equal(selectedItemID, 9);
  });

  it("opens an item's PDF at a 1-based source page", async function () {
    const pdf = createPdfAttachment(20);
    let opened:
      | { itemID: number; location: unknown; options: unknown }
      | undefined;
    let resolvedLibraryID: number | undefined;
    setZoteroMock({
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: (libraryID) => {
          resolvedLibraryID = libraryID;
          return {
            id: 10,
            key: "ITEMABCD",
            isAttachment: () => false,
            isNote: () => false,
            getAttachments: () => [20],
          };
        },
        get: () => false,
        getAsync: async () => pdf,
      },
      Reader: {
        open: async (itemID, location, options) => {
          opened = { itemID, location, options };
        },
      },
      getActiveZoteroPane: () => null,
      getMainWindow: () => ({}),
    });

    await openSourceTarget({
      type: "item",
      key: "itemabcd",
      libraryID: 4,
      page: 3,
    });

    assert.equal(resolvedLibraryID, 4);
    assert.deepEqual(opened, {
      itemID: 20,
      location: { pageIndex: 2 },
      options: { openInBackground: false, allowDuplicate: false },
    });
  });

  it("selects an item when it has no PDF attachment", async function () {
    let selectedItemID: number | undefined;
    let focused = false;
    setZoteroMock({
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => ({
          id: 10,
          key: "ITEMABCD",
          isAttachment: () => false,
          isNote: () => false,
          getAttachments: () => [],
        }),
        get: () => false,
        getAsync: async () => false,
      },
      getActiveZoteroPane: () => ({
        selectItem: (itemID: number) => {
          selectedItemID = itemID;
        },
      }),
      getMainWindow: () => ({
        focus: () => {
          focused = true;
        },
      }),
    });

    await openSourceTarget({ type: "item", key: "ITEMABCD" });

    assert.equal(selectedItemID, 10);
    assert.isTrue(focused);
  });

  it("opens an annotation's parent PDF using annotationID", async function () {
    const pdf = createPdfAttachment(20);
    let openedLocation: unknown;
    setZoteroMock({
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => ({
          id: 30,
          key: "ANNOT123",
          parentItemID: 20,
          isAnnotation: () => true,
        }),
        get: () => pdf,
        getAsync: async () => false,
      },
      Reader: {
        open: async (_itemID, location) => {
          openedLocation = location;
        },
      },
      getActiveZoteroPane: () => null,
      getMainWindow: () => ({}),
    });

    await openSourceTarget({ type: "annotation", key: "ANNOT123" });

    assert.deepEqual(openedLocation, { annotationID: "ANNOT123" });
  });

  it("navigates an already active PDF reader to an annotation", async function () {
    const pdf = createPdfAttachment(20);
    let navigatedLocation: unknown;
    let focused = false;
    setZoteroMock({
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => ({
          id: 30,
          key: "ANNOT123",
          parentItemID: 20,
          isAnnotation: () => true,
        }),
        get: () => pdf,
        getAsync: async () => false,
      },
      Reader: {
        getByTabID: () => ({
          itemID: 20,
          focus: () => {
            focused = true;
          },
          navigate: async (location: unknown) => {
            navigatedLocation = location;
          },
        }),
        open: async () => {
          assert.fail("the existing reader should be reused");
        },
      },
      getActiveZoteroPane: () => null,
      getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader-tab" } }),
    });

    await openSourceTarget({ type: "annotation", key: "ANNOT123" });

    assert.isTrue(focused);
    assert.deepEqual(navigatedLocation, { annotationID: "ANNOT123" });
  });

  it("selects a collection when the Zotero runtime supports it", async function () {
    let selectedCollectionID: number | undefined;
    setZoteroMock({
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => false,
        get: () => false,
        getAsync: async () => false,
      },
      Collections: {
        getByLibraryAndKey: () => ({ id: 55 }),
      },
      getActiveZoteroPane: () => ({
        selectCollection: (collectionID: number) => {
          selectedCollectionID = collectionID;
        },
      }),
      getMainWindow: () => ({}),
    });

    await openSourceTarget({ type: "collection", key: "COLLECT1" });

    assert.equal(selectedCollectionID, 55);
  });

  it("rejects collection navigation when selectCollection is unavailable", async function () {
    setZoteroMock({
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => false,
        get: () => false,
        getAsync: async () => false,
      },
      Collections: {
        getByLibraryAndKey: () => ({ id: 55 }),
      },
      getActiveZoteroPane: () => ({}),
      getMainWindow: () => ({}),
    });

    try {
      await openSourceTarget({ type: "collection", key: "COLLECT1" });
      assert.fail("expected unsupported collection navigation to fail");
    } catch (error) {
      assert.include(String(error), "cannot select collections");
    }
  });

  it("launches only HTTP and HTTPS web sources", async function () {
    const launched: string[] = [];
    setZoteroMock({
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => false,
        get: () => false,
        getAsync: async () => false,
      },
      getActiveZoteroPane: () => null,
      getMainWindow: () => ({}),
      launchURL: (url) => launched.push(url),
    });

    await openSourceTarget({ type: "web", url: " https://example.com/paper " });
    assert.deepEqual(launched, ["https://example.com/paper"]);

    try {
      await openSourceTarget({ type: "web", url: "javascript:alert(1)" });
      assert.fail("expected a non-HTTP URL to fail");
    } catch (error) {
      assert.include(String(error), "Unsupported source URL protocol");
    }
    assert.lengthOf(launched, 1);
  });

  it("rejects invalid item pages before navigating", async function () {
    setZoteroMock({
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => ({
          id: 10,
          key: "ITEMABCD",
          getAttachments: () => [],
        }),
        get: () => false,
        getAsync: async () => false,
      },
      getActiveZoteroPane: () => null,
      getMainWindow: () => ({}),
    });

    try {
      await openSourceTarget({ type: "item", key: "ITEMABCD", page: 0 });
      assert.fail("expected an invalid page to fail");
    } catch (error) {
      assert.include(String(error), "Invalid source page");
    }
  });

  it("does not fall back to another active PDF for an explicit source", async function () {
    let navigated = false;
    const activePdf = {
      ...createPdfAttachment(20),
      attachmentText: "A sufficiently long quote from the wrong active PDF.",
    };
    setZoteroMock({
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => false,
        get: () => activePdf,
        getAsync: async () => false,
      },
      Reader: {
        getByTabID: () => ({
          itemID: 20,
          navigate: async () => {
            navigated = true;
          },
        }),
        open: async () => {
          navigated = true;
        },
      },
      getActiveZoteroPane: () => null,
      getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader-tab" } }),
    });

    const result = await navigateToPdfQuote(
      "A sufficiently long quote from the wrong active PDF.",
      {
        id: 10,
        isAttachment: () => false,
        isNote: () => false,
        getAttachments: () => [],
      } as Zotero.Item,
      { allowActiveReaderFallback: false },
    );

    assert.isFalse(result);
    assert.isFalse(navigated);
  });

  it("uses a trusted page when quote text cannot be located", async function () {
    let openedLocation: unknown;
    const pdf = {
      ...createPdfAttachment(20),
      attachmentText: "Text from a different page.",
    };
    setZoteroMock({
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => false,
        get: () => false,
        getAsync: async () => pdf,
      },
      Reader: {
        open: async (_itemID, location) => {
          openedLocation = location;
        },
      },
      getActiveZoteroPane: () => null,
      getMainWindow: () => ({}),
    });

    const result = await navigateToPdfQuote(
      "A sufficiently long grounded quotation that is not indexed.",
      pdf as Zotero.Item,
      { allowActiveReaderFallback: false, fallbackPageIndex: 5 },
    );

    assert.isTrue(result);
    assert.deepEqual(openedLocation, { pageIndex: 5 });
  });

  it("flashes a self-owned overlay twice without touching Selection", async function () {
    this.timeout(3000);
    const quote =
      "A sufficiently long grounded quotation that appears on the PDF page.";
    const overlayDocument = createOverlayReaderDocument(quote);
    const pdf = {
      ...createPdfAttachment(20),
      attachmentText: quote,
    };
    const reader = {
      itemID: 20,
      type: "pdf",
      focus: () => undefined,
      navigate: async () => undefined,
      _internalReader: {
        _lastView: {
          _iframeWindow: { document: overlayDocument.document },
        },
      },
    };
    setZoteroMock({
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => false,
        get: () => pdf,
        getAsync: async () => false,
      },
      Reader: {
        getByTabID: () => reader,
        open: async () => {
          assert.fail("the existing reader should be reused");
        },
      },
      getActiveZoteroPane: () => null,
      getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader-tab" } }),
    });

    assert.isTrue(await navigateToPdfQuote(quote, pdf as Zotero.Item));
    const findOverlay = () =>
      overlayDocument.page.children.find((child) =>
        child.getAttribute("data-paperchat-pdf-quote-overlay"),
      ) as unknown as { style: Record<string, string> } | undefined;
    assert.equal(findOverlay()?.style.opacity, "1");
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(findOverlay()?.style.opacity, "0");
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(findOverlay()?.style.opacity, "1");
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.isUndefined(findOverlay());
  });

  it("serializes Reader navigation so the latest rapid click wins", async function () {
    const quoteA = "A sufficiently long quotation on the first PDF page.";
    const quoteB = "A sufficiently long quotation on the second PDF page.";
    const pdf = {
      ...createPdfAttachment(20),
      attachmentText: `${quoteA}\f${quoteB}`,
    };
    const navigatedPages: number[] = [];
    let releaseFirstNavigation: (() => void) | undefined;
    const reader = {
      itemID: 20,
      type: "epub",
      focus: () => undefined,
      navigate: async (location: { pageIndex: number }) => {
        navigatedPages.push(location.pageIndex);
        if (navigatedPages.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstNavigation = resolve;
          });
        }
      },
    };
    setZoteroMock({
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => false,
        get: () => pdf,
        getAsync: async () => false,
      },
      Reader: {
        getByTabID: () => reader,
        open: async () => {
          assert.fail("the existing reader should be reused");
        },
      },
      getActiveZoteroPane: () => null,
      getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader-tab" } }),
    });

    const first = navigateToPdfQuote(quoteA, pdf as Zotero.Item);
    for (
      let attempt = 0;
      attempt < 10 && navigatedPages.length === 0;
      attempt++
    ) {
      await Promise.resolve();
    }
    assert.deepEqual(navigatedPages, [0]);
    const second = navigateToPdfQuote(quoteB, pdf as Zotero.Item);
    releaseFirstNavigation?.();
    await Promise.all([first, second]);

    assert.deepEqual(navigatedPages, [0, 1]);
  });
});
