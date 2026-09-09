import { assert } from "chai";
import {
  normalizeTokenUsage,
  addTokenUsage,
  parseStoredTokenUsage,
} from "../src/modules/chat/message-token-usage.ts";
import {
  parseSSEStream,
  parseSSEStreamWithToolCalling,
} from "../src/modules/providers/SSEParser.ts";

function stream(events: unknown[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events)
        controller.enqueue(
          new TextEncoder().encode("data: " + JSON.stringify(event) + "\n\n"),
        );
      controller.close();
    },
  }).getReader();
}

describe("message token usage", function () {
  it("normalizes API formats without counting cached input twice", function () {
    assert.deepEqual(
      normalizeTokenUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 80 },
      }),
      {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedInputTokens: 80,
      },
    );
    assert.deepEqual(
      normalizeTokenUsage(
        {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 10,
        },
        "anthropic",
      ),
      {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedInputTokens: 80,
      },
    );
    assert.deepEqual(
      normalizeTokenUsage(
        {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 5,
          totalTokenCount: 35,
        },
        "gemini",
      ),
      { inputTokens: 10, outputTokens: 25, totalTokens: 35 },
    );
    assert.isUndefined(normalizeTokenUsage({}));
    assert.isUndefined(
      normalizeTokenUsage({ input_tokens: -1, output_tokens: 2 }),
    );
  });

  it("persists totals and adds separate requests without estimating missing usage", function () {
    const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
    assert.deepEqual(parseStoredTokenUsage(JSON.stringify(usage)), usage);
    assert.isUndefined(parseStoredTokenUsage("{"));
    assert.deepEqual(addTokenUsage(usage, usage), {
      inputTokens: 200,
      outputTokens: 40,
      totalTokens: 240,
    });
    assert.strictEqual(addTokenUsage(usage, undefined), usage);
  });

  it("keeps cache counts optional, persists them and sums only reported hits", function () {
    const usage = normalizeTokenUsage({
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_tokens_details: { cached_tokens: 80 },
    })!;
    assert.equal(usage.cachedInputTokens, 80);
    assert.deepEqual(parseStoredTokenUsage(JSON.stringify(usage)), usage);
    assert.equal(addTokenUsage(usage, usage)?.cachedInputTokens, 160);
    const missing = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
    assert.equal(addTokenUsage(usage, missing)?.cachedInputTokens, 80);
    assert.equal(addTokenUsage(missing, usage)?.cachedInputTokens, 80);
    assert.isUndefined(addTokenUsage(missing, missing)?.cachedInputTokens);
    for (const count of [0, 80, -1, "80", null]) {
      const actual = normalizeTokenUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: count },
      })!;
      assert.equal(
        actual.cachedInputTokens,
        typeof count === "number" && count >= 0 ? count : undefined,
      );
      assert.equal(actual.totalTokens, 120);
    }
    assert.equal(
      normalizeTokenUsage(
        {
          promptTokenCount: 100,
          candidatesTokenCount: 20,
          cachedContentTokenCount: 80,
        },
        "gemini",
      )?.cachedInputTokens,
      80,
    );
  });

  it("reads usage-only OpenAI chunks once before completion", async function () {
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 80 },
    };
    const received: unknown[] = [];
    await parseSSEStream(
      stream([
        { choices: [], usage },
        { choices: [], usage },
      ]),
      "openai",
      {
        onText() {},
        onUsage: (value) => received.push(value),
        onDone: () => received.push("done"),
      },
    );
    assert.deepEqual(received, [
      {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedInputTokens: 80,
      },
      "done",
    ]);
  });

  it("combines Anthropic start and final cumulative output counts", async function () {
    const received: unknown[] = [];
    await parseSSEStreamWithToolCalling(
      stream([
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 10,
              output_tokens: 1,
              cache_read_input_tokens: 90,
            },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 20 },
        },
        { type: "message_stop" },
      ]),
      "anthropic",
      { onEvent() {}, onUsage: (usage) => received.push(usage) },
    );
    assert.deepEqual(received, [
      {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedInputTokens: 90,
      },
    ]);
  });
});
