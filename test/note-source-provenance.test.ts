import { assert } from "chai";
import {
  collectTrustedGeneratedNoteKeys,
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
    const content =
      '<source-group label="A < B" type="note" key="ABCD1234">x</source-group>';

    assert.notInclude(sanitizeNoteSourceGroupKeys(content, new Set()), "key=");
    assert.include(
      sanitizeNoteSourceGroupKeys(content, new Set(["ABCD1234"])),
      'key="ABCD1234"',
    );
  });

  it("handles many incomplete source-group tags without backtracking", function () {
    const malformed = [
      "<source-group ".repeat(8_000),
      '<source-group label="' + "<source-group ".repeat(8_000),
    ].join("\n");
    const startedAt = Date.now();

    assert.equal(sanitizeNoteSourceGroupKeys(malformed, new Set()), malformed);
    assert.isBelow(Date.now() - startedAt, 250);
  });
});
