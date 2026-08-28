import { assert } from "chai";
import {
  MAX_OUTPUT_TRUNCATION_CONTINUATIONS,
  REASONING_TRUNCATION_CONTINUATION_USER_MESSAGE,
  appendOutputContinuationMessages,
  continueTruncatedOutput,
  hasUnexpectedContinuationToolProtocol,
  mergeContinuationText,
  shouldContinueTruncatedOutput,
} from "../src/modules/chat/agent-runtime/outputTruncationContinuation.ts";
import {
  OUTPUT_TRUNCATION_NOTICE,
  getOutputTruncationNotice,
} from "../src/modules/chat/agent-runtime/messages.ts";
import type { ChatMessage } from "../src/types/chat";

describe("output truncation continuation", function () {
  it("continues only useful max-token text or reasoning responses", function () {
    assert.isTrue(
      shouldContinueTruncatedOutput({
        content: "partial",
        stopReason: "max_tokens",
      }),
    );
    assert.isTrue(
      shouldContinueTruncatedOutput({
        reasoning: "still thinking",
        stopReason: "max_tokens",
      }),
    );
    assert.isFalse(
      shouldContinueTruncatedOutput({
        content: "",
        reasoning: "",
        stopReason: "max_tokens",
      }),
    );
    assert.isFalse(
      shouldContinueTruncatedOutput({
        content: "partial",
        stopReason: "end_turn",
      }),
    );
    assert.isFalse(
      shouldContinueTruncatedOutput({
        content: "partial",
        stopReason: "max_tokens",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "search", arguments: "{}" },
          },
        ],
      }),
    );
    assert.isFalse(
      shouldContinueTruncatedOutput({
        content: "partial",
        stopReason: "max_tokens",
        suppressedToolCall: true,
      }),
    );
    assert.isFalse(
      shouldContinueTruncatedOutput({
        content: "partial",
        stopReason: "max_tokens",
        incompleteToolProtocol: true,
      }),
    );
    assert.isTrue(
      hasUnexpectedContinuationToolProtocol({ suppressedToolCall: true }, 1),
    );
    assert.isTrue(
      hasUnexpectedContinuationToolProtocol(
        { incompleteToolProtocol: true },
        1,
      ),
    );
    assert.isTrue(
      hasUnexpectedContinuationToolProtocol({ stopReason: "tool_calls" }, 1),
    );
    assert.isTrue(
      hasUnexpectedContinuationToolProtocol(
        {
          toolCalls: [
            {
              id: "call-2",
              type: "function",
              function: { name: "search", arguments: "{}" },
            },
          ],
        },
        1,
      ),
    );
    assert.isTrue(
      hasUnexpectedContinuationToolProtocol(
        {
          hostedWebSearches: [
            {
              id: "hosted-search-1",
              index: 0,
              status: "completed",
            },
          ],
        },
        1,
      ),
    );
  });

  it("localizes the incomplete-output notice and falls back safely", function () {
    const runtime = globalThis as {
      addon?: {
        data: {
          locale?: {
            current: {
              formatMessagesSync: () => Array<
                { value: string | null; attributes: null } | undefined
              >;
            };
          };
        };
      };
    };
    const originalAddon = runtime.addon;

    try {
      runtime.addon = {
        data: {
          locale: {
            current: {
              formatMessagesSync: () => [
                {
                  value: "  Localized notice\n with   whitespace  ",
                  attributes: null,
                },
              ],
            },
          },
        },
      };
      assert.equal(
        getOutputTruncationNotice(),
        "\n\n> Localized notice with whitespace",
      );

      runtime.addon.data.locale!.current.formatMessagesSync = () => [];
      assert.equal(getOutputTruncationNotice(), OUTPUT_TRUNCATION_NOTICE);

      runtime.addon.data.locale!.current.formatMessagesSync = () => {
        throw new Error("locale unavailable");
      };
      assert.equal(getOutputTruncationNotice(), OUTPUT_TRUNCATION_NOTICE);
    } finally {
      runtime.addon = originalAddon;
    }
  });

  it("does not create an invalid empty assistant message for reasoning-only output", function () {
    const messages: ChatMessage[] = [];
    let id = 0;

    appendOutputContinuationMessages(
      messages,
      "",
      "partial reasoning",
      () => `message-${++id}`,
    );

    assert.lengthOf(messages, 1);
    assert.equal(messages[0].role, "user");
    assert.equal(
      messages[0].content,
      REASONING_TRUNCATION_CONTINUATION_USER_MESSAGE,
    );
    assert.isTrue(messages[0].apiOnly);
    assert.isTrue(messages[0].outputContinuation);
  });

  it("accumulates terminal output and caps continuation requests", async function () {
    const messages: ChatMessage[] = [];
    const persistedDisplays: string[] = [];
    let id = 0;
    let requestCount = 0;

    const continued = await continueTruncatedOutput({
      initialResult: {
        content: "part-0",
        stopReason: "max_tokens" as const,
      },
      displayBeforeRound: "prefix:",
      currentMessages: messages,
      generateId: () => `message-${++id}`,
      beforeContinuation: (display) => persistedDisplays.push(display),
      requestNext: async () => ({
        content: `part-${++requestCount}`,
        stopReason: "max_tokens" as const,
      }),
    });

    assert.equal(
      continued.continuationCount,
      MAX_OUTPUT_TRUNCATION_CONTINUATIONS,
    );
    assert.equal(requestCount, MAX_OUTPUT_TRUNCATION_CONTINUATIONS);
    assert.isTrue(continued.outputStillTruncated);
    assert.isFalse(continued.unexpectedToolProtocol);
    assert.equal(
      continued.accumulatedDisplay,
      "prefix:part-0part-1part-2part-3",
    );
    assert.deepEqual(persistedDisplays, [
      "prefix:part-0",
      "prefix:part-0part-1",
      "prefix:part-0part-1part-2",
    ]);
    assert.lengthOf(messages, MAX_OUTPUT_TRUNCATION_CONTINUATIONS * 2);
    assert.isTrue(messages.every((message) => message.apiOnly));
    assert.isTrue(
      messages.every((message) => message.outputContinuation === true),
    );
  });

  it("removes a long provider overlap without dropping short ordinary text", function () {
    assert.equal(
      mergeContinuationText(
        "The result is 42 and ",
        "result is 42 and it is final.",
      ),
      "The result is 42 and it is final.",
    );
    assert.equal(
      mergeContinuationText("hello ", "hello world"),
      "hello hello world",
    );
  });
});
