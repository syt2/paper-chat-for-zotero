/* eslint-disable mocha/max-top-level-suites -- renderer behaviors use focused suites. */
import { assert } from "chai";
import {
  extractSourceGroupFragments,
  formatMarkdownForMessageCopy,
  renderMarkdownToElement,
  stripIncompleteTrailingToolCall,
} from "../src/modules/ui/chat-panel/MarkdownRenderer.ts";
import { sanitizeSourceGroupTargets } from "../src/modules/chat/note-source-provenance.ts";
import { getMessageMarkdownRenderOptions } from "../src/modules/ui/chat-panel/MessageRenderer.ts";
import { createPdfPassageEvidenceRecord } from "../src/modules/chat/evidence/index.ts";
import { MAX_ITERATIONS_MESSAGE } from "../src/modules/chat/agent-runtime/messages.ts";

class FakeElement {
  readonly ELEMENT_NODE = 1;
  readonly TEXT_NODE = 3;
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, (event: any) => void>();
  parentNode: FakeElement | null = null;
  private value = "";

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
    readonly nodeType: number = 1,
  ) {}

  get childNodes(): FakeElement[] {
    return this.children;
  }

  get firstChild(): FakeElement | null {
    return this.children[0] || null;
  }

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
    if (child.parentNode) {
      const index = child.parentNode.children.indexOf(child);
      if (index >= 0) child.parentNode.children.splice(index, 1);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) || null;
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
  readonly body = new FakeElement(this, "body");
  readonly documentElement = this.body;

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }

  createTextNode(value: string): FakeElement {
    const node = new FakeElement(this, "#text", 3);
    node.textContent = value;
    return node;
  }
}

