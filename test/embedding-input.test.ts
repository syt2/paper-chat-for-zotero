import { assert } from "chai";
import {
  normalizeEmbeddingBatch,
  normalizeEmbeddingInput,
  tryNormalizeEmbeddingInput,
} from "../src/modules/embedding/EmbeddingInput";

describe("embedding input normalization", function () {
  it("trims non-empty embedding input", function () {
    assert.equal(normalizeEmbeddingInput("  hello\n"), "hello");
  });

  it("rejects empty embedding input before hitting provider APIs", function () {
    assert.throws(
      () => normalizeEmbeddingInput(" \n\t"),
      /Embedding input at index 0 is empty/,
    );
    assert.isNull(tryNormalizeEmbeddingInput(""));
  });

  it("truncates long embedding input to provider-safe length", function () {
    const normalized = normalizeEmbeddingInput("x".repeat(9000));

    assert.lengthOf(normalized, 8192);
  });

  it("normalizes every batch input with the original failing index", function () {
    assert.throws(
      () => normalizeEmbeddingBatch(["valid", "  "]),
      /Embedding input at index 1 is empty/,
    );
  });
});
