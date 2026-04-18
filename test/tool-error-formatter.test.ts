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

  it("normalizes raw executor errors into structured missing-context hints", async function () {
    const scheduler = new ToolScheduler(async () => {
      return "Error: Could not extract PDF content for item \"ITEM-1\". The item may not exist or may not have a PDF attachment.";
    });
    const toolCall: ToolCall = {
      id: "tool-missing-context",
      type: "function",
      function: {
        name: "get_full_text",
        arguments: JSON.stringify({ itemKey: "ITEM-1" }),
      },
    };

    const result = await scheduler.execute({ toolCall, sessionId: "session-1" });
    const parsed = parseToolError(result.content);

    assert.equal(result.status, "failed");
    assert.equal(parsed?.category, "missing_context");
    assert.include(parsed?.suggestedFix || "", "itemKey");
    assert.include(parsed?.saferAlternative || "", "metadata");
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
      "Error: Could not extract PDF content for item \"ITEM-1\". The item may not exist or may not have a PDF attachment.",
    );

    (runtime as any).appendRecoveryGuidanceMessage(messages, [
      {
        toolCall: {
          id: "tool-missing-context",
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
    assert.include(messages[0].content, "itemKey");
    assert.include(messages[0].content, "Alternative:");
  });
});
