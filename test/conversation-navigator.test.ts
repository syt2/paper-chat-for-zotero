import { assert } from "chai";
import type { ChatMessage } from "../src/types/chat";
import {
  collectConversationTurns,
  shouldShowConversationNavigator,
  groupConversationTurns,
  getConversationNavigatorCapacity,
} from "../src/modules/ui/chat-panel/ConversationNavigator";

function message(
  role: ChatMessage["role"],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id: `${role}-${content}`, role, content, timestamp: 1, ...extra };
}

function rounds(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => [
    message("user", `question ${index}`),
    message("assistant", `answer ${index}`),
  ]).flat();
}

describe("conversation turn navigator", function () {
  it("uses only the available height with 24px margins and 2px gaps", function () {
    assert.equal(getConversationNavigatorCapacity(1000), 106);
    assert.equal(getConversationNavigatorCapacity(160), 12);
    assert.equal(getConversationNavigatorCapacity(0), 0);
    assert.equal(getConversationNavigatorCapacity(54), 0);
    assert.equal(getConversationNavigatorCapacity(55), 1);
    assert.equal(getConversationNavigatorCapacity(63), 1);
    assert.equal(getConversationNavigatorCapacity(64), 2);
  });

  it("groups long conversations into balanced consecutive ranges without losing any turn", function () {
    for (const count of [6, 15, 16, 100, 1000]) {
      const groups = groupConversationTurns(count, 15);
      assert.lengthOf(groups, Math.min(count, 15));
      const indices = groups.flatMap((group) =>
        Array.from(
          { length: group.end - group.start + 1 },
          (_, index) => group.start + index,
        ),
      );
      assert.deepEqual(
        indices,
        Array.from({ length: count }, (_, index) => index),
      );
      const sizes = groups.map((group) => group.end - group.start + 1);
      assert.isAtMost(Math.max(...sizes) - Math.min(...sizes), 1);
    }
    assert.deepEqual(
      groupConversationTurns(6, 15),
      Array.from({ length: 6 }, (_, index) => ({ start: index, end: index })),
    );
    assert.isEmpty(groupConversationTurns(0, 15));
    assert.isEmpty(groupConversationTurns(20, 0));
  });

  it("appears only after the sixth complete round and includes the current question", function () {
    assert.isFalse(
      shouldShowConversationNavigator(collectConversationTurns(rounds(5))),
    );
    const six = rounds(6);
    assert.isTrue(
      shouldShowConversationNavigator(collectConversationTurns(six)),
    );
    const turns = collectConversationTurns([
      ...six,
      message("user", "current"),
    ]);
    assert.lengthOf(turns, 7);
    assert.isTrue(shouldShowConversationNavigator(turns));
    assert.isFalse(turns[6].complete);
    assert.equal(turns[6].messageId, "user-current");
    assert.isFalse(
      shouldShowConversationNavigator(collectConversationTurns([])),
    );
  });

  it("does not count streaming, cancelled, failed or tool-only replies as complete", function () {
    for (const reply of [
      message("assistant", "partial", { streamingState: "in_progress" }),
      message("assistant", "cancelled", { streamingState: "interrupted" }),
      message("assistant", "", { reasoning: "thinking" }),
      message("assistant", "searching", {
        tool_calls: [
          {
            id: "call",
            type: "function",
            function: { name: "search", arguments: "{}" },
          },
        ],
      }),
      message("error", "network error"),
    ]) {
      const turns = collectConversationTurns([
        ...rounds(5),
        message("user", "sixth"),
        reply,
      ]);
      assert.isFalse(shouldShowConversationNavigator(turns), reply.content);
    }
  });

  it("keeps tool activity, system notices and hidden context out of the turn count", function () {
    const turns = collectConversationTurns([
      message("system", "paper switched", { isSystemNotice: true }),
      message("user", "real question", { id: 'opaque"id]' }),
      message("assistant", "search", {
        tool_calls: [
          {
            id: "call",
            type: "function",
            function: { name: "search", arguments: "{}" },
          },
        ],
      }),
      message("tool", "result"),
      message("user", "hidden prompt", { apiOnly: true }),
      message("assistant", "hidden output", { apiOnly: true }),
      message("assistant", "first explanation"),
      message("assistant", "final answer"),
    ]);
    assert.deepEqual(turns, [
      {
        messageId: 'opaque"id]',
        question: "real question",
        answer: "final answer",
        complete: true,
      },
    ]);
  });

  it("extracts the question from attached document context and bounds plain-text previews", function () {
    const turns = collectConversationTurns([
      message("user", "[PDF Content]: a long paper\n[Question]: What is new?"),
      message("assistant", "<img onerror=alert(1)>\n" + "answer ".repeat(100)),
      message("user", "", {
        images: [{ type: "url", data: "image", mimeType: "image/png" }],
      }),
    ]);
    assert.equal(turns[0].question, "What is new?");
    assert.isAtMost(turns[0].answer.length, 180);
    assert.include(turns[0].answer, "<img onerror=alert(1)>");
    assert.equal(turns[1].question, "");
    assert.isFalse(turns[1].complete);
  });

  it("recognizes a successfully retried reply without adding a new turn", function () {
    const turns = collectConversationTurns([
      ...rounds(5),
      message("user", "retry"),
      message("assistant", "partial", { streamingState: "interrupted" }),
      message("error", "failed"),
      message("assistant", "recovered"),
    ]);
    assert.lengthOf(turns, 6);
    assert.isTrue(shouldShowConversationNavigator(turns));
    assert.equal(turns[5].answer, "recovered");
  });
});
