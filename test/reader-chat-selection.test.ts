import { assert } from "chai";
import { collectAnnotationText } from "../src/modules/ui/reader-chat-selection.ts";

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
});