describe("markdown renderer source groups", function () {
  it("disables every source action until an assistant message is complete", function () {
    const markdown = {
      blockquoteAction: {
        label: "View source",
        title: "Open source",
        onClick: async () => undefined,
      },
      sourceGroupAction: {
        getTitle: () => "Open source",
        onClick: async () => undefined,
      },
      evidenceAction: {
        citationTitle: "View evidence",
        viewSourceLabel: "View source",
        onClick: async () => undefined,
      },
    };

    assert.strictEqual(
      getMessageMarkdownRenderOptions(markdown, undefined),
      markdown,
    );
    for (const streamingState of ["in_progress", "interrupted"] as const) {
      const options = getMessageMarkdownRenderOptions(markdown, streamingState);
      assert.isUndefined(options?.blockquoteAction);
      assert.isUndefined(options?.sourceGroupAction);
      assert.isUndefined(options?.evidenceAction);
    }
  });

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
<source-group label = "Paper B" type = "web" url = "https://example.com/paper" page = "7">
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
    assert.equal(fragments[0].url, "https://example.com/paper");
    assert.equal(fragments[0].page, 7);
  });

  it("accepts greater-than signs inside quoted source-group attributes", function () {
    const fragments = extractSourceGroupFragments(`
<source-group label="Accuracy > Speed" type="paper" key="PAPER123">
- Compares the two optimization goals.
</source-group>
`);

    assert.lengthOf(fragments, 1);
    assert.equal(fragments[0]?.kind, "source-group");
    if (fragments[0]?.kind !== "source-group") {
      assert.fail("expected quote-aware source-group parsing");
    }
    assert.equal(fragments[0].label, "Accuracy > Speed");
    assert.equal(fragments[0].key, "PAPER123");
  });

  it("does not reinterpret attribute-like label text as navigation targets", function () {
    const sanitized = sanitizeSourceGroupTargets(
      `<source-group label="Trusted paper type='web' url='https://evil.example/' key='FAKE1234'" type="paper" key="PAPER123">
- Grounded result.
</source-group>`,
      {
        itemKeys: new Set(["PAPER123"]),
        noteKeys: new Set(),
        annotationKeys: new Set(),
        collectionKeys: new Set(),
        webUrls: new Set(),
        itemPages: new Set(),
      },
    );
    const fragments = extractSourceGroupFragments(sanitized);

    assert.lengthOf(fragments, 1);
    assert.equal(fragments[0]?.kind, "source-group");
    if (fragments[0]?.kind !== "source-group") {
      assert.fail("expected a sanitized source group");
    }
    assert.equal(fragments[0].type, "paper");
    assert.equal(fragments[0].key, "PAPER123");
    assert.isUndefined(fragments[0].url);
  });

  it("renders only source groups with actions as single-line clickable headers", async function () {
    const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
    (globalThis as { Zotero?: unknown }).Zotero = {
      getMainWindow: () => null,
    };
    const doc = new FakeDocument();
    const root = new FakeElement(doc, "div");
    const clickedGroups: Array<{ type: string; key?: string }> = [];
    const errors: Error[] = [];
    const options = {
      sourceGroupAction: {
        getTitle: (group: { key?: string }) =>
          group.key ? "Open source" : null,
        onClick: async (group: { type: string; key?: string }) => {
          clickedGroups.push({ type: group.type, key: group.key });
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
      assert.deepEqual(clickedGroups, [{ type: "note", key: "MISJCTQ9" }]);
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

  it("passes the enclosing paper source to blockquote navigation", async function () {
    const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
    (globalThis as { Zotero?: unknown }).Zotero = {
      getMainWindow: () => null,
    };
    const doc = new FakeDocument();
    const root = new FakeElement(doc, "div");
    const clicks: Array<{ quote: string; key?: string }> = [];

    try {
      renderMarkdownToElement(
        root as unknown as HTMLElement,
        `<source-group label="Paper A" type="paper" key="PAPER123">
> A sufficiently long grounded quotation from the paper.
</source-group>`,
        "message-quote",
        {
          blockquoteAction: {
            label: "View source",
            title: "Open quote",
            onClick: async (quote, group) => {
              clicks.push({ quote, key: group?.key });
            },
          },
        },
      );

      const findAction = (node: FakeElement): FakeElement | undefined => {
        if (node.getAttribute("data-blockquote-action") === "true") {
          return node;
        }
        for (const child of node.children) {
          const found = findAction(child);
          if (found) return found;
        }
        return undefined;
      };
      const action = findAction(root);
      assert.isDefined(action);
      action?.dispatch("click");
      await Promise.resolve();

      assert.deepEqual(clicks, [
        {
          quote: "A sufficiently long grounded quotation from the paper.",
          key: "PAPER123",
        },
      ]);
    } finally {
      (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    }
  });

  describe("evidence references", function () {
    let record: NonNullable<ReturnType<typeof createPdfPassageEvidenceRecord>>;
    let secondRecord: NonNullable<
      ReturnType<typeof createPdfPassageEvidenceRecord>
    >;

    beforeEach(function () {
      record = createPdfPassageEvidenceRecord({
        itemKey: "ITEM0001",
        page: 7,
        section: "Results",
        quote: "The verified result is supported by this exact passage.",
        toolCallId: "tool-search",
        resultIndex: 1,
      })!;
      secondRecord = createPdfPassageEvidenceRecord({
        itemKey: "ITEM0001",
        page: 8,
        section: "Discussion",
        quote: "A second passage should replace the first open preview.",
        toolCallId: "tool-search",
        resultIndex: 2,
      })!;
    });

    function findByAttribute(
      node: FakeElement,
      name: string,
      value: string,
    ): FakeElement | undefined {
      if (node.getAttribute(name) === value) return node;
      for (const child of node.children) {
        const found = findByAttribute(child, name, value);
        if (found) return found;
      }
      return undefined;
    }

    it("resolves citations from message-local records and opens their preview", async function () {
      const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
      (globalThis as { Zotero?: unknown }).Zotero = {
        getMainWindow: () => null,
      };
      const doc = new FakeDocument();
      const root = new FakeElement(doc, "div");
      const opened: string[] = [];

      try {
        renderMarkdownToElement(
          root as unknown as HTMLElement,
          `Verified claim.<evidence-ref ids="${record.id}"/> Another claim.<evidence-ref ids="${secondRecord.id}"/>`,
          "message-evidence",
          {
            evidenceRecords: [record, secondRecord],
            evidenceAction: {
              citationTitle: "View evidence",
              viewSourceLabel: "View source",
              onClick: async (selected) => opened.push(selected.id),
            },
          },
        );

        const citation = findByAttribute(root, "data-evidence-ref", record.id);
        const secondCitation = findByAttribute(
          root,
          "data-evidence-ref",
          secondRecord.id,
        );
        assert.isDefined(citation);
        assert.equal(citation?.textContent, "[1]");
        citation?.dispatch("click");
        const firstCard = findByAttribute(
          doc.body,
          "data-evidence-card",
          record.id,
        );
        assert.equal(firstCard?.style.display, "block");
        assert.equal(firstCard?.style.position, "fixed");
        assert.strictEqual(firstCard?.parentNode, doc.body);

        secondCitation?.dispatch("click");
        const secondCard = findByAttribute(
          doc.body,
          "data-evidence-card",
          secondRecord.id,
        );
        const sourceAction = findByAttribute(
          doc.body,
          "data-evidence-source-action",
          secondRecord.id,
        );
        assert.equal(firstCard?.style.display, "none");
        assert.equal(citation?.getAttribute("aria-expanded"), "false");
        assert.equal(secondCard?.style.display, "block");
        assert.strictEqual(secondCard?.parentNode, doc.body);
        sourceAction?.dispatch("click");
        await Promise.resolve();
        await Promise.resolve();
        assert.deepEqual(opened, [secondRecord.id]);
      } finally {
        (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
      }
    });

    it("never renders an unknown evidence ID as a citation action", function () {
      const doc = new FakeDocument();
      const root = new FakeElement(doc, "div");
      renderMarkdownToElement(
        root as unknown as HTMLElement,
        'Claim.<evidence-ref ids="ev-ffffffffffffffff"/>',
        "message-forged-evidence",
        { evidenceRecords: [record] },
      );
      assert.isUndefined(
        findByAttribute(root, "data-evidence-ref", "ev-ffffffffffffffff"),
      );
    });

    it("copies citation numbers and an evidence appendix without raw tags", function () {
      const copied = formatMarkdownForMessageCopy(
        `Verified claim.<evidence-ref ids="${record.id}"/>`,
        { evidenceRecords: [record] },
      );
      assert.include(copied, "Verified claim.[1]");
      assert.include(copied, "### Evidence");
      assert.include(copied, record.quote);
      assert.notInclude(copied, "<evidence-ref");
      assert.notInclude(copied, record.id);
    });
  });
});

describe("markdown renderer internal settings links", function () {
  it("opens and focuses the maximum planning iterations preference", function () {
    const originalAddon = (globalThis as { addon?: unknown }).addon;
    const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
    const doc = new FakeDocument();
    const root = new FakeElement(doc, "div");
    let openedPane = "";
    let focused = false;
    let selected = false;
    let scrolled = false;
    const input = {
      focus: () => {
        focused = true;
      },
      select: () => {
        selected = true;
      },
      scrollIntoView: () => {
        scrolled = true;
      },
    };

    (globalThis as { addon?: unknown }).addon = {
      data: {
        prefs: {
          window: {
            document: {
              getElementById: (id: string) =>
                id === "pref-agent-max-planning-iterations" ? input : null,
            },
            setTimeout: (callback: () => void) => callback(),
          },
        },
      },
    };
    (globalThis as { Zotero?: unknown }).Zotero = {
      getMainWindow: () => null,
      Utilities: {
        Internal: {
          openPreferences: (pane: string) => {
            openedPane = pane;
          },
        },
      },
    };

    try {
      renderMarkdownToElement(
        root as unknown as HTMLElement,
        MAX_ITERATIONS_MESSAGE,
        undefined,
        { enableAgentMaxPlanningIterationsSettingsLink: true },
      );

      const findSettingsLink = (node: FakeElement): FakeElement | undefined => {
        if (
          node.getAttribute("data-paperchat-settings-target") ===
          "agent-max-planning-iterations"
        ) {
          return node;
        }
        for (const child of node.children) {
          const found = findSettingsLink(child);
          if (found) return found;
        }
        return undefined;
      };
      const settingsLink = findSettingsLink(root);
      assert.exists(settingsLink);
      assert.isNull(settingsLink?.getAttribute("role") || null);

      settingsLink?.dispatch("click");

      assert.equal(openedPane, "paperchat-prefpane");
      assert.isTrue(scrolled);
      assert.isTrue(focused);
      assert.isTrue(selected);
    } finally {
      (globalThis as { addon?: unknown }).addon = originalAddon;
      (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    }
  });

  it("keeps model-authored internal settings links inert", function () {
    const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
    const doc = new FakeDocument();
    const root = new FakeElement(doc, "div");
    let openCount = 0;
    (globalThis as { Zotero?: unknown }).Zotero = {
      getMainWindow: () => null,
      Utilities: {
        Internal: {
          openPreferences: () => {
            openCount++;
          },
        },
      },
    };

    try {
      renderMarkdownToElement(
        root as unknown as HTMLElement,
        "[Open citation](paperchat://preferences/agent-max-planning-iterations)",
      );
      const link = root.children[0]?.children[0];
      link?.dispatch("click");

      assert.equal(openCount, 0);
      assert.isNull(
        link?.getAttribute("data-paperchat-settings-target") || null,
      );
    } finally {
      (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    }
  });

  it("ignores a closed preferences window and focuses the reopened pane", function () {
    const originalAddon = (globalThis as { addon?: unknown }).addon;
    const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
    const originalSetTimeout = globalThis.setTimeout;
    const doc = new FakeDocument();
    const root = new FakeElement(doc, "div");
    const queuedCallbacks: Array<() => void> = [];
    let staleFocusCount = 0;
    let liveFocusCount = 0;
    const staleWindow = {
      closed: true,
      document: {
        getElementById: () => ({
          focus: () => staleFocusCount++,
          select: () => undefined,
          scrollIntoView: () => undefined,
        }),
      },
    };
    const liveInput = {
      isConnected: true,
      focus: () => liveFocusCount++,
      select: () => undefined,
      scrollIntoView: () => undefined,
    };
    const liveWindow = {
      closed: false,
      document: {
        getElementById: (id: string) =>
          id === "pref-agent-max-planning-iterations" ? liveInput : null,
      },
    };

    (globalThis as { addon?: unknown }).addon = {
      data: { prefs: { window: staleWindow } },
    };
    (globalThis as { Zotero?: unknown }).Zotero = {
      getMainWindow: () => null,
      Utilities: { Internal: { openPreferences: () => undefined } },
    };
    globalThis.setTimeout = ((callback: () => void) => {
      queuedCallbacks.push(callback);
      return 1;
    }) as typeof setTimeout;

    try {
      renderMarkdownToElement(
        root as unknown as HTMLElement,
        MAX_ITERATIONS_MESSAGE,
        undefined,
        { enableAgentMaxPlanningIterationsSettingsLink: true },
      );
      const findSettingsLink = (node: FakeElement): FakeElement | undefined => {
        if (node.getAttribute("data-paperchat-settings-target")) return node;
        for (const child of node.children) {
          const found = findSettingsLink(child);
          if (found) return found;
        }
        return undefined;
      };
      findSettingsLink(root)?.dispatch("click");
      (globalThis as any).addon.data.prefs.window = liveWindow;
      queuedCallbacks.shift()?.();

      assert.equal(staleFocusCount, 0);
      assert.equal(liveFocusCount, 1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      (globalThis as { addon?: unknown }).addon = originalAddon;
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
