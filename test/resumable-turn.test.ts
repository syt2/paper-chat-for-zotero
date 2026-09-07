import { assert } from "chai";
import type { ChatMessage } from "../src/types/chat.ts";
import { getResumableTurn } from "../src/modules/chat/resumable-turn.ts";
import { ChatManager } from "../src/modules/chat/ChatManager.ts";

const user: ChatMessage = {
  id: "u",
  role: "user",
  content: "question",
  timestamp: 1,
};
const partial: ChatMessage = {
  id: "a",
  role: "assistant",
  content: "partial",
  streamingState: "interrupted",
  timestamp: 2,
};
const error: ChatMessage = {
  id: "e",
  role: "error",
  content: "failed",
  timestamp: 3,
};

describe("resume latest turn", function () {
  it("finds cancelled, failed and unanswered turns while ignoring hidden context", function () {
    assert.equal(getResumableTurn([user])?.targetMessageId, user.id);
    assert.equal(getResumableTurn([user, partial])?.assistantMessage, partial);
    const target = getResumableTurn([
      user,
      partial,
      { ...partial, id: "hidden", apiOnly: true },
      error,
    ]);
    assert.equal(target?.targetMessageId, error.id);
    assert.equal(target?.userMessage, user);
    assert.equal(target?.assistantMessage, partial);
    assert.equal(getResumableTurn([user, error])?.errorMessage, error);
  });

  it("does not revive older turns or offer resume for a completed/running reply", function () {
    assert.isNull(getResumableTurn([]));
    assert.isNull(getResumableTurn([error]));
    assert.isNull(
      getResumableTurn([user, { ...partial, streamingState: undefined }]),
    );
    assert.isNull(
      getResumableTurn([
        user,
        { ...partial, streamingState: "in_progress" },
        error,
      ]),
    );
    const next = { ...user, id: "next" };
    const target = getResumableTurn([user, partial, error, next]);
    assert.equal(target?.userMessage.id, next.id);
    assert.isUndefined(target?.assistantMessage);
    assert.isUndefined(target?.errorMessage);
  });

  it("rejects stale buttons and active runs, and reuses the original messages", async function () {
    const manager = Object.create(ChatManager.prototype) as any;
    const session = { id: "s", messages: [user, partial] };
    manager.currentSession = session;
    manager.activeSessionRunIds = new Map();
    manager.init = async () => {};
    manager.getSessionItem = () => null;
    const sends: any[] = [];
    manager.sendMessage = async (content: string, options: unknown) => {
      sends.push({ content, options });
      return true;
    };
    assert.isFalse(await manager.resumeLastTurn("other", partial.id));
    assert.isFalse(await manager.resumeLastTurn("s", "stale"));
    manager.activeSessionRunIds.set("s", 1);
    assert.isFalse(await manager.resumeLastTurn("s", partial.id));
    manager.activeSessionRunIds.clear();
    assert.isTrue(await manager.resumeLastTurn("s", partial.id));
    assert.lengthOf(sends, 1);
    assert.equal(sends[0].content, user.content);
    assert.equal(sends[0].options.reuseUserMessageId, user.id);
    assert.equal(sends[0].options.reuseAssistantMessageId, partial.id);
    assert.isTrue(sends[0].options.resumeFailedTurn);
    assert.deepEqual(session.messages, [user, partial]);
    session.messages.push(error);
    let retried = "";
    manager.retryFailedTurn = async (_sessionId: string, id: string) => {
      retried = id;
      return true;
    };
    assert.isTrue(await manager.resumeLastTurn("s", error.id));
    assert.equal(retried, error.id);
  });
});
