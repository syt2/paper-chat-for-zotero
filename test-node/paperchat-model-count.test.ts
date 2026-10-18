import { assert } from "chai";

import {
  countIntersectingPaperchatModels,
  getPaperchatLoadedModelCount,
} from "../src/modules/preferences/paperchat-model-count";

describe("PaperChat model count", function () {
  it("counts the intersection of the key and routing lists", function () {
    assert.equal(
      countIntersectingPaperchatModels(
        ["model-a", "model-b", "model-c"],
        ["model-b", "model-c", "model-d"],
      ),
      2,
    );
  });

  it("ignores duplicate ids", function () {
    assert.equal(
      countIntersectingPaperchatModels(
        ["model-a", "model-a", "model-b"],
        ["model-a", "model-b", "model-b"],
      ),
      2,
    );
  });

  it("returns zero when the lists do not overlap", function () {
    assert.equal(countIntersectingPaperchatModels(["model-a"], ["model-b"]), 0);
  });

  it("falls back to the relay count when routing metadata is unavailable", function () {
    assert.equal(
      getPaperchatLoadedModelCount(["model-a", "model-b"], ["model-a"], false),
      2,
    );
  });
});
