import { assert } from "chai";
import { normalizeToolCallingStopReason } from "../src/modules/providers/stopReason.ts";

describe("provider stop reason normalization", function () {
  it("normalizes token limits across provider protocols", function () {
    assert.equal(normalizeToolCallingStopReason("length"), "max_tokens");
    assert.equal(normalizeToolCallingStopReason("max_tokens"), "max_tokens");
    assert.equal(
      normalizeToolCallingStopReason("max_output_tokens"),
      "max_tokens",
    );
  });

  it("preserves tool endings and treats unknown terminal reasons as end turns", function () {
    assert.equal(normalizeToolCallingStopReason("tool_calls"), "tool_calls");
    assert.equal(normalizeToolCallingStopReason("tool_use"), "tool_calls");
    assert.equal(normalizeToolCallingStopReason("stop"), "stop");
    assert.equal(normalizeToolCallingStopReason("stop_sequence"), "end_turn");
    assert.equal(normalizeToolCallingStopReason(undefined), "end_turn");
  });
});
