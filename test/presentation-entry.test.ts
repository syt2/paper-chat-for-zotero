import { assert } from "chai";
import {
  createDeferredPresentationFocus,
  getSingleSelectedPresentationPaper,
  paperHasPdf,
  resolvePresentationPaper,
  resolvePresentationPaperFromCandidates,
} from "../src/modules/presentation/PresentationEntry.ts";
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
