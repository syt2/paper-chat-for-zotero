import { assert } from "chai";
import type { ToolCall } from "../src/types/tool";

describe("tool scheduler execution hooks", function () {
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
    (globalThis as any).Zotero = originalZotero;
  });

  it("fires execution-ready hooks only for calls that will actually execute", async function () {
    const { getToolPermissionManager } = await import(
      "../src/modules/chat/tool-permissions/index.ts"
    );
    const { ToolScheduler } = await import(
      "../src/modules/chat/tool-scheduler/ToolScheduler.ts"
    );

    getToolPermissionManager().setDescriptorModeOverride("create_note", "deny");

    const lifecycle: string[] = [];
    const scheduler = new ToolScheduler(async (toolCall) => {
      lifecycle.push(`execute:${toolCall.function.name}`);
      return "ok";
    });

    const requests: Array<{ toolCall: ToolCall; sessionId: string }> = [
      {
        toolCall: {
          id: "tool-denied",
          type: "function",
          function: {
            name: "create_note",
            arguments: JSON.stringify({ content: "hello" }),
          },
        },
        sessionId: "session-1",
      },
      {
        toolCall: {
          id: "tool-allowed",
          type: "function",
          function: {
            name: "get_item_metadata",
            arguments: JSON.stringify({ itemKey: "ITEM-1" }),
          },
        },
        sessionId: "session-1",
      },
    ];

    const results = await scheduler.executeBatch(requests, {
      onExecutionReady: (request) => {
        lifecycle.push(`ready:${request.toolCall.function.name}`);
      },
    });

    assert.deepEqual(lifecycle, [
      "ready:get_item_metadata",
      "execute:get_item_metadata",
    ]);
    assert.deepEqual(
      results.map((result) => `${result.toolCall.function.name}:${result.status}`),
      ["create_note:denied", "get_item_metadata:completed"],
    );
  });
});
