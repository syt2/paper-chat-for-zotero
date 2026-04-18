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
    const { preflightToolArguments } = await import(
      "../src/modules/chat/tool-arguments/ToolArgumentPreflight.ts"
    );
    const normalized = preflightToolArguments("web_search", {
      query: "transformer scaling",
      maxResults: "3",
      includeContent: "true",
      domainFilter: "arxiv.org, aclanthology.org",
    });

    assert.deepEqual(normalized, {
      query: "transformer scaling",
      max_results: 3,
      include_content: true,
      domain_filter: ["arxiv.org", "aclanthology.org"],
    });
  });

  it("fills create_note content and add_item identifier from common aliases", async function () {
    const { preflightToolArguments } = await import(
      "../src/modules/chat/tool-arguments/ToolArgumentPreflight.ts"
    );
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
    const { ToolScheduler } = await import(
      "../src/modules/chat/tool-scheduler/ToolScheduler.ts"
    );
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
});
