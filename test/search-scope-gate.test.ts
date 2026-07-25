import { assert } from "chai";
import {
  SEARCH_SCOPE_TOOL_NAME,
  advanceSearchScopeAfterResults,
  createPendingSearchScopeTools,
  executeSearchScopeSelection,
  filterSearchToolsForScope,
  findCompletedSearchScope,
  getSelectedSearchScopeRuntimeGuidance,
  getSearchToolPromptMode,
} from "../src/modules/chat/agent-runtime/SearchScopeGate.ts";
import type {
  ToolCall,
  ToolDefinition,
  ToolExecutionResult,
} from "../src/types/tool";

const searchTools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Web search",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_scholarly_sources",
      description: "Scholarly search",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_items",
      description: "Search Zotero",
      parameters: { type: "object", properties: {} },
    },
  },
];

function createScopeCall(
  scope: string,
  reason: string = "The user explicitly restricted the sources.",
): ToolCall {
  return {
    id: `scope-${scope}`,
    type: "function",
    function: {
      name: SEARCH_SCOPE_TOOL_NAME,
      arguments: JSON.stringify({ scope, reason }),
    },
  };
}

describe("search scope gate", function () {
  it("exposes only the model-driven gate before external search", function () {
    const tools = createPendingSearchScopeTools(searchTools);

    assert.deepEqual(
      tools.map((tool) => tool.function.name),
      ["search_items", SEARCH_SCOPE_TOOL_NAME],
    );
    assert.equal(getSearchToolPromptMode(tools, true), "gated");
  });

  it("maps a selected scope to the allowed hosted and local tools", function () {
    assert.deepEqual(
      filterSearchToolsForScope({
        tools: searchTools,
        supportsHostedWebSearch: true,
        scope: "scholarly_then_web",
      }).map((tool) => tool.function.name),
      ["search_scholarly_sources", "search_items"],
    );
    assert.deepEqual(
      filterSearchToolsForScope({
        tools: searchTools,
        supportsHostedWebSearch: true,
        scope: "web_allowed",
      }).map((tool) => tool.function.name),
      ["web_search", "search_scholarly_sources", "search_items"],
    );
    assert.deepEqual(
      filterSearchToolsForScope({
        tools: searchTools,
        supportsHostedWebSearch: true,
        scope: "scholarly_only",
      }).map((tool) => tool.function.name),
      ["search_scholarly_sources", "search_items"],
    );
    assert.deepEqual(
      filterSearchToolsForScope({
        tools: searchTools,
        supportsHostedWebSearch: false,
        scope: "web_allowed",
      }).map((tool) => tool.function.name),
      ["web_search", "search_items"],
    );
    assert.deepEqual(
      filterSearchToolsForScope({
        tools: searchTools,
        supportsHostedWebSearch: true,
        scope: "no_external_search",
      }).map((tool) => tool.function.name),
      ["search_items"],
    );
  });

  it("unlocks web fallback after a finished scholarly attempt only for scholarly_then_web", function () {
    const scholarlyCall: ToolCall = {
      id: "scholarly-attempt",
      type: "function",
      function: {
        name: "search_scholarly_sources",
        arguments: JSON.stringify({ query: "related papers" }),
      },
    };

    for (const status of ["completed", "failed"] as const) {
      const result: ToolExecutionResult = {
        toolCall: scholarlyCall,
        status,
        content:
          status === "completed"
            ? "scholarly results"
            : [
                "Error: No scholarly results found.",
                "Category: not_found",
                "Retryable: no",
              ].join("\n"),
      };

      assert.equal(
        advanceSearchScopeAfterResults("scholarly_then_web", [result]),
        "web_allowed",
      );
      assert.equal(
        advanceSearchScopeAfterResults("scholarly_only", [result]),
        "scholarly_only",
      );
      assert.equal(
        advanceSearchScopeAfterResults("web_allowed", [result]),
        "web_allowed",
      );
    }

    assert.equal(
      advanceSearchScopeAfterResults("scholarly_then_web", [
        {
          toolCall: scholarlyCall,
          status: "denied",
          content: "The call was blocked before execution.",
        },
      ]),
      "scholarly_then_web",
    );
    assert.equal(
      advanceSearchScopeAfterResults("scholarly_then_web", [
        {
          toolCall: scholarlyCall,
          status: "failed",
          policyTrace: [
            {
              stage: "scheduler",
              policy: "argument_validation",
              outcome: "blocked",
              summary: "The scholarly search never reached the executor.",
            },
          ],
          content: [
            "Error: Invalid arguments for search_scholarly_sources.",
            "Category: invalid_arguments",
            "Retryable: yes",
          ].join("\n"),
        },
      ]),
      "scholarly_then_web",
    );
    assert.equal(
      advanceSearchScopeAfterResults("scholarly_then_web", [
        {
          toolCall: scholarlyCall,
          status: "failed",
          content: [
            "Error: Tool budget exhausted for search_scholarly_sources.",
            "Category: budget_exhausted",
            "Retryable: no",
          ].join("\n"),
        },
      ]),
      "web_allowed",
    );
  });

  it("restores the unlocked fallback only from a scholarly result after the selected scope", function () {
    const selected = executeSearchScopeSelection(
      createScopeCall(
        "scholarly_then_web",
        "The user permits ordinary web only after scholarly search.",
      ),
    ).result;
    const scholarlyResult: ToolExecutionResult = {
      toolCall: {
        id: "restored-scholarly-attempt",
        type: "function",
        function: {
          name: "search_scholarly_sources",
          arguments: JSON.stringify({ query: "missing paper" }),
        },
      },
      status: "failed",
      content: [
        "Error: No scholarly results found.",
        "Category: not_found",
        "Retryable: no",
      ].join("\n"),
    };

    assert.equal(
      findCompletedSearchScope([selected, scholarlyResult]),
      "web_allowed",
    );
    assert.equal(
      findCompletedSearchScope([scholarlyResult, selected]),
      "scholarly_then_web",
    );
  });

  it("accepts one valid model selection and locks the turn scope", function () {
    const first = executeSearchScopeSelection(
      createScopeCall("scholarly_only"),
    );
    const conflicting = executeSearchScopeSelection(
      createScopeCall("web_allowed"),
      first.selectedScope,
    );
    const duplicate = executeSearchScopeSelection(
      createScopeCall("scholarly_only"),
      first.selectedScope,
    );

    assert.equal(first.result.status, "completed");
    assert.equal(first.selectedScope, "scholarly_only");
    assert.include(first.result.content, "current user turn");
    assert.equal(conflicting.result.status, "denied");
    assert.isUndefined(conflicting.selectedScope);
    assert.equal(duplicate.result.status, "denied");
    assert.isUndefined(duplicate.selectedScope);

    const webAllowed = executeSearchScopeSelection(
      createScopeCall(
        "web_allowed",
        "The user requested ordinary web search as a fallback.",
      ),
    );
    assert.include(
      webAllowed.result.content,
      "continue with web_search after scholarly search returns no useful results",
    );

    const scholarlyThenWeb = executeSearchScopeSelection(
      createScopeCall(
        "scholarly_then_web",
        "The user requested scholarly search first and web as fallback.",
      ),
    );
    assert.equal(scholarlyThenWeb.selectedScope, "scholarly_then_web");
    assert.include(
      scholarlyThenWeb.result.content,
      "web search remains hidden until a scholarly-search attempt completes",
    );
  });

  it("rejects an invalid model selection and restores completed scope", function () {
    const invalid = executeSearchScopeSelection(createScopeCall("general_web"));
    const completed = executeSearchScopeSelection(
      createScopeCall("web_allowed"),
    ).result;
    const results: ToolExecutionResult[] = [invalid.result, completed];

    assert.equal(invalid.result.status, "failed");
    assert.equal(findCompletedSearchScope(results), "web_allowed");
  });

  it("describes the actual search tools after a model capability switch", function () {
    assert.include(
      getSelectedSearchScopeRuntimeGuidance("web_allowed", "split"),
      "search_scholarly_sources before web_search",
    );
    assert.include(
      getSelectedSearchScopeRuntimeGuidance("web_allowed", "unified"),
      "unified local web_search tool",
    );
  });
});
