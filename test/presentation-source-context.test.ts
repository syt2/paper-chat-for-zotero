import { assert } from "chai";
import { resolvePresentationSourceItemKey } from "../src/modules/presentation/PresentationSourceContext.ts";

describe("presentation source context", function () {
  let originalZotero: unknown;

  beforeEach(function () {
    originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
  });

  afterEach(function () {
    (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
  });

  it("keeps explicit and session-bound papers ahead of the library selection", function () {
    (globalThis as { Zotero?: unknown }).Zotero = {
      getActiveZoteroPane: () => ({
        getSelectedItems: () => [{ key: "SELECTED1" }],
      }),
    };

    assert.equal(
      resolvePresentationSourceItemKey("EXPLICIT1", "SESSION01"),
      "EXPLICIT1",
    );
    assert.equal(
      resolvePresentationSourceItemKey(undefined, "SESSION01"),
      "SESSION01",
    );
  });

  it("uses the single selected Zotero item for an empty presentation call", function () {
    (globalThis as { Zotero?: unknown }).Zotero = {
      getActiveZoteroPane: () => ({
        getSelectedItems: () => [{ key: "SBZ2M99R" }],
      }),
    };

    assert.equal(resolvePresentationSourceItemKey(undefined, null), "SBZ2M99R");
  });

  it("does not guess between multiple selected papers", function () {
    (globalThis as { Zotero?: unknown }).Zotero = {
      getActiveZoteroPane: () => ({
        getSelectedItems: () => [{ key: "PAPER001" }, { key: "PAPER002" }],
      }),
    };

    assert.isUndefined(resolvePresentationSourceItemKey(undefined, null));
  });
});
