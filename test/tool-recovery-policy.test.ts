import { assert } from "chai";
import type { ToolExecutionResult } from "../src/types/tool";

describe("tool recovery policy", function () {
  it("maps missing-context failures to context-acquisition guidance", async function () {
    const { getRecoveryDirective } = await import(
      "../src/modules/chat/tool-recovery/ToolRecoveryPolicy.ts"
    );

    const result: ToolExecutionResult = {
      toolCall: {
        id: "tool-1",
        type: "function",
        function: {
          name: "get_full_text",
          arguments: JSON.stringify({ itemKey: "ITEM-1" }),
        },
      },
      args: { itemKey: "ITEM-1" },
      status: "failed",
      content: [
        "Error: Required paper context is unavailable for get_full_text.",
        "Category: missing_context",
        "Retryable: yes",
        "Suggested fix: Retry with a valid itemKey, or open the relevant PDF if the tool depends on the active reader.",
        "Safer alternative: Use metadata, notes, or library search tools that do not require full PDF text.",
      ].join("\n"),
    };

    const directive = getRecoveryDirective(result);

    assert.equal(directive.category, "missing_context");
    assert.include(directive.immediateAction, "itemKey");
    assert.include(directive.planningInstruction, "missing target context");
    assert.include(directive.alternative || "", "metadata");
  });

  it("maps denied calls to no-retry replanning guidance", async function () {
    const {
      createRecoveryGuidanceSystemMessage,
      formatRecoveryNotice,
      getRecoveryDirective,
    } = await import(
      "../src/modules/chat/tool-recovery/ToolRecoveryPolicy.ts"
    );

    const deniedResult = {
      toolCall: {
        id: "tool-1",
        type: "function" as const,
        function: {
          name: "create_note",
          arguments: JSON.stringify({ content: "hello" }),
        },
      },
      status: "denied" as const,
      permissionDecision: {
        verdict: "deny" as const,
        mode: "ask" as const,
        scope: "once" as const,
        descriptor: {
          name: "create_note" as const,
          riskLevel: "write" as const,
          mode: "ask" as const,
          description: "Create a Zotero note",
        },
        reason: "Blocked by approval policy.",
      },
      content: "Permission denied by policy.",
    } satisfies ToolExecutionResult;
    const notice = formatRecoveryNotice([deniedResult]);
    const directive = getRecoveryDirective(deniedResult);
    const systemMessage = createRecoveryGuidanceSystemMessage(
      [deniedResult],
      () => "system-1",
      123,
    );

    assert.equal(directive.category, "permission_denied");
    assert.include(notice || "", "category: permission_denied");
    assert.include(notice || "", "Do not retry this tool in the current turn");
    assert.include(notice || "", "Replanning rules:");
    assert.include(notice || "", "do not repeat the call");
    assert.deepEqual(systemMessage, {
      id: "system-1",
      role: "system",
      content: notice!,
      timestamp: 123,
    });
  });

  it("maps not-found failures to discovery-first guidance", async function () {
    const { summarizeRecoveryDirectives } = await import(
      "../src/modules/chat/tool-recovery/ToolRecoveryPolicy.ts"
    );

    const lines = summarizeRecoveryDirectives([
      {
        toolCall: {
          id: "tool-1",
          type: "function",
          function: {
            name: "get_note_content",
            arguments: JSON.stringify({ noteKey: "MISSING" }),
          },
        },
        status: "failed",
        content: [
          "Error: Requested resource for get_note_content was not found.",
          "Category: not_found",
          "Retryable: yes",
          "Suggested fix: Retry with a valid Zotero key, collection key, note key, or identifier.",
          "Safer alternative: Discover valid targets first with list or search tools before retrying.",
        ].join("\n"),
      } satisfies ToolExecutionResult,
    ]);

    assert.include(lines[0] || "", "category=not_found");
    assert.include(lines[0] || "", "Discover valid Zotero keys");
  });
});
