import { assert } from "chai";
import {
  buildEditedLastTurn,
  getEditableUserPrompt,
} from "../src/modules/chat/edit-last-user-message";
import type { ChatSession } from "../src/types/chat";

describe("edit last user message", function () {
  function fixture(): ChatSession {
    return {
      id: "session",
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: null,
      messages: [
        { id: "u1", role: "user", content: "earlier", timestamp: 1 },
        {
          id: "a1",
          role: "assistant",
          content: "earlier answer",
          timestamp: 2,
        },
        {
          id: "u2",
          role: "user",
          content: "[File: notes]\nsource\n\n[Question]:\nold question",
          timestamp: 3,
          files: [{ name: "notes", content: "source", type: "text" }],
          images: [
            {
              type: "url",
              data: "https://example.org/image.png",
              mimeType: "image/png",
            },
          ],
        },
        { id: "a2", role: "assistant", content: "old answer", timestamp: 4 },
        {
          id: "tool",
          role: "tool",
          content: "old result",
          timestamp: 5,
          apiOnly: true,
        },
        {
          id: "continuation",
          role: "user",
          content: "continue",
          timestamp: 6,
          apiOnly: true,
        },
        { id: "error", role: "error", content: "old error", timestamp: 7 },
      ],
      lastRetryableErrorMessageId: "error",
    };
  }

  it("replaces only the last visible turn, preserving attachments, IDs and earlier turns", function () {
    const original = fixture();
    const next = buildEditedLastTurn(original, "u2", " new question ")!;
    assert.deepEqual(
      next.messages.map((m) => m.id),
      ["u1", "a1", "u2"],
    );
    assert.equal(
      next.messages[2].content,
      "[File: notes]\nsource\n\n[Question]:\nnew question",
    );
    assert.strictEqual(next.messages[2].files, original.messages[2].files);
    assert.strictEqual(next.messages[2].images, original.messages[2].images);
    assert.isUndefined(next.lastRetryableErrorMessageId);
    assert.lengthOf(original.messages, 7);
    assert.equal(getEditableUserPrompt(original.messages[2]), "old question");
  });

  it("rejects earlier messages, blank edits, and unchanged prompts", function () {
    for (const [id, text] of [
      ["u1", "new"],
      ["u2", " "],
      ["u2", " old question "],
    ]) {
      assert.isNull(buildEditedLastTurn(fixture(), id, text));
    }
  });

  it("invalidates a summary covering the replaced turn but preserves an earlier summary", function () {
    const session = fixture();
    session.contextSummary = {
      id: "summary",
      content: "old",
      coveredMessageIds: ["u1", "u2"],
      createdAt: 1,
      messageCountAtCreation: 4,
    };
    session.contextState = {
      summaryInProgress: false,
      lastSummaryMessageCount: 4,
    };
    assert.isUndefined(
      buildEditedLastTurn(session, "u2", "new")!.contextSummary,
    );
    assert.isUndefined(buildEditedLastTurn(session, "u2", "new")!.contextState);
    session.contextSummary.coveredMessageIds = ["u1", "a1"];
    assert.strictEqual(
      buildEditedLastTurn(session, "u2", "new")!.contextSummary,
      session.contextSummary,
    );
    // Older persisted summaries can lack explicit covered-message IDs.
    delete (session.contextSummary as Partial<typeof session.contextSummary>)
      .coveredMessageIds;
    assert.isUndefined(
      buildEditedLastTurn(session, "u2", "new")!.contextSummary,
    );
  });

  it("does not interpret attachment markers in a plain user prompt", function () {
    const user = fixture().messages[0];
    user.content = "Explain [Question]:\nliterally";
    assert.equal(getEditableUserPrompt(user), user.content);
    user.pdfContext = true;
    assert.equal(getEditableUserPrompt(user), user.content);
  });
});
