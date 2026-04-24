import { assert } from "chai";
import { shouldIncludeReasoningContentForRequest } from "../src/modules/providers/reasoning-content.ts";

describe("DeepSeek reasoning_content request policy", function () {
  it("passes reasoning_content for DeepSeek requests", function () {
    assert.isTrue(
      shouldIncludeReasoningContentForRequest({
        providerId: "deepseek",
        modelId: "deepseek-reasoner",
        baseUrl: "https://api.deepseek.com/v1",
      }),
    );
  });

  it("passes reasoning_content for PaperChat DeepSeek-routed requests", function () {
    assert.isTrue(
      shouldIncludeReasoningContentForRequest({
        providerId: "paperchat",
        modelId: "Pro/deepseek-ai/DeepSeek-V3.2",
        baseUrl: "https://paperchat.zotero.store/v1",
      }),
    );
  });

  it("does not pass reasoning_content for PaperChat non-DeepSeek requests", function () {
    assert.isFalse(
      shouldIncludeReasoningContentForRequest({
        providerId: "paperchat",
        modelId: "Pro/openai/gpt-4.1",
        baseUrl: "https://paperchat.zotero.store/v1",
      }),
    );
  });

  it("does not pass reasoning_content for unrelated OpenAI-compatible providers", function () {
    assert.isFalse(
      shouldIncludeReasoningContentForRequest({
        providerId: "mistral",
        modelId: "mistral-large-latest",
        baseUrl: "https://api.mistral.ai/v1",
      }),
    );
  });
});
