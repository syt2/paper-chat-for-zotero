import { assert } from "chai";
import type { ChatMessage } from "../src/types/chat";
import {
  FIELD_BOUNDARY_TOKEN,
  buildVisibleSearchSegments,
  createSearchSnippet,
  getAssistantSearchFastDecision,
  getMessageSearchFastDecision,
  mapNormalizedRangeToDisplayRange,
  normalizeSearchValue,
  projectMessageSearchNormalizedText,
  projectSearchDocument,
  projectSearchNormalizedText,
  projectSearchTitle,
  type SearchDocument,
  type VisibleSearchSegment,
} from "../src/modules/chat/search/SearchProjection";

function canSkipAssistantSearchProjection(
  message: ChatMessage,
  terms: readonly string[],
): boolean {
  return (
    getAssistantSearchFastDecision(message, {
      exactPhrase: terms.join(" "),
      terms,
    }) === "skip"
  );
}
import { classifyMessageMatch } from "../src/modules/chat/search/SearchQuery";

function message(
  role: ChatMessage["role"],
  content: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: `${role}-message`,
    role,
    content,
    timestamp: 1,
    ...overrides,
  };
}

function projectMessage(value: ChatMessage): SearchDocument {
  return projectSearchDocument(buildVisibleSearchSegments(value));
}

function assertFastPathParity(
  label: string,
  segments: VisibleSearchSegment[],
): void {
  assert.strictEqual(
    projectSearchNormalizedText(segments),
    projectSearchDocument(segments).normalizedText,
    label,
  );
}

function assertMessageFastPathParity(label: string, value: ChatMessage): void {
  assert.strictEqual(
    projectMessageSearchNormalizedText(value),
    projectMessage(value).normalizedText,
    label,
  );
}

