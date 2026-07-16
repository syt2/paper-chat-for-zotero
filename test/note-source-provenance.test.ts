import { assert } from "chai";
import {
  collectTrustedSourceTargets,
  collectTrustedGeneratedNoteKeys,
  sanitizeSourceGroupTargets,
  sanitizeNoteSourceGroupKeys,
} from "../src/modules/chat/note-source-provenance.ts";
import type { ToolExecutionResult } from "../src/types/tool";

function createNoteResult(
  toolName: "create_note" | "append_to_note",
  noteKey: string,
): ToolExecutionResult {
  return {
    toolCall: {
      id: `tool-${toolName}`,
      type: "function",
      function: { name: toolName, arguments: "{}" },
    },
    status: "completed",
    content: `Note ${toolName === "create_note" ? "created" : "appended"} successfully!\nNote key: ${noteKey}`,
  };
}

describe("note source provenance", function () {
  it("trusts only note keys returned by successful write tools", function () {
    const trusted = collectTrustedGeneratedNoteKeys([
      createNoteResult("create_note", "MISJCTQ9"),
      {
        ...createNoteResult("append_to_note", "ABCD1234"),
        status: "failed",
      },
    ]);

    assert.deepEqual(Array.from(trusted), ["MISJCTQ9"]);
  });

  it("keeps only trusted keys on note source groups", function () {
    const content = [
      '<source-group label="Trusted" type="note" key="MISJCTQ9">ok</source-group>',
      '<source-group label="Hallucinated" type="note" key="ABCD1234">bad</source-group>',
      '<source-group label="Paper" type="paper" key="MISJCTQ9">paper</source-group>',
    ].join("\n");

    const sanitized = sanitizeNoteSourceGroupKeys(
      content,
      new Set(["MISJCTQ9"]),
    );

    assert.include(sanitized, 'type="note" key="MISJCTQ9"');
    assert.notInclude(sanitized, 'key="ABCD1234"');
    assert.notInclude(sanitized, 'type="paper" key=');
  });

  it("removes every note key when a completion has no trusted write result", function () {
    const sanitized = sanitizeNoteSourceGroupKeys(
      '<source-group label="Fake" type="note" key="MISJCTQ9">x</source-group>',
      new Set(),
    );

    assert.notInclude(sanitized, "key=");
  });

  it("sanitizes quoted labels containing angle brackets", function () {
    const content = [
      '<source-group label="A < B" type="note" key="ABCD1234">x</source-group>',
      '<source-group label="A > B" type="note" key="ABCD1234">y</source-group>',
    ].join("\n");

    assert.notInclude(sanitizeNoteSourceGroupKeys(content, new Set()), "key=");
    assert.include(
      sanitizeNoteSourceGroupKeys(content, new Set(["ABCD1234"])),
      'key="ABCD1234"',
    );
    assert.notInclude(
      sanitizeNoteSourceGroupKeys(content, new Set(["ABCD1234"])),
      "invalid-source-group",
    );
  });

  it("neutralizes many incomplete source-group tags without backtracking", function () {
    const malformed = [
      "<source-group ".repeat(8_000),
      '<source-group label="' + "<source-group ".repeat(8_000),
    ].join("\n");
    const startedAt = Date.now();

    const sanitized = sanitizeNoteSourceGroupKeys(malformed, new Set());
    assert.match(sanitized, /^<invalid-source-group/);
    assert.isBelow(Date.now() - startedAt, 250);
  });

  it("keeps only type-matched targets emitted by completed tools", function () {
    const completed: ToolExecutionResult = {
      toolCall: {
        id: "tool-sources",
        type: "function",
        function: { name: "get_annotations", arguments: "{}" },
      },
      status: "completed",
      content: "executor output",
      references: [
        { type: "item", key: "ITEM0001" },
        { type: "page", itemKey: "ITEM0001", page: 7 },
        { type: "note", key: "NOTE0001" },
        { type: "annotation", key: "ANNO0001" },
        { type: "collection", key: "COLL0001" },
        { type: "web", url: "https://example.com/evidence?a=1&b=2" },
      ],
    };
    const failed: ToolExecutionResult = {
      ...completed,
      status: "failed",
      references: [{ type: "item", key: "FAKE0001" }],
    };
    const targets = collectTrustedSourceTargets([completed, failed]);
    const content = [
      '<source-group label="Paper" type="paper" key="ITEM0001" page="7">paper</source-group>',
      '<source-group label="Wrong page" type="paper" key="ITEM0001" page="8">paper</source-group>',
      '<source-group label="Item" type="item" key="ITEM0001">item</source-group>',
      '<source-group label="Note" type="note" key="NOTE0001">note</source-group>',
      '<source-group label="Annotation" type="annotation" key="ANNO0001">annotation</source-group>',
      '<source-group label="Collection" type="collection" key="COLL0001">collection</source-group>',
      '<source-group label="Web" type="web" url="https://example.com/evidence?a=1&amp;b=2">web</source-group>',
      '<source-group label="Wrong type" type="paper" key="NOTE0001">wrong</source-group>',
      '<source-group label="Failed" type="item" key="FAKE0001">failed</source-group>',
    ].join("\n");

    const sanitized = sanitizeSourceGroupTargets(content, targets);

    assert.include(sanitized, 'type="paper" key="ITEM0001" page="7"');
    assert.include(sanitized, 'label="Wrong page" type="paper" key="ITEM0001"');
    assert.notInclude(
      sanitized,
      'label="Wrong page" type="paper" key="ITEM0001" page=',
    );
    assert.include(sanitized, 'type="item" key="ITEM0001"');
    assert.include(sanitized, 'type="note" key="NOTE0001"');
    assert.include(sanitized, 'type="annotation" key="ANNO0001"');
    assert.include(sanitized, 'type="collection" key="COLL0001"');
    assert.include(sanitized, 'url="https://example.com/evidence?a=1&amp;b=2"');
    assert.notInclude(sanitized, 'type="paper" key="NOTE0001"');
    assert.notInclude(sanitized, 'key="FAKE0001"');
  });

  it("requires a trusted item identity before accepting an item page", function () {
    const targets = collectTrustedSourceTargets([
      {
        toolCall: {
          id: "tool-page-only",
          type: "function",
          function: { name: "get_pages", arguments: "{}" },
        },
        status: "completed",
        content: "page",
        references: [{ type: "page", itemKey: "ITEM0001", page: 4 }],
      },
    ]);

    const sanitized = sanitizeSourceGroupTargets(
      '<source-group label="Page" type="paper" key="ITEM0001" page="4">x</source-group>',
      targets,
    );

    assert.notInclude(sanitized, "key=");
    assert.notInclude(sanitized, "page=");
  });

  it("parses real attributes linearly without treating label text as attributes", function () {
    const targets = collectTrustedSourceTargets([
      {
        toolCall: {
          id: "tool-note",
          type: "function",
          function: { name: "get_note_content", arguments: "{}" },
        },
        status: "completed",
        content: "note",
        references: [{ type: "note", key: "NOTE0001" }],
      },
    ]);
    const content =
      `<source-group label="A key='FAKE0001' &lt; B" ` +
      `type='note' key='NOTE0001' url='https://evil.invalid' page='9'>x</source-group>`;

    const sanitized = sanitizeSourceGroupTargets(content, targets);

    assert.include(sanitized, `label="A key='FAKE0001' &lt; B"`);
    assert.include(sanitized, `type='note' key="NOTE0001"`);
    assert.notInclude(sanitized, "evil.invalid");
    assert.notInclude(sanitized, "page=");
  });

  it("neutralizes malformed opening tags that could expose fake attributes", function () {
    const targets = collectTrustedSourceTargets([
      {
        toolCall: {
          id: "tool-note-malformed",
          type: "function",
          function: { name: "get_note_content", arguments: "{}" },
        },
        status: "completed",
        content: "note",
        references: [{ type: "note", key: "NOTE0001" }],
      },
    ]);
    const malformed =
      '<source-group label="broken key="NOTE0001" type="note">x</source-group>';

    const sanitized = sanitizeSourceGroupTargets(malformed, targets);

    assert.include(sanitized, "<invalid-source-group");
    assert.notInclude(sanitized, "<source-group");

    const unclosed =
      `<source-group label="broken type='note' key='NOTE0001'>` +
      "x</source-group>";
    const sanitizedUnclosed = sanitizeSourceGroupTargets(unclosed, targets);
    assert.include(sanitizedUnclosed, "<invalid-source-group");
    assert.notInclude(sanitizedUnclosed, "<source-group");
  });

  it("clears all navigation attributes without trusted tool results", function () {
    const content = [
      '<source-group label="Paper" type="paper" key="ITEM0001" page="2">x</source-group>',
      '<source-group label="Web" type="web" url="https://example.com/">x</source-group>',
    ].join("\n");
    const sanitized = sanitizeSourceGroupTargets(
      content,
      collectTrustedSourceTargets([]),
    );

    assert.notInclude(sanitized, "key=");
    assert.notInclude(sanitized, "page=");
    assert.notInclude(sanitized, "url=");
  });
});
