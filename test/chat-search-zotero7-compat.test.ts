import { assert } from "chai";
import {
  createNativeGraphemeSegmenter,
  iterateGraphemeSegments,
} from "../src/modules/chat/search/SearchProjection";

describe("Zotero 7 chat search compatibility", function () {
  it("does not construct a native segmenter when the runtime lacks it", function () {
    assert.isNull(createNativeGraphemeSegmenter(() => undefined));
  });

  it("preserves modern grapheme clusters in the fallback", function () {
    assert.deepEqual(
      Array.from(iterateGraphemeSegments("e\u0301 👩🏽‍🔬 🇨🇳 क्‍ष 가", null)),
      [
        { segment: "e\u0301", index: 0 },
        { segment: " ", index: 2 },
        { segment: "👩🏽‍🔬", index: 3 },
        { segment: " ", index: 10 },
        { segment: "🇨🇳", index: 11 },
        { segment: " ", index: 15 },
        { segment: "क्‍ष", index: 16 },
        { segment: " ", index: 20 },
        { segment: "가", index: 21 },
      ],
    );
  });
});
