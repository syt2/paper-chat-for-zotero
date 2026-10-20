import { assert } from "chai";
import { selectChatMessagePresentations } from "../src/modules/chat/message-presentation.ts";
import type { ChatMessage } from "../src/types/chat.ts";

function message(
  id: string,
  role: ChatMessage["role"],
  streamingState?: ChatMessage["streamingState"],
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content: "",
    timestamp: 1,
    streamingState,
    ...extra,
  };
}

describe("chat message presentation", function () {
  it("attaches a failed error to an interrupted assistant", function () {
    const error = message("error", "error", undefined, { content: "failed" });
    const presentations = selectChatMessagePresentations([
      message("assistant", "assistant", "interrupted"),
      error,
    ]);

    assert.lengthOf(presentations, 1);
    assert.equal(presentations[0].message.id, "assistant");
    assert.equal(presentations[0].attachedError?.id, error.id);
  });

  it("hides a superseded error while the same assistant is retrying", function () {
    const presentations = selectChatMessagePresentations([
      message("assistant", "assistant", "in_progress"),
      message("error", "error", undefined, {
        content: "Error in input stream",
      }),
    ]);

    assert.lengthOf(presentations, 1);
    assert.equal(presentations[0].message.id, "assistant");
    assert.isUndefined(presentations[0].attachedError);
  });

  it("hides the old error when a model-switch retry has started", function () {
    const presentations = selectChatMessagePresentations([
      message("old-assistant", "assistant", "interrupted"),
      message("old-error", "error", undefined, {
        content: "Error in input stream",
      }),
      message("reroute-notice", "system", undefined, {
        content: "Switched models",
        isSystemNotice: true,
      }),
      message("retry-assistant", "assistant", "in_progress"),
    ]);

    assert.deepEqual(
      presentations.map(({ message }) => message.id),
      ["old-assistant", "reroute-notice", "retry-assistant"],
    );
    assert.lengthOf(presentations[0].attachedNotices, 0);
    assert.isUndefined(presentations[0].attachedError);
  });

  it("keeps the old error hidden if a model-switch retry fails again", function () {
    const newError = message("new-error", "error", undefined, {
      content: "New retry failed",
    });
    const presentations = selectChatMessagePresentations([
      message("old-assistant", "assistant", "interrupted"),
      message("old-error", "error", undefined, {
        content: "Old retry failed",
      }),
      message("reroute-notice", "system", undefined, {
        content: "Switched models",
        isSystemNotice: true,
      }),
      message("retry-assistant", "assistant", "interrupted"),
      newError,
    ]);

    assert.deepEqual(
      presentations.map(({ message: presented }) => presented.id),
      ["old-assistant", "reroute-notice", "retry-assistant"],
    );
    assert.isUndefined(presentations[0].attachedError);
    assert.equal(presentations[2].attachedError?.id, newError.id);
  });

  it("still shows an error that is not attached to an assistant attempt", function () {
    const presentations = selectChatMessagePresentations([
      message("user", "user"),
      message("error", "error", undefined, { content: "standalone failure" }),
    ]);

    assert.deepEqual(
      presentations.map(({ message }) => message.id),
      ["user", "error"],
    );
  });
});
