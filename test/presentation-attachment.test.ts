import { assert } from "chai";
import { attachPresentationToZotero } from "../src/modules/presentation/PresentationAttachment.ts";

describe("presentation Zotero attachment", function () {
  const runtime = globalThis as any;
  let previousZotero: unknown;
  let previousIOUtils: unknown;

  beforeEach(function () {
    previousZotero = runtime.Zotero;
    previousIOUtils = runtime.IOUtils;
  });

  afterEach(function () {
    runtime.Zotero = previousZotero;
    runtime.IOUtils = previousIOUtils;
  });

  it("imports the PPTX below the corresponding paper item", async function () {
    const paper = {
      id: 42,
      key: "PAPER001",
      libraryID: 1,
      isAttachment: () => false,
      isNote: () => false,
      getField: (field: string) => (field === "title" ? "Paper title" : ""),
    };
    const imported = {
      id: 77,
      key: "PPTX001",
      libraryID: 1,
      getFilePathAsync: async () => "/zotero/storage/PPTX001/deck.pptx",
    };
    const importOptions: any[] = [];
    const removed: string[] = [];
    runtime.Zotero = {
      Libraries: { userLibraryID: 1, getAll: () => [{ libraryID: 1 }] },
      Items: {
        getByLibraryAndKey: (_libraryID: number, key: string) =>
          key === "PAPER001" ? paper : false,
        get: () => false,
      },
      Attachments: {
        importFromFile: async (options: unknown) => {
          importOptions.push(options);
          return imported;
        },
      },
    };
    runtime.IOUtils = {
      exists: async () => true,
      remove: async (path: string) => removed.push(path),
    };

    const result = await attachPresentationToZotero({
      outputPath: "/paper-chat/presentations/deck.pptx",
      presentationTitle: "Generated deck",
      sourceItemKey: "PAPER001",
    });

    assert.equal(result.status, "attached");
    assert.equal(result.mode, "child");
    assert.equal(result.parentItemID, 42);
    assert.equal(result.path, "/zotero/storage/PPTX001/deck.pptx");
    assert.deepInclude(importOptions[0], {
      parentItemID: 42,
      title: "Paper title - PaperChat PPT",
      contentType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    assert.deepEqual(removed, ["/paper-chat/presentations/deck.pptx"]);
  });

  it("creates a top-level PPTX for an independent PDF attachment", async function () {
    const sourcePdf = {
      id: 12,
      key: "PDF001",
      libraryID: 3,
      parentItemID: 0,
      isAttachment: () => true,
      isNote: () => false,
      getCollections: () => [101, 102],
      getField: () => "Standalone PDF",
    };
    const importOptions: any[] = [];
    runtime.Zotero = {
      Libraries: {
        userLibraryID: 1,
        getAll: () => [{ libraryID: 1 }, { libraryID: 3 }],
      },
      Items: {
        getByLibraryAndKey: (libraryID: number, key: string) =>
          libraryID === 3 && key === "PDF001" ? sourcePdf : false,
        get: () => false,
      },
      Attachments: {
        importFromFile: async (options: unknown) => {
          importOptions.push(options);
          return {
            id: 88,
            key: "PPTX002",
            libraryID: 3,
            getFilePathAsync: async () => "/zotero/storage/PPTX002/deck.pptx",
          };
        },
      },
    };
    runtime.IOUtils = {
      exists: async () => false,
      remove: async () => undefined,
    };

    const result = await attachPresentationToZotero({
      outputPath: "/paper-chat/presentations/deck.pptx",
      presentationTitle: "Generated deck",
      sourceItemKey: "PDF001",
    });

    assert.equal(result.status, "attached");
    assert.equal(result.mode, "top_level");
    assert.equal(result.path, "/zotero/storage/PPTX002/deck.pptx");
    assert.deepInclude(importOptions[0], {
      libraryID: 3,
      collections: [101, 102],
      title: "Standalone PDF - PaperChat PPT",
    });
    assert.notProperty(importOptions[0], "parentItemID");
  });

  it("uses the trusted library when two libraries contain the same item key", async function () {
    const userPaper = {
      id: 11,
      key: "SHARED01",
      libraryID: 1,
      isAttachment: () => false,
      isNote: () => false,
      getField: () => "Wrong user-library paper",
    };
    const groupPaper = {
      id: 55,
      key: "SHARED01",
      libraryID: 5,
      isAttachment: () => false,
      isNote: () => false,
      getField: () => "Correct group-library paper",
    };
    const importOptions: any[] = [];
    runtime.Zotero = {
      Libraries: {
        userLibraryID: 1,
        getAll: () => [{ libraryID: 1 }, { libraryID: 5 }],
      },
      Items: {
        getByLibraryAndKey: (libraryID: number, key: string) => {
          if (key !== "SHARED01") return false;
          return libraryID === 1 ? userPaper : groupPaper;
        },
        get: () => false,
      },
      Attachments: {
        importFromFile: async (options: unknown) => {
          importOptions.push(options);
          return {
            id: 91,
            key: "PPTX005",
            libraryID: 5,
            getFilePathAsync: async () => "/zotero/storage/PPTX005/deck.pptx",
          };
        },
      },
    };
    runtime.IOUtils = {
      exists: async () => false,
      remove: async () => undefined,
    };

    const result = await attachPresentationToZotero({
      outputPath: "/paper-chat/presentations/deck.pptx",
      presentationTitle: "Generated deck",
      sourceItemKey: "SHARED01",
      sourceLibraryID: 5,
    });

    assert.equal(result.status, "attached");
    assert.equal(result.parentItemID, 55);
    assert.deepInclude(importOptions[0], {
      parentItemID: 55,
      title: "Correct group-library paper - PaperChat PPT",
    });
  });

  it("preserves the generated file when Zotero attachment import fails", async function () {
    runtime.Zotero = {
      Libraries: { userLibraryID: 1, getAll: () => [] },
      Items: { getByLibraryAndKey: () => false, get: () => false },
      Attachments: {
        importFromFile: async () => {
          throw new Error("library is read-only");
        },
      },
    };

    const result = await attachPresentationToZotero({
      outputPath: "/paper-chat/presentations/deck.pptx",
      presentationTitle: "Generated deck",
    });

    assert.equal(result.status, "not_attached");
    assert.equal(result.path, "/paper-chat/presentations/deck.pptx");
    assert.include(result.warning, "library is read-only");
  });

  it("removes an imported attachment when Zotero cannot resolve its file path", async function () {
    let eraseCount = 0;
    runtime.Zotero = {
      Libraries: { userLibraryID: 1, getAll: () => [] },
      Items: { getByLibraryAndKey: () => false, get: () => false },
      Attachments: {
        importFromFile: async () => ({
          id: 99,
          key: "BROKEN01",
          libraryID: 1,
          getFilePathAsync: async () => null,
          eraseTx: async () => {
            eraseCount += 1;
          },
        }),
      },
    };

    const result = await attachPresentationToZotero({
      outputPath: "/paper-chat/presentations/deck.pptx",
      presentationTitle: "Generated deck",
    });

    assert.equal(result.status, "not_attached");
    assert.equal(result.path, "/paper-chat/presentations/deck.pptx");
    assert.include(result.warning, "without a readable file path");
    assert.equal(eraseCount, 1);
  });

  it("marks an imported attachment as committed when cleanup also fails", async function () {
    let eraseCount = 0;
    let importCount = 0;
    runtime.Zotero = {
      Libraries: { userLibraryID: 1, getAll: () => [] },
      Items: { getByLibraryAndKey: () => false, get: () => false },
      Attachments: {
        importFromFile: async () => {
          importCount += 1;
          return {
            id: 100,
            key: "ORPHAN01",
            libraryID: 1,
            getFilePathAsync: async () => null,
            eraseTx: async () => {
              eraseCount += 1;
              throw new Error("synthetic erase failure");
            },
          };
        },
      },
    };

    const result = await attachPresentationToZotero({
      outputPath: "/paper-chat/presentations/deck.pptx",
      presentationTitle: "Generated deck",
    });

    assert.equal(result.status, "not_attached");
    assert.equal(result.attachmentCommitted, true);
    assert.equal(result.itemID, 100);
    assert.include(result.warning, "cleanup failed");
    assert.equal(importCount, 1);
    assert.equal(eraseCount, 1);
  });
});
