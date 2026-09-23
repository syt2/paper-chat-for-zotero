import { assert } from "chai";
import {
  appendSelectionCommentToDraft,
  captureSelectionRanges,
  collectAnnotationText,
  FLOATING_SELECTION_ENTRY_PROXIMITY_PX,
  getSelectionEntryExpandedWidth,
  getSelectionEntryRefreshAction,
  getSelectionEntryRect,
  getSelectionEntryPosition,
  isReaderSelectionEntryEnabled,
  isSelectionEntryPointerNear,
  isSelectionEntryTextEligible,
  restoreSelectionRanges,
} from "../src/modules/ui/reader-chat-selection.ts";

type FakeAnnotation = {
  annotationText?: string;
  annotationComment?: string;
};

describe("reader chat selection", function () {
  let originalZotero: unknown;
  let hadZotero = false;
  let annotationsByKey: Map<string, FakeAnnotation>;
  let attachment: { libraryID: number } | false;

  beforeEach(function () {
    hadZotero = "Zotero" in globalThis;
    originalZotero = (globalThis as any).Zotero;
    annotationsByKey = new Map();
    attachment = { libraryID: 1 };

    (globalThis as any).Zotero = {
      Items: {
        get: () => attachment,
        getByLibraryAndKey: (_libraryID: number, key: string) =>
          annotationsByKey.get(key) || false,
      },
    };
  });

  afterEach(function () {
    if (hadZotero) (globalThis as any).Zotero = originalZotero;
    else delete (globalThis as any).Zotero;
  });

  it("pairs highlighted text with its comment", function () {
    annotationsByKey.set("A1", {
      annotationText: "  attention is all you need  ",
      annotationComment: " core claim ",
    });

    const result = collectAnnotationText({ itemID: 7 }, ["A1"]);

    assert.equal(result, "attention is all you need\n\n(core claim)");
  });

  it("keeps text-only and comment-only annotations, joined by a rule", function () {
    annotationsByKey.set("A1", { annotationText: "highlighted" });
    annotationsByKey.set("A2", { annotationComment: "just a note" });

    const result = collectAnnotationText({ itemID: 7 }, ["A1", "A2"]);

    assert.equal(result, "highlighted\n\n---\n\njust a note");
  });

  it("skips unresolvable keys and fully empty annotations", function () {
    annotationsByKey.set("A1", { annotationText: "kept" });
    annotationsByKey.set("A3", {
      annotationText: "   ",
      annotationComment: "",
    });

    const result = collectAnnotationText({ itemID: 7 }, [
      "A1",
      "MISSING",
      "A3",
    ]);

    assert.equal(result, "kept");
  });

  it("returns empty when the reader has no item, no ids, or no attachment", function () {
    annotationsByKey.set("A1", { annotationText: "kept" });

    assert.equal(collectAnnotationText({}, ["A1"]), "");
    assert.equal(collectAnnotationText({ itemID: 7 }, []), "");
    assert.equal(collectAnnotationText({ itemID: 7 }, undefined), "");

    attachment = false;
    assert.equal(collectAnnotationText({ itemID: 7 }, ["A1"]), "");
  });

  it("places the selection entry to the right of the selected line", function () {
    assert.deepEqual(
      getSelectionEntryPosition(
        { left: 100, right: 160, top: 40, height: 22 },
        500,
        400,
      ),
      { left: 164, top: 42 },
    );
  });

  it("uses the visually final selected line instead of range order", function () {
    const selectedTextRect = { left: 100, right: 160, top: 40, height: 22 };
    const pdfJsHelperRect = { left: 0, right: 500, top: 0, height: 400 };

    assert.deepEqual(
      getSelectionEntryRect([pdfJsHelperRect, selectedTextRect]),
      selectedTextRect,
    );
  });

  it("falls back to the final selection rect when no endpoint rect exists", function () {
    const finalRect = { left: 100, right: 160, top: 40, height: 22 };

    assert.deepEqual(getSelectionEntryRect([finalRect]), finalRect);
    assert.isNull(getSelectionEntryRect([]));
  });

  it("anchors a multiline selection to its visually final line", function () {
    const firstLine = { left: 100, right: 300, top: 40, height: 22 };
    const finalLine = { left: 100, right: 160, top: 64, height: 22 };
    assert.deepEqual(getSelectionEntryRect([finalLine, firstLine]), finalLine);
  });

  it("uses the rightmost fragment when the final line has multiple rects", function () {
    const leftFragment = { left: 100, right: 140, top: 64, height: 22 };
    const rightFragment = { left: 145, right: 190, top: 64, height: 22 };

    assert.deepEqual(
      getSelectionEntryRect([rightFragment, leftFragment]),
      rightFragment,
    );
  });

  it("repositions the entry for the same text and replaces it for new text", function () {
    assert.equal(
      getSelectionEntryRefreshAction("same passage", "same passage"),
      "reposition",
    );
    assert.equal(
      getSelectionEntryRefreshAction("old passage", "new passage"),
      "replace",
    );
  });

  it("only allows selection entries for text longer than four characters", function () {
    assert.isFalse(isSelectionEntryTextEligible("abcd"));
    assert.isTrue(isSelectionEntryTextEligible("abcde"));
    assert.isFalse(isSelectionEntryTextEligible("  a  "));
  });

  it("uses full opacity only within the configured proximity of the entry", function () {
    const rect = { left: 100, right: 118, top: 40, height: 24 };

    assert.isTrue(
      isSelectionEntryPointerNear(
        rect,
        100 - FLOATING_SELECTION_ENTRY_PROXIMITY_PX,
        52,
      ),
    );
    assert.isFalse(
      isSelectionEntryPointerNear(
        rect,
        100 - FLOATING_SELECTION_ENTRY_PROXIMITY_PX - 1,
        52,
      ),
    );
    assert.isTrue(isSelectionEntryPointerNear(rect, 121, 68, 5));
    assert.isFalse(isSelectionEntryPointerNear(rect, 122, 68, 5));
    assert.isTrue(isSelectionEntryPointerNear(rect, 109, 52));
  });

  it("moves the selection entry to the left when the right edge has no room", function () {
    assert.deepEqual(
      getSelectionEntryPosition(
        { left: 470, right: 496, top: 380, height: 22 },
        500,
        400,
      ),
      { left: 448, top: 382 },
    );
  });

  it("grows the entry by one slot per revealed action", function () {
    assert.equal(getSelectionEntryExpandedWidth(0), 18);
    assert.equal(getSelectionEntryExpandedWidth(2), 74);
    assert.equal(getSelectionEntryExpandedWidth(3), 102);
  });

  it("appends a comment to the draft on its own line", function () {
    assert.equal(
      appendSelectionCommentToDraft("existing draft", "what does this mean?"),
      "existing draft\nwhat does this mean?",
    );
    assert.equal(
      appendSelectionCommentToDraft("  existing draft  ", "  spaced  "),
      "existing draft\nspaced",
    );
  });

  it("uses only the comment when the draft is empty or blank", function () {
    assert.equal(
      appendSelectionCommentToDraft("", "first thought"),
      "first thought",
    );
    assert.equal(
      appendSelectionCommentToDraft("   \n  ", "first thought"),
      "first thought",
    );
  });

  it("keeps the draft untouched when the comment is empty or blank", function () {
    assert.equal(
      appendSelectionCommentToDraft("existing draft", ""),
      "existing draft",
    );
    assert.equal(
      appendSelectionCommentToDraft("existing draft", "  \n "),
      "existing draft",
    );
  });

  it("keeps the floating entry enabled unless the pref is explicitly false", function () {
    assert.isTrue(isReaderSelectionEntryEnabled(true));
    assert.isTrue(isReaderSelectionEntryEnabled(undefined));
    assert.isFalse(isReaderSelectionEntryEnabled(false));
  });

  it("copies every reader selection range before a focus change", function () {
    const stub = createSelectionStub([fakeRange("a"), fakeRange("b")]);

    const captured = captureSelectionRanges(stub.selection);

    assert.deepEqual(
      captured.map((range) => (range as FakeRange).id),
      ["a-clone", "b-clone"],
    );
    assert.isEmpty(captureSelectionRanges(null));
    assert.isEmpty(captureSelectionRanges(createSelectionStub().selection));
  });

  it("skips ranges that disappear while they are being copied", function () {
    const goneRange = {
      cloneRange: () => {
        throw new Error("range is gone");
      },
    } as unknown as FakeRange;
    const stub = createSelectionStub([goneRange, fakeRange("kept")]);

    assert.deepEqual(
      captureSelectionRanges(stub.selection).map(
        (range) => (range as FakeRange).id,
      ),
      ["kept-clone"],
    );
  });

  it("puts the captured ranges back after the engine drops them", function () {
    const stub = createSelectionStub([fakeRange("user-selection")]);

    const restored = restoreSelectionRanges(
      stub.selection,
      captureSelectionRanges(stub.selection),
    );

    assert.isTrue(restored);
    assert.equal(stub.clearedCount(), 1);
    assert.deepEqual(
      stub.applied.map((range) => range.id),
      ["user-selection-clone"],
    );
  });

  it("reports nothing restored when there is no selection to put back", function () {
    const stub = createSelectionStub();

    assert.isFalse(restoreSelectionRanges(null, [fakeRange("a")]));
    assert.isFalse(restoreSelectionRanges(stub.selection, []));
    assert.equal(stub.clearedCount(), 0);
  });

  it("survives a selection that is already going away", function () {
    const deadSelection = {
      rangeCount: 1,
      getRangeAt: () => {
        throw new Error("document is gone");
      },
      removeAllRanges: () => {
        throw new Error("document is gone");
      },
      addRange: () => {
        throw new Error("document is gone");
      },
    } as unknown as Selection;

    assert.isEmpty(captureSelectionRanges(deadSelection));
    assert.isFalse(restoreSelectionRanges(deadSelection, [fakeRange("a")]));
  });
});

type FakeRange = Range & { id: string };

function fakeRange(id: string): FakeRange {
  return {
    id,
    cloneRange: () => fakeRange(`${id}-clone`),
  } as unknown as FakeRange;
}

function createSelectionStub(ranges: FakeRange[] = []) {
  const applied: FakeRange[] = [];
  let cleared = 0;
  const selection = {
    get rangeCount() {
      return ranges.length;
    },
    getRangeAt: (index: number) => ranges[index],
    removeAllRanges() {
      cleared += 1;
      applied.length = 0;
    },
    addRange: (range: FakeRange) => {
      applied.push(range);
    },
  } as unknown as Selection;

  return { selection, applied, clearedCount: () => cleared };
}
