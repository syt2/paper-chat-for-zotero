import { assert } from "chai";
import type { ToolCall } from "../src/types/tool";

describe("tool error formatting", function () {
  let originalZotero: unknown;

  beforeEach(function () {
    originalZotero = (globalThis as any).Zotero;
    const prefStore = new Map<string, unknown>();
    (globalThis as any).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key),
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
          return true;
        },
      },
    };
  });

  afterEach(async function () {
    const { getToolPermissionManager } = await import(
      "../src/modules/chat/tool-permissions/index.ts"
    );
    getToolPermissionManager().setDescriptorModeOverride("create_note", null);
    getToolPermissionManager().setDescriptorModeOverride("get_full_text", null);
    (globalThis as any).Zotero = originalZotero;
  });

  it("formats invalid JSON argument failures into structured recovery hints", async function () {
    const { ToolScheduler } = await import(
      "../src/modules/chat/tool-scheduler/ToolScheduler.ts"
    );
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
    assert.include(result.content, "Fix hint:");
    assert.deepInclude(result.policyTrace?.[0], {
      stage: "scheduler",
      policy: "argument_parse",
      outcome: "blocked",
    });
  });

  it("formats denied tool calls with stable recovery guidance", async function () {
    const { getToolPermissionManager } = await import(
      "../src/modules/chat/tool-permissions/index.ts"
    );
    const { ToolScheduler } = await import(
      "../src/modules/chat/tool-scheduler/ToolScheduler.ts"
    );
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
    assert.deepInclude(result.policyTrace?.[0], {
      stage: "scheduler",
      policy: "permission_decision",
      outcome: "blocked",
    });
  });

  it("normalizes raw executor errors into structured missing-context hints", async function () {
    const { getToolPermissionManager } = await import(
      "../src/modules/chat/tool-permissions/index.ts"
    );
    const { ToolScheduler } = await import(
      "../src/modules/chat/tool-scheduler/ToolScheduler.ts"
    );
    const { parseToolError } = await import(
      "../src/modules/chat/tool-errors/ToolErrorFormatter.ts"
    );
    getToolPermissionManager().setDescriptorModeOverride(
      "get_full_text",
      "auto_allow",
    );
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

  it("keeps structured fix guidance available for runtime recovery consumption", async function () {
    const {
      normalizeToolErrorContent,
      parseToolError,
    } = await import("../src/modules/chat/tool-errors/ToolErrorFormatter.ts");
    const normalized = normalizeToolErrorContent(
      "get_full_text",
      "Error: Could not extract PDF content for item \"ITEM-1\". The item may not exist or may not have a PDF attachment.",
    );
    const parsed = parseToolError(normalized.content);

    assert.equal(parsed?.category, "missing_context");
    assert.include(parsed?.suggestedFix || "", "itemKey");
    assert.include(parsed?.saferAlternative || "", "metadata");
  });

  it("parses legacy structured labels during migration", async function () {
    const { normalizeToolErrorContent, parseToolError } = await import(
      "../src/modules/chat/tool-errors/ToolErrorFormatter.ts"
    );
    const legacyContent = [
      "Error: Required paper context is unavailable for get_full_text.",
      "Category: missing_context",
      "Retryable: yes",
      "Suggested fix: Retry with a valid itemKey.",
      "Safer alternative: Use metadata first.",
    ].join("\n");
    const normalized = normalizeToolErrorContent("get_full_text", legacyContent);
    const parsed = parseToolError(legacyContent);

    assert.include(normalized.content, "Fix hint: Retry with a valid itemKey.");
    assert.include(normalized.content, "Alternative: Use metadata first.");
    assert.notInclude(normalized.content, "Suggested fix:");
    assert.notInclude(normalized.content, "Safer alternative:");
    assert.deepEqual(normalized.parsed, parsed);

    assert.equal(parsed?.category, "missing_context");
    assert.equal(parsed?.suggestedFix, "Retry with a valid itemKey.");
    assert.equal(parsed?.saferAlternative, "Use metadata first.");
  });
});
