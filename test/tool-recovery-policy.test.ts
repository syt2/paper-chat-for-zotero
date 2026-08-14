import { assert } from "chai";
import type { ToolExecutionResult } from "../src/types/tool";

describe("tool recovery policy", function () {
  it("maps missing-context failures to context-acquisition guidance", async function () {
    const { getRecoveryDirective } =
      await import("../src/modules/chat/tool-recovery/ToolRecoveryPolicy.ts");

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
        "Fix hint: Retry with a valid itemKey, or open the relevant PDF if the tool depends on the active reader.",
        "Alternative: Use metadata, notes, or library search tools that do not require full PDF text.",
      ].join("\n"),
    };

    const directive = getRecoveryDirective(result);

    assert.equal(directive.category, "missing_context");
    assert.include(directive.immediateAction, "itemKey");
    assert.include(directive.planningInstruction, "missing target context");
    assert.include(directive.alternative || "", "metadata");
    assert.includeMembers(directive.recommendedTools, [
      "get_item_metadata",
      "get_item_notes",
      "list_all_items",
    ]);
  });

  it("maps denied calls to no-retry replanning guidance", async function () {
    const {
      createRecoveryGuidanceSystemMessage,
      formatRecoveryNotice,
      getRecoveryDirective,
    } = await import("../src/modules/chat/tool-recovery/ToolRecoveryPolicy.ts");

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
    assert.include(
      notice || "",
      "Suggested tools: get_item_metadata, get_item_notes, get_note_content",
    );
    assert.deepEqual(systemMessage, {
      id: "system-1",
      role: "system",
      content: notice!,
      timestamp: 123,
    });
  });

  it("maps not-found failures to discovery-first guidance", async function () {
    const { summarizeRecoveryDirectives } =
      await import("../src/modules/chat/tool-recovery/ToolRecoveryPolicy.ts");

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
          "Fix hint: Retry with a valid Zotero key, collection key, note key, or identifier.",
          "Alternative: Discover valid targets first with list or search tools before retrying.",
        ].join("\n"),
      } satisfies ToolExecutionResult,
    ]);

    assert.include(lines[0] || "", "category=not_found");
    assert.include(lines[0] || "", "Discover valid Zotero keys");
    assert.include(
      lines[0] || "",
      "tools=search_items, search_fulltext, list_all_items",
    );
  });

  it("maps budget-exhausted full-text failures to cheaper fallback tools", async function () {
    const { getRecoveryDirective } =
      await import("../src/modules/chat/tool-recovery/ToolRecoveryPolicy.ts");

    const directive = getRecoveryDirective({
      toolCall: {
        id: "tool-1",
        type: "function",
        function: {
          name: "get_full_text",
          arguments: JSON.stringify({ itemKey: "ITEM-1" }),
        },
      },
      status: "failed",
      content: [
        "Error: Tool budget exhausted for get_full_text.",
        "Category: budget_exhausted",
        "Retryable: no",
        "Cause: High-cost tool limit reached: get_full_text may only run 3 times per user turn.",
      ].join("\n"),
    } satisfies ToolExecutionResult);

    assert.equal(directive.category, "budget_exhausted");
    assert.include(
      directive.immediateAction,
      "Do not call get_full_text again",
    );
    assert.includeMembers(directive.recommendedTools, [
      "get_paper_section",
      "search_paper_content",
      "get_pages",
    ]);
  });

  it("allows presentation execution failures to rerun unchanged", async function () {
    const { formatRecoveryNotice, getRecoveryDirective } =
      await import("../src/modules/chat/tool-recovery/ToolRecoveryPolicy.ts");

    const failedResult = {
      toolCall: {
        id: "presentation-1",
        type: "function",
        function: {
          name: "presentation",
          arguments: JSON.stringify({ sourceItemKey: "ITEM-1" }),
        },
      },
      args: { sourceItemKey: "ITEM-1" },
      status: "failed",
      content: [
        "Error: Presentation generation failed.",
        "Category: execution_failed",
        "Retryable: yes",
        "Fix hint: Retry the presentation request to rerun rendering and export.",
      ].join("\n"),
    } satisfies ToolExecutionResult;
    const directive = getRecoveryDirective(failedResult);
    const notice = formatRecoveryNotice([failedResult]);

    assert.equal(directive.category, "execution_failed");
    assert.include(directive.immediateAction, "Retry the presentation request");
    assert.include(
      directive.planningInstruction,
      "exempt from the unchanged-call retry block",
    );
    assert.include(
      directive.planningInstruction,
      "Call presentation again in the current turn",
    );
    assert.include(
      directive.planningInstruction,
      "Never claim that the runtime forbids unchanged presentation retries",
    );
    assert.include(
      directive.planningInstruction,
      "report that the attempts failed instead of describing a duplicate-call restriction",
    );
    assert.include(notice || "", "Call presentation again in the current turn");
    assert.include(
      notice || "",
      "Never claim that the runtime forbids unchanged presentation retries",
    );
    assert.notInclude(directive.planningInstruction, "avoid repeating");
  });

  it("falls back from failed scholarly search only when general web evidence is acceptable", async function () {
    const { getRecoveryDirective } =
      await import("../src/modules/chat/tool-recovery/ToolRecoveryPolicy.ts");

    const directive = getRecoveryDirective({
      toolCall: {
        id: "scholarly-1",
        type: "function",
        function: {
          name: "search_scholarly_sources",
          arguments: JSON.stringify({ query: "transformer interpretability" }),
        },
      },
      args: { query: "transformer interpretability" },
      status: "failed",
      content: [
        "Error: Tool execution failed for search_scholarly_sources.",
        "Category: execution_failed",
        "Retryable: yes",
      ].join("\n"),
    } satisfies ToolExecutionResult);

    assert.include(
      directive.immediateAction,
      "ordinary web evidence is acceptable",
    );
    assert.include(directive.planningInstruction, "scholarly-only sources");
    assert.include(directive.recommendedTools, "web_search");
  });

  it("treats empty scholarly results as a conditional hosted-search fallback", async function () {
    const { getRecoveryDirective } =
      await import("../src/modules/chat/tool-recovery/ToolRecoveryPolicy.ts");

    const directive = getRecoveryDirective({
      toolCall: {
        id: "scholarly-empty",
        type: "function",
        function: {
          name: "search_scholarly_sources",
          arguments: JSON.stringify({ query: "missing scholarly work" }),
        },
      },
      status: "failed",
      content: [
        'Error: No scholarly results found for "missing scholarly work".',
        "Category: not_found",
        "Retryable: no",
      ].join("\n"),
    } satisfies ToolExecutionResult);

    assert.equal(directive.category, "not_found");
    assert.include(
      directive.immediateAction,
      "ordinary web evidence is acceptable",
    );
    assert.include(directive.planningInstruction, "Never downgrade");
    assert.include(directive.recommendedTools, "web_search");
  });

  it("allows only an exposed hosted web_search after local search budget exhaustion", async function () {
    const { getRecoveryDirective } =
      await import("../src/modules/chat/tool-recovery/ToolRecoveryPolicy.ts");

    const directive = getRecoveryDirective({
      toolCall: {
        id: "scholarly-budget",
        type: "function",
        function: {
          name: "search_scholarly_sources",
          arguments: JSON.stringify({ query: "transformer interpretability" }),
        },
      },
      status: "failed",
      content: [
        "Error: Tool budget exhausted for search_scholarly_sources.",
        "Category: budget_exhausted",
        "Retryable: no",
      ].join("\n"),
    } satisfies ToolExecutionResult);

    assert.include(directive.recommendedTools, "web_search");
    assert.include(
      directive.immediateAction,
      "Do not retry local web or scholarly search",
    );
    assert.include(directive.immediateAction, "vendor-hosted web_search");
    assert.include(directive.planningInstruction, "actually exposed");
  });

  it("replans a failed download around a different direct URL", async function () {
    const { getRecoveryDirective } =
      await import("../src/modules/chat/tool-recovery/ToolRecoveryPolicy.ts");

    const directive = getRecoveryDirective({
      toolCall: {
        id: "download-failed",
        type: "function",
        function: {
          name: "download",
          arguments: JSON.stringify({
            url: "https://example.test/not-a-file",
            destination: "zotero",
          }),
        },
      },
      status: "failed",
      content: [
        "Error: The file could not be downloaded.",
        "Category: execution_failed",
        "Retryable: yes",
        "Cause: HTTP 404",
      ].join("\n"),
    } satisfies ToolExecutionResult);

    assert.include(
      directive.planningInstruction,
      "alternative direct file URL",
    );
    assert.includeMembers(directive.recommendedTools, ["search_items"]);
    assert.notInclude(directive.recommendedTools, "web_search");
  });
});
