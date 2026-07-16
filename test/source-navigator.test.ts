import { assert } from "chai";
import { openSourceTarget } from "../src/modules/ui/chat-panel/SourceNavigator.ts";
import { navigateToPdfQuote } from "../src/modules/ui/chat-panel/PdfQuoteNavigator.ts";

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
    ) => Promise<void>;
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
});
