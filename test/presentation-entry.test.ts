import { assert } from "chai";
import {
  createDeferredPresentationFocus,
  getSingleSelectedPresentationPaper,
  paperHasPdf,
  resolvePresentationPaper,
  resolvePresentationPaperFromCandidates,
  resolvePresentationLaunchSource,
} from "../src/modules/presentation/PresentationEntry.ts";
import { extractPresentationMentionSources } from "../src/modules/presentation/PresentationSourceContext.ts";
import {
  isPresentationSessionCompatibleWithPaper,
  presentationLaunchRequiresActiveSession,
  selectPresentationSession,
} from "../src/modules/presentation/PresentationSessionPolicy.ts";
import type { ChatSession } from "../src/types/chat.ts";

describe("presentation entry", function () {
  let originalZotero: unknown;

  beforeEach(function () {
    originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
  });

  afterEach(function () {
    (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
  });

  it("normalizes a selected PDF attachment to its paper", function () {
    const paper = {
      id: 10,
      key: "PAPER001",
      isAttachment: () => false,
      isNote: () => false,
      getAttachments: () => [11],
    } as unknown as Zotero.Item;
    const pdf = {
      id: 11,
      key: "PDF00001",
      parentItemID: 10,
      attachmentContentType: "application/pdf",
      isAttachment: () => true,
      isPDFAttachment: () => true,
      isNote: () => false,
    } as unknown as Zotero.Item;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Items: { get: (id: number) => (id === 10 ? paper : pdf) },
    };

    assert.strictEqual(resolvePresentationPaper(pdf), paper);
    assert.isTrue(paperHasPdf(paper));
  });

  it("keeps an independent PDF attachment as the presentation source", function () {
    const pdf = {
      id: 11,
      key: "PDFONLY1",
      parentItemID: 0,
      attachmentContentType: "application/pdf",
      isAttachment: () => true,
      isPDFAttachment: () => true,
      isNote: () => false,
    } as unknown as Zotero.Item;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Items: { get: () => false },
    };

    assert.strictEqual(resolvePresentationPaper(pdf), pdf);
    assert.isTrue(paperHasPdf(pdf));
  });

  it("rejects notes and non-PDF attachments", function () {
    const note = {
      id: 12,
      isNote: () => true,
      isAttachment: () => false,
    } as unknown as Zotero.Item;
    const image = {
      id: 13,
      parentItemID: 10,
      attachmentContentType: "image/png",
      isNote: () => false,
      isAttachment: () => true,
      isPDFAttachment: () => false,
    } as unknown as Zotero.Item;
    assert.isNull(resolvePresentationPaper(note));
    assert.isNull(resolvePresentationPaper(image));
  });

  it("falls through an invalid stale source to the next usable paper", function () {
    const note = {
      id: 14,
      isNote: () => true,
      isAttachment: () => false,
    } as unknown as Zotero.Item;
    const paper = {
      id: 15,
      isNote: () => false,
      isAttachment: () => false,
    } as unknown as Zotero.Item;

    assert.strictEqual(
      resolvePresentationPaperFromCandidates(null, note, paper),
      paper,
    );
  });

  it("returns a source only for exactly one selected paper", function () {
    const pdf = {
      id: 21,
      attachmentContentType: "application/pdf",
      isAttachment: () => true,
      isPDFAttachment: () => true,
    } as unknown as Zotero.Item;
    const paper = {
      id: 20,
      key: "PAPER020",
      isAttachment: () => false,
      isNote: () => false,
      getAttachments: () => [21],
    } as unknown as Zotero.Item;
    let selected: Zotero.Item[] = [paper];
    (globalThis as { Zotero?: unknown }).Zotero = {
      getActiveZoteroPane: () => ({ getSelectedItems: () => selected }),
      Items: { get: () => pdf },
    };

    assert.strictEqual(getSingleSelectedPresentationPaper(), paper);
    selected = [pdf];
    assert.strictEqual(getSingleSelectedPresentationPaper(), pdf);
    selected = [paper, paper];
    assert.isNull(getSingleSelectedPresentationPaper());
    selected = [];
    assert.isNull(getSingleSelectedPresentationPaper());
  });

  it("resolves a library-aware mention ahead of the currently open paper", function () {
    const currentPdf = {
      id: 31,
      isAttachment: () => true,
      isPDFAttachment: () => true,
    };
    const mentionedPdf = {
      id: 41,
      isAttachment: () => true,
      isPDFAttachment: () => true,
    };
    const current = {
      id: 30,
      key: "CURRENT1",
      libraryID: 1,
      isAttachment: () => false,
      isNote: () => false,
      getAttachments: () => [31],
    } as unknown as Zotero.Item;
    const mentioned = {
      id: 40,
      key: "MENTION1",
      libraryID: 5,
      isAttachment: () => false,
      isNote: () => false,
      getAttachments: () => [41],
    } as unknown as Zotero.Item;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Libraries: { userLibraryID: 1, getAll: () => [{ libraryID: 5 }] },
      Items: {
        get: (id: number) =>
          id === 31 ? currentPdf : id === 41 ? mentionedPdf : null,
        getByLibraryAndKey: (libraryID: number, key: string) =>
          libraryID === 1 && key === current.key
            ? current
            : libraryID === 5 && key === mentioned.key
              ? mentioned
              : null,
      },
      getActiveZoteroPane: () => ({ getSelectedItems: () => [current] }),
    };

    const result = resolvePresentationLaunchSource({}, current, [
      { itemKey: mentioned.key, libraryID: mentioned.libraryID },
    ]);
    assert.deepEqual(result, {
      allowed: true,
      source: { itemKey: mentioned.key, libraryID: mentioned.libraryID },
    });
  });

  it("does not guess when multiple explicit mentions lack a model choice", function () {
    const result = resolvePresentationLaunchSource({}, null, [
      { itemKey: "PAPER1", libraryID: 1 },
      { itemKey: "PAPER2", libraryID: 1 },
    ]);
    assert.deepEqual(result, { allowed: false, reason: "source_ambiguous" });
  });

  it("does not pick a library when a key-only choice matches two library mentions", function () {
    const paper = {
      id: 51,
      key: "SHARED01",
      libraryID: 1,
      isAttachment: () => false,
      isNote: () => false,
      getAttachments: () => [],
    } as unknown as Zotero.Item;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Libraries: { userLibraryID: 1, getAll: () => [{ libraryID: 5 }] },
      Items: {
        getByLibraryAndKey: (libraryID: number, key: string) =>
          key === paper.key && libraryID === 1 ? paper : null,
      },
    };

    assert.deepEqual(
      resolvePresentationLaunchSource({ sourceItemKey: paper.key }, null, [
        { itemKey: paper.key, libraryID: 1 },
        { itemKey: paper.key, libraryID: 5 },
      ]),
      { allowed: false, reason: "source_ambiguous" },
    );
  });

  it("does not let a model source override an explicit mention", function () {
    const paper = {
      id: 61,
      key: "MENTIONED1",
      libraryID: 1,
      isAttachment: () => false,
      isNote: () => false,
      getAttachments: () => [],
    } as unknown as Zotero.Item;
    const redirected = {
      id: 62,
      key: "REDIRECT1",
      libraryID: 2,
      isAttachment: () => false,
      isNote: () => false,
      getAttachments: () => [],
    } as unknown as Zotero.Item;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Libraries: { userLibraryID: 1, getAll: () => [{ libraryID: 2 }] },
      Items: {
        getByLibraryAndKey: (libraryID: number, key: string) =>
          libraryID === paper.libraryID && key === paper.key
            ? paper
            : libraryID === redirected.libraryID && key === redirected.key
              ? redirected
              : null,
      },
    };

    assert.deepEqual(
      resolvePresentationLaunchSource(
        {
          sourceItemKey: redirected.key,
          sourceLibraryID: redirected.libraryID,
        },
        null,
        [{ itemKey: paper.key, libraryID: paper.libraryID }],
      ),
      { allowed: false, reason: "source_ambiguous" },
    );
    assert.deepEqual(
      resolvePresentationLaunchSource(
        {
          sourceItemKey: paper.key,
          sourceLibraryID: redirected.libraryID,
        },
        null,
        [{ itemKey: paper.key, libraryID: paper.libraryID }],
      ),
      { allowed: false, reason: "source_ambiguous" },
    );
  });

  it("keeps a repeated current-paper key bound to its library", function () {
    const currentPdf = {
      id: 71,
      isAttachment: () => true,
      isPDFAttachment: () => true,
    };
    const otherPdf = {
      id: 81,
      isAttachment: () => true,
      isPDFAttachment: () => true,
    };
    const current = {
      id: 70,
      key: "SHARED02",
      libraryID: 1,
      isAttachment: () => false,
      isNote: () => false,
      getAttachments: () => [71],
    } as unknown as Zotero.Item;
    const other = {
      id: 80,
      key: "SHARED02",
      libraryID: 5,
      isAttachment: () => false,
      isNote: () => false,
      getAttachments: () => [81],
    } as unknown as Zotero.Item;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Libraries: { userLibraryID: 1, getAll: () => [{ libraryID: 5 }] },
      Items: {
        get: (id: number) =>
          id === 71 ? currentPdf : id === 81 ? otherPdf : null,
        getByLibraryAndKey: (libraryID: number, key: string) =>
          key !== "SHARED02" ? null : libraryID === 1 ? current : other,
      },
    };

    assert.deepEqual(
      resolvePresentationLaunchSource({ sourceItemKey: "SHARED02" }, current),
      { allowed: true, source: { itemKey: "SHARED02", libraryID: 1 } },
    );
    assert.deepEqual(
      resolvePresentationLaunchSource(
        { sourceItemKey: "SHARED02", sourceLibraryID: 5 },
        current,
      ),
      { allowed: false, reason: "source_ambiguous" },
    );
  });

  it("normalizes a reader PDF attachment key to its parent paper", function () {
    const paper = {
      id: 92,
      key: "PAPER092",
      libraryID: 1,
      isAttachment: () => false,
      isNote: () => false,
      getAttachments: () => [91],
    } as unknown as Zotero.Item;
    const attachment = {
      id: 91,
      key: "PDF09201",
      libraryID: 1,
      parentItemID: paper.id,
      isAttachment: () => true,
      isPDFAttachment: () => true,
      isNote: () => false,
    } as unknown as Zotero.Item;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Libraries: { userLibraryID: 1, getAll: () => [{ libraryID: 1 }] },
      Items: {
        get: (id: number) => (id === attachment.id ? attachment : paper),
        getByLibraryAndKey: (libraryID: number, key: string) =>
          libraryID === 1 && key === attachment.key ? attachment : null,
      },
    };

    assert.deepEqual(
      resolvePresentationLaunchSource(
        { sourceItemKey: attachment.key, sourceLibraryID: 1 },
        paper,
      ),
      { allowed: true, source: { itemKey: paper.key, libraryID: 1 } },
    );
  });

  it("extracts the library and key from the selector marker", function () {
    assert.deepEqual(
      extractPresentationMentionSources(
        "请生成 @[A paper](library:5,key:ABC123) 的 PPT",
      ),
      [{ itemKey: "ABC123", libraryID: 5, title: "A paper" }],
    );
  });

  it("defers a running-task focus request until its message card exists", function () {
    const focus = createDeferredPresentationFocus();
    let focusCalls = 0;

    focus.requestFocus();
    assert.equal(focusCalls, 0);
    focus.setFocus(() => {
      focusCalls += 1;
    });
    assert.equal(focusCalls, 1);
    focus.requestFocus();
    assert.equal(focusCalls, 2);

    focus.clearFocus();
    focus.requestFocus();
    assert.equal(focusCalls, 2);
  });

  it("allows dedicated menu sessions to run in the background", function () {
    assert.isFalse(
      presentationLaunchRequiresActiveSession("presentation_menu"),
    );
    assert.isTrue(
      presentationLaunchRequiresActiveSession("presentation_button"),
    );
  });

  function createHarness(active: ChatSession | null) {
    const created = { id: "created" } as ChatSession;
    let createCalls = 0;
    let currentActive = active;
    const itemSessionCalls: Array<{
      itemKey: string;
      title: string;
      libraryID?: number;
    }> = [];
    return {
      created,
      itemSessionCalls,
      get createCalls() {
        return createCalls;
      },
      manager: {
        getActiveSession: () => currentActive,
        createNewSession: async () => {
          createCalls += 1;
          currentActive = created;
          return created;
        },
        createItemSession: async (
          itemKey: string,
          title: string,
          libraryID?: number,
        ) => {
          itemSessionCalls.push({ itemKey, title, libraryID });
          currentActive = created;
          return created;
        },
      },
    };
  }

  it("reuses the active chat for the in-chat PPT button", async function () {
    const active = { id: "active" } as ChatSession;
    const harness = createHarness(active);

    assert.deepEqual(
      await selectPresentationSession(
        harness.manager,
        "presentation_button",
        active,
      ),
      { session: active, expectedActiveSession: active },
    );
    assert.equal(harness.createCalls, 0);
  });

  it("starts a fresh chat for the library context-menu entry", async function () {
    const harness = createHarness({ id: "active" } as ChatSession);

    assert.deepEqual(
      await selectPresentationSession(
        harness.manager,
        "presentation_menu",
        null,
        { itemKey: "PAPER001", title: "Paper title", libraryID: 5 },
      ),
      { session: harness.created, expectedActiveSession: null },
    );
    assert.equal(harness.createCalls, 0);
    assert.deepEqual(harness.itemSessionCalls, [
      { itemKey: "PAPER001", title: "Paper title", libraryID: 5 },
    ]);
  });

  it("creates a chat when the in-chat button has no active session", async function () {
    const harness = createHarness(null);

    assert.deepEqual(
      await selectPresentationSession(
        harness.manager,
        "presentation_button",
        null,
      ),
      { session: harness.created, expectedActiveSession: null },
    );
    assert.equal(harness.createCalls, 1);
  });

  it("cancels an in-chat launch when the active chat changed during its dialogs", async function () {
    const clickedSession = { id: "clicked" } as ChatSession;
    const nextSession = { id: "next" } as ChatSession;
    const harness = createHarness(nextSession);

    assert.isNull(
      await selectPresentationSession(
        harness.manager,
        "presentation_button",
        clickedSession,
      ),
    );
    assert.equal(harness.createCalls, 0);
  });

  it("treats a legacy session without a library ID as a personal-library chat", function () {
    const legacySession = {
      id: "legacy",
      lastActiveItemKey: "PAPER001",
      lastActiveItemLibraryID: undefined,
    } as ChatSession;

    assert.isTrue(
      isPresentationSessionCompatibleWithPaper(
        legacySession,
        { itemKey: "PAPER001", libraryID: 1 },
        1,
      ),
    );
    assert.isFalse(
      isPresentationSessionCompatibleWithPaper(
        legacySession,
        { itemKey: "PAPER001", libraryID: 5 },
        1,
      ),
    );
  });
});
