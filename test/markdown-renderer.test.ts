import { assert } from "chai";
import { extractSourceGroupFragments } from "../src/modules/ui/chat-panel/MarkdownRenderer.ts";

describe("markdown renderer source groups", function () {
  it("extracts source-group fragments while preserving surrounding markdown", function () {
    const fragments = extractSourceGroupFragments(`
Intro paragraph.

<source-group label="Paper A" type="paper">
- Finds strong gains on retrieval tasks.
</source-group>

Transition text.

<source-group label="Lab notes" type="note">
- Notes mention the ablation is limited.
</source-group>

Closing sentence.
`);

    assert.deepEqual(
      fragments.map((fragment) => fragment.kind),
      ["markdown", "source-group", "markdown", "source-group", "markdown"],
    );

    const firstGroup = fragments[1];
    if (firstGroup.kind !== "source-group") {
      assert.fail("expected first extracted fragment to be a source-group");
    }
    assert.equal(firstGroup.label, "Paper A");
    assert.equal(firstGroup.type, "paper");
    assert.include(firstGroup.content, "retrieval tasks");

    const secondGroup = fragments[3];
    if (secondGroup.kind !== "source-group") {
      assert.fail("expected second extracted fragment to be a source-group");
    }
    assert.equal(secondGroup.label, "Lab notes");
    assert.equal(secondGroup.type, "note");
  });

  it("leaves malformed source-group markup as normal markdown", function () {
    const fragments = extractSourceGroupFragments(`
<source-group type="paper">
Missing label should not be parsed.
</source-group>
`);

    assert.lengthOf(fragments, 1);
    assert.equal(fragments[0]?.kind, "markdown");
    assert.include(fragments[0]?.content || "", "Missing label");
  });

  it("accepts source-group attributes with surrounding whitespace", function () {
    const fragments = extractSourceGroupFragments(`
<source-group label = "Paper B" type = "web">
- Finds an external replication result.
</source-group>
`);

    assert.lengthOf(fragments, 1);
    assert.equal(fragments[0]?.kind, "source-group");
    if (fragments[0]?.kind !== "source-group") {
      assert.fail("expected whitespace-tolerant source-group parsing");
    }
    assert.equal(fragments[0].label, "Paper B");
    assert.equal(fragments[0].type, "web");
  });
});
