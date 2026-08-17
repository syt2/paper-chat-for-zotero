import { assert } from "chai";
import { getSingleSelectedCollection } from "../src/modules/ui/library-chat-scope-selection.ts";

function collection(name: string): Zotero.Collection {
  return { name } as Zotero.Collection;
}

describe("library chat scope selection", function () {
  it("uses the Zotero 10 plural APIs for one selected collection", function () {
    const selected = collection("Reading list");

    const result = getSingleSelectedCollection({
      getCollectionTreeRows: () => [{ isCollection: () => true }],
      getSelectedCollections: () => [selected],
      getSelectedCollection: () => {
        throw new Error("Zotero 10 singular getter must not be called");
      },
    });

    assert.strictEqual(result, selected);
  });

  it("rejects multiple selected collections", function () {
    const result = getSingleSelectedCollection({
      getCollectionTreeRows: () => [{}, {}],
      getSelectedCollections: () => [collection("A"), collection("B")],
    });

    assert.isNull(result);
  });

  it("rejects a collection mixed with a saved search", function () {
    const result = getSingleSelectedCollection({
      getCollectionTreeRows: () => [
        { isCollection: () => true },
        { isSearch: () => true },
      ],
      getSelectedCollections: () => [collection("A")],
    });

    assert.isNull(result);
  });

  it("rejects a non-collection Zotero 10 selection", function () {
    const result = getSingleSelectedCollection({
      getCollectionTreeRows: () => [{ isSearch: () => true }],
      getSelectedCollections: () => [],
    });

    assert.isNull(result);
  });

  it("keeps the Zotero 9 single-selection fallback", function () {
    const selected = collection("Legacy collection");

    const result = getSingleSelectedCollection({
      getSelectedCollection: () => selected,
    });

    assert.strictEqual(result, selected);
  });
});
