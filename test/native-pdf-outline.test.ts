import { assert } from "chai";
import type { PaperStructureExtended } from "../src/types/tool";
import {
  executeGetOutline,
  executeListSections,
} from "../src/modules/chat/pdf-tools/toolExecutors.ts";
import { extractNativeOutline } from "../src/modules/chat/pdf-tools/nativeOutlineExtractor.ts";

function createStructure(): PaperStructureExtended {
  const fullText = "Introduction\nBody";
  return {
    metadata: {},
    fullText,
    sections: [
      {
        name: "Introduction",
        normalizedName: "introduction",
        content: "Body",
        startIndex: 0,
        endIndex: fullText.length,
      },
    ],
    pages: [
      {
        pageNumber: 1,
        startIndex: 0,
        endIndex: fullText.length,
        content: fullText,
      },
    ],
    pageCount: 1,
    nativePageCount: 12,
    nativeOutline: [
      {
        title: "Introduction",
        pageNumber: 1,
        children: [
          {
            title: "Domain Adaptation",
            pageNumber: 5,
            children: [],
          },
        ],
      },
    ],
  };
}

describe("native PDF outline", function () {
  describe("formatting", function () {
    it("keeps hierarchy and emits trusted PDF page references", function () {
      const output = executeGetOutline(createStructure());

      assert.match(
        output,
        /^Source references: \{"version":1,"pages":\[1,5\]\}/,
      );
      assert.include(output, "12 PDF pages total");
      assert.include(output, "1. Introduction (PDF Page 1)");
      assert.include(output, "\n  1. Domain Adaptation (PDF Page 5)");
      assert.include(output, "get_pages may differ");
    });

    it("keeps get_paper_section IDs while exposing bookmarks for navigation", function () {
      const output = executeListSections(createStructure());

      assert.include(output, "navigation only");
      assert.include(output, "these titles are not get_paper_section IDs");
      assert.include(output, "Domain Adaptation (PDF Page 5)");
      assert.include(output, "ID: introduction");
    });

    it("preserves the heuristic warning when native bookmarks are unavailable", function () {
      const structure = createStructure();
      structure.nativeOutline = undefined;
      structure.nativePageCount = undefined;
      structure.sections = [
        {
          name: "Full Text",
          normalizedName: "full_text",
          content: structure.fullText,
          startIndex: 0,
          endIndex: structure.fullText.length,
        },
      ];

      const output = executeGetOutline(structure);
      assert.include(output, "detected heuristically");
      assert.include(output, "open it in the Zotero reader and try again");
    });
  });

  describe("extraction", function () {
    let originalZotero: unknown;
    let originalZtoolkit: unknown;
    let originalDateNow: typeof Date.now;

    beforeEach(function () {
      originalZotero = (globalThis as any).Zotero;
      originalZtoolkit = (globalThis as any).ztoolkit;
      originalDateNow = Date.now;
    });

    afterEach(function () {
      (globalThis as any).Zotero = originalZotero;
      (globalThis as any).ztoolkit = originalZtoolkit;
      Date.now = originalDateNow;
    });

    function installReader(itemID: number, pdfDocument: object): void {
      const reader = {
        itemID,
        _isReaderInitialized: true,
        _internalReader: {
          _lastView: {
            _iframeWindow: {
              PDFViewerApplication: { pdfDocument },
            },
          },
        },
      };
      (globalThis as any).Zotero = {
        Reader: { getByTabID: () => reader, _readers: [reader] },
        getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader-tab" } }),
      };
      (globalThis as any).ztoolkit = { log: () => undefined };
    }

    it("lazily enriches a cached parent item and matches its reader by item ID", async function () {
      let attachmentTextReads = 0;
      const pdfAttachment = {
        id: 42,
        key: "PDF00001",
        isAttachment: () => true,
        isPDFAttachment: () => true,
        get attachmentText() {
          attachmentTextReads += 1;
          return Promise.resolve("Introduction\n\nBody");
        },
      };
      const parentItem = {
        id: 7,
        key: "PARENT01",
        isAttachment: () => false,
        getAttachments: () => [pdfAttachment.id],
      };

      let activeReader: Record<string, unknown> | null = null;
      let openReaders: Record<string, unknown>[] = [];
      let nativeOutlineReads = 0;
      const pdfDocument = {
        numPages: 9,
        getOutline: async () => {
          nativeOutlineReads += 1;
          return [
            {
              title: "  Methods\nOverview  ",
              dest: "methods",
              items: [
                {
                  title: "Experiment",
                  dest: [2],
                  items: [],
                },
                {
                  title: "Invalid page",
                  dest: [99],
                  items: [],
                },
              ],
            },
          ];
        },
        getDestination: async (name: string) =>
          name === "methods" ? [{ pageIndex: 3 }] : null,
        getPageIndex: async (ref: { pageIndex?: number }) =>
          ref.pageIndex ?? -1,
      };
      const readerWindow = {
        PDFViewerApplication: {
          initializedPromise: Promise.resolve(),
          pdfDocument,
        },
      };
      const initializingReader: Record<string, unknown> = {
        itemID: pdfAttachment.id,
        _isReaderInitialized: false,
        _internalReader: {},
      };
      initializingReader._initPromise = Promise.resolve().then(() => {
        initializingReader._internalReader = {
          _lastView: { _iframeWindow: readerWindow },
        };
      });
      const foreignReader = {
        itemID: 99,
        _isReaderInitialized: true,
        _internalReader: {
          _lastView: {
            _iframeWindow: {
              PDFViewerApplication: {
                pdfDocument: {
                  ...pdfDocument,
                  getOutline: async () => [
                    { title: "Foreign Outline", dest: [0], items: [] },
                  ],
                },
              },
            },
          },
        },
      };
      activeReader = foreignReader;
      openReaders = [foreignReader, initializingReader];

      (globalThis as any).Zotero = {
        Libraries: { userLibraryID: 1 },
        Items: {
          getByLibraryAndKey: (_libraryID: number, key: string) =>
            key === parentItem.key ? parentItem : null,
          get: (id: number) =>
            id === pdfAttachment.id
              ? pdfAttachment
              : id === 99
                ? { id, key: pdfAttachment.key }
                : null,
        },
        Reader: {
          getByTabID: () => activeReader,
          get _readers() {
            return openReaders;
          },
        },
        getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader-tab" } }),
      };
      (globalThis as any).ztoolkit = { log: () => undefined };

      const { PdfToolManager } =
        await import("../src/modules/chat/pdf-tools/PdfToolManager.ts");
      const manager = new PdfToolManager();

      const withoutReader = await manager.extractAndParsePaper(parentItem.key);
      assert.isDefined(withoutReader);
      assert.isUndefined(withoutReader?.nativeOutline);
      assert.equal(attachmentTextReads, 1);
      assert.equal(nativeOutlineReads, 0);

      const [withReader, concurrentResult] = await Promise.all([
        manager.extractAndParsePaper(parentItem.key, true),
        manager.extractAndParsePaper(parentItem.key, true),
      ]);
      assert.strictEqual(withReader, withoutReader);
      assert.strictEqual(concurrentResult, withoutReader);
      assert.equal(
        attachmentTextReads,
        1,
        "text structure should remain cached",
      );
      assert.equal(withReader?.nativePageCount, 9);
      assert.equal(nativeOutlineReads, 1);
      assert.equal(withReader?.nativeOutline?.[0]?.title, "Methods Overview");
      assert.equal(withReader?.nativeOutline?.[0]?.pageNumber, 4);
      assert.equal(withReader?.nativeOutline?.[0]?.children[0]?.pageNumber, 3);
      assert.equal(withReader?.nativeOutline?.[0]?.children[1]?.pageNumber, 0);
    });

    it("extracts a paper from a group library", async function () {
      const pdfAttachment = {
        id: 142,
        key: "GROUPPDF",
        isAttachment: () => true,
        isPDFAttachment: () => true,
        get attachmentText() {
          return Promise.resolve("Introduction\n\nGroup-library body");
        },
      };
      const parentItem = {
        id: 107,
        key: "GROUP001",
        isAttachment: () => false,
        getAttachments: () => [pdfAttachment.id],
      };
      (globalThis as any).Zotero = {
        Libraries: {
          userLibraryID: 1,
          getAll: () => [{ libraryID: 1 }, { libraryID: 5 }],
        },
        Items: {
          getByLibraryAndKey: (libraryID: number, key: string) =>
            libraryID === 5 && key === parentItem.key ? parentItem : null,
          get: (id: number) => (id === pdfAttachment.id ? pdfAttachment : null),
        },
      };
      (globalThis as any).ztoolkit = { log: () => undefined };

      const { PdfToolManager } =
        await import("../src/modules/chat/pdf-tools/PdfToolManager.ts");
      const manager = new PdfToolManager();
      const structure = await manager.extractAndParsePaper(parentItem.key);

      assert.isDefined(structure);
      assert.include(structure?.fullText, "Group-library body");
    });

    it("enriches fallback content when attachment text extraction rejects", async function () {
      const attachment = {
        id: 44,
        key: "PDF00002",
        isAttachment: () => true,
        isPDFAttachment: () => true,
        get attachmentText() {
          return Promise.reject(new Error("text extraction failed"));
        },
      };
      let nativeOutlineReads = 0;
      installReader(attachment.id, {
        numPages: 3,
        getOutline: async () => {
          nativeOutlineReads += 1;
          return [{ title: "Reader Bookmark", dest: [1], items: [] }];
        },
        getDestination: async () => null,
        getPageIndex: async () => 0,
      });
      Object.assign((globalThis as any).Zotero, {
        Libraries: { userLibraryID: 1 },
        Items: {
          getByLibraryAndKey: (_libraryID: number, key: string) =>
            key === attachment.key ? attachment : null,
          get: (id: number) => (id === attachment.id ? attachment : null),
        },
      });

      const fallback = createStructure();
      fallback.nativeOutline = undefined;
      fallback.nativePageCount = undefined;
      fallback.sections = [
        {
          name: "Full Text",
          normalizedName: "full_text",
          content: fallback.fullText,
          startIndex: 0,
          endIndex: fallback.fullText.length,
        },
      ];

      const { PdfToolManager } =
        await import("../src/modules/chat/pdf-tools/PdfToolManager.ts");
      const manager = new PdfToolManager();
      manager.setCurrentItemKey(attachment.key);

      const fullTextResult = await manager.executeToolCall(
        {
          id: "full-text-after-extraction-error",
          type: "function",
          function: { name: "get_full_text", arguments: "{}" },
        },
        fallback,
      );
      assert.include(fullTextResult, fallback.fullText);
      assert.equal(nativeOutlineReads, 0, "non-outline tools stay lazy");

      const outlineResult = await manager.executeToolCall(
        {
          id: "outline-after-extraction-error",
          type: "function",
          function: { name: "get_outline", arguments: "{}" },
        },
        fallback,
      );
      assert.include(outlineResult, "Reader Bookmark (PDF Page 2)");
      assert.include(outlineResult, "No heuristic section breakdown");
      assert.equal(nativeOutlineReads, 1);
    });

    it("stops traversing bookmarks when the shared conversion deadline expires", async function () {
      const attachment = { id: 42, key: "PDF00001" };
      let deadlineExpired = false;
      let pageIndexCalls = 0;
      Date.now = () => (deadlineExpired ? 5000 : 0);

      const pdfDocument = {
        numPages: 9,
        getOutline: async () => [
          { title: "First", dest: [{ ref: 1 }], items: [] },
          { title: "Second", dest: [{ ref: 2 }], items: [] },
        ],
        getDestination: async () => null,
        getPageIndex: async () => {
          pageIndexCalls += 1;
          deadlineExpired = true;
          return 0;
        },
      };
      installReader(attachment.id, pdfDocument);

      const extraction = await extractNativeOutline(attachment.id);

      assert.equal(pageIndexCalls, 1);
      assert.deepEqual(
        extraction?.outline.map((item) => item.title),
        ["First"],
      );
    });

    it("caps malformed raw bookmark nodes before title validation", async function () {
      const attachmentID = 43;
      const pdfDocument = {
        numPages: 1,
        getOutline: async () => [
          ...Array.from({ length: 500 }, () => null),
          { title: "Beyond limit", dest: [0], items: [] },
        ],
        getDestination: async () => null,
        getPageIndex: async () => 0,
      };
      installReader(attachmentID, pdfDocument);

      const extraction = await extractNativeOutline(attachmentID);

      assert.isNull(extraction);
    });
  });
});
