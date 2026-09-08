import { assert } from "chai";
import { captureTranslationContext } from "../src/modules/ui/SelectionTranslationContext";

describe("selection translation context snapshot", function () {
  function fixture(selected = "target") {
    const layer = {};
    const start = { parentElement: { closest: () => layer } };
    const end = { parentElement: { closest: () => layer } };
    const calls: unknown[] = [];
    const doc = {
      getSelection: () => ({
        rangeCount: 1,
        toString: () => selected,
        getRangeAt: () => ({
          startContainer: start,
          startOffset: 2,
          endContainer: end,
          endOffset: 5,
        }),
      }),
      createRange: () => {
        let text = "";
        return {
          selectNodeContents: (value: unknown) => {
            assert.strictEqual(value, layer);
          },
          setEnd: (node: unknown, offset: number) => {
            calls.push([node, offset]);
            text = "preceding target occurrence";
          },
          setStart: (node: unknown, offset: number) => {
            calls.push([node, offset]);
            text = "following target occurrence";
          },
          toString: () => text,
        };
      },
    } as unknown as Document;
    return { doc, calls, start, end };
  }

  it("extracts around actual range boundaries rather than another matching occurrence", function () {
    const { doc, calls, start, end } = fixture();
    assert.deepEqual(captureTranslationContext(doc, "target", " Paper "), {
      paperTitle: "Paper",
      before: "preceding target occurrence",
      after: "following target occurrence",
    });
    assert.deepEqual(calls, [
      [start, 2],
      [end, 5],
    ]);
  });

  it("omits neighboring text if PDF.js has changed the selection", function () {
    const { doc, calls } = fixture("different passage");
    assert.deepEqual(captureTranslationContext(doc, "target", "Paper"), {
      paperTitle: "Paper",
    });
    assert.isEmpty(calls);
  });

  it("falls back to title-only context when selection is unavailable", function () {
    const doc = {
      getSelection: () => {
        throw new Error("detached");
      },
    } as unknown as Document;
    assert.deepEqual(captureTranslationContext(doc, "target", "Paper"), {
      paperTitle: "Paper",
    });
  });
});