describe("chat search visible projection", function () {
  describe("normalizeSearchValue", function () {
    it("applies NFKC, canonical newlines, Unicode lowercase, and whitespace collapse", function () {
      assert.equal(
        normalizeSearchValue(" \tＡ\r\nΟΣ\u2003中\u00a0\n X  "),
        "a οσ 中 x",
      );
      assert.equal(normalizeSearchValue("Straße，中文。"), "straße,中文。");
    });

    it("prevents a query from manufacturing the reserved field boundary", function () {
      assert.equal(
        normalizeSearchValue(`left${FIELD_BOUNDARY_TOKEN}right`),
        "left right",
      );
    });

    it("preserves literal punctuation, operators, and NUL", function () {
      const literal = `% _ \\ "quotes" (a OR b)\u0000`;
      assert.equal(
        normalizeSearchValue(literal),
        `% _ \\ "quotes" (a or b)\u0000`,
      );
    });
  });

  describe("projectSearchDocument", function () {
    it("uses inline, block, and protected field separators", function () {
      const document = projectSearchDocument([
        { kind: "text", text: "Alpha" },
        { kind: "code", text: "beta" },
        { kind: "text", text: "Gamma", separator: "block" },
        { kind: "fieldBoundary" },
        { kind: "text", text: "Delta" },
      ]);

      assert.equal(document.displayText, "Alpha beta\nGamma\n\nDelta");
      assert.equal(
        document.normalizedText,
        `alpha beta gamma${FIELD_BOUNDARY_TOKEN}delta`,
      );
      assert.notInclude(document.normalizedText, "gamma delta");
    });

    it("maps NFKC expansion, contraction, collapsed whitespace, and emoji by grapheme", function () {
      const document = projectSearchTitle("ﬃ e\u0301 👩🏽‍🔬");
      assert.equal(document.normalizedText, "ffi é 👩🏽‍🔬");

      const contentSpans = document.spans.filter(
        (span) => span.normalizedEnd > span.normalizedStart,
      );
      assert.deepEqual(contentSpans[0], {
        normalizedStart: 0,
        normalizedEnd: 3,
        displayStart: 0,
        displayEnd: 1,
      });
      assert.deepEqual(mapNormalizedRangeToDisplayRange(document, 1, 2), {
        start: 0,
        end: 1,
      });

      for (let index = 1; index < contentSpans.length; index += 1) {
        assert.equal(
          contentSpans[index].normalizedStart,
          contentSpans[index - 1].normalizedEnd,
        );
        assert.isAtLeast(
          contentSpans[index].displayStart,
          contentSpans[index - 1].displayEnd,
        );
      }
      assert.deepEqual(document.spans[0], {
        normalizedStart: 0,
        normalizedEnd: 0,
        displayStart: 0,
        displayEnd: 0,
      });
      assert.deepEqual(document.spans.at(-1), {
        normalizedStart: document.normalizedText.length,
        normalizedEnd: document.normalizedText.length,
        displayStart: document.displayText.length,
        displayEnd: document.displayText.length,
      });

      const whitespace = projectSearchTitle("A \r\n\t\u00a0 B");
      assert.equal(whitespace.displayText, "A \n\t\u00a0 B");
      assert.equal(whitespace.normalizedText, "a b");
      assert.deepInclude(whitespace.spans, {
        normalizedStart: 1,
        normalizedEnd: 2,
        displayStart: 1,
        displayEnd: 6,
      });
    });

    it("returns an intentionally empty but fully bounded document", function () {
      assert.deepEqual(projectSearchDocument([]), {
        displayText: "",
        normalizedText: "",
        spans: [
          {
            normalizedStart: 0,
            normalizedEnd: 0,
            displayStart: 0,
            displayEnd: 0,
          },
          {
            normalizedStart: 0,
            normalizedEnd: 0,
            displayStart: 0,
            displayEnd: 0,
          },
        ],
      });
    });
  });

  describe("projectSearchNormalizedText fast path", function () {
    it("matches the full projector for normalization, boundaries, and grapheme edge cases", function () {
      const fixtures: Array<{
        label: string;
        segments: VisibleSearchSegment[];
      }> = [
        {
          label: "NFKC expansion and Unicode lowercase",
          segments: [
            {
              kind: "text",
              text: "  ＡＢＣ ﬃ Straße ΟΣ ΟϹ 𝚶𝚺 İ e\u0301  ",
              separator: "none",
            },
          ],
        },
        {
          label: "canonical newlines and collapsed Unicode whitespace",
          segments: [
            { kind: "text", text: "\tAlpha\r\n\u2003", separator: "none" },
            { kind: "code", text: "\u00a0 Beta  " },
            { kind: "text", text: "\rGamma", separator: "block" },
          ],
        },
        {
          label: "protected and repeated field boundaries",
          segments: [
            { kind: "fieldBoundary" },
            {
              kind: "sourceText",
              text: " Selected text \n",
              separator: "none",
            },
            { kind: "fieldBoundary" },
            { kind: "fieldBoundary" },
            { kind: "text", text: "\tQuestion?  ", separator: "none" },
            { kind: "fieldBoundary" },
          ],
        },
        {
          label: "emoji, flags, modifiers, and combining marks",
          segments: [
            {
              kind: "text",
              text: "👩🏽‍🔬 🇨🇳 👍🏿 e\u0301 क्‍ष",
              separator: "none",
            },
          ],
        },
        {
          label: "Hangul compatibility Jamo normalization boundaries",
          segments: [
            {
              kind: "text",
              text: "ㅎㅏ ㄱㅏ 하",
              separator: "none",
            },
          ],
        },
        {
          label: "mixed visible segment kinds and separators",
          segments: [
            { kind: "text", text: "Heading", separator: "none" },
            { kind: "linkLabel", text: "Visible Link", separator: "block" },
            { kind: "code", text: "const Ｘ = 1;", separator: "inline" },
            { kind: "math", text: "Σ = Α + Β", separator: "block" },
            { kind: "sourceText", text: "Trusted Note", separator: "block" },
          ],
        },
        { label: "empty projection", segments: [] },
      ];

      for (const fixture of fixtures) {
        assertFastPathParity(fixture.label, fixture.segments);
      }
    });

    it("matches the full projector for selected-text and ordinary user messages", function () {
      const messages = [
        message(
          "user",
          "[PDF Content]: HIDDEN\r\n\r\n[Question]: Ｗｈａｔ does 👩🏽‍🔬 mean?",
          {
            selectedText: "  Straße\u2003ΟΣ evidence  ",
            pdfContext: true,
          },
        ),
        message("user", "Plain 🇨🇳 question with e\u0301 and\tspaces"),
        message("user", "[Question]:\n", {
          selectedText: "Selection only",
        }),
      ];

      for (const candidate of messages) {
        assertFastPathParity(
          `user message ${candidate.id}: ${candidate.content}`,
          buildVisibleSearchSegments(candidate),
        );
      }
    });

    it("matches the full projector for complex Markdown and source-group messages", function () {
      const assistant = message(
        "assistant",
        `# ＨＥＡＤＩＮＧ ΟΣ

A **bold** [Visible Link](https://secret.invalid), \`inline ﬃ code\`, $Σ=Α+Β$, and 👩🏽‍🔬.

> Quoted\u2003evidence

| Col A | Col B |
| --- | --- |
| Cell 1 | Cell 2 |

\`\`\`ts
const Ｘ = "Straße";
\`\`\`

<source-group label="Trusted Ｎｏｔｅ" type="note" key="SECRETKEY">Source **body** with e\u0301 and 🇨🇳.</source-group>

Before tool.
<tool-call status="completed"><tool-name>secret_tool</tool-name><tool-result>HIDDEN_RESULT</tool-result></tool-call>
After tool.`,
      );
      const segments = buildVisibleSearchSegments(assistant);

      assert.isAbove(segments.length, 5);
      assertFastPathParity("assistant Markdown/source-group", segments);
    });

    it("matches the canonical message projector for user field boundaries", function () {
      const messages = [
        message(
          "user",
          "[PDF Content]: HIDDEN\r\n\r\n[Question]: Ｗｈａｔ does 👩🏽‍🔬 mean?",
          {
            selectedText: "  Straße\u2003ΟΣ evidence  ",
            pdfContext: true,
          },
        ),
        message("user", "Plain 🇨🇳 question with e\u0301 and\tspaces"),
        message("user", "[Question]:\n", {
          selectedText: "Selection only",
        }),
        message("user", "[PDF Content]: hidden\n\n[Question]:\n"),
      ];

      for (const candidate of messages) {
        assertMessageFastPathParity(
          `user message ${candidate.id}: ${candidate.content}`,
          candidate,
        );
      }
    });

    it("matches the canonical message projector for assistant Markdown and source groups", function () {
      assertMessageFastPathParity(
        "assistant Markdown/source-group",
        message(
          "assistant",
          `# ＨＥＡＤＩＮＧ ΟΣ

A **bold** [Visible Link](https://secret.invalid), \`inline ﬃ code\`, $Σ=Α+Β$, and 👩🏽‍🔬.

<source-group label="Trusted Ｎｏｔｅ" type="note" key="SECRETKEY">Source **body** with e\u0301 and 🇨🇳.</source-group>

Before tool.<tool-call status="completed"><tool-result>HIDDEN</tool-result></tool-call>After tool.`,
        ),
      );
    });

    it("matches the canonical empty projection for hidden message lifecycles", function () {
      const excluded: ChatMessage[] = [
        message("user", "partial", { streamingState: "in_progress" }),
        message("assistant", "partial", { streamingState: "interrupted" }),
        message("assistant", "intermediate", {
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "search", arguments: "{}" },
            },
          ],
        }),
        message("assistant", "tool response", { tool_call_id: "call-1" }),
        message("assistant", "   "),
        message(
          "assistant",
          "⚠️ No AI provider available. Please configure a provider in Settings.",
        ),
        message("assistant", "⚠️ 没有可用的 AI 服务商，请在设置中配置。"),
        message("assistant", "paperchat-chat-error-no-provider"),
        message("user", "hidden API user", { apiOnly: true }),
        message("user", "hidden notice user", { isSystemNotice: true }),
        message("assistant", "hidden API", { apiOnly: true }),
        message("system", "hidden system"),
        message("system", "hidden notice", { isSystemNotice: true }),
        message("tool", "hidden tool"),
        message("error", "hidden error"),
      ];

      for (const candidate of excluded) {
        assertMessageFastPathParity(
          `hidden lifecycle ${candidate.role}: ${candidate.content}`,
          candidate,
        );
      }
    });
  });

  describe("buildVisibleSearchSegments", function () {
    it("indexes selected text once and only the final visible user question", function () {
      const document = projectMessage(
        message(
          "user",
          '[Selected text from PDF]:\n"Selected evidence"\n\n' +
            "[PDF Content]:\nHIDDEN FULL PAPER\n\n" +
            "[File: secret.txt]\nHIDDEN FILE\n\n" +
            "[Question]:\nWhat does this establish?",
          { selectedText: "  Selected evidence  ", pdfContext: true },
        ),
      );

      assert.equal(
        document.displayText,
        "Selected evidence\n\nWhat does this establish?",
      );
      assert.equal(
        document.normalizedText,
        `selected evidence${FIELD_BOUNDARY_TOKEN}what does this establish?`,
      );
      assert.notInclude(document.normalizedText, "hidden");
      assert.equal(document.displayText.match(/Selected evidence/g)?.length, 1);
      assert.notInclude(document.displayText, "[Question]");
      assert.notInclude(document.displayText, "[Selected");
    });

    it("never falls back to hidden context when a final question marker is empty", function () {
      const document = projectMessage(
        message("user", "[PDF Content]: secret\n\n[Question]:\n", {
          selectedText: "Visible selection",
          pdfContext: true,
        }),
      );
      assert.equal(document.normalizedText, "visible selection");
      assert.notInclude(document.displayText, "secret");
    });

    it("keeps ordinary user text when no transport marker exists", function () {
      assert.equal(
        projectMessage(message("user", "  Plain visible question  "))
          .displayText,
        "Plain visible question",
      );
    });

    it("extracts visible assistant Markdown/source text and hides transport details", function () {
      const assistant = message(
        "assistant",
        `# Heading

A **bold** [visible link](https://secret.invalid/path), ![hidden alt](https://secret.invalid/image.png), \`inline code\`, $E=mc^2$, and \\(x+1\\).

> Quoted evidence

| Col A | Col B |
| --- | --- |
| Cell 1 | Cell 2 |

\`\`\`ts
const value = 42;
\`\`\`

<div data-secret="hidden attribute">HIDDEN HTML BLOCK</div>

<source-group label="Trusted Note" type="note" key="SECRETKEY" url="https://secret.invalid/source">Source **body**</source-group>

Before tool.
<tool-call status="completed"><tool-name>secret_tool</tool-name><tool-args>{&quot;token&quot;:&quot;HIDDEN_ARG&quot;}</tool-args><tool-status>Done</tool-status><tool-result>HIDDEN_RESULT</tool-result></tool-call>
After tool.`,
        { reasoning: "HIDDEN_REASONING" },
      );
      const segments = buildVisibleSearchSegments(assistant);
      const document = projectSearchDocument(segments);

      assert.deepInclude(segments, {
        kind: "linkLabel",
        text: "visible link",
        separator: "none",
      });
      assert.deepInclude(segments, {
        kind: "code",
        text: "const value = 42;",
        separator: "block",
      });
      assert.deepInclude(segments, {
        kind: "math",
        text: "E=mc^2",
        separator: "none",
      });
      assert.include(document.displayText, "Heading\nA bold visible link");
      assert.include(document.displayText, "Quoted evidence");
      assert.include(document.displayText, "Col A\nCol B\nCell 1\nCell 2");
      assert.include(document.displayText, "Trusted Note\nSource body");
      assert.include(document.displayText, "Before tool.\nAfter tool.");

      for (const hidden of [
        "secret.invalid",
        "hidden alt",
        "hidden html block",
        "hidden attribute",
        "secretkey",
        "secret_tool",
        "hidden_arg",
        "hidden_result",
        "hidden_reasoning",
      ]) {
        assert.notInclude(document.normalizedText, hidden);
      }
    });

    it("strips incomplete trailing tool markup", function () {
      const document = projectMessage(
        message(
          "assistant",
          'Stable answer.\n<tool-call status="calling"><tool-name>HIDDEN',
        ),
      );
      assert.equal(document.normalizedText, "stable answer.");
    });

    it("excludes every non-answer lifecycle and hidden role", function () {
      const excluded: ChatMessage[] = [
        message("assistant", "partial", { streamingState: "in_progress" }),
        message("assistant", "partial", { streamingState: "interrupted" }),
        message("assistant", "intermediate", {
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "search", arguments: "{}" },
            },
          ],
        }),
        message(
          "assistant",
          "⚠️ No AI provider available. Please configure a provider in Settings.",
        ),
        message("assistant", "⚠️ 没有可用的 AI 服务商，请在设置中配置。"),
        message("assistant", "hidden API", { apiOnly: true }),
        message("system", "hidden system"),
        message("system", "hidden notice", { isSystemNotice: true }),
        message("tool", "hidden tool"),
        message("error", "hidden error"),
      ];

      for (const candidate of excluded) {
        assert.deepEqual(buildVisibleSearchSegments(candidate), []);
        assert.equal(projectMessage(candidate).normalizedText, "");
      }
    });
  });

  describe("message source prefilter", function () {
    it("proves simple ASCII user matches without crossing field boundaries", function () {
      assert.equal(
        getMessageSearchFastDecision(
          message("user", "[Question]: How does BROADMATCH affect this?", {
            selectedText: "Visible evidence",
          }),
          { exactPhrase: "broadmatch", terms: ["broadmatch"] },
        ),
        "exactMatch",
      );
      assert.equal(
        getMessageSearchFastDecision(
          message("user", "[Question]: beta", { selectedText: "alpha" }),
          { exactPhrase: "alpha beta", terms: ["alpha", "beta"] },
        ),
        "project",
      );
      assert.equal(
        getMessageSearchFastDecision(
          message("user", "[Question]: alpha---beta"),
          { exactPhrase: "alpha beta", terms: ["alpha", "beta"] },
        ),
        "project",
      );
    });

    it("skips only when an ASCII query term is absent from every visible user field", function () {
      assert.equal(
        getMessageSearchFastDecision(
          message("user", "[PDF Content]: hidden\n[Question]: visible", {
            selectedText: "selected evidence",
          }),
          { exactPhrase: "missing", terms: ["missing"] },
        ),
        "skip",
      );
      assert.equal(
        getMessageSearchFastDecision(message("tool", "visible"), {
          exactPhrase: "visible",
          terms: ["visible"],
        }),
        "skip",
      );
      assert.equal(
        getMessageSearchFastDecision(message("user", "[Question]: pa---per"), {
          exactPhrase: "paper",
          terms: ["paper"],
        }),
        "project",
      );
    });

    it("falls back for Unicode normalization and hides non-visible lifecycles", function () {
      assert.equal(
        getMessageSearchFastDecision(message("user", "Ｆｕｌｌｗｉｄｔｈ"), {
          exactPhrase: "fullwidth",
          terms: ["fullwidth"],
        }),
        "project",
      );
      assert.equal(
        getMessageSearchFastDecision(
          message("user", "visible", { streamingState: "in_progress" }),
          { exactPhrase: "visible", terms: ["visible"] },
        ),
        "skip",
      );
      assert.equal(
        getMessageSearchFastDecision(
          message("user", "visible", { apiOnly: true }),
          { exactPhrase: "visible", terms: ["visible"] },
        ),
        "skip",
      );
    });

    it("never upgrades or skips against the canonical classifier", function () {
      const query = { exactPhrase: "alpha beta", terms: ["alpha", "beta"] };
      const messages = [
        message("user", "[Question]: ALPHA BETA"),
        message("user", "[Question]: alpha---beta"),
        message("user", "[Question]: beta", { selectedText: "alpha" }),
        message("user", "[Question]: alpha only"),
        message("user", "[Question]: ＡＬＰＨＡ ＢＥＴＡ"),
      ];

      for (const candidate of messages) {
        const decision = getMessageSearchFastDecision(candidate, query);
        const category = classifyMessageMatch(
          projectMessageSearchNormalizedText(candidate),
          query,
        );
        if (decision === "skip") assert.isNull(category);
        if (decision === "exactMatch") assert.equal(category, 0);
      }
    });
  });

  describe("assistant source prefilter", function () {
    it("rejects absent common terms without hiding markup-split matches", function () {
      assert.isTrue(
        canSkipAssistantSearchProjection(
          message("assistant", "## Methods\nThe control group was stable."),
          ["missing"],
        ),
      );
      assert.isFalse(
        canSkipAssistantSearchProjection(
          message("assistant", "The pa**per** is reproducible."),
          ["paper"],
        ),
      );
      assert.isFalse(
        canSkipAssistantSearchProjection(
          message("assistant", "The pa<span>per</span> is linked."),
          ["paper"],
        ),
      );
      assert.isFalse(
        canSkipAssistantSearchProjection(
          message(
            "assistant",
            "pa<tool-call><tool-result>hidden</tool-result></tool-call>per",
          ),
          ["paper"],
        ),
      );
      assert.isFalse(
        canSkipAssistantSearchProjection(
          message("assistant", "pa![hidden](https://x.test/url)per"),
          ["paper"],
        ),
      );
      assert.isFalse(
        canSkipAssistantSearchProjection(
          message("assistant", "pa[visible](https://hidden.example)per"),
          ["pavisibleper"],
        ),
      );
      assert.isFalse(
        canSkipAssistantSearchProjection(
          message("assistant", "https://example.com/%70aper"),
          ["paper"],
        ),
      );
      assert.isFalse(
        canSkipAssistantSearchProjection(
          message(
            "assistant",
            '<source-group label="Evidence">result</source-group>',
          ),
          ["evidence"],
        ),
      );
    });

    it("falls back for entities and non-safe query terms", function () {
      assert.isFalse(
        canSkipAssistantSearchProjection(message("assistant", "caf&eacute;"), [
          "café",
        ]),
      );
      assert.isFalse(
        canSkipAssistantSearchProjection(
          message("assistant", "Use C++ here."),
          ["c++"],
        ),
      );
      assert.isFalse(
        canSkipAssistantSearchProjection(message("user", "ordinary user"), [
          "missing",
        ]),
      );
      assert.isTrue(
        canSkipAssistantSearchProjection(
          message("assistant", "partial", {
            streamingState: "in_progress",
          }),
          ["partial"],
        ),
      );
    });

    it("accepts only exact matches in the safe visible prefix", function () {
      const decide = (content: string, exactPhrase: string, terms: string[]) =>
        getAssistantSearchFastDecision(message("assistant", content), {
          exactPhrase,
          terms,
        });

      assert.equal(
        decide("## Result\nThe research method is stable.", "research method", [
          "research",
          "method",
        ]),
        "exactMatch",
      );
      assert.equal(
        decide("AT&amp;T precedes broadmatch", "broadmatch", ["broadmatch"]),
        "exactMatch",
      );
      assert.equal(decide("&#97;&#98;", "ab", ["ab"]), "exactMatch");
      assert.equal(
        decide("See [paper](https://hidden.example).", "paper", ["paper"]),
        "exactMatch",
      );
      assert.equal(
        decide("```ts\nconst research = true;\n```", "research", ["research"]),
        "project",
      );
      assert.equal(
        decide(
          '<source-group label="Evidence">research result</source-group>',
          "evidence",
          ["evidence"],
        ),
        "exactMatch",
      );
      assert.equal(
        decide("alpha appears here, then beta", "alpha beta", [
          "alpha",
          "beta",
        ]),
        "project",
      );
    });

    it("falls through when a raw match may be hidden or transformed", function () {
      const decide = (content: string, exactPhrase: string, terms: string[]) =>
        getAssistantSearchFastDecision(message("assistant", content), {
          exactPhrase,
          terms,
        });

      assert.equal(
        decide("[label](https://example.com/research)", "research", [
          "research",
        ]),
        "skip",
      );
      assert.equal(
        decide("![research](image.png)", "research", ["research"]),
        "skip",
      );
      assert.equal(
        decide("$![research](image.png)$", "research", ["research"]),
        "project",
      );
      assert.equal(
        decide("$alpha![hidden](x) beta$", "alpha beta", ["alpha", "beta"]),
        "project",
      );
      assert.equal(
        decide("`[label](research)`", "research", ["research"]),
        "project",
      );
      assert.equal(
        decide("[label](javascript:research)", "research", ["research"]),
        "project",
      );
      assert.equal(
        decide(
          `<source-group label="[label](research)">body</source-group>`,
          "research",
          ["research"],
        ),
        "project",
      );
      assert.equal(
        decide(
          `<source-group label="alpha![hidden](x) beta">body</source-group>`,
          "alpha beta",
          ["alpha", "beta"],
        ),
        "project",
      );
      assert.equal(
        decide(`![research](${"(".repeat(33)}x${")".repeat(33)})`, "research", [
          "research",
        ]),
        "project",
      );
      assert.equal(
        decide("![research](a\u0001b)", "research", ["research"]),
        "project",
      );
      assert.equal(
        decide("    [label](research)", "research", ["research"]),
        "project",
      );
      assert.equal(
        decide("```research\nconst value = 1;\n```", "research", ["research"]),
        "project",
      );
      assert.equal(
        decide("> ```research\n> body\n> ```", "research", ["research"]),
        "project",
      );
      assert.equal(
        decide("- ```research\n  body\n  ```", "research", ["research"]),
        "project",
      );
      assert.equal(
        decide("<tool-call>research</tool-call>answer", "research", [
          "research",
        ]),
        "skip",
      );
      assert.equal(
        decide(
          "pa<tool-call><tool-result>hidden</tool-result></tool-call>per",
          "paper",
          ["paper"],
        ),
        "exactMatch",
      );
      assert.equal(
        decide("The pa**per** is visible.", "paper", ["paper"]),
        "project",
      );
      assert.equal(decide("caf&eacute;", "café", ["café"]), "project");
      assert.equal(decide("Product (tm)", "tm", ["tm"]), "project");
      assert.equal(decide("`&#97;&#98;`", "ab", ["ab"]), "project");
      assert.equal(decide("    &#97;&#98;", "ab", ["ab"]), "project");
      assert.equal(decide("~~~txt\n&#97;&#98;\n~~~", "ab", ["ab"]), "project");
      assert.equal(
        decide("https://example.com/%70aper", "paper", ["paper"]),
        "project",
      );
      assert.equal(decide("12. result", "12", ["12"]), "project");
      assert.equal(
        decide("- outer\n    12. research", "12", ["12"]),
        "project",
      );
      assert.equal(
        decide("[research]: https://example.com", "research", ["research"]),
        "project",
      );
      assert.equal(
        getAssistantSearchFastDecision(
          message("assistant", "hidden research", { apiOnly: true }),
          { exactPhrase: "research", terms: ["research"] },
        ),
        "skip",
      );
      assert.equal(
        getAssistantSearchFastDecision(
          message("assistant", "hidden research", { isSystemNotice: true }),
          { exactPhrase: "research", terms: ["research"] },
        ),
        "skip",
      );
    });

    it("never contradicts the canonical projector on conservative fixtures", function () {
      const fixtures: Array<{
        value: ChatMessage;
        exactPhrase: string;
        terms: string[];
      }> = [
        {
          value: message("assistant", "plain research result"),
          exactPhrase: "research",
          terms: ["research"],
        },
        {
          value: message("assistant", "pa**per**"),
          exactPhrase: "paper",
          terms: ["paper"],
        },
        {
          value: message("assistant", "pa[visible](https://hidden.test)per"),
          exactPhrase: "pavisibleper",
          terms: ["pavisibleper"],
        },
        {
          value: message("assistant", "pa![hidden](image.png)per"),
          exactPhrase: "paper",
          terms: ["paper"],
        },
        {
          value: message("assistant", "pa<tool-call>hidden</tool-call>per"),
          exactPhrase: "paper",
          terms: ["paper"],
        },
        {
          value: message(
            "assistant",
            '<source-group label="Evidence">research</source-group>',
          ),
          exactPhrase: "evidence",
          terms: ["evidence"],
        },
        {
          value: message("assistant", "[research](https://hidden.test)"),
          exactPhrase: "research",
          terms: ["research"],
        },
        {
          value: message("assistant", "```research\nbody\n```"),
          exactPhrase: "research",
          terms: ["research"],
        },
        {
          value: message("assistant", "caf&eacute;"),
          exactPhrase: "café",
          terms: ["café"],
        },
        {
          value: message("assistant", "hidden research", { apiOnly: true }),
          exactPhrase: "research",
          terms: ["research"],
        },
      ];

      for (const fixture of fixtures) {
        const query = {
          exactPhrase: fixture.exactPhrase,
          terms: fixture.terms,
        };
        const decision = getAssistantSearchFastDecision(fixture.value, query);
        const category = classifyMessageMatch(
          projectMessage(fixture.value).normalizedText,
          query,
        );
        if (decision === "skip") assert.isNull(category);
        if (decision === "exactMatch") assert.equal(category, 0);
      }
    });

    it("preserves the one-way fast-decision invariant across Markdown syntax", function () {
      const contents = [
        "plain research result",
        "## Heading\nmethod before [paper](https://hidden.test/research)",
        "pa![hidden](https://hidden.test)per",
        "pa[visible](https://hidden.test)per",
        "pa<tool-call><tool-result>hidden</tool-result></tool-call>per",
        '<source-group label="Evidence">research **result**</source-group>',
        "pa<span data-hidden='research'></span>per",
        "<div>hidden research</div>\nvisible result",
        "caf&eacute; and research",
        "https://example.com/%70aper",
        "```research\nvisible body\n```",
        "> ```research\n> visible body\n> ```",
        "[research]: https://hidden.test\nvisible result",
        "[research\\]]: /hidden\nvisible result",
        "[research\ncontinued]: /hidden\nvisible result",
        "Product (tm) research",
        "12. ordered result",
        "The pa**per** is visible",
        "\\[literal](not-a-link) research",
        "[outer [inner](hidden)](destination) result",
      ];
      const fixedCandidates = [
        "research",
        "paper",
        "hidden",
        "visible",
        "result",
        "destination",
        "method",
        "evidence",
        "ordered",
        "missing",
        "tm",
        "12",
      ];
      const safe = /^[a-z0-9\p{Script=Han}]+$/u;

      for (const content of contents) {
        const candidateMessage = message("assistant", content);
        const canonical = projectMessage(candidateMessage).normalizedText;
        const candidates = new Set(fixedCandidates);
        for (const source of [canonical, normalizeSearchValue(content)]) {
          for (const word of source.match(/[a-z0-9\p{Script=Han}]+/gu) || []) {
            const maximum = Math.min(word.length, 6);
            for (let length = 2; length <= maximum; length += 1) {
              for (let start = 0; start <= word.length - length; start += 1) {
                candidates.add(word.slice(start, start + length));
              }
            }
          }
        }

        for (const exactPhrase of candidates) {
          if (!safe.test(exactPhrase)) continue;
          const query = { exactPhrase, terms: [exactPhrase] };
          const decision = getAssistantSearchFastDecision(
            candidateMessage,
            query,
          );
          const category = classifyMessageMatch(canonical, query);
          assert.notEqual(
            decision === "skip" && category !== null,
            true,
            `skip contradicted canonical projection for ${JSON.stringify({ content, exactPhrase, canonical })}`,
          );
          assert.notEqual(
            decision === "exactMatch" && category !== 0,
            true,
            `exactMatch contradicted canonical projection for ${JSON.stringify({ content, exactPhrase, canonical })}`,
          );
        }
      }
    });
  });

  describe("createSearchSnippet", function () {
    it("anchors the first exact phrase ahead of an earlier individual term", function () {
      const document = projectSearchTitle(
        "beta appears first, then alpha beta, then alpha again",
      );
      const result = createSearchSnippet(document, "alpha beta");
      const phraseStart = result.snippet.indexOf("alpha beta");
      assert.deepInclude(result.highlightRanges, {
        start: phraseStart,
        end: phraseStart + "alpha beta".length,
      });
      assert.deepInclude(result.highlightRanges, { start: 0, end: 4 });
    });

    it("uses a 200-grapheme window, a 60-grapheme lead, and external ellipses", function () {
      const before = "a".repeat(100);
      const after = "b".repeat(180);
      const result = createSearchSnippet(
        projectSearchTitle(`${before}TARGET${after}`),
        "target",
      );
      assert.equal(Array.from(result.snippet.slice(1, -1)).length, 200);
      assert.equal(result.snippet[0], "…");
      assert.equal(result.snippet.at(-1), "…");
      assert.equal(result.snippet.indexOf("TARGET"), 61);
      assert.deepInclude(result.highlightRanges, { start: 61, end: 67 });
    });

    it("backfills the window from the left near the document end", function () {
      const result = createSearchSnippet(
        projectSearchTitle(`${"a".repeat(220)}TARGET${"b".repeat(5)}`),
        "target",
      );
      assert.equal(Array.from(result.snippet.slice(1)).length, 200);
      assert.equal(result.snippet[0], "…");
      assert.notEqual(result.snippet.at(-1), "…");
      assert.equal(result.snippet.indexOf("TARGET"), 190);
    });

    it("snaps expanded matches and emoji to whole display graphemes", function () {
      const ligature = createSearchSnippet(projectSearchTitle("x ﬃ y"), "fi");
      assert.deepEqual(ligature.highlightRanges, [{ start: 2, end: 3 }]);

      const emoji = "👩🏽‍🔬";
      const emojiResult = createSearchSnippet(
        projectSearchTitle(`before ${emoji} after`),
        emoji,
      );
      assert.deepEqual(emojiResult.highlightRanges, [
        { start: 7, end: 7 + emoji.length },
      ]);
    });

    it("does not create an exact phrase across selected-text boundaries", function () {
      const document = projectMessage(
        message("user", "[Question]:\nright", { selectedText: "left" }),
      );
      assert.notInclude(document.normalizedText, "left right");
      const result = createSearchSnippet(document, "left right");
      assert.deepEqual(result.highlightRanges, [
        { start: 0, end: 4 },
        { start: 6, end: 11 },
      ]);
    });

    it("merges overlapping and adjacent literal highlight ranges", function () {
      const result = createSearchSnippet(projectSearchTitle("aaaa"), "aa a");
      assert.deepEqual(result.highlightRanges, [{ start: 0, end: 4 }]);
    });

    it("clips a term occurrence that crosses a snippet boundary", function () {
      const result = createSearchSnippet(
        projectSearchTitle(
          `${"x".repeat(60)}anchor${"y".repeat(131)}alphaaaa${"z".repeat(100)}`,
        ),
        "anchor alphaaaa",
      );

      assert.equal(result.snippet.indexOf("anchor"), 60);
      assert.equal(result.snippet.slice(-4), "alp…");
      assert.deepInclude(result.highlightRanges, { start: 197, end: 200 });
    });

    it("limits repeated-match span mapping to the visible snippet window", function () {
      const base = projectSearchTitle("a".repeat(1000));
      let spanPropertyReads = 0;
      const spans = base.spans.map(
        (span) =>
          new Proxy(span, {
            get(target, property, receiver) {
              if (
                typeof property === "string" &&
                (property.startsWith("normalized") ||
                  property.startsWith("display"))
              ) {
                spanPropertyReads += 1;
              }
              return Reflect.get(target, property, receiver);
            },
          }),
      );

      const result = createSearchSnippet({ ...base, spans }, "aa a");

      assert.equal(result.snippet, `${"a".repeat(200)}…`);
      assert.deepEqual(result.highlightRanges, [{ start: 0, end: 200 }]);
      assert.isBelow(spanPropertyReads, base.spans.length * 500);
    });
  });
});
