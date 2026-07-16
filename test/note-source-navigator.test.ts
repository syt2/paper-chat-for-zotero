import { assert } from "chai";
import {
  normalizeNoteSourceKey,
  openNoteSource,
} from "../src/modules/ui/chat-panel/NoteSourceNavigator.ts";

describe("note source navigation", function () {
  let originalZotero: unknown;

  beforeEach(function () {
    originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
  });

  afterEach(function () {
    (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
  });

  it("normalizes only explicit Zotero note keys", function () {
    assert.equal(normalizeNoteSourceKey("misjctq9"), "MISJCTQ9");
    assert.isNull(normalizeNoteSourceKey(undefined));
    assert.isNull(normalizeNoteSourceKey("note MISJCTQ9"));
  });

  it("selects the resolved note in the active Zotero pane", async function () {
    let selectedItemID: number | null = null;
    let focused = false;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => ({ id: 42, isNote: () => true }),
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
    };

    await openNoteSource("MISJCTQ9");

    assert.equal(selectedItemID, 42);
    assert.isTrue(focused);
  });

  it("reports missing notes, panes, and selection failures", async function () {
    (globalThis as { Zotero?: unknown }).Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: { getByLibraryAndKey: () => false },
    };
    try {
      await openNoteSource("MISJCTQ9");
      assert.fail("expected a missing note to fail");
    } catch (error) {
      assert.include(String(error), "was not found");
    }

    (globalThis as { Zotero?: unknown }).Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => ({ id: 42, isNote: () => true }),
      },
      getActiveZoteroPane: () => null,
    };
    try {
      await openNoteSource("MISJCTQ9");
      assert.fail("expected a missing pane to fail");
    } catch (error) {
      assert.include(String(error), "pane is not available");
    }

    (globalThis as { Zotero?: unknown }).Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => ({ id: 42, isNote: () => true }),
      },
      getActiveZoteroPane: () => ({
        selectItem: async () => {
          throw new Error("selection failed");
        },
      }),
    };
    try {
      await openNoteSource("MISJCTQ9");
      assert.fail("expected selection to fail");
    } catch (error) {
      assert.include(String(error), "selection failed");
    }
  });
});
