import { assert } from "chai";
import { AgentRuntime } from "../src/modules/chat/agent-runtime/AgentRuntime.ts";
import {
  normalizeToolErrorContent,
  parseToolError,
} from "../src/modules/chat/tool-errors/ToolErrorFormatter.ts";
import { getToolPermissionManager } from "../src/modules/chat/tool-permissions/index.ts";
import { ToolScheduler } from "../src/modules/chat/tool-scheduler/ToolScheduler.ts";
import type { ChatMessage } from "../src/types/chat";
import type { ToolCall } from "../src/types/tool";

describe("tool error formatting", function () {
  afterEach(function () {
    getToolPermissionManager().setDescriptorModeOverride("create_note", null);
  });

  it("formats invalid JSON argument failures into structured recovery hints", async function () {
    const scheduler = new ToolScheduler(async () => "ok");
    const toolCall: ToolCall = {
      id: "tool-bad-json",
      type: "function",
      function: {
        name: "get_item_metadata",
        arguments: "{bad json",
      },
    };

    const result = await scheduler.execute({ toolCall, sessionId: "session-1" });

    assert.equal(result.status, "failed");
    assert.include(result.content, "Category: invalid_arguments");
    assert.include(result.content, "Retryable: yes");
    assert.include(result.content, "Suggested fix:");
  });

  it("formats denied tool calls with stable recovery guidance", async function () {
    getToolPermissionManager().setDescriptorModeOverride("create_note", "deny");
    const scheduler = new ToolScheduler(async () => "ok");
    const toolCall: ToolCall = {
      id: "tool-denied",
      type: "function",
      function: {
        name: "create_note",
        arguments: JSON.stringify({ content: "hello" }),
      },
    };

    const result = await scheduler.execute({ toolCall, sessionId: "session-1" });

    assert.equal(result.status, "denied");
    assert.include(result.content, "Category: permission_denied");
    assert.include(result.content, "Retryable: no");
    assert.include(result.content, "Do not retry this tool");
  });

  it("normalizes raw executor errors into structured confirmation hints", async function () {
    const scheduler = new ToolScheduler(async () => {
      return "Error: You must set confirm=true to use this tool. This tool returns the entire paper content and consumes many tokens.";
    });
    const toolCall: ToolCall = {
      id: "tool-confirm",
      type: "function",
      function: {
        name: "get_full_text",
        arguments: JSON.stringify({ itemKey: "ITEM-1" }),
      },
    };

    const result = await scheduler.execute({ toolCall, sessionId: "session-1" });
    const parsed = parseToolError(result.content);

    assert.equal(result.status, "failed");
    assert.equal(parsed?.category, "confirmation_required");
    assert.include(parsed?.suggestedFix || "", "confirm");
    assert.include(parsed?.saferAlternative || "", "get_paper_section");
  });

  it("adds structured fix guidance into the recovery system message", function () {
    const runtime = new AgentRuntime(
      {} as any,
      {
        isSessionActive: () => false,
        isSessionTracked: () => false,
        formatToolCallCard: () => "",
        generateId: () => "system-recovery",
      } as any,
    );
    const messages: ChatMessage[] = [];
    const normalized = normalizeToolErrorContent(
      "get_full_text",
      "Error: You must set confirm=true to use this tool.",
    );

    (runtime as any).appendRecoveryGuidanceMessage(messages, [
      {
        toolCall: {
          id: "tool-confirm",
          type: "function",
          function: {
            name: "get_full_text",
            arguments: JSON.stringify({ itemKey: "ITEM-1" }),
          },
        },
        status: "failed",
        content: normalized.content,
        error: normalized.parsed.cause,
      },
    ]);

    assert.lengthOf(messages, 1);
    assert.include(messages[0].content, "Fix:");
    assert.include(messages[0].content, "confirm");
    assert.include(messages[0].content, "Alternative:");
  });
});
