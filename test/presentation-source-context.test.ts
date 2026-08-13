import { assert } from "chai";
import { PdfToolManager } from "../src/modules/chat/pdf-tools/PdfToolManager.ts";
import { resetPresentationRendererForTests } from "../src/modules/presentation/PresentationRendererLoader.ts";
import { PRESENTATION_RENDERER_GLOBAL } from "../src/modules/presentation/contracts.ts";
import { resolvePresentationSourceItemKey } from "../src/modules/presentation/PresentationSourceContext.ts";
import {
  beginPresentationAuthorizationAttempt,
  createPresentationLaunchAuthorization,
  finishPresentationAuthorizationAttempt,
} from "../src/modules/presentation/PresentationLaunchAuthorization.ts";

describe("presentation source context", function () {
  let originalZotero: unknown;

  beforeEach(function () {
    originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
  });

  afterEach(function () {
    (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
  });

  it("keeps the session-bound paper ahead of model arguments and library selection", function () {
    (globalThis as { Zotero?: unknown }).Zotero = {
      getActiveZoteroPane: () => ({
        getSelectedItems: () => [{ key: "SELECTED1" }],
      }),
    };

    assert.equal(
      resolvePresentationSourceItemKey("EXPLICIT1", "SESSION01"),
      "SESSION01",
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

  it("rejects a model attempt to replace the authorized paper", async function () {
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
          presentationAuthorization: createPresentationLaunchAuthorization({
            itemKey: currentPaper.key,
            libraryID: currentPaper.libraryID,
          }),
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
      assert.equal(
        result,
        "Error: The presentation source does not match the paper authorized by the user.",
      );
      assert.equal(plannerPaperText, "");
      assert.lengthOf(importOptions, 0);
    } finally {
      resetPresentationRendererForTests();
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
      runtime.ztoolkit = previousZtoolkit;
    }
  });

  it("refuses direct presentation execution without a guarded launch authorization", async function () {
    const runtime = globalThis as any;
    const previousZtoolkit = runtime.ztoolkit;
    runtime.ztoolkit = { log: () => undefined };
    try {
      const manager = new PdfToolManager();
      const result = await manager.executeToolCall(
        {
          id: "unguarded-presentation",
          type: "function",
          function: {
            name: "presentation",
            arguments: JSON.stringify({ sourceItemKey: "CURRENT1" }),
          },
        },
        undefined,
        { sourceItemKey: "CURRENT1" },
        "CURRENT1",
        {
          paperSource: { itemKey: "CURRENT1", libraryID: 1 },
        },
      );

      assert.equal(
        result,
        "Error: Presentation generation must be started from a PaperChat PPT entry after its balance check and confirmation.",
      );
    } finally {
      runtime.ztoolkit = previousZtoolkit;
    }
  });

  it("consumes one authorization after a successful full-deck attempt", function () {
    const authorization = createPresentationLaunchAuthorization({
      itemKey: "CURRENT1",
      libraryID: 1,
    });

    assert.deepEqual(beginPresentationAuthorizationAttempt(authorization), {
      allowed: true,
      attempt: 1,
    });
    finishPresentationAuthorizationAttempt(authorization, "completed");
    assert.deepEqual(beginPresentationAuthorizationAttempt(authorization), {
      allowed: false,
      reason: "already_completed",
    });
  });

  it("bounds retryable presentation attempts at the executor boundary", async function () {
    const runtime = globalThis as any;
    const previousZtoolkit = runtime.ztoolkit;
    runtime.ztoolkit = { log: () => undefined };
    const manager = new PdfToolManager() as any;
    let extractionCalls = 0;
    let plannerCalls = 0;
    manager.extractAndParsePaper = async () => {
      extractionCalls += 1;
      return {
        metadata: { title: "Paper" },
        sections: [],
        fullText: "Evidence",
        pages: [],
        pageCount: 1,
      };
    };
    const authorization = createPresentationLaunchAuthorization({
      itemKey: "CURRENT1",
      libraryID: 1,
    });
    const executionContext = {
      paperSource: { itemKey: "CURRENT1", libraryID: 1 },
      presentationAuthorization: authorization,
      presentationPlanner: async () => {
        plannerCalls += 1;
        throw new Error(`planner failure ${plannerCalls}`);
      },
    };
    const toolCall = {
      id: "retryable-presentation",
      type: "function" as const,
      function: {
        name: "presentation",
        arguments: JSON.stringify({ sourceItemKey: "CURRENT1" }),
      },
    };

    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const result = await manager.executeToolCall(
          toolCall,
          undefined,
          { sourceItemKey: "CURRENT1" },
          "CURRENT1",
          executionContext,
        );
        assert.include(result, "Presentation internal planning failed");
        assert.include(result, "Retryable: yes");
      }
      const blocked = await manager.executeToolCall(
        toolCall,
        undefined,
        { sourceItemKey: "CURRENT1" },
        "CURRENT1",
        executionContext,
      );

      assert.include(
        blocked,
        "Presentation launch authorization cannot start another deck",
      );
      assert.include(blocked, "Retryable: no");
      assert.equal(extractionCalls, 3);
      assert.equal(plannerCalls, 3);
    } finally {
      runtime.ztoolkit = previousZtoolkit;
    }
  });
});
