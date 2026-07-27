import { assert } from "chai";
import {
  executeLinkRelatedItems,
  executeUpdateItemMetadata,
} from "../src/modules/chat/pdf-tools/libraryExecutors.ts";

type FakeItem = {
  key: string;
  itemType: string;
  fields: Record<string, string>;
  saved: number;
  related: string[];
  isAttachment: () => boolean;
  isNote: () => boolean;
  getField: (field: string) => string;
  setField: (field: string, value: string) => void;
  saveTx: () => Promise<void>;
  save: () => Promise<void>;
  addRelatedItem: (other: FakeItem) => boolean;
  getCreators: () => Array<{ lastName?: string }>;
};

function makeItem(
  key: string,
  fields: Record<string, string> = {},
  itemType = "journalArticle",
): FakeItem {
  const item: FakeItem = {
    key,
    itemType,
    fields: { title: "A Paper", ...fields },
    saved: 0,
    related: [],
    isAttachment: () => false,
    isNote: () => false,
    getField: (field: string) => {
      if (field === "unsupportedForType") {
        throw new Error("field not valid for type");
      }
      return item.fields[field] ?? "";
    },
    setField: (field: string, value: string) => {
      item.fields[field] = value;
    },
    saveTx: async () => {
      item.saved++;
    },
    save: async () => {
      item.saved++;
    },
    addRelatedItem: (other: FakeItem) => {
      if (item.related.includes(other.key)) return false;
      item.related.push(other.key);
      return true;
    },
    getCreators: () => [{ lastName: "Shen" }],
  };
  return item;
}

describe("library curation tools", function () {
  let originalZotero: unknown;
  let hadZotero = false;
  let itemsByKey: Map<string, FakeItem>;
  let transactions: number;

  beforeEach(function () {
    hadZotero = "Zotero" in globalThis;
    originalZotero = (globalThis as any).Zotero;
    itemsByKey = new Map();
    transactions = 0;

    (globalThis as any).Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: (_lib: number, key: string) =>
          itemsByKey.get(key) || false,
      },
      DB: {
        executeTransaction: async (fn: () => Promise<void>) => {
          transactions++;
          await fn();
        },
      },
    };
  });

  afterEach(function () {
    if (hadZotero) (globalThis as any).Zotero = originalZotero;
    else delete (globalThis as any).Zotero;
  });

  describe("update_item_metadata", function () {
    it("applies changes and reports before -> after", async function () {
      const item = makeItem("AAA", { date: "2021", DOI: "" });
      itemsByKey.set("AAA", item);

      const result = await executeUpdateItemMetadata({
        itemKey: "AAA",
        fields: { date: "2022", DOI: "10.1000/xyz" },
      });

      assert.include(result, 'date: "2021" -> "2022"');
      assert.include(result, 'DOI: "" -> "10.1000/xyz"');
      assert.equal(item.fields.date, "2022");
      assert.equal(item.saved, 1);
    });

    it("rejects fields outside the whitelist without saving", async function () {
      const item = makeItem("AAA");
      itemsByKey.set("AAA", item);

      const result = await executeUpdateItemMetadata({
        itemKey: "AAA",
        fields: { itemType: "book", creators: "x" },
      });

      assert.include(result, "not editable");
      assert.include(result, "itemType");
      assert.equal(item.saved, 0);
    });

    it("skips saving when every value already matches", async function () {
      const item = makeItem("AAA", { date: "2022" });
      itemsByKey.set("AAA", item);

      const result = await executeUpdateItemMetadata({
        itemKey: "AAA",
        fields: { date: "2022" },
      });

      assert.include(result, "No changes");
      assert.equal(item.saved, 0);
    });

    it("errors on unknown item and on empty fields", async function () {
      itemsByKey.set("AAA", makeItem("AAA"));

      assert.include(
        await executeUpdateItemMetadata({
          itemKey: "GONE",
          fields: { date: "1" },
        }),
        "not found",
      );
      assert.include(
        await executeUpdateItemMetadata({ itemKey: "AAA", fields: {} }),
        "fields is required",
      );
    });
  });

  describe("link_related_items", function () {
    it("links both directions and saves every touched item", async function () {
      const a = makeItem("AAA");
      const b = makeItem("BBB");
      itemsByKey.set("AAA", a);
      itemsByKey.set("BBB", b);

      const result = await executeLinkRelatedItems({
        itemKey: "AAA",
        relatedItemKeys: ["BBB"],
      });

      assert.include(result, "1 related item(s)");
      assert.deepEqual(a.related, ["BBB"]);
      assert.deepEqual(b.related, ["AAA"]);
      assert.equal(transactions, 1);
      assert.equal(a.saved, 1);
      assert.equal(b.saved, 1);
    });

    it("skips self-links and unresolved keys", async function () {
      const a = makeItem("AAA");
      const b = makeItem("BBB");
      itemsByKey.set("AAA", a);
      itemsByKey.set("BBB", b);

      const result = await executeLinkRelatedItems({
        itemKey: "AAA",
        relatedItemKeys: ["AAA", "GONE", "BBB"],
      });

      assert.include(result, "Skipped");
      assert.deepEqual(a.related, ["BBB"]);
    });

    it("does not open a transaction when nothing could be linked", async function () {
      itemsByKey.set("AAA", makeItem("AAA"));

      const result = await executeLinkRelatedItems({
        itemKey: "AAA",
        relatedItemKeys: ["GONE"],
      });

      assert.include(result, "No relations added");
      assert.equal(transactions, 0);
    });
  });
});
