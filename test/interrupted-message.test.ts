import { assert } from "chai";
import {
  createInterruptedAssistantContextMessage,
  sanitizeInterruptedAssistantContent,
  stripPendingAndIncompleteToolCallContent,
} from "../src/modules/chat/interrupted-message.ts";
import type { ChatMessage } from "../src/types/chat.ts";

function interruptedMessage(
  content: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content,
    timestamp: 1,
    streamingState: "interrupted",
    ...overrides,
  };
}

describe("interrupted assistant context", function () {
  it("removes completed and incomplete tool cards from model-facing text", function () {
    const content = [
      "The first conclusion is stable.",
      '<tool-call status="completed">',
      "<tool-name>web_search</tool-name>",
      "<tool-result>hidden result</tool-result>",
      "</tool-call>",
      "The second conclusion started.",
      '<tool-call status="calling">',
      "<tool-name>create_note</tool-name>",
    ].join("\n");

    assert.equal(
      sanitizeInterruptedAssistantContent(content),
      "The first conclusion is stable.\nThe second conclusion started.",
    );
  });

  it("projects an interrupted reply as an ordinary assistant message without mutating storage", function () {
    const stored = interruptedMessage(
      'Visible partial.\n<tool-call status="calling"><tool-name>web_search</tool-name>',
      {
        reasoning: "private reasoning",
        tool_calls: [
          {
            id: "tool-call-1",
            type: "function",
            function: { name: "web_search", arguments: "{}" },
          },
        ],
      },
    );

    const projected = createInterruptedAssistantContextMessage(stored);

    assert.deepEqual(projected, {
      id: "assistant-1",
      role: "assistant",
      content: "Visible partial.",
      timestamp: 1,
    });
    assert.equal(stored.streamingState, "interrupted");
    assert.equal(stored.reasoning, "private reasoning");
    assert.lengthOf(stored.tool_calls || [], 1);
    assert.include(stored.content, "<tool-call");
  });

  it("omits empty, tool-only, non-interrupted, and API-only messages", function () {
    assert.isNull(
      createInterruptedAssistantContextMessage(interruptedMessage("")),
    );
    assert.isNull(
      createInterruptedAssistantContextMessage(
        interruptedMessage(
          '<tool-call status="calling"><tool-name>web_search</tool-name>',
        ),
      ),
    );
    assert.isNull(
      createInterruptedAssistantContextMessage(
        interruptedMessage("completed", { streamingState: undefined }),
      ),
    );
    assert.isNull(
      createInterruptedAssistantContextMessage(
        interruptedMessage("hidden runtime message", { apiOnly: true }),
      ),
    );
  });

  it("keeps content after a literal tool-call mention that is not a card", function () {
    const content = [
      "The renderer uses a `<tool-call` prefix for cards.",
      "Everything after this explanation must survive interruption cleanup.",
    ].join("\n");

    assert.equal(sanitizeInterruptedAssistantContent(content), content);
  });

  it("keeps prose after a literal unclosed card-opening tag", function () {
    const content = [
      'Cards are rendered as <tool-call status="calling"> tags in the UI.',
      "This explanation after the literal tag must survive cleanup.",
    ].join("\n");

    // The stray literal tag itself is dropped from the model-facing text, but
    // the surrounding prose is preserved instead of being truncated.
    assert.equal(
      sanitizeInterruptedAssistantContent(content),
      [
        "Cards are rendered as  tags in the UI.",
        "This explanation after the literal tag must survive cleanup.",
      ].join("\n"),
    );
  });

  it("keeps a trailing literal tool-call fragment followed by prose", function () {
    const content =
      "Use the <tool-call example from the docs and adapt it to your needs.";

    assert.equal(sanitizeInterruptedAssistantContent(content), content);
  });

  it("keeps a literal calling tag at the end of stored content", function () {
    const content = 'Keep this literal: <tool-call status="calling">';

    assert.equal(stripPendingAndIncompleteToolCallContent(content), content);
  });

  it("does not apply a recovery-specific length limit", function () {
    const content = "x".repeat(20_000);

    assert.equal(
      createInterruptedAssistantContextMessage(interruptedMessage(content))
        ?.content,
      content,
    );
  });
});
