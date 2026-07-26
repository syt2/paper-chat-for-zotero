import { assert } from "chai";
import { executeSearchFulltext } from "../src/modules/chat/pdf-tools/libraryExecutors.ts";

type FakeItem = {
  id: number;
  key: string;
  itemType: string;
  parentItemID?: number;
  isAttachment?: () => boolean;
  isNote?: () => boolean;
  getField: (field: string) => string;
  getCreators: () => Array<{ lastName?: string; name?: string }>;
  getDisplayTitle?: () => string;
};

function paper(
  id: number,
  key: string,
  title: string,
  itemType = "journalArticle",
): FakeItem {
  return {
    id,
    key,
    itemType,
    isAttachment: () => false,
    isNote: () => false,
    getField: (field: string) => (field === "title" ? title : ""),
    getCreators: () => [{ lastName: "Shen" }],
    getDisplayTitle: () => title,
  };
}

function attachment(id: number, key: string, parentItemID?: number): FakeItem {
  return {
    id,
    key,
    itemType: "attachment",
    parentItemID,
    isAttachment: () => true,
    isNote: () => false,
    getField: () => "",
    getCreators: () => [],
  };
}

describe("search_fulltext tool", function () {
  let originalZotero: unknown;
  let hadZotero = false;
  let recordedConditions: Array<[string, string, string]>;
  let searchResultIDs: number[];
  let itemsById: Map<number, FakeItem>;

  beforeEach(function () {
    hadZotero = "Zotero" in globalThis;
    originalZotero = (globalThis as any).Zotero;
    recordedConditions = [];
    searchResultIDs = [];
    itemsById = new Map();

    class FakeSearch {
      addCondition(field: string, operator: string, value: string): void {
        recordedConditions.push([field, operator, value]);
      }
      async search(): Promise<number[]> {
        return searchResultIDs;
      }
    }

    (globalThis as any).Zotero = {
      Libraries: { userLibraryID: 1 },
      Search: FakeSearch,
      Items: {
        getAsync: async (ids: number[]) =>
          ids.map((id) => itemsById.get(id)).filter(Boolean),
        get: (id: number) => itemsById.get(id) || false,
      },
    };
  });

  afterEach(function () {
    if (hadZotero) (globalThis as any).Zotero = originalZotero;
    else delete (globalThis as any).Zotero;
  });

  it("queries the fulltextContent condition and maps attachments to deduped parents", async function () {
    const parentA = paper(1, "AAAA1111", "Attention Is All You Need");
    const parentB = paper(2, "BBBB2222", "BERT Pre-training");
    itemsById.set(1, parentA);
    itemsById.set(2, parentB);
    // Two attachments of the same parent + one of another: expect 2 papers.
    itemsById.set(11, attachment(11, "ATT1", 1));
    itemsById.set(12, attachment(12, "ATT2", 1));
    itemsById.set(21, attachment(21, "ATT3", 2));
    searchResultIDs = [11, 12, 21];

    const result = await executeSearchFulltext({ query: "transformer" });

    assert.deepEqual(recordedConditions, [
      ["fulltextContent", "contains", "transformer"],
    ]);
    assert.include(result, "[AAAA1111]");
    assert.include(result, "[BBBB2222]");
    assert.include(result, "showing 2 of 2 matches");
  });

  it("filters by parent itemType after parent resolution and drops orphans", async function () {
    const article = paper(1, "AAAA1111", "An Article", "journalArticle");
    const book = paper(2, "BBBB2222", "A Book", "book");
    itemsById.set(1, article);
    itemsById.set(2, book);
    itemsById.set(11, attachment(11, "ATT1", 1));
    itemsById.set(21, attachment(21, "ATT2", 2));
    // Orphan attachment without a parent must be skipped, not crash.
    itemsById.set(31, attachment(31, "ATT3", undefined));
    searchResultIDs = [11, 21, 31];

    const result = await executeSearchFulltext({
      query: "methods",
      itemType: "book",
    });

    assert.include(result, "[BBBB2222]");
    assert.notInclude(result, "[AAAA1111]");
    assert.include(result, "showing 1 of 1 matches");
  });

  it("returns a helpful message when nothing matches", async function () {
    searchResultIDs = [];
    const result = await executeSearchFulltext({ query: "nonexistent" });
    assert.include(result, "No papers found");
    assert.include(result, "indexed");
  });

  it("rejects an empty query", async function () {
    const result = await executeSearchFulltext({ query: "   " });
    assert.include(result, "Error");
  });
});
