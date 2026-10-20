import { assert } from "chai";
import type { ChatMessage } from "../src/types/chat";
import { HttpResponseError } from "../src/modules/providers/HttpResponseError";
import {
  buildHandoffTranscript,
  boundHandoffReplayMessage,
  isContextOverflowError,
  isHandoffEligibleError,
} from "../src/modules/providers/responses-recovery";

function httpError(status: number, body: string): HttpResponseError {
  return new HttpResponseError({ status, statusText: "", responseBody: body });
}

describe("responses recovery", function () {
  describe("classification", function () {
    it("accepts known history replay failures", function () {
      assert.isTrue(
        isHandoffEligibleError(
          httpError(
            400,
            "The `reasoning_text` in the thinking mode must be passed back to the API.",
          ),
        ),
      );
      assert.isTrue(
        isHandoffEligibleError(
          httpError(
            400,
            "Invalid type for 'input[1].content[0].logprobs': expected an array of unknown values, but got null instead.",
          ),
        ),
      );
      assert.isTrue(
        isHandoffEligibleError(
          httpError(400, "tool result does not follow an assistant tool call"),
        ),
      );
      assert.isTrue(
        isHandoffEligibleError(
          httpError(413, "maximum context length exceeded"),
        ),
      );
    });

    it("never compacts routing, quota, model, or policy errors", function () {
      for (const body of [
        "invalid api key",
        "permission denied",
        "insufficient quota",
        "billing account frozen",
        "model not found",
        "content policy violation",
        "rate limit exceeded",
      ]) {
        assert.isFalse(isHandoffEligibleError(httpError(400, body)), body);
      }
      assert.isFalse(
        isHandoffEligibleError(
          httpError(500, "reasoning_text must be passed back"),
        ),
      );
      assert.isFalse(isHandoffEligibleError(new Error("reasoning_text")));
    });

    it("detects context overflow separately", function () {
      assert.isTrue(
        isContextOverflowError(
          httpError(400, "maximum context length exceeded"),
        ),
      );
      assert.isFalse(
        isContextOverflowError(
          httpError(400, "Invalid type for 'input[1].content[0].logprobs'"),
        ),
      );
    });
  });

  describe("handoff transcript", function () {
    it("keeps the task head and recent tool context", function () {
      const messages: ChatMessage[] = [
        { id: "s", role: "system", content: "system rules", timestamp: 0 },
        {
          id: "u1",
          role: "user",
          content: "find the key result",
          timestamp: 1,
        },
        {
          id: "a1",
          role: "assistant",
          content: "I will search.",
          timestamp: 2,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search_pdf", arguments: '{"query":"result"}' },
            },
          ],
        },
        {
          id: "t1",
          role: "tool",
          content: "Table 2 shows 42 participants.",
          tool_call_id: "call_1",
          timestamp: 3,
        },
        {
          id: "u2",
          role: "user",
          content: "Now explain it.",
          timestamp: 4,
        },
      ];

      const transcript = buildHandoffTranscript(messages);

      assert.include(transcript, "SYSTEM: system rules");
      assert.include(transcript, "USER: find the key result");
      assert.include(transcript, "ASSISTANT_TOOL_CALL: search_pdf");
      assert.include(transcript, "TOOL_CALL_ID: call_1");
      assert.include(transcript, "Table 2 shows 42 participants.");
      assert.include(transcript, "USER: Now explain it.");
    });

    it("bounds the input and reports omitted history", function () {
      const messages: ChatMessage[] = [
        { id: "s", role: "system", content: "system", timestamp: 0 },
        { id: "u1", role: "user", content: "first", timestamp: 1 },
        { id: "a1", role: "assistant", content: "x".repeat(200), timestamp: 2 },
        { id: "u2", role: "user", content: "last", timestamp: 3 },
      ];

      const transcript = buildHandoffTranscript(messages, 80);

      assert.isAtMost(transcript.length, 80);
      assert.include(transcript, "SYSTEM: system");
      assert.include(transcript, "USER: first");
      assert.include(transcript, "earlier message(s) omitted");
    });

    it("bounds the replay copy of the last user message", function () {
      const bounded = boundHandoffReplayMessage("x".repeat(30_000));

      assert.include(bounded, "[... truncated ...]");
      assert.isBelow(bounded.length, 30_000);
    });
  });
});
