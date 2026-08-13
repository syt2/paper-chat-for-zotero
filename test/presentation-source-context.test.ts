import { assert } from "chai";
import { PdfToolManager } from "../src/modules/chat/pdf-tools/PdfToolManager.ts";
import { resetPresentationRendererForTests } from "../src/modules/presentation/PresentationRendererLoader.ts";
import { PRESENTATION_RENDERER_GLOBAL } from "../src/modules/presentation/contracts.ts";
import { resolvePresentationSourceItemKey } from "../src/modules/presentation/PresentationSourceContext.ts";

describe("presentation source context", function () {
  let originalZotero: unknown;

  beforeEach(function () {
    originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
  });

  afterEach(function () {
    (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
  });

  it("keeps explicit and session-bound papers ahead of the library selection", function () {
    (globalThis as { Zotero?: unknown }).Zotero = {
      getActiveZoteroPane: () => ({
        getSelectedItems: () => [{ key: "SELECTED1" }],
      }),
    };

    assert.equal(
      resolvePresentationSourceItemKey("EXPLICIT1", "SESSION01"),
      "EXPLICIT1",
    );
    assert.equal(
      resolvePresentationSourceItemKey(undefined, "SESSION01"),
      "SESSION01",
    );
  });

  it("uses the single selected Zotero item for an empty presentation call", function () {
    (globalThis as { Zotero?: unknown }).Zotero = {
      getActiveZoteroPane: () => ({
        getSelectedItems: () => [{ key: "SBZ2M99R" }],
      }),
    };

    assert.equal(resolvePresentationSourceItemKey(undefined, null), "SBZ2M99R");
  });

  it("does not guess between multiple selected papers", function () {
    (globalThis as { Zotero?: unknown }).Zotero = {
      getActiveZoteroPane: () => ({
        getSelectedItems: () => [{ key: "PAPER001" }, { key: "PAPER002" }],
      }),
    };

    assert.isUndefined(resolvePresentationSourceItemKey(undefined, null));
  });

  it("rebinds an explicit cross-library source to its resolved Zotero item", async function () {
    const runtime = globalThis as any;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const previousZtoolkit = runtime.ztoolkit;
    const rendererTarget: Record<string, unknown> = {};
    const currentPaper = {
      id: 101,
      key: "CURRENT1",
      libraryID: 1,
      isAttachment: () => false,
      isNote: () => false,
      getAttachments: () => [],
      getField: () => "Current personal-library paper",
    };
    const explicitPdf = {
      id: 502,
      key: "EXPDF001",
      libraryID: 5,
      isAttachment: () => true,
      isPDFAttachment: () => true,
      get attachmentText() {
        return Promise.resolve(
          "Introduction\n\nExplicit group-library evidence",
        );
      },
    };
    const explicitPaper = {
      id: 205,
      key: "EXPLICIT1",
      libraryID: 5,
      isAttachment: () => false,
      isNote: () => false,
      getAttachments: () => [explicitPdf.id],
      getField: () => "Explicit group-library paper",
    };
    const importOptions: Array<Record<string, unknown>> = [];
    let plannerPaperText = "";

    runtime.Zotero = {
      DataDirectory: { dir: "/zotero-data" },
      Libraries: {
        userLibraryID: 1,
        getAll: () => [{ libraryID: 1 }, { libraryID: 5 }],
      },
      Items: {
        getByLibraryAndKey: (libraryID: number, itemKey: string) => {
          if (libraryID === 1 && itemKey === currentPaper.key) {
            return currentPaper;
          }
          if (libraryID === 5 && itemKey === explicitPaper.key) {
            return explicitPaper;
          }
          return null;
        },
        get: (itemID: number) =>
          itemID === explicitPdf.id ? explicitPdf : null,
      },
      Attachments: {
        importFromFile: async (options: Record<string, unknown>) => {
          importOptions.push(options);
          return {
            id: 901,
            key: "PPTX0001",
            libraryID: 5,
            getFilePathAsync: async () => "/zotero/storage/PPTX0001/deck.pptx",
          };
        },
      },
      getMainWindow: () => rendererTarget,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          rendererTarget[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () =>
              new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async () => undefined,
      exists: async () => false,
      remove: async () => undefined,
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };
    runtime.ztoolkit = { log: () => undefined };

    try {
      resetPresentationRendererForTests();
      const manager = new PdfToolManager();
      const result = await manager.executeToolCall(
        {
          id: "cross-library-presentation",
          type: "function",
          function: {
            name: "presentation",
            arguments: JSON.stringify({ sourceItemKey: explicitPaper.key }),
          },
        },
        undefined,
        { sourceItemKey: explicitPaper.key },
        currentPaper.key,
        {
          paperSource: {
            itemKey: currentPaper.key,
            libraryID: currentPaper.libraryID,
          },
          presentationPlanner: async ({ paper }) => {
            plannerPaperText = paper.fullText;
            return {
              title: "Cross-library deck",
              sourceItemKey: explicitPaper.key,
              slides: [
                {
                  title: "Evidence",
                  metrics: [{ value: "1", label: "result" }],
                },
              ],
            } as any;
          },
        },
      );
      const payload = JSON.parse(result);

      assert.oneOf(payload.status, ["completed", "completed_with_warnings"]);
      assert.include(plannerPaperText, "Explicit group-library evidence");
      assert.deepInclude(importOptions[0], {
        parentItemID: explicitPaper.id,
        title: "Explicit group-library paper - PaperChat PPT",
      });
      assert.notProperty(importOptions[0], "libraryID");
    } finally {
      resetPresentationRendererForTests();
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
      runtime.ztoolkit = previousZtoolkit;
    }
  });
});
