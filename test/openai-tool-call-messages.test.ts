import { assert } from "chai";
import { sanitizeOpenAIToolCallMessages } from "../src/modules/providers/openai-tool-call-messages.ts";
import type { ChatMessage } from "../src/types/chat";

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: 1,
    ...extra,
  };
}

describe("sanitizeOpenAIToolCallMessages", function () {
  it("keeps complete assistant tool-call blocks", function () {
    const messages = [
      message("u1", "user", "search"),
      message("a1", "assistant", "", {
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "search", arguments: "{}" },
          },
        ],
      }),
      message("t1", "tool", "result", { tool_call_id: "call_1" }),
      message("a2", "assistant", "done"),
    ];

    assert.deepEqual(
      sanitizeOpenAIToolCallMessages(messages).map((item) => item.id),
      ["u1", "a1", "t1", "a2"],
    );
  });

  it("drops incomplete assistant tool-call blocks", function () {
    const messages = [
      message("u1", "user", "search"),
      message("a1", "assistant", "", {
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "search", arguments: "{}" },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      }),
      message("t1", "tool", "result", { tool_call_id: "call_1" }),
      message("a2", "assistant", "continue"),
    ];

    assert.deepEqual(
      sanitizeOpenAIToolCallMessages(messages).map((item) => item.id),
      ["u1", "a2"],
    );
  });

  it("drops orphan tool messages", function () {
    const messages = [
      message("u1", "user", "hello"),
      message("t1", "tool", "orphan", { tool_call_id: "call_1" }),
      message("a1", "assistant", "hi"),
    ];

    assert.deepEqual(
      sanitizeOpenAIToolCallMessages(messages).map((item) => item.id),
      ["u1", "a1"],
    );
  });

  it("requires tool messages to immediately follow the assistant tool call", function () {
    const messages = [
      message("u1", "user", "search"),
      message("a1", "assistant", "", {
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "search", arguments: "{}" },
          },
        ],
      }),
      message("s1", "system", "notice"),
      message("t1", "tool", "late result", { tool_call_id: "call_1" }),
      message("a2", "assistant", "done"),
    ];

    assert.deepEqual(
      sanitizeOpenAIToolCallMessages(messages).map((item) => item.id),
      ["u1", "s1", "a2"],
    );
  });

  it("drops malformed assistant tool calls without stable ids", function () {
    const messages = [
      message("u1", "user", "search"),
      message("a1", "assistant", "", {
        tool_calls: [
          {
            id: "",
            type: "function",
            function: { name: "search", arguments: "{}" },
          },
        ],
      }),
      message("a2", "assistant", "continue"),
    ];

    assert.deepEqual(
      sanitizeOpenAIToolCallMessages(messages).map((item) => item.id),
      ["u1", "a2"],
    );
  });
});
