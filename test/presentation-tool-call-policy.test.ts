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

function presentationLaunchCall(args: Record<string, unknown>): ToolCall {
  return {
    id: "presentation-launch-call",
    type: "function",
    function: {
      name: "request_presentation",
      arguments: JSON.stringify(args),
    },
  };
}

describe("presentation tool-call policy", function () {
  it("keeps a model-extracted page count but drops unrequested launcher defaults", function () {
    const normalized = normalizePresentationToolCall(
      presentationLaunchCall({
        slideCount: 10,
        designSystem: "paper-white-courseware",
        instructions: "为这篇论文生成10页PPT",
      }),
      "为这篇论文生成一个 10 页的 PPT",
    );

    assert.deepEqual(JSON.parse(normalized.function.arguments), {
      slideCount: 10,
    });
  });

  it("keeps explicitly requested launcher style and custom emphasis", function () {
    const userRequest =
      "为 @[Paper](library:5,key:SBZ2M99R) 生成 10 页深蓝图谱风格的 PPT，突出消融实验。";
    const normalized = normalizePresentationToolCall(
      presentationLaunchCall({
        sourceItemKey: "SBZ2M99R",
        sourceLibraryID: 5,
        slideCount: 10,
        designSystem: "deep-blue-atlas",
        instructions: "突出消融实验",
      }),
      userRequest,
    );

    assert.deepEqual(JSON.parse(normalized.function.arguments), {
      sourceItemKey: "SBZ2M99R",
      sourceLibraryID: 5,
      slideCount: 10,
      designSystem: "deep-blue-atlas",
      instructions: "突出消融实验",
    });
  });

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

  it("keeps an explicitly requested original academic preset", function () {
    const normalized = normalizePresentationToolCall(
      presentationCall({ designSystem: "deep-blue-atlas" }),
      "请用深蓝图谱风格生成 PPT。",
    );

    assert.deepEqual(JSON.parse(normalized.function.arguments), {
      designSystem: "deep-blue-atlas",
      instructions: "请用深蓝图谱风格生成 PPT。",
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

  it("drops invalid launcher suggestions instead of blocking the native dialog", function () {
    const normalized = normalizePresentationToolCall(
      presentationLaunchCall({
        sourceItemKey: "SBZ2M99R",
        sourceLibraryID: 1.5,
        slideCount: 31,
        designSystem: "not-a-bundled-style",
        instructions: "x".repeat(5_000),
      }),
      "为这篇论文生成一个 PPT。",
    );

    assert.deepEqual(JSON.parse(normalized.function.arguments), {
      sourceItemKey: "SBZ2M99R",
    });
  });

  it("keeps only bounded explicit launcher suggestions", function () {
    const userRequest = "为这篇论文生成 10 页 PPT，突出消融实验。";
    const normalized = normalizePresentationToolCall(
      presentationLaunchCall({
        sourceItemKey: "SBZ2M99R",
        sourceLibraryID: "5",
        slideCount: "10",
        designSystem: "deep-blue-atlas",
        instructions: "突出消融实验",
      }),
      userRequest,
    );

    assert.deepEqual(JSON.parse(normalized.function.arguments), {
      sourceItemKey: "SBZ2M99R",
      sourceLibraryID: 5,
      slideCount: 10,
      instructions: "突出消融实验",
    });
  });
});
