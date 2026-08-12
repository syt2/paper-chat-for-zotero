import { assert } from "chai";
import { normalizePresentationToolCall } from "../src/modules/presentation/PresentationToolCallPolicy.ts";
import type { ToolCall, ToolExecutionResult } from "../src/types/tool.ts";

function presentationCall(args: Record<string, unknown>): ToolCall {
  return {
    id: "presentation-call",
    type: "function",
    function: {
      name: "presentation",
      arguments: JSON.stringify(args),
    },
  };
}

describe("presentation tool-call policy", function () {
  it("removes model-invented optional arguments from a generic PPT request", function () {
    const normalized = normalizePresentationToolCall(
      presentationCall({
        sourceItemKey: "SBZ2M99R",
        language: "zh-CN",
        designSystem: "dark-editorial",
        instructions: "Six minimal English slides",
        title: "AlexNet Overview",
        fileName: "AlexNet_Overview",
      }),
      "请直接使用 presentation 工具，基于当前论文生成一份 PPT。",
    );

    assert.deepEqual(JSON.parse(normalized.function.arguments), {
      sourceItemKey: "SBZ2M99R",
    });
  });

  it("keeps preferences that the user explicitly requested", function () {
    const userRequest =
      "请用英文生成深色编辑风 PPT，标题叫 AlexNet，重点讲训练方法。";
    const normalized = normalizePresentationToolCall(
      presentationCall({
        sourceItemKey: "SBZ2M99R",
        language: "en-US",
        designSystem: "dark-editorial",
        instructions: "invented model wording",
        title: "AlexNet",
        fileName: "unrequested-name",
      }),
      userRequest,
    );

    assert.deepEqual(JSON.parse(normalized.function.arguments), {
      sourceItemKey: "SBZ2M99R",
      language: "en-US",
      designSystem: "dark-editorial",
      title: "AlexNet",
      instructions: userRequest,
    });
  });

  it("reuses the first failed attempt arguments instead of rotating styles", function () {
    const firstCall = presentationCall({ sourceItemKey: "SBZ2M99R" });
    const previousResults: ToolExecutionResult[] = [
      {
        toolCall: firstCall,
        args: { sourceItemKey: "SBZ2M99R" },
        status: "failed",
        content: "Retryable: yes",
      },
    ];

    const normalized = normalizePresentationToolCall(
      presentationCall({
        sourceItemKey: "SBZ2M99R",
        language: "en-US",
        designSystem: "dark-editorial",
        instructions: "Try a different style",
      }),
      "请为这篇论文生成 PPT。",
      previousResults,
    );

    assert.deepEqual(JSON.parse(normalized.function.arguments), {
      sourceItemKey: "SBZ2M99R",
    });
  });
});
