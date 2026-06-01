import { assert } from "chai";
import {
  extractSourceGroupFragments,
  stripIncompleteTrailingToolCall,
} from "../src/modules/ui/chat-panel/MarkdownRenderer.ts";

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

describe("markdown renderer tool-call streaming", function () {
  const completedToolCall = `
<tool-call status="completed">
<tool-name>done search_paper_content</tool-name>
<tool-args>query=&quot;positional encoding&quot;</tool-args>
<tool-status>completed</tool-status>
<tool-result>Found relevant passages.</tool-result>
</tool-call>
`;

  it("keeps complete tool-call blocks while hiding the trailing draft", function () {
    const content = `Intro
${completedToolCall}
<tool-call status="calling">
<tool-name>calling search_paper_content</tool-name>
<tool-args>query=&quot;encoder decoder`;

    const stable = stripIncompleteTrailingToolCall(content);

    assert.include(stable, "Intro");
    assert.include(stable, completedToolCall.trim());
    assert.notInclude(stable, "encoder decoder");
    assert.notInclude(stable, '<tool-call status="calling">');
  });

  it("returns complete consecutive tool-call blocks unchanged", function () {
    const secondToolCall = `
<tool-call status="completed">
<tool-name>done search_paper_content</tool-name>
<tool-args>query=&quot;encoder decoder attention&quot;</tool-args>
<tool-status>completed</tool-status>
<tool-result>Found more relevant passages.</tool-result>
</tool-call>
`;

    const content = `${completedToolCall}${secondToolCall}`;

    assert.equal(stripIncompleteTrailingToolCall(content), content);
  });

  it("hides a standalone incomplete tool-call draft", function () {
    const content = `
<tool-call status="calling">
<tool-name>calling search_paper_content</tool-name>`;

    assert.equal(stripIncompleteTrailingToolCall(content), "\n");
  });
});
