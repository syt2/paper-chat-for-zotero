import { assert } from "chai";
import {
  executeListSavedSearches,
  executeRunSavedSearch,
} from "../src/modules/chat/pdf-tools/libraryExecutors.ts";

type FakeSearch = {
  key: string;
  name: string;
  search: () => Promise<number[]>;
};

type FakeItem = {
  key: string;
  itemType: string;
  isNote?: () => boolean;
  getField: (field: string) => string;
  getCreators: () => Array<{ lastName?: string }>;
  isAttachment?: () => boolean;
};

function item(key: string, title: string, isNote = false): FakeItem {
  return {
    key,
    itemType: isNote ? "note" : "journalArticle",
    isNote: () => isNote,
    isAttachment: () => false,
    getField: (field: string) =>
      field === "year" ? "2022" : field === "title" ? title : "",
    getCreators: () => [{ lastName: "Shen" }],
  };
}

describe("saved search tools", function () {
  let originalZotero: unknown;
  let hadZotero = false;
  let searchesById: Map<number, FakeSearch>;
  let searchesByKey: Map<string, FakeSearch>;
  let itemsById: Map<number, FakeItem>;

  beforeEach(function () {
    hadZotero = "Zotero" in globalThis;
    originalZotero = (globalThis as any).Zotero;
    searchesById = new Map();
    searchesByKey = new Map();
    itemsById = new Map();

    (globalThis as any).Zotero = {
      Libraries: { userLibraryID: 1 },
      Searches: {
        getAllIDs: async () => [...searchesById.keys()],
        get: (id: number) => searchesById.get(id),
        getByLibraryAndKey: (_lib: number, key: string) =>
          searchesByKey.get(key) || false,
      },
      Items: {
        getAsync: async (ids: number[]) =>
          ids.map((id) => itemsById.get(id)).filter(Boolean),
      },
    };
  });

  afterEach(function () {
    if (hadZotero) (globalThis as any).Zotero = originalZotero;
    else delete (globalThis as any).Zotero;
  });

  function registerSearch(
    id: number,
    key: string,
    name: string,
    ids: number[],
  ) {
    const search: FakeSearch = { key, name, search: async () => ids };
    searchesById.set(id, search);
    searchesByKey.set(key, search);
    return search;
  }

  describe("list_saved_searches", function () {
    it("lists searches with their keys", async function () {
      registerSearch(1, "SK1", "Q1 Methods", []);
      registerSearch(2, "SK2", "To Read", []);

      const result = await executeListSavedSearches();

      assert.include(result, "Saved searches (2)");
      assert.include(result, "1. [SK1] Q1 Methods");
      assert.include(result, "2. [SK2] To Read");
      assert.include(result, "run_saved_search");
    });

    it("reports when there are none", async function () {
      assert.include(await executeListSavedSearches(), "No saved searches");
    });
  });

  describe("run_saved_search", function () {
    it("executes by key and formats the matching items", async function () {
      registerSearch(1, "SK1", "Q1 Methods", [10, 11]);
      itemsById.set(10, item("AAA", "Attention"));
      itemsById.set(11, item("BBB", "BERT"));

      const result = await executeRunSavedSearch({ searchKey: "SK1" });

      assert.include(result, 'Saved search "Q1 Methods"');
      assert.include(result, "showing 2 of 2 matches");
      assert.include(result, "[AAA] Attention");
      assert.include(result, "[BBB] BERT");
    });

    it("drops notes from the results", async function () {
      registerSearch(1, "SK1", "Mixed", [10, 11]);
      itemsById.set(10, item("AAA", "Attention"));
      itemsById.set(11, item("NOTE", "A note", true));

      const result = await executeRunSavedSearch({ searchKey: "SK1" });

      assert.include(result, "[AAA] Attention");
      assert.notInclude(result, "[NOTE]");
    });

    it("errors on an unknown key and on a blank key", async function () {
      assert.include(
        await executeRunSavedSearch({ searchKey: "MISSING" }),
        "No saved search found",
      );
      assert.include(
        await executeRunSavedSearch({ searchKey: "  " }),
        "searchKey is required",
      );
    });

    it("reports an empty result set without erroring", async function () {
      registerSearch(1, "SK1", "Empty", []);

      assert.include(
        await executeRunSavedSearch({ searchKey: "SK1" }),
        "returned no items",
      );
    });
  });
});
