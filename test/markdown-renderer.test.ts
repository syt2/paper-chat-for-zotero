import { assert } from "chai";
import {
  extractSourceGroupFragments,
  formatMarkdownForMessageCopy,
  renderMarkdownToElement,
  stripIncompleteTrailingToolCall,
} from "../src/modules/ui/chat-panel/MarkdownRenderer.ts";

class FakeElement {
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, (event: any) => void>();
  private value = "";

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {}

  get textContent(): string {
    return this.value;
  }

  set textContent(value: string) {
    this.value = value;
    if (value === "") {
      this.children.length = 0;
    }
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.set(type, listener);
  }

  dispatch(type: string): void {
    this.listeners.get(type)?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
  }
}

class FakeDocument {
  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }
}

describe("markdown renderer source groups", function () {
  it("extracts source-group fragments while preserving surrounding markdown", function () {
    const fragments = extractSourceGroupFragments(`
Intro paragraph.

<source-group label="Paper A" type="paper">
- Finds strong gains on retrieval tasks.
</source-group>

Transition text.

<source-group label="Lab notes" type="note" key="MISJCTQ9">
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
    assert.equal(secondGroup.key, "MISJCTQ9");
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

  it("renders only explicit note keys as single-line clickable headers", async function () {
    const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
    (globalThis as { Zotero?: unknown }).Zotero = {
      getMainWindow: () => null,
    };
    const doc = new FakeDocument();
    const root = new FakeElement(doc, "div");
    const clickedKeys: string[] = [];
    const errors: Error[] = [];
    const options = {
      sourceGroupAction: {
        title: "Open note",
        getTargetKey: (group: { key?: string }) => group.key || null,
        onClick: async (key: string) => {
          clickedKeys.push(key);
        },
        onError: (error: Error) => errors.push(error),
      },
    };

    try {
      renderMarkdownToElement(
        root as unknown as HTMLElement,
        '<source-group label="MISJCTQ9" type="note"></source-group>',
        "message-1",
        options,
      );
      assert.equal(root.children[0]?.children[0]?.tagName, "div");

      renderMarkdownToElement(
        root as unknown as HTMLElement,
        '<source-group label="A very long note title" type="note" key="MISJCTQ9"></source-group>',
        "message-1",
        options,
      );
      const header = root.children[0]?.children[0];
      const label = header?.children[1];
      assert.equal(header?.tagName, "button");
      assert.equal(label?.style.minWidth, "0");
      assert.equal(label?.style.whiteSpace, "nowrap");
      assert.equal(label?.style.overflow, "hidden");
      assert.equal(label?.style.textOverflow, "ellipsis");
      assert.equal(header?.style.boxSizing, "border-box");
      assert.equal(header?.style.padding, "16px 10px");

      header?.dispatch("click");
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(clickedKeys, ["MISJCTQ9"]);
      assert.deepEqual(errors, []);

      options.sourceGroupAction.onClick = async () => {
        throw new Error("open failed");
      };
      header?.dispatch("click");
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(errors[0]?.message, "open failed");
    } finally {
      (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    }
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

describe("markdown message copy", function () {
  it("keeps normal markdown content unchanged", function () {
    const content = `# Summary

- First point
- Second point

\`\`\`ts
const value = 1;
\`\`\``;

    assert.equal(formatMarkdownForMessageCopy(content), content);
  });

  it("omits tool-call cards from copied markdown", function () {
    const content = `Before

<tool-call status="completed">
<tool-name>done search_paper_content</tool-name>
<tool-args>{&quot;query&quot;:&quot;attention&quot;}</tool-args>
<tool-status>completed</tool-status>
<tool-result>Found passages.</tool-result>
</tool-call>

After`;

    const copied = formatMarkdownForMessageCopy(content);

    assert.equal(copied, "Before\n\nAfter");
    assert.notInclude(copied, "Tool Call");
    assert.notInclude(copied, "search_paper_content");
    assert.notInclude(copied, "<tool-call");
  });

  it("serializes source groups to markdown headings", function () {
    const content = `<source-group label="Paper A" type="paper">
- Relevant result.
</source-group>`;

    const copied = formatMarkdownForMessageCopy(content);

    assert.equal(copied, "### Paper: Paper A\n\n- Relevant result.");
  });

  it("includes reasoning before the visible answer content", function () {
    const copied = formatMarkdownForMessageCopy("Final answer.", {
      reasoning: "Hidden thinking details.",
    });

    assert.equal(
      copied,
      "## Thinking\n\nHidden thinking details.\n\nFinal answer.",
    );
  });
});
