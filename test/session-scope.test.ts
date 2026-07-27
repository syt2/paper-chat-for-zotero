import { assert } from "chai";
import {
  MAX_SCOPE_ITEMS,
  buildScopeFromItems,
  formatScopedPapersPrompt,
  resolveScopedPapers,
} from "../src/modules/chat/session-scope.ts";

type FakeItem = {
  key: string;
  isAttachment?: () => boolean;
  isNote?: () => boolean;
  getField?: (field: string) => string;
  getCreators?: () => Array<{ lastName?: string; name?: string }>;
};

function paper(key: string, title = "T", year = "2022", author = "Shen") {
  return {
    key,
    isAttachment: () => false,
    isNote: () => false,
    getField: (field: string) =>
      field === "year" ? year : field === "title" ? title : "",
    getCreators: () => [{ lastName: author }],
  } as FakeItem;
}

describe("session scope", function () {
  describe("buildScopeFromItems", function () {
    it("keeps regular items, drops attachments/notes, and dedupes", function () {
      const scope = buildScopeFromItems(
        [
          paper("AAA"),
          { key: "ATT", isAttachment: () => true, isNote: () => false },
          { key: "NOTE", isAttachment: () => false, isNote: () => true },
          paper("AAA"),
          paper("BBB"),
          false,
          null,
        ],
        "My Collection",
      );

      assert.deepEqual(scope?.itemKeys, ["AAA", "BBB"]);
      assert.equal(scope?.label, "My Collection");
      assert.isFalse(scope?.truncated);
    });

    it("returns null when nothing usable is selected", function () {
      assert.isNull(buildScopeFromItems([], "empty"));
      assert.isNull(
        buildScopeFromItems(
          [{ key: "ATT", isAttachment: () => true, isNote: () => false }],
          "attachments only",
        ),
      );
    });

    it("caps at MAX_SCOPE_ITEMS and flags truncation", function () {
      const many = Array.from({ length: MAX_SCOPE_ITEMS + 5 }, (_, i) =>
        paper(`K${i}`),
      );

      const scope = buildScopeFromItems(many, "big");

      assert.equal(scope?.itemKeys.length, MAX_SCOPE_ITEMS);
      assert.isTrue(scope?.truncated);
    });
  });

  describe("resolveScopedPapers", function () {
    let originalZotero: unknown;
    let hadZotero = false;
    let itemsByKey: Map<string, FakeItem>;

    beforeEach(function () {
      hadZotero = "Zotero" in globalThis;
      originalZotero = (globalThis as any).Zotero;
      itemsByKey = new Map();
      (globalThis as any).Zotero = {
        Libraries: { userLibraryID: 1 },
        Items: {
          getByLibraryAndKey: (_id: number, key: string) =>
            itemsByKey.get(key) || false,
          get: (id: number) => itemsByKey.get(String(id)) || false,
        },
      };
    });

    afterEach(function () {
      if (hadZotero) (globalThis as any).Zotero = originalZotero;
      else delete (globalThis as any).Zotero;
    });

    it("resolves keys and drops ones that no longer exist", function () {
      itemsByKey.set("AAA", paper("AAA", "Attention", "2017", "Vaswani"));

      const papers = resolveScopedPapers(["AAA", "GONE"]);

      assert.equal(papers.length, 1);
      assert.deepEqual(papers[0], {
        key: "AAA",
        title: "Attention",
        year: "2017",
        firstAuthor: "Vaswani",
      });
    });

    it("returns empty for empty or missing input", function () {
      assert.deepEqual(resolveScopedPapers([]), []);
      assert.deepEqual(resolveScopedPapers(undefined), []);
    });
  });

  describe("formatScopedPapersPrompt", function () {
    it("renders a numbered block with keys, label, and count", function () {
      const block = formatScopedPapersPrompt(
        [
          { key: "AAA", title: "Attention", year: "2017", firstAuthor: "V" },
          { key: "BBB", title: "BERT", year: "", firstAuthor: "" },
        ],
        "My Collection",
      );

      assert.include(block, "=== SCOPED PAPERS ===");
      assert.include(block, "2 paper(s)");
      assert.include(block, 'from "My Collection"');
      assert.include(block, "1. [AAA] Attention (V, 2017)");
      // No author/year means no trailing parens.
      assert.include(block, "2. [BBB] BERT\n");
    });

    it("renders nothing when there are no papers", function () {
      assert.equal(formatScopedPapersPrompt([], "x"), "");
    });
  });
});
