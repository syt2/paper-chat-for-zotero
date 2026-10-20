import { assert } from "chai";
import { HttpResponseError } from "../src/modules/providers/HttpResponseError";
import {
  applyReasoningReplayFallback,
  applyResponsesReasoningReplayFallback,
  isReasoningReplayRequiredError,
} from "../src/modules/providers/reasoning-request";

/**
 * The exact body DeepSeek answered for channels 93/94/76 on 2026-10-16, taken
 * from the NewAPI error log.
 */
const DEEPSEEK_400 = JSON.stringify({
  error: {
    message:
      "The `reasoning_content` in the thinking mode must be passed back to the API.",
    type: "invalid_request_error",
    code: "invalid_request_error",
  },
});

function httpError(status: number, body: string): HttpResponseError {
  return new HttpResponseError({ status, statusText: "", responseBody: body });
}

describe("reasoning replay fallback", function () {
  it("recognises the upstream's replay requirement", function () {
    assert.isTrue(isReasoningReplayRequiredError(httpError(400, DEEPSEEK_400)));
    assert.isTrue(
      isReasoningReplayRequiredError(
        httpError(
          400,
          "The `reasoning_text` in the thinking mode must be passed back to the API.",
        ),
      ),
    );
    // Anthropic-style wording names the thinking block instead.
    assert.isTrue(
      isReasoningReplayRequiredError(
        httpError(
          400,
          "thinking blocks in the last assistant message must be provided",
        ),
      ),
    );
  });

  it("leaves unrelated failures alone", function () {
    assert.isFalse(
      isReasoningReplayRequiredError(
        httpError(400, "invalid parameter: max_tokens"),
      ),
    );
    assert.isFalse(
      isReasoningReplayRequiredError(httpError(400, "model not found")),
    );
    // Status alone must never be enough, and neither must a statusless error.
    assert.isFalse(
      isReasoningReplayRequiredError(httpError(500, DEEPSEEK_400)),
    );
    assert.isFalse(isReasoningReplayRequiredError(new Error(DEEPSEEK_400)));
  });

  it("retries without thinking or its effort hint", function () {
    const body: Record<string, unknown> = {
      model: "gpt-5.6-terra",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function" }],
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      temperature: 0.7,
    };

    applyReasoningReplayFallback(body);

    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal("reasoning_effort" in body, false);
    // Everything else about the request stays exactly as it was.
    assert.equal(body.model, "gpt-5.6-terra");
    assert.equal(body.temperature, 0.7);
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
  });

  it("disables thinking and drops foreign reasoning items for Responses", function () {
    const body: Record<string, unknown> = {
      model: "gpt-6-astra",
      reasoning: { summary: "detailed" },
      input: [
        { role: "user", content: "hi" },
        { type: "reasoning", id: "rs_1", encrypted_content: "openai-only" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" },
      ],
    };

    applyResponsesReasoningReplayFallback(body);

    assert.deepEqual(body.reasoning, {
      summary: "detailed",
      effort: "none",
    });
    assert.deepEqual(body.input, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ]);
  });
});
