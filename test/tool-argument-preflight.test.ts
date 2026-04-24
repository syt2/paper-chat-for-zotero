import { assert } from "chai";
import type { ToolCall } from "../src/types/tool";

describe("tool argument preflight", function () {
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

  afterEach(function () {
    (globalThis as any).Zotero = originalZotero;
  });

  it("repairs common aliases and scalar types for web_search", async function () {
    const { preflightToolArguments } =
      await import("../src/modules/chat/tool-arguments/ToolArgumentPreflight.ts");
    const normalized = preflightToolArguments("web_search", {
      query: "transformer scaling",
      maxResults: "3",
      includeContent: "true",
      domainFilter: "arxiv.org, aclanthology.org",
      provider: "semantic_scholar",
      searchIntent: "related",
      yearFrom: "2020",
      yearTo: "2024",
      openAccessOnly: "1",
      seedTitle: "Scaling Laws for Neural Language Models",
      seedDoi: "10.1234/example",
    });

    assert.deepEqual(normalized, {
      query: "transformer scaling",
      max_results: 3,
      include_content: true,
      domain_filter: ["arxiv.org", "aclanthology.org"],
      source: "semantic_scholar",
      intent: "related",
      year_from: 2020,
      year_to: 2024,
      open_access_only: true,
      seed_title: "Scaling Laws for Neural Language Models",
      seed_doi: "10.1234/example",
    });
  });

  it("fills create_note content and add_item identifier from common aliases", async function () {
    const { preflightToolArguments } =
      await import("../src/modules/chat/tool-arguments/ToolArgumentPreflight.ts");
    const createNoteArgs = preflightToolArguments("create_note", {
      item_key: "ABCD1234",
      text: "A short summary",
      tags: ["llm", "survey"],
    });
    assert.equal(createNoteArgs.itemKey, "ABCD1234");
    assert.equal(createNoteArgs.content, "A short summary");
    assert.equal(createNoteArgs.tags, "llm, survey");

    const addItemArgs = preflightToolArguments("add_item", {
      doi: "10.1000/example",
      collectionKey: "COLL1234",
    });
    assert.equal(addItemArgs.identifier, "10.1000/example");
    assert.equal(addItemArgs.collection_key, "COLL1234");
  });

  it("normalizes annotation aliases and scalar booleans", async function () {
    const { ToolScheduler } =
      await import("../src/modules/chat/tool-scheduler/ToolScheduler.ts");
    const calls: Record<string, unknown>[] = [];
    const scheduler = new ToolScheduler(async (_toolCall, _fallback, args) => {
      calls.push(args);
      return "ok";
    });

    const toolCall: ToolCall = {
      id: "tool-1",
      type: "function",
      function: {
        name: "get_annotations",
        arguments: JSON.stringify({
          item_key: "AAA111",
          annotation_type: "highlight",
          selected_only: "true",
          include_position: "1",
        }),
      },
    };

    const result = await scheduler.execute({
      toolCall,
      sessionId: "session-1",
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(calls[0], {
      itemKey: "AAA111",
      annotationType: "highlight",
      selectedOnly: true,
      includePosition: true,
    });
    assert.deepEqual(result.args, calls[0]);
  });

  it("repairs schema-shaped key casing, enum casing, and drops unsupported keys", async function () {
    const { ToolScheduler } =
      await import("../src/modules/chat/tool-scheduler/ToolScheduler.ts");
    const calls: Record<string, unknown>[] = [];
    const scheduler = new ToolScheduler(async (_toolCall, _fallback, args) => {
      calls.push(args);
      return "ok";
    });

    const toolCall: ToolCall = {
      id: "tool-2",
      type: "function",
      function: {
        name: "search_by_tag",
        arguments: JSON.stringify({
          TAGS: ["llm", "agents"],
          MODE: "AND",
          UNUSED_FLAG: true,
        }),
      },
    };

    const result = await scheduler.execute({
      toolCall,
      sessionId: "session-1",
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(calls[0], {
      tags: "llm, agents",
      mode: "and",
    });
    assert.deepInclude(result.policyTrace?.[0], {
      stage: "scheduler",
      policy: "argument_repair",
      outcome: "rewritten",
    });
  });

  it("blocks arguments that still violate the schema after repair", async function () {
    const { ToolScheduler } =
      await import("../src/modules/chat/tool-scheduler/ToolScheduler.ts");
    let invoked = false;
    const scheduler = new ToolScheduler(async () => {
      invoked = true;
      return "ok";
    });

    const toolCall: ToolCall = {
      id: "tool-3",
      type: "function",
      function: {
        name: "web_search",
        arguments: JSON.stringify({
          query: "attention is all you need",
          max_results: "abc",
        }),
      },
    };

    const result = await scheduler.execute({
      toolCall,
      sessionId: "session-1",
    });

    assert.equal(invoked, false);
    assert.equal(result.status, "failed");
    assert.include(result.content, "Category: invalid_arguments");
    assert.include(result.content, "max_results: expected number");
    assert.deepInclude(result.policyTrace?.[0], {
      stage: "scheduler",
      policy: "argument_validation",
      outcome: "blocked",
    });
  });

  it("blocks singular string fields instead of joining array values", async function () {
    const { ToolScheduler } =
      await import("../src/modules/chat/tool-scheduler/ToolScheduler.ts");
    let invoked = false;
    const scheduler = new ToolScheduler(async () => {
      invoked = true;
      return "ok";
    });

    const toolCall: ToolCall = {
      id: "tool-4",
      type: "function",
      function: {
        name: "get_note_content",
        arguments: JSON.stringify({
          noteKey: ["NOTE1", "NOTE2"],
        }),
      },
    };

    const result = await scheduler.execute({
      toolCall,
      sessionId: "session-1",
    });

    assert.equal(invoked, false);
    assert.equal(result.status, "failed");
    assert.include(result.content, "Category: invalid_arguments");
    assert.include(result.content, "noteKey: expected string, got array");
  });

  it("surfaces validator crashes as internal validation failures instead of JSON parse errors", async function () {
    const { ToolScheduler } =
      await import("../src/modules/chat/tool-scheduler/ToolScheduler.ts");
    const { getPdfToolManager } = await import("../src/modules/chat/pdf-tools/index.ts");
    const { resetToolArgumentValidationCache } = await import(
      "../src/modules/chat/tool-arguments/ToolArgumentValidation.ts"
    );
    const manager = getPdfToolManager();
    const originalGetToolDefinitions = manager.getToolDefinitions.bind(manager);
    resetToolArgumentValidationCache();
    manager.getToolDefinitions = (() => {
      throw new Error("schema boom");
    }) as typeof manager.getToolDefinitions;

    try {
      const scheduler = new ToolScheduler(async () => "ok");
      const toolCall: ToolCall = {
        id: "tool-5",
        type: "function",
        function: {
          name: "web_search",
          arguments: JSON.stringify({
            query: "tool validation",
          }),
        },
      };

      const result = await scheduler.execute({
        toolCall,
        sessionId: "session-1",
      });

      assert.equal(result.status, "failed");
      assert.include(result.content, "Category: execution_failed");
      assert.include(result.content, "Cause: schema boom");
      assert.notInclude(result.content, "Tool arguments are not valid JSON");
      assert.deepInclude(result.policyTrace?.[0], {
        stage: "scheduler",
        policy: "argument_validation",
        outcome: "blocked",
      });
    } finally {
      manager.getToolDefinitions = originalGetToolDefinitions;
      resetToolArgumentValidationCache();
    }
  });
});
