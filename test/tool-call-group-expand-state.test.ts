import { assert } from "chai";

describe("ToolCallGroupExpandState", function () {
  it("returns null when messageId is missing", async function () {
    const { getToolCallGroupExpandKey } = await import(
      "../src/modules/ui/chat-panel/ToolCallGroupExpandState.ts"
    );

    assert.isNull(getToolCallGroupExpandKey(undefined, 0));
    assert.isNull(getToolCallGroupExpandKey("", 0));
  });

  it("builds a stable key from messageId and groupIndex", async function () {
    const { getToolCallGroupExpandKey } = await import(
      "../src/modules/ui/chat-panel/ToolCallGroupExpandState.ts"
    );

    assert.equal(getToolCallGroupExpandKey("msg-42", 0), "msg-42#0");
    assert.equal(getToolCallGroupExpandKey("msg-42", 3), "msg-42#3");
    assert.notEqual(
      getToolCallGroupExpandKey("msg-42", 0),
      getToolCallGroupExpandKey("msg-42", 1),
    );
  });

  it("treats unknown or null keys as collapsed", async function () {
    const { isToolCallGroupExpanded, resetToolCallGroupExpandState } =
      await import("../src/modules/ui/chat-panel/ToolCallGroupExpandState.ts");
    resetToolCallGroupExpandState();

    assert.isFalse(isToolCallGroupExpanded(null));
    assert.isFalse(isToolCallGroupExpanded("never-set#0"));
  });

  it("remembers expanded groups until they are collapsed again", async function () {
    const {
      isToolCallGroupExpanded,
      setToolCallGroupExpanded,
      resetToolCallGroupExpandState,
    } = await import(
      "../src/modules/ui/chat-panel/ToolCallGroupExpandState.ts"
    );
    resetToolCallGroupExpandState();

    setToolCallGroupExpanded("msg-1#0", true);
    assert.isTrue(isToolCallGroupExpanded("msg-1#0"));

    setToolCallGroupExpanded("msg-1#0", false);
    assert.isFalse(isToolCallGroupExpanded("msg-1#0"));
  });

  it("ignores writes with a null key", async function () {
    const {
      getToolCallGroupExpandStateSize,
      setToolCallGroupExpanded,
      resetToolCallGroupExpandState,
    } = await import(
      "../src/modules/ui/chat-panel/ToolCallGroupExpandState.ts"
    );
    resetToolCallGroupExpandState();

    setToolCallGroupExpanded(null, true);
    setToolCallGroupExpanded(null, false);

    assert.equal(getToolCallGroupExpandStateSize(), 0);
  });

  it("stores only expanded entries so the map shrinks on collapse", async function () {
    const {
      getToolCallGroupExpandStateSize,
      setToolCallGroupExpanded,
      resetToolCallGroupExpandState,
    } = await import(
      "../src/modules/ui/chat-panel/ToolCallGroupExpandState.ts"
    );
    resetToolCallGroupExpandState();

    // Collapsing a key that was never expanded never adds an entry.
    setToolCallGroupExpanded("msg-1#0", false);
    assert.equal(getToolCallGroupExpandStateSize(), 0);

    // Expanding two groups adds exactly two entries.
    setToolCallGroupExpanded("msg-1#0", true);
    setToolCallGroupExpanded("msg-2#0", true);
    assert.equal(getToolCallGroupExpandStateSize(), 2);

    // Collapsing one group frees it.
    setToolCallGroupExpanded("msg-1#0", false);
    assert.equal(getToolCallGroupExpandStateSize(), 1);

    // Collapsing the remaining group returns the map to empty.
    setToolCallGroupExpanded("msg-2#0", false);
    assert.equal(getToolCallGroupExpandStateSize(), 0);
  });

  it("allows resetToolCallGroupExpandState to clear everything", async function () {
    const {
      getToolCallGroupExpandStateSize,
      setToolCallGroupExpanded,
      resetToolCallGroupExpandState,
    } = await import(
      "../src/modules/ui/chat-panel/ToolCallGroupExpandState.ts"
    );

    setToolCallGroupExpanded("msg-a#0", true);
    setToolCallGroupExpanded("msg-b#0", true);
    setToolCallGroupExpanded("msg-c#1", true);
    assert.isAtLeast(getToolCallGroupExpandStateSize(), 3);

    resetToolCallGroupExpandState();
    assert.equal(getToolCallGroupExpandStateSize(), 0);
  });
});
