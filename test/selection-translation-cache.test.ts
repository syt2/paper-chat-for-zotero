import { assert } from "chai";
import { SelectionTranslationCache } from "../src/modules/ui/SelectionTranslationCache.ts";

describe("selection translation cache", function () {
  it("evicts least recently used results", function () {
    const cache = new SelectionTranslationCache(2);
    cache.set("a", "A");
    cache.set("b", "B");
    assert.equal(cache.get("a"), "A");
    cache.set("c", "C");
    assert.isUndefined(cache.get("b"));
    assert.equal(cache.get("a"), "A");
  });

  it("bounds retained text and accounts for replacements", function () {
    const cache = new SelectionTranslationCache(50, 8);
    cache.set("a", "1234");
    cache.set("a", "1");
    cache.set("b", "1234");
    assert.equal(cache.get("a"), "1");
    cache.set("c", "too long for cache");
    assert.isUndefined(cache.get("c"));
    cache.set("d", "12");
    assert.isUndefined(cache.get("b"));
  });
});
