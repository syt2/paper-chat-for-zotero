import { assert } from "chai";
import { applyExtraRequestBody } from "../src/modules/providers/OpenAICompatibleProvider.ts";

describe("OpenAI-compatible extra request body", function () {
  it("merges provider and model extra body while preserving protected fields", function () {
    const requestBody: Record<string, unknown> = {
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      temperature: 0.7,
      max_tokens: 8192,
      tools: [{ type: "function", function: { name: "search" } }],
      tool_choice: "auto",
    };

    applyExtraRequestBody(requestBody, {
      defaultModel: "gpt-5",
      extraRequestBody: {
        reasoning_effort: "low",
        max_tokens: 2048,
        temperature: 1.5,
        stream: false,
        model: "other-model",
        messages: [],
        tools: [],
        tool_choice: "none",
      },
      modelExtraRequestBody: {
        "gpt-5": {
          reasoning_effort: "high",
          reasoning: { effort: "high" },
          top_p: 0.9,
        },
        "gpt-5-mini": {
          reasoning_effort: "medium",
        },
      },
    });

    assert.equal(requestBody.model, "gpt-5");
    assert.deepEqual(requestBody.messages, [{ role: "user", content: "hello" }]);
    assert.equal(requestBody.stream, true);
    assert.deepEqual(requestBody.tools, [
      { type: "function", function: { name: "search" } },
    ]);
    assert.equal(requestBody.tool_choice, "auto");
    assert.equal(requestBody.max_tokens, 8192);
    assert.equal(requestBody.temperature, 0.7);
    assert.equal(requestBody.reasoning_effort, "high");
    assert.deepEqual(requestBody.reasoning, { effort: "high" });
    assert.equal(requestBody.top_p, 0.9);
  });
});
