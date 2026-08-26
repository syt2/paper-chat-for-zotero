import { assert } from "chai";
import {
  collectAnnotationText,
  getSelectionEntryRefreshAction,
  getSelectionEntryRect,
  getSelectionEntryPosition,
  isSelectionEntryTextEligible,
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
});
